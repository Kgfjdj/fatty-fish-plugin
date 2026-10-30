/**
 * 中长期活动记忆：基于既有截图视觉理解的结果，沉淀「最近 72 小时做过什么」的中期活动记忆，
 * 同一活动在滚动 72 小时窗口内出现 3 次独立会话后晋升为长期记忆（30 天）；长期记忆满期未再出现
 * 时压缩成一句历史概括，压缩概括再保留一段时间后删除。
 *
 * 与短期记忆（MemoryManager，纯内存、按轮数淡出）分层：
 * - 中期/长期/压缩记忆持久化到插件本地 JSON 文件，重启后恢复；
 * - 不保存原始截图，只保存由模型描述的活动事实（kind / title / action / summary / confidence）；
 * - 模型负责描述活动，代码负责时间戳、去重、会话计数、晋升、过期、压缩与持久化；
 * - 所有时间计算用可注入时钟，便于单元测试。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** 活动类型：书籍 / 文章 / 视频 / 项目 / 其他。 */
export type ActivityKind = 'book' | 'article' | 'video' | 'project' | 'other';

/** 记忆阶段：中期（72h）/ 长期（30d）/ 压缩概括（再保留一段）。 */
export type MemoryTier = 'medium' | 'long' | 'compressed';

/** 视觉置信度：low 不进入中长期记忆，只在短期摘要里保留。 */
export type Confidence = 'high' | 'medium' | 'low';

export const ACTIVITY_KINDS: readonly ActivityKind[] = ['book', 'article', 'video', 'project', 'other'];

export const ACTIVITY_KIND_LABEL: Record<ActivityKind, string> = {
  book: '书籍',
  article: '文章',
  video: '视频',
  project: '项目',
  other: '其他',
};

export const ACTIVITY_TIER_LABEL: Record<MemoryTier, string> = {
  medium: '中期',
  long: '长期',
  compressed: '压缩',
};

/** 模型提交的活动候选（由 screen_companion_memory_record 透传）。 */
export interface ActivityCandidate {
  /** 关联的截图观察 id，用于「同一截图不重复计数」的幂等。 */
  observationId?: string;
  kind: ActivityKind;
  /** 从画面识别的书名/文章名/视频名/项目名；认不出就省略，代码不会为此编造身份。 */
  title?: string;
  /** 动作：reading / browsing / watching / working（模型可自由描述）。 */
  action?: string;
  summary: string;
  confidence?: Confidence;
}

/** 一条中长期活动记忆。 */
export interface ActivityMemory {
  id: string;
  tier: MemoryTier;
  kind: ActivityKind;
  /** 规范化身份：`${kind}:${规范化 title}`，用于合并同一活动。 */
  identityKey: string;
  title: string;
  action: string;
  summary: string;
  /** 入库置信度只保留 high / medium（low 不入库）。 */
  confidence: 'high' | 'medium';
  firstSeenAt: number;
  lastSeenAt: number;
  promotedAt?: number;
  compressedAt?: number;
  /** 独立会话起始时间戳（仅保留晋升与检索所需）。 */
  sessionStarts: number[];
  /** 有效观察次数。 */
  evidenceCount: number;
}

export interface ActivityMemoryLimits {
  /** 中期记忆窗口（小时），滚动窗口判断晋升与过期。 */
  mediumHours: number;
  /** 两次有效观察间隔超过该毫秒数即视为一次新会话。 */
  sessionGapMs: number;
  /** 滚动窗口内达到该独立会话次数才晋升长期。 */
  promotionSessions: number;
  /** 长期记忆保留天数，满期未再出现触发压缩/删除。 */
  longDays: number;
  /** 压缩概括再保留的天数，仍无再次出现则删除。 */
  compressedDays: number;
  /** 全部活动记忆条数上限。 */
  maxItems: number;
}

export type ObserveOutcome = 'added' | 'updated' | 'promoted' | 'no_identity' | 'low_confidence' | 'duplicate';

export interface ObserveResult {
  outcome: ObserveOutcome;
  id?: string;
  tier?: MemoryTier;
  /** 本次是否开启了一个新的独立会话。 */
  newSession?: boolean;
}

/** 单条活动摘要最大长度（汉字）。 */
const MAX_ACTIVITY_SUMMARY = 120;
/** 活动摘要最小长度（汉字），过短视为噪声，不进入中长期记忆。 */
const MIN_ACTIVITY_SUMMARY = 4;
/** 压缩概括的最大长度。 */
const MAX_COMPRESSED_SUMMARY = 60;
/** 活动标题最大长度。 */
const MAX_TITLE_LENGTH = 80;
/** 幂等去重窗口：只记住最近这么多观察 id。 */
const MAX_SEEN_OBSERVATIONS = 500;

