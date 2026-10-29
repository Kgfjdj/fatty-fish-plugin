import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { WorldSection } from 'cortico/world.ts';

export const SCREEN_COMPANION_ID = 'screen-companion';

/** 桌宠活跃度：安静 / 适中 / 活跃。 */
export type ActivityLevel = '安静' | '适中' | '活跃';

/** 截图模式：整屏或自定义区域。 */
export type CaptureMode = '全屏' | '自定义区域';

/** 自定义截图区域（物理像素坐标）。 */
export interface ScreenRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** config.json 的 worlds.screen-companion 段，默认禁用；由部署或操作者启用。全部键热改生效。 */
export interface ScreenCompanionConfigSection extends WorldSection {
  /** 截屏的显示器 id（系统 DeviceName，如 \\.\DISPLAY2），空串 = 主屏；热改。 */
  screen: string;
  /** 截图最大宽度（像素），超过时等比缩小以节省视觉 token；热改。 */
  maxWidth: number;
  /** 自动观察开关：开启后按固定间隔盯屏幕，画面变化时把截图推给模型；热改。 */
  autoObserve: boolean;
  /** 自动观察的截屏轮询间隔（毫秒）；只比对画面，不调用模型；热改。 */
  captureIntervalMs: number;
  /** 画面变化比例阈值（0-1），超过才把截图推给模型；调大更省调用，调小更灵敏；热改。 */
  motionThreshold: number;
  /** 桌宠活跃度：安静 / 适中 / 活跃，注入环境提示词调节主动开口的频繁程度；热改。 */
  activity: ActivityLevel;
  /** 两次把截图交给模型之间的最小间隔（毫秒），防止画面持续变化时太吵；热改。 */
  pushCooldownMs: number;
  /** 截图模式：全屏或自定义区域；热改。 */
  captureMode: CaptureMode;
  /** 自定义截图区域（物理像素坐标）；仅 captureMode=自定义区域 时使用；由框选工具写入，热改。 */
  region: ScreenRegion | null;
  /** 短期观察记忆开关：开启后把每次被模型理解的截图整理成摘要，供后续观察连续接续；关闭则不记录、不注入；热改。 */
  shortMemoryEnabled: boolean;
  /** 每条摘要产生多少轮真实用户回合后从短期记忆移除；热改。 */
  memoryMaxTurns: number;
  /** 每条摘要的最长保留时间（分钟），防止用户不聊天时记忆无限存在；热改。 */
  memoryTtlMinutes: number;
  /** 每个场景最多保留的摘要条数；热改。 */
  memoryMaxEntriesPerScene: number;
  /** 最多保留的场景数；热改。 */
  memoryMaxScenes: number;
}

export const SCREEN_COMPANION_DEFAULTS: ScreenCompanionConfigSection = {
  enabled: false,
  screen: '',
  maxWidth: 1920,
  autoObserve: true,
  captureIntervalMs: 3000,
  motionThreshold: 0.05,
  activity: '适中',
  pushCooldownMs: 20000,
  captureMode: '全屏',
  region: null,
  shortMemoryEnabled: true,
  memoryMaxTurns: 10,
  memoryTtlMinutes: 60,
  memoryMaxEntriesPerScene: 5,
  memoryMaxScenes: 3,
};

const K = `worlds.${SCREEN_COMPANION_ID}`;

