import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { WorldSection } from 'cortico/world.ts';

export const SCREEN_COMPANION_ID = 'screen-companion';

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
}

export const SCREEN_COMPANION_DEFAULTS: ScreenCompanionConfigSection = {
  enabled: false,
  screen: '',
  maxWidth: 1920,
  autoObserve: true,
  captureIntervalMs: 3000,
  motionThreshold: 0.05,
};

const K = `worlds.${SCREEN_COMPANION_ID}`;

/** World 配置的 JSON Schema 声明。 */
export const SCREEN_COMPANION_CONFIG_GROUP: ConfigGroup = {
  id: `world:${SCREEN_COMPANION_ID}`,
  owner: `world:${SCREEN_COMPANION_ID}`,
  schema: {
    type: 'object',
    title: '屏幕陪伴桌宠',
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
        description: '自动观察的截屏间隔，毫秒。只比对画面变化，不调用模型，成本很低。',
        minimum: 1000,
        maximum: 60000,
        'x-suffix': 'ms',
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
    },
  },
};