function normalizeTitle(raw: string | undefined): string {
  const t = (raw ?? '').trim();
  // 去掉首尾书名号/引号，便于「三体」与「《三体》」归并为同一活动。
  const stripped = t.replace(/^[《「『"'“‘]+|[》」』"’']+$/g, '').trim();
  return stripped.slice(0, MAX_TITLE_LENGTH).toLowerCase();
}

function normalizeKind(raw: unknown): ActivityKind | null {
  return typeof raw === 'string' && ACTIVITY_KINDS.includes(raw as ActivityKind) ? (raw as ActivityKind) : null;
}

function normalizeConfidence(raw: unknown): Confidence {
  return raw === 'high' || raw === 'medium' || raw === 'low' ? raw : 'medium';
}

function defaultAction(kind: ActivityKind): string {
  switch (kind) {
    case 'book':
    case 'article':
      return 'reading';
    case 'video':
      return 'watching';
    case 'project':
      return 'working';
    default:
      return 'browsing';
  }
}

export class ActivityMemoryStore {
  private items: ActivityMemory[] = [];
  private seenObservationIds = new Set<string>();
  private readonly dataDir: string;
  private readonly nowFn: () => number;

  constructor(dataDir: string, opts: { now?: () => number } = {}) {
    this.dataDir = dataDir;
    this.nowFn = opts.now ?? Date.now;
    this.load();
  }

  private get file(): string {
    return join(this.dataDir, 'activity-memory.json');
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { version?: number; items?: unknown };
      if (raw && Array.isArray(raw.items)) {
        this.items = (raw.items as ActivityMemory[]).filter(
          (it) => it && typeof it.id === 'string' && typeof it.identityKey === 'string',
        );
      }
    } catch {
      this.items = [];
    }
  }

  private save(): void {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, items: this.items }, null, 2), 'utf8');
      renameSync(tmp, this.file);
    } catch {
      /* 落盘失败不影响内存态，下次写入重试。 */
    }
  }

  /**
   * 记录一次有效截图观察对应的活动候选：
   * - title 无法辨认时不做精确身份，不进入中长期记忆（留在短期摘要）；
   * - confidence 为 low 时不进入；
   * - 同一 observationId 重复提交幂等，不重复计数；
   * - 超过会话间隔的再次出现计一次新会话；滚动窗口内达到阈值即晋升长期。
   */
  observe(candidate: ActivityCandidate, limits: ActivityMemoryLimits, now: number): ObserveResult {
    const kind = normalizeKind(candidate.kind);
    const title = normalizeTitle(candidate.title);
    const confidence = normalizeConfidence(candidate.confidence);
    const summary = (candidate.summary ?? '').trim().slice(0, MAX_ACTIVITY_SUMMARY);

    if (!kind) return { outcome: 'no_identity' };
    if (!title) return { outcome: 'no_identity' };
    if (summary.length < MIN_ACTIVITY_SUMMARY) return { outcome: 'no_identity' };
    if (confidence === 'low') return { outcome: 'low_confidence' };

    const observationId = candidate.observationId?.trim();
    if (observationId && this.seenObservationIds.has(observationId)) {
      return { outcome: 'duplicate' };
    }

    const identityKey = `${kind}:${title}`;
    const storedConfidence: 'high' | 'medium' = confidence === 'high' ? 'high' : 'medium';
    const existing = this.items.find((i) => i.identityKey === identityKey);
    let item: ActivityMemory;
    let newSession = false;
    let outcome: ObserveOutcome;

    if (!existing) {
      item = {
        id: `act-${randomUUID().slice(0, 8)}`,
        tier: 'medium',
        kind,
        identityKey,
        title: candidate.title?.trim().slice(0, MAX_TITLE_LENGTH) ?? title,
        action: (candidate.action ?? '').trim() || defaultAction(kind),
        summary,
        confidence: storedConfidence,
        firstSeenAt: now,
        lastSeenAt: now,
        sessionStarts: [now],
        evidenceCount: 1,
      };
      this.items.push(item);
      outcome = 'added';
    } else {
      item = existing;
      newSession = now - item.lastSeenAt >= limits.sessionGapMs;
      item.lastSeenAt = now;
      item.summary = summary;
      if (storedConfidence === 'high') item.confidence = 'high';
      item.evidenceCount += 1;
      if (newSession) {
        // 只有中期阶段需要累积独立会话用于晋升；长期阶段只刷新 lastSeenAt。
        if (item.tier === 'medium') item.sessionStarts.push(now);
        // 压缩概括被重新观察到：重新激活为长期，更新观察时间。
        if (item.tier === 'compressed') {
          item.tier = 'long';
          item.compressedAt = undefined;
        }
      }
      outcome = 'updated';
    }

    const tierBeforePromote = item.tier;
    this.maybePromote(item, limits, now);
    if (outcome === 'updated' && tierBeforePromote === 'medium' && item.tier === 'long') {
      outcome = 'promoted';
    }

    if (observationId) {
      this.seenObservationIds.add(observationId);
      if (this.seenObservationIds.size > MAX_SEEN_OBSERVATIONS) this.seenObservationIds = new Set();
    }

    this.trim(limits);
    this.cleanup(limits, now);
    this.save();
    return { outcome, id: item.id, tier: item.tier, newSession };
  }

  private maybePromote(item: ActivityMemory, limits: ActivityMemoryLimits, now: number): void {
    if (item.tier !== 'medium') return;
    const windowStart = now - limits.mediumHours * 3600_000;
    const recentSessions = item.sessionStarts.filter((t) => t >= windowStart).length;
    if (recentSessions >= limits.promotionSessions) {
      item.tier = 'long';
      item.promotedAt = now;
      item.sessionStarts = []; // 晋升已达成，清空不再需要的会话时间戳。
    }
  }

  /** 满期处理：低价值长期记忆删除，高价值压缩为一句历史概括。 */
  private compress(item: ActivityMemory, now: number): void {
    item.tier = 'compressed';
    item.compressedAt = now;
    item.summary = item.summary.slice(0, MAX_COMPRESSED_SUMMARY);
    item.sessionStarts = [];
  }

  private isHighValue(item: ActivityMemory): boolean {
    // 有清晰依据（高置信）或多次活动证据的记录保留为概括；低置信且证据稀少的直接遗忘。
    return item.confidence === 'high' || item.evidenceCount >= 4;
  }

  /** 过期清理：中期满 72h 未出现删除；长期满 30 天压缩/删除；压缩概括满期删除。返回删除条数。 */
  cleanup(limits: ActivityMemoryLimits, now: number): number {
    const mediumMs = limits.mediumHours * 3600_000;
    const longMs = limits.longDays * 24 * 3600_000;
    const compressedMs = limits.compressedDays * 24 * 3600_000;
    const before = this.items.length;

    this.items = this.items.filter((item) => {
      if (item.tier === 'medium') {
        return now - item.lastSeenAt < mediumMs;
      }
      if (item.tier === 'long') {
        if (now - item.lastSeenAt >= longMs) {
          if (this.isHighValue(item)) {
            this.compress(item, now);
            return true;
          }
          return false;
        }
        return true;
      }
      if (item.tier === 'compressed') {
        const base = item.compressedAt ?? item.lastSeenAt;
        return now - base < compressedMs;
      }
      return true;
    });

    const removed = before - this.items.length;
    if (removed > 0) this.save();
    return removed;
  }

  /** 容量裁剪：超出上限淘汰最久未更新的。 */
  private trim(limits: ActivityMemoryLimits): void {
    if (this.items.length <= limits.maxItems) return;
    this.items.sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    this.items = this.items.slice(this.items.length - limits.maxItems);
  }

  /** 列出全部活动记忆，最近观察的在前。 */
  list(): ActivityMemory[] {
    return this.items.slice().sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  /** 按类别 / 标题 / 摘要 / 动作做文字检索；query 为空则返回最近的。 */
  recall(query: string, limit = 5): ActivityMemory[] {
    const q = (query ?? '').trim().toLowerCase();
    const list = this.list();
    if (!q) return list.slice(0, Math.max(1, limit));
    const terms = q.split(/\s+/).filter(Boolean);
    return list
      .map((item) => {
        const hay = `${ACTIVITY_KIND_LABEL[item.kind]} ${item.title} ${item.summary} ${item.action}`.toLowerCase();
        let score = 0;
        for (const t of terms) if (hay.includes(t)) score += 1;
        return { item, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.item.lastSeenAt - a.item.lastSeenAt)
      .slice(0, Math.max(1, limit))
      .map((x) => x.item);
  }

  /** 按 id 删除一条错误记忆，返回是否命中。 */
  forget(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.id !== id);
    if (this.items.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  /** 各阶段条数统计。 */
  stats(): { medium: number; long: number; compressed: number; total: number } {
    let medium = 0;
    let long = 0;
    let compressed = 0;
    for (const i of this.items) {
      if (i.tier === 'medium') medium++;
      else if (i.tier === 'long') long++;
      else compressed++;
    }
    return { medium, long, compressed, total: this.items.length };
  }
}