/** World 配置的 JSON Schema 声明。 */
export const SCREEN_COMPANION_CONFIG_GROUP: ConfigGroup = {
  id: `world:${SCREEN_COMPANION_ID}`,
  owner: `world:${SCREEN_COMPANION_ID}`,
  schema: {
    type: 'object',
    title: '截图与观察',
    description: '桌宠定期观察当前屏幕，画面变化时把截图作为图片附件交给支持视觉的模型，理解并自然回应用户；也可被用户主动叫去看一眼。',
    properties: {
      [`${K}.screen`]: {
        type: 'string',
        title: '显示器',
        description: '截取哪台显示器。留空为主屏；多屏填系统显示 id（如 \\\\.\\DISPLAY2）。',
        'x-hot': true,
      },
      [`${K}.maxWidth`]: {
        type: 'integer',
        title: '截图最大宽度',
        description: '超过该宽度时等比缩小，控制视觉模型的 token 成本；默认 1920 保持 1080p 原分辨率，中文文字清晰可读。',
        minimum: 640,
        maximum: 3840,
        'x-suffix': 'px',
        'x-hot': true,
      },
      [`${K}.autoObserve`]: {
        type: 'boolean',
        title: '自动观察',
        description: '开启后按「轮询间隔」定期截屏，画面变化超过阈值时把截图交给模型，桌宠主动开口；关闭后只能靠用户主动请求触发 screen_companion_look_now。',
        'x-hot': true,
      },
      [`${K}.captureIntervalMs`]: {
        type: 'integer',
        title: '轮询间隔',
        description: '自动观察的截屏间隔，秒。只比对画面变化，不调用模型，成本很低。',
        minimum: 1000,
        maximum: 60000,
        'x-scale': 1000,
        'x-suffix': 's',
        'x-hot': true,
      },
      [`${K}.motionThreshold`]: {
        type: 'number',
        title: '画面变化阈值',
        description: '降采样画面上变化像素的占比超过该值才把截图推给模型。调大更省调用、更安静，调小更灵敏。',
        minimum: 0.01,
        maximum: 0.5,
        'x-hot': true,
      },
      [`${K}.activity`]: {
        type: 'string',
        enum: ['安静', '适中', '活跃'],
        title: '活跃度',
        description: '桌宠主动开口的频繁程度，注入环境提示词调节：安静只在确有重要内容时开口；适中有值得说的就自然开口；活跃尽量主动找话题。',
        'x-hot': true,
      },
      [`${K}.pushCooldownMs`]: {
        type: 'integer',
        title: '推送冷却',
        description: '两次把截图交给模型之间的最小间隔，秒。画面持续变化（如视频、连续翻页）时防止桌宠过于频繁开口。',
        minimum: 3000,
        maximum: 120000,
        'x-scale': 1000,
        'x-suffix': 's',
        'x-hot': true,
      },
      [`${K}.captureMode`]: {
        type: 'string',
        enum: ['全屏', '自定义区域'],
        title: '截图模式',
        description: '全屏：截取整个显示器；自定义区域：只截取你框选的那块矩形。切到「自定义区域」后，直接跟桌宠说「帮我框选一块区域」就会弹出框选；恢复全屏可说「取消区域」，或切回「全屏」。',
        'x-hot': true,
      },
    },
  },
};

/** 短期观察记忆的配置组：与截图/观察分开，独立成一块。 */
export const SCREEN_COMPANION_MEMORY_CONFIG_GROUP: ConfigGroup = {
  id: `world:${SCREEN_COMPANION_ID}.memory`,
  owner: `world:${SCREEN_COMPANION_ID}`,
  schema: {
    type: 'object',
    title: '短期记忆',
    description: '短期观察记忆：把每次被模型理解的截图整理成简短摘要、按场景分组，让桌宠连续阅读、看视频、浏览网页或研究代码时记得近期内容；约若干轮后自动淡出。仅内存保存，重启清空，不存原始截图。',
    properties: {
      [`${K}.shortMemoryEnabled`]: {
        type: 'boolean',
        title: '启用短期记忆',
        description: '开启后，模型理解截图时可写回简短摘要，后续观察会附上最近的摘要帮助接续；关闭后不再记录或注入，工具返回已关闭。',
        'x-hot': true,
      },
      [`${K}.memoryMaxTurns`]: {
        type: 'integer',
        title: '记忆轮数',
        description: '每条摘要产生这么多轮真实用户回合后，从短期记忆移除。自动观察、主动评论与工具调用不计数。',
        minimum: 2,
        maximum: 30,
        'x-suffix': '轮',
        'x-hot': true,
      },
      [`${K}.memoryTtlMinutes`]: {
        type: 'integer',
        title: '记忆时长上限',
        description: '每条摘要最长保留时间，防止用户不聊天时记忆无限存在；到点即从短期记忆移除。',
        minimum: 5,
        maximum: 1440,
        'x-suffix': 'min',
        'x-hot': true,
      },
      [`${K}.memoryMaxEntriesPerScene`]: {
        type: 'integer',
        title: '每场景摘要条数',
        description: '每个场景（如同一本书）最多保留的摘要条数，超出淘汰最旧。',
        minimum: 1,
        maximum: 10,
        'x-suffix': '条',
        'x-hot': true,
      },
      [`${K}.memoryMaxScenes`]: {
        type: 'integer',
        title: '场景数上限',
        description: '最多保留的短期场景数，超出淘汰最久未更新的场景；切回最近场景仍能接上。',
        minimum: 1,
        maximum: 5,
        'x-suffix': '个',
        'x-hot': true,
      },
    },
  },
};
