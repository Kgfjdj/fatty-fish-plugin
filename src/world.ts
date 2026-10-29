/**
 * 屏幕陪伴桌宠 World：
 * - 自动观察：按配置的间隔定期截屏，画面变化超过阈值时，把截图作为图片附件通过 pushEvent 交给宿主多模态模型，桌宠主动开口。
 * - 手动触发：screen_companion_look_now 工具截屏并把截图交给模型，回答用户的问题。
 * - 短期观察记忆：模型理解截图后，通过 screen_companion_memory_record 把简短摘要写回，
 *   之后每次观察的正文会附上最近的摘要，帮助桌宠连续讨论；约若干轮后自动淡出。
 * 不限定具体应用，不预设用户在看什么。
 */
import { fileURLToPath } from 'node:url';
import { nowIso } from 'cortico/core/util.ts';
import type { EventEnvelope, ToolDef, ToolOutcome, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { DeepPartial } from 'cortico/world.ts';
import {
  SCREEN_COMPANION_CONFIG_GROUP,
  SCREEN_COMPANION_MEMORY_CONFIG_GROUP,
  SCREEN_COMPANION_ID,
  type ActivityLevel,
  type ScreenCompanionConfigSection,
  type ScreenRegion,
} from './config.ts';
import { captureRegion, captureScreen, frameInfo, resizeToMaxWidth, selectRegion, type CapturedFrame } from './capture.ts';
import { MotionSentinel } from './sentinel.ts';
import { MemoryManager, SCENE_TYPE_LABEL, type MemoryLimits } from './memory.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** 把截图推给模型时的开口引导，随活跃度调整。 */
export const ACTIVITY_NUDGE: Record<ActivityLevel, string> = {
  安静: '当前活跃度为「安静」：除非画面里确有重要、值得说的内容，否则保持安静陪伴。',
  适中: '当前活跃度为「适中」：有值得说的就自然开口，不刻意找话，也不刻意沉默。',
  活跃: '当前活跃度为「活跃」：尽量主动开口，哪怕只是聊两句你看到的、或一个小小的感想，别冷场。',
};

export interface ScreenCompanionWorldOptions {
  /** `worlds.screen-companion` 的活引用。 */
  cfg: ScreenCompanionConfigSection;
  timezone: string;
  /** 整屏截屏实现，测试可注入假实现。 */
  capture?: (screen?: string) => Promise<CapturedFrame>;
  /** 区域截屏实现，测试可注入假实现。 */
  captureRegion?: (region: ScreenRegion) => Promise<CapturedFrame>;
  /** 弹出框选界面的实现，测试可注入假实现。 */
  selectRegion?: () => Promise<ScreenRegion | null>;
  /** 把配置补丁持久化（并同步活引用）；缺省直接改活引用。 */
  persist?: (patch: DeepPartial<ScreenCompanionConfigSection>) => void;
  /** 当前模型是否接受图片附件，测试可注入；缺省读 host.modelFacts。 */
  acceptsImage?: () => boolean;
  /** 时钟，测试可注入。 */
  now?: () => number;
}

/** 全部工具的声明；定义里的 describe 与 `tools()` 都取它。 */
export const SCREEN_COMPANION_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'screen_companion_look_now',
    description:
      'Take a fresh screenshot of the user\'s current screen and attach it to the receipt so you can see what they are looking at right now and answer their question about it. Use it when the user asks you to look at their screen, explain some text on it, or comment on the page they are viewing. Pass their question as `question` when there is one.',
    tags: ['read', 'snapshot'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        question: {
          type: 'string',
          description: 'Optional question from the user about the current screen, e.g. "帮我解释屏幕上的这段文字".',
        },
      },
    },
  },
  {
    name: 'screen_companion_select_region',
    description:
      'Popup a full-screen overlay so the user can drag to select a rectangular region of the screen; afterwards the companion will capture only that region. Use it when the user wants you to watch just part of the screen. The user finishes by releasing the mouse, or cancels with Escape.',
    tags: ['act', 'write'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'screen_companion_clear_region',
    description:
      'Clear the selected capture region and switch back to capturing the full screen. Use it when the user no longer wants to limit the watched area.',
    tags: ['write'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'screen_companion_memory_record',
    description:
      'Save a short structured summary of what you just saw in a screenshot into the companion\'s short-term memory, so later observations can continue the same book/video/project without losing the thread. Call it after you actually look at a screenshot and find content worth remembering — even if you choose not to comment on it. Pass the `observationId` shown in the screenshot text when present; otherwise omit it and the summary is associated with the most recent observation.',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['summary'],
      properties: {
        summary: {
          type: 'string',
          description: 'A concise summary of the meaningful content in this frame (about 50-180 Chinese characters).',
        },
        sceneType: {
          type: 'string',
          description: 'Scene kind: reading / video / coding / web / other / unknown. Defaults to unknown.',
        },
        sceneLabel: {
          type: 'string',
          description: 'Optional book/video/project name if recognizable; omit it instead of guessing.',
        },
        observationId: {
          type: 'string',
          description: 'Optional observation id shown in the screenshot text; omit to attach to the latest observation.',
        },
      },
    },
  },
  {
    name: 'screen_companion_memory_recent',
    description:
      'Read the currently valid short-term observation summaries (latest first) for the current scene, so you can recall what the user was just reading/watching/coding before continuing the conversation.',
    tags: ['read', 'snapshot'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sceneId: { type: 'string', description: 'Optional scene id; omit for the current scene.' },
      },
    },
  },
  {
    name: 'screen_companion_memory_clear',
    description:
      'Clear all short-term observation memory of this companion. Use it when the user wants to forget the recent screen observations.',
    tags: ['write'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
];

export class ScreenCompanionWorld implements World {
  readonly id = SCREEN_COMPANION_ID;

  private host: WorldHost | null = null;
  private readonly sentinel = new MotionSentinel();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private lastPushAt = 0;
  private readonly memory = new MemoryManager();
  private observationSeq = 0;
  private lastObservationId: string | null = null;
  private lastTurnCursor = 0;
  private currentTurn = 0;

  constructor(private readonly opts: ScreenCompanionWorldOptions) {}

  private get cfg(): ScreenCompanionConfigSection {
    return this.opts.cfg;
  }

  private get captureImpl(): (screen?: string) => Promise<CapturedFrame> {
    return this.opts.capture ?? captureScreen;
  }

  private get captureRegionImpl(): (region: ScreenRegion) => Promise<CapturedFrame> {
    return this.opts.captureRegion ?? captureRegion;
  }

  private get selectRegionImpl(): () => Promise<ScreenRegion | null> {
    return this.opts.selectRegion ?? selectRegion;
  }

  private persist(patch: DeepPartial<ScreenCompanionConfigSection>): void {
    if (this.opts.persist) this.opts.persist(patch);
    else Object.assign(this.cfg, patch);
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private memoryLimits(): MemoryLimits {
    return {
      maxScenes: this.cfg.memoryMaxScenes,
      maxEntriesPerScene: this.cfg.memoryMaxEntriesPerScene,
      maxTurns: this.cfg.memoryMaxTurns,
      ttlMs: this.cfg.memoryTtlMinutes * 60_000,
    };
  }

  private nextObservationId(): string {
    this.observationSeq += 1;
    return `obs-${this.observationSeq}`;
  }

  /** 按当前截图模式截一帧：自定义区域时只取框选矩形，否则整屏。 */
  private async captureCurrent(): Promise<CapturedFrame> {
    const screen = this.cfg.screen.trim() || undefined;
    const region = this.cfg.region;
    if (this.cfg.captureMode === '自定义区域' && region) {
      return this.captureRegionImpl(region);
    }
    return this.captureImpl(screen);
  }

  envPromptVars(): Record<string, string> {
    const r = this.cfg.region;
    return {
      'screenCompanion.screen': this.cfg.screen.trim() || '主显示器',
      'screenCompanion.maxWidth': String(this.cfg.maxWidth),
      'screenCompanion.autoObserve': this.cfg.autoObserve ? '开启' : '关闭',
      'screenCompanion.captureIntervalMs': String(this.cfg.captureIntervalMs),
      'screenCompanion.activity': this.cfg.activity,
      'screenCompanion.captureMode': this.cfg.captureMode,
      'screenCompanion.region': r ? `(${r.x}, ${r.y}) ${r.width}×${r.height}` : '无（整屏）',
      'screenCompanion.shortMemoryEnabled': this.cfg.shortMemoryEnabled ? '开启' : '关闭',
      'screenCompanion.memoryMaxTurns': String(this.cfg.memoryMaxTurns),
      'screenCompanion.memoryTtlMinutes': String(this.cfg.memoryTtlMinutes),
    };
  }

  tools(): ToolDef[] {
    return SCREEN_COMPANION_TOOL_DECLS.map((decl) => {
      if (decl.name === 'screen_companion_look_now') {
        return { ...decl, handler: async (args: Record<string, unknown>) => this.lookNow(args) };
      }
      if (decl.name === 'screen_companion_select_region') {
        return { ...decl, handler: () => this.selectRegionTool() };
      }
      if (decl.name === 'screen_companion_clear_region') {
        return { ...decl, handler: () => this.clearRegionTool() };
      }
      if (decl.name === 'screen_companion_memory_record') {
        return { ...decl, handler: async (args: Record<string, unknown>) => this.memoryRecordTool(args) };
      }
      if (decl.name === 'screen_companion_memory_recent') {
        return { ...decl, handler: async (args: Record<string, unknown>) => this.memoryRecentTool(args) };
      }
      return { ...decl, handler: async () => this.memoryClearTool() };
    });
  }

  webUi(): WorldWebUiDecl {
    return {
      lamps: [
        {
          label: '屏幕观察',
          state: this.host ? (this.cfg.autoObserve ? 'online' : 'offline') : 'offline',
          hint: this.cfg.autoObserve
            ? `每 ${this.cfg.captureIntervalMs}ms 盯屏，${this.cfg.screen.trim() ? `显示器 ${this.cfg.screen.trim()}` : '主显示器'}，${this.cfg.captureMode}，活跃度${this.cfg.activity}`
            : '自动观察关闭，仅手动触发',
        },
      ],
      config: [SCREEN_COMPANION_CONFIG_GROUP, SCREEN_COMPANION_MEMORY_CONFIG_GROUP],
      promptDocs: [
        {
          key: `worlds.${SCREEN_COMPANION_ID}.envPrompt`,
          title: '屏幕陪伴桌宠 · 环境提示词',
          description: '屏幕陪伴桌宠 World 进 system 前缀的那一段。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'screenCompanion.screen', description: '当前截取的显示器（主屏或显示器 id）。' },
            { name: 'screenCompanion.maxWidth', description: '截图最大宽度（像素）。' },
            { name: 'screenCompanion.autoObserve', description: '自动观察是否开启。' },
            { name: 'screenCompanion.captureIntervalMs', description: '自动观察的轮询间隔（毫秒）。' },
            { name: 'screenCompanion.activity', description: '当前活跃度（安静 / 适中 / 活跃）。' },
            { name: 'screenCompanion.captureMode', description: '当前截图模式（全屏 / 自定义区域）。' },
            { name: 'screenCompanion.region', description: '自定义区域坐标（x, y, width, height）。' },
            { name: 'screenCompanion.shortMemoryEnabled', description: '短期观察记忆是否开启。' },
            { name: 'screenCompanion.memoryMaxTurns', description: '摘要保留的轮数上限。' },
            { name: 'screenCompanion.memoryTtlMinutes', description: '摘要保留的时间上限（分钟）。' },
          ],
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    // 轮数计数从当前事件尾开始，不回灌历史。
    try {
      this.lastTurnCursor = host.store?.latestCursor?.() ?? 0;
    } catch {
      this.lastTurnCursor = 0;
    }
    await host.pushEvent({
      type: 'screen_companion.started',
      ts: nowIso(this.opts.timezone),
      source: this.id,
      origin: 'internal',
      senderKey: this.id,
      text: this.cfg.autoObserve
        ? `屏幕陪伴桌宠已挂载：每 ${this.cfg.captureIntervalMs}ms 观察一次画面，变化超过阈值时把截图交给模型；${this.cfg.captureMode}；活跃度${this.cfg.activity}；screen_companion_look_now 可用。`
        : `屏幕陪伴桌宠已挂载：自动观察关闭；${this.cfg.captureMode}；活跃度${this.cfg.activity}；screen_companion_look_now 可用。`,
    });
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.host = null;
    this.sentinel.reset();
  }

  /**
   * 一轮结束（assistant 自然结束 / LLM 失败 / 达到轮数上限）。这里数「真实用户回合」：
   * 扫本轮新增事件，出现「非本插件产生的外部事件」才算一次真人回合，避免自动观察唤醒被误算。
   */
  onTurnEnded(): void {
    if (!this.cfg.shortMemoryEnabled) return;
    const store = this.host?.store;
    if (!store) return;
    let to = 0;
    try {
      to = store.latestCursor?.() ?? 0;
    } catch {
      return;
    }
    if (!Number.isFinite(to) || to <= this.lastTurnCursor) return;
    let events: EventEnvelope[] = [];
    try {
      events = store.range({ fromCursor: this.lastTurnCursor + 1, toCursor: to }) ?? [];
    } catch {
      return;
    }
    this.lastTurnCursor = to;
    const hasUserInput = events.some((e) => e.origin === 'external' && e.source !== this.id);
    if (hasUserInput) {
      this.currentTurn += 1;
      this.memory.advanceTurn(this.currentTurn, this.now(), this.memoryLimits());
    }
  }

  /** 哨兵主循环：定期截屏比对，变化明显且冷却允许时把截图推给模型。 */
  private scheduleNext(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.tick().catch((error) => {
        this.host?.log.warn('屏幕陪伴哨兵这一轮失败', { err: String(error) });
      });
      this.scheduleNext();
    }, Math.max(1000, this.cfg.captureIntervalMs));
  }

  private async tick(): Promise<void> {
    if (!this.host || !this.cfg.autoObserve || this.busy) return;
    // 模型无法处理图像时不自动推，避免只推 fallbackText 的空话。
    if (!this.acceptsImage()) return;
    this.busy = true;
    try {
      const frame = await this.captureCurrent();
      const ratio = await this.sentinel.ingest(frame.bytes);
      if (ratio < this.cfg.motionThreshold) return;
      if (this.now() - this.lastPushAt < this.cfg.pushCooldownMs) return;

      const resized = await resizeToMaxWidth(frame, this.cfg.maxWidth);
      const info = await frameInfo(resized);
      const screenLabel = this.cfg.screen.trim() ? `显示器 ${this.cfg.screen.trim()}` : '主显示器';
      const observationId = this.nextObservationId();
      this.lastObservationId = observationId;
      this.lastPushAt = this.now();
      await this.host.pushEvent(
        {
          type: 'screen_companion.observed',
          ts: nowIso(this.opts.timezone),
          source: this.id,
          origin: 'external',
          senderKey: this.id,
          text:
            `用户当前屏幕（${screenLabel}）画面有了变化，这是刚刚截取的一帧（观察 ID：${observationId}）。` +
            `${ACTIVITY_NUDGE[this.cfg.activity]}这只是此刻的一次观察，不代表用户完整的浏览或阅读历史。` +
            this.buildMemoryContext(),
          blobs: [
            {
              bytes: resized.bytes,
              mime: resized.mime,
              name: 'screen.jpg',
              fallbackText: `当前屏幕截图（${info.width}×${info.height}）`,
            },
          ],
        },
        { trigger: 'debounce' },
      );
    } finally {
      this.busy = false;
    }
  }

  /** screen_companion_look_now：截一张当前屏幕，作为图片附件交给宿主模型。 */
  private async lookNow(args: Record<string, unknown>): Promise<ToolOutcome> {
    if (!this.host) return fail('World 未挂载，无法截图。');
    const question = typeof args.question === 'string' && args.question.trim() ? args.question.trim() : undefined;

    // 当前模型无法处理图像时，给出明确说明，而不是让宿主把截图降级成一段文字。
    if (!this.acceptsImage()) {
      return fail('当前模型无法处理图像（image/jpeg），截图没法被理解。请切换到支持视觉能力的多模态模型。');
    }

    try {
      const frame = await this.captureCurrent();
      const resized = await resizeToMaxWidth(frame, this.cfg.maxWidth);
      const info = await frameInfo(resized);
      const screenLabel = this.cfg.screen.trim() ? `显示器 ${this.cfg.screen.trim()}` : '主显示器';
      const observationId = this.nextObservationId();
      this.lastObservationId = observationId;
      const head = question ? `用户的问题：「${question}」` : '用户请桌宠看一眼当前屏幕。';
      const text =
        `${head}\n` +
        `以下是当前屏幕的一次截图（${info.width}×${info.height}，${screenLabel}，观察 ID：${observationId}）。` +
        '这只是此刻的一次观察，不代表用户完整的浏览或阅读历史；请只根据画面与上下文回答。' +
        this.buildMemoryContext();
      return {
        text,
        blobs: [
          {
            bytes: resized.bytes,
            mime: resized.mime,
            name: 'screen.jpg',
            fallbackText: `当前屏幕截图（${info.width}×${info.height}）`,
          },
        ],
      };
    } catch (error) {
      return fail(`截图失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** screen_companion_select_region：弹出全屏遮罩让用户框选，保存区域并切到自定义区域模式。 */
  private async selectRegionTool(): Promise<ToolOutcome> {
    if (!this.host) return fail('World 未挂载，无法框选。');
    try {
      const region = await this.selectRegionImpl();
      if (!region) {
        return { text: '已取消框选，截图区域未改变。' };
      }
      this.persist({ captureMode: '自定义区域', region });
      return {
        text: `已保存截图区域：从 (${region.x}, ${region.y}) 开始，宽 ${region.width}、高 ${region.height} 像素。之后的自动观察与手动截图都只取这块区域。可再次框选，或调用 screen_companion_clear_region 恢复全屏。`,
      };
    } catch (error) {
      return fail(`框选失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** screen_companion_clear_region：清除区域，恢复全屏截图。 */
  private async clearRegionTool(): Promise<ToolOutcome> {
    if (!this.host) return fail('World 未挂载，无法清除区域。');
    this.persist({ captureMode: '全屏', region: null });
    return { text: '已取消自定义区域，恢复全屏截图。' };
  }

  /** screen_companion_memory_record：把模型对当前截图的摘要写回短期记忆。 */
  private async memoryRecordTool(args: Record<string, unknown>): Promise<ToolOutcome> {
    if (!this.host) return fail('World 未挂载，无法记录记忆。');
    if (!this.cfg.shortMemoryEnabled) return { text: '短期记忆已关闭，未记录。' };
    const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
    if (!summary) return fail('缺少 summary（本次画面的内容摘要）。');
    const observationId =
      typeof args.observationId === 'string' && args.observationId.trim()
        ? args.observationId.trim()
        : (this.lastObservationId ?? undefined);
    const result = this.memory.record(
      {
        observationId,
        sceneType: typeof args.sceneType === 'string' ? args.sceneType : undefined,
        sceneLabel: typeof args.sceneLabel === 'string' ? args.sceneLabel : undefined,
        summary,
      },
      this.memoryLimits(),
      this.currentTurn,
      this.now(),
    );
    if (result.outcome === 'skipped') {
      return fail(result.reason === 'empty' ? '摘要为空，未记录。' : '摘要过短，未记录。');
    }
    const label = result.sceneLabel ? `「${result.sceneLabel}」` : SCENE_TYPE_LABEL[result.sceneType];
    const verb = result.outcome === 'updated' ? '已更新' : '已记录';
    return { text: `${verb}短期观察摘要（场景 ${label}，观察 ${observationId ?? '最近一次'}）：${summary.slice(0, 80)}` };
  }

  /** screen_companion_memory_recent：读取当前/指定场景的有效摘要。 */
  private async memoryRecentTool(args: Record<string, unknown>): Promise<ToolOutcome> {
    if (!this.host) return fail('World 未挂载，无法读取记忆。');
    if (!this.cfg.shortMemoryEnabled) return { text: '短期记忆已关闭。' };
    const sceneId = typeof args.sceneId === 'string' && args.sceneId.trim() ? args.sceneId.trim() : undefined;
    const entries = this.memory.recent(sceneId, this.currentTurn, this.now(), this.memoryLimits());
    if (!entries.length) return { text: '短期记忆为空（或已全部过期）。' };
    const lines = entries.map((e) => {
      const label = e.sceneLabel ? `《${e.sceneLabel}》` : SCENE_TYPE_LABEL[e.sceneType];
      return `- [${label}] ${e.summary}`;
    });
    return { text: `当前短期记忆（${entries.length} 条，最新在前）：\n${lines.join('\n')}` };
  }

  /** screen_companion_memory_clear：清空本插件短期记忆。 */
  private async memoryClearTool(): Promise<ToolOutcome> {
    if (!this.host) return fail('World 未挂载，无法清空记忆。');
    this.memory.clear();
    this.lastObservationId = null;
    return { text: '已清空短期观察记忆。' };
  }

  /** 当前场景最近摘要的注入文本；关闭或为空时返回空串。 */
  private buildMemoryContext(): string {
    if (!this.cfg.shortMemoryEnabled) return '';
    const entries = this.memory.recent(undefined, this.currentTurn, this.now(), this.memoryLimits());
    if (!entries.length) return '';
    const lines = entries.slice(0, 3).map((e) => {
      const label = e.sceneLabel ? `《${e.sceneLabel}》` : SCENE_TYPE_LABEL[e.sceneType];
      return `- ${label}：${e.summary}`;
    });
    const text = lines.join('\n');
    const capped = text.length > 800 ? `${text.slice(0, 800)}…` : text;
    return `\n[短期观察记忆] 你此前看过（供连续讨论，不确定处用「可能/似乎」表达）：\n${capped}`;
  }

  private acceptsImage(): boolean {
    if (this.opts.acceptsImage) return this.opts.acceptsImage();
    try {
      return this.host?.modelFacts.accepts('image/jpeg') ?? true;
    } catch {
      // 未选端点或端点异常时先放行，宿主渲染层会自行降级为 fallbackText。
      return true;
    }
  }
}

function fail(text: string): ToolOutcome {
  return { text, failed: true };
}
