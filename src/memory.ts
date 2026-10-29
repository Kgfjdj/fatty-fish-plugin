/**
 * 短期观察记忆：把每次被模型实际理解的有效截图，整理成一条简短的结构化观察摘要，
 * 按场景分组保存，支持按轮数/时间过期、容量限制与去重（同一截图不重复记录）。
 *
 * 纯内存、重启清空，不保存原始截图。独立于 Cortico World，便于单元测试。
 * 场景判断只依赖模型在摘要里给的 sceneType/sceneLabel，不读 URL、DOM、窗口标题或文件系统。
 */

/** 场景类型：阅读 / 视频 / 编程 / 网页 / 其他 / 未知。 */
export type SceneType = 'reading' | 'video' | 'coding' | 'web' | 'other' | 'unknown';

export const SCENE_TYPES: readonly SceneType[] = ['reading', 'video', 'coding', 'web', 'other', 'unknown'];

export const SCENE_TYPE_LABEL: Record<SceneType, string> = {
  reading: '阅读',
  video: '视频',
  coding: '编程',
  web: '网页',
  other: '其他',
  unknown: '未知',
};

/** 一条观察摘要。 */
export interface ObservationMemory {
  id: string;
  /** 关联的截图观察 id，用于「同一张截图不重复记录」。 */
  observationId: string;
  sceneId: string;
  sceneType: SceneType;
  /** 书名/视频名/项目名；模型认不出则省略，不编造。 */
  sceneLabel?: string;
  summary: string;
  /** 观察时间戳（毫秒）。 */
  observedAt: number;
  /** 创建时的真人回合数。 */
  createdTurn: number;
}

/** 一个短期场景（例如同一本书、同一个项目、同一个视频）。 */
export interface Scene {
  id: string;
  type: SceneType;
  label?: string;
  createdAt: number;
  lastUpdatedAt: number;
  entries: ObservationMemory[]; // 最新在末尾
}

/** 容量与过期上限，从配置热读。总条数由 maxScenes × maxEntriesPerScene 约束。 */
export interface MemoryLimits {
  maxScenes: number;
  maxEntriesPerScene: number;
  maxTurns: number;
  ttlMs: number;
}

export interface RecordInput {
  observationId?: string;
  sceneType?: SceneType | string;
  sceneLabel?: string;
  summary: string;
}

export type RecordResult =
  | { outcome: 'skipped'; reason: 'empty' | 'tooShort' }
  | { outcome: 'added'; sceneId: string; sceneType: SceneType; sceneLabel?: string }
  | { outcome: 'updated'; sceneId: string; sceneType: SceneType; sceneLabel?: string };

/** 短于该长度的摘要视为噪声，不记。 */
const MIN_SUMMARY_LENGTH = 4;
/** 摘要单条最大长度（汉字），超出截断，避免注入上下文膨胀。 */
const MAX_SUMMARY_LENGTH = 200;
/** 场景标签最大长度。 */
const MAX_LABEL_LENGTH = 60;

function normLabel(label: string): string {
  return label.trim().toLowerCase();
}

function normalizeSceneType(raw: SceneType | string | undefined): SceneType {
  if (raw && SCENE_TYPES.includes(raw as SceneType)) return raw as SceneType;
  return 'unknown';
}

export class MemoryManager {
  private scenes: Scene[] = [];
  private seq = 0;

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  /** 记录（或更新）一条摘要；空/过短摘要不记。 */
  record(input: RecordInput, limits: MemoryLimits, turn: number, now: number): RecordResult {
    const summary = (input.summary ?? '').trim().slice(0, MAX_SUMMARY_LENGTH);
    if (!summary) return { outcome: 'skipped', reason: 'empty' };
    if (summary.length < MIN_SUMMARY_LENGTH) return { outcome: 'skipped', reason: 'tooShort' };

    const sceneType = normalizeSceneType(input.sceneType);
    const sceneLabel = (input.sceneLabel ?? '').trim().slice(0, MAX_LABEL_LENGTH) || undefined;

