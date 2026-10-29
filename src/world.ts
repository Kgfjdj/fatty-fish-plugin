/**
 * 屏幕陪伴桌宠 World：
 * - 自动观察：按配置的间隔定期截屏，画面变化超过阈值时，把截图作为图片附件通过 pushEvent 交给宿主多模态模型，桌宠主动开口。
 * - 手动触发：screen_companion_look_now 工具截屏并把截图交给模型，回答用户的问题。
 * 不限定具体应用，不预设用户在看什么。
 */
import { fileURLToPath } from 'node:url';
import { nowIso } from 'cortico/core/util.ts';
import type { ToolDef, ToolOutcome, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { SCREEN_COMPANION_CONFIG_GROUP, SCREEN_COMPANION_ID, type ScreenCompanionConfigSection } from './config.ts';
import { captureScreen, frameInfo, resizeToMaxWidth, type CapturedFrame } from './capture.ts';
import { MotionSentinel } from './sentinel.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** 自动观察两次推送给模型的最小间隔，避免视频等持续变化场景下太吵。 */
export const MIN_PUSH_INTERVAL_MS = 20_000;

export interface ScreenCompanionWorldOptions {
  /** `worlds.screen-companion` 的活引用。 */
  cfg: ScreenCompanionConfigSection;
  timezone: string;
  /** 截屏实现，测试可注入假实现。 */
  capture?: (screen?: string) => Promise<CapturedFrame>;
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
];

export class ScreenCompanionWorld implements World {
  readonly id = SCREEN_COMPANION_ID;

  private host: WorldHost | null = null;
  private readonly sentinel = new MotionSentinel();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private lastPushAt = 0;

  constructor(private readonly opts: ScreenCompanionWorldOptions) {}

  private get cfg(): ScreenCompanionConfigSection {
    return this.opts.cfg;
  }

  private get capture(): (screen?: string) => Promise<CapturedFrame> {
    return this.opts.capture ?? captureScreen;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  envPromptVars(): Record<string, string> {
    return {
      'screenCompanion.screen': this.cfg.screen.trim() || '主显示器',
      'screenCompanion.maxWidth': String(this.cfg.maxWidth),
      'screenCompanion.autoObserve': this.cfg.autoObserve ? '开启' : '关闭',
      'screenCompanion.captureIntervalMs': String(this.cfg.captureIntervalMs),
    };
  }

  tools(): ToolDef[] {
    return [
      {
        ...SCREEN_COMPANION_TOOL_DECLS[0],
        handler: async (args) => this.lookNow(args),
      },
    ];
  }

  webUi(): WorldWebUiDecl {
    return {
      lamps: [
        {
          label: '屏幕观察',
          state: this.host ? (this.cfg.autoObserve ? 'online' : 'offline') : 'offline',
          hint: this.cfg.autoObserve
            ? `每 ${this.cfg.captureIntervalMs}ms 盯屏，${this.cfg.screen.trim() ? `显示器 ${this.cfg.screen.trim()}` : '主显示器'}`
            : '自动观察关闭，仅手动触发',
        },
      ],
      config: [SCREEN_COMPANION_CONFIG_GROUP],
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
          ],
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    await host.pushEvent({
      type: 'screen_companion.started',
      ts: nowIso(this.opts.timezone),
      source: this.id,
      origin: 'internal',
      senderKey: this.id,
      text: this.cfg.autoObserve
        ? `屏幕陪伴桌宠已挂载：每 ${this.cfg.captureIntervalMs}ms 观察一次画面，变化超过阈值时把截图交给模型；screen_companion_look_now 可用。`
        : '屏幕陪伴桌宠已挂载：自动观察关闭，screen_companion_look_now 可用。',
    });
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.host = null;
    this.sentinel.reset();
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
      const frame = await this.capture(this.cfg.screen.trim() || undefined);
      const ratio = await this.sentinel.ingest(frame.bytes);
      if (ratio < this.cfg.motionThreshold) return;
      if (this.now() - this.lastPushAt < MIN_PUSH_INTERVAL_MS) return;

      const resized = await resizeToMaxWidth(frame, this.cfg.maxWidth);
      const info = await frameInfo(resized);
      const screenLabel = this.cfg.screen.trim() ? `显示器 ${this.cfg.screen.trim()}` : '主显示器';
      this.lastPushAt = this.now();
      await this.host.pushEvent(
        {
          type: 'screen_companion.observed',
          ts: nowIso(this.opts.timezone),
          source: this.id,
          origin: 'external',
          senderKey: this.id,
          text:
            `用户当前屏幕（${screenLabel}）画面有了变化，这是刚刚截取的一帧。` +
            '请观察画面：如果里面有值得你回应、或用户可能想讨论的内容，就自然地开口；否则保持安静。' +
            '这只是此刻的一次观察，不代表用户完整的浏览或阅读历史。',
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
      const frame = await this.capture(this.cfg.screen.trim() || undefined);
      const resized = await resizeToMaxWidth(frame, this.cfg.maxWidth);
      const info = await frameInfo(resized);
      const screenLabel = this.cfg.screen.trim() ? `显示器 ${this.cfg.screen.trim()}` : '主显示器';
      const head = question ? `用户的问题：「${question}」` : '用户请桌宠看一眼当前屏幕。';
      const text =
        `${head}\n` +
        `以下是当前屏幕的一次截图（${info.width}×${info.height}，${screenLabel}）。` +
        '这只是此刻的一次观察，不代表用户完整的浏览或阅读历史；请只根据画面与上下文回答。';
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