    let scene = this.findScene(sceneLabel, sceneType);
    if (!scene) {
      scene = this.createScene(sceneType, sceneLabel, now);
      this.scenes.push(scene);
    }

    // 同一截图（observationId 相同）重复记录时，更新最近一条而非新增，避免连续滚动刷屏。
    const last = scene.entries[scene.entries.length - 1];
    if (input.observationId && last && last.observationId === input.observationId) {
      last.summary = summary;
      last.sceneType = sceneType;
      if (sceneLabel) last.sceneLabel = sceneLabel;
      last.observedAt = now;
      last.createdTurn = turn;
      scene.lastUpdatedAt = now;
      return { outcome: 'updated', sceneId: scene.id, sceneType, sceneLabel };
    }

    scene.entries.push({
      id: this.nextId('mem'),
      observationId: input.observationId ?? this.nextId('obs'),
      sceneId: scene.id,
      sceneType,
      sceneLabel,
      summary,
      observedAt: now,
      createdTurn: turn,
    });
    scene.lastUpdatedAt = now;
    this.trim(limits);
    return { outcome: 'added', sceneId: scene.id, sceneType, sceneLabel };
  }

  /** 定位/切回场景：给了 label 按 label 精确匹配；没给 label 按最近活跃的同 type 场景。 */
  private findScene(label: string | undefined, type: SceneType): Scene | undefined {
    if (label) {
      const n = normLabel(label);
      const byLabel = this.scenes.find((s) => s.label && normLabel(s.label) === n);
      if (byLabel) return byLabel;
      // label 未命中 = 换了一本书/一个项目，不 fallback 到同 type 的旧场景。
      return undefined;
    }
    const byType = this.scenes
      .filter((s) => s.type === type)
      .sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt)[0];
    return byType;
  }

  private createScene(type: SceneType, label: string | undefined, now: number): Scene {
    return { id: this.nextId('scene'), type, label, createdAt: now, lastUpdatedAt: now, entries: [] };
  }

  /** 容量裁剪：每场景条数、场景数，超出截最旧；总条数由两者乘积约束。 */
  private trim(limits: MemoryLimits): void {
    for (const scene of this.scenes) {
      while (scene.entries.length > limits.maxEntriesPerScene) scene.entries.shift();
    }
    this.scenes = this.scenes.filter((s) => s.entries.length > 0);
    this.scenes.sort((a, b) => a.lastUpdatedAt - b.lastUpdatedAt);
    while (this.scenes.length > limits.maxScenes) this.scenes.shift();
  }

  private isExpired(entry: ObservationMemory, turn: number, now: number, limits: MemoryLimits): boolean {
    if (turn - entry.createdTurn >= limits.maxTurns) return true;
    if (now - entry.observedAt >= limits.ttlMs) return true;
    return false;
  }

  /** 推进一轮并清理过期条目。 */
  advanceTurn(turn: number, now: number, limits: MemoryLimits): void {
    for (const scene of this.scenes) {
      scene.entries = scene.entries.filter((e) => !this.isExpired(e, turn, now, limits));
    }
    this.scenes = this.scenes.filter((s) => s.entries.length > 0);
  }

  /** 当前场景（最近活跃）。 */
  currentScene(): Scene | undefined {
    return this.scenes.slice().sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt)[0];
  }

  /** 读取当前/指定场景的有效摘要，最新在前。 */
  recent(sceneId: string | undefined, turn: number, now: number, limits: MemoryLimits): ObservationMemory[] {
    this.advanceTurn(turn, now, limits);
    const target = sceneId ? this.scenes.find((s) => s.id === sceneId) : this.currentScene();
    if (!target) return [];
    return [...target.entries].reverse();
  }

  listScenes(): Scene[] {
    return [...this.scenes];
  }

  clear(): void {
    this.scenes = [];
  }
}
