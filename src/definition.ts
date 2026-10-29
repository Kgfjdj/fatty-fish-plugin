import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { SCREEN_COMPANION_DEFAULTS, SCREEN_COMPANION_ID, type ScreenCompanionConfigSection } from './config.ts';
import { SCREEN_COMPANION_TOOL_DECLS, ScreenCompanionWorld } from './world.ts';

export const SCREEN_COMPANION: WorldDefinition<ScreenCompanionConfigSection> = {
  id: SCREEN_COMPANION_ID,
  label: '屏幕陪伴桌宠',
  defaults: () => ({ ...SCREEN_COMPANION_DEFAULTS }),
  // `ctx.cfg` 是 `worlds.screen-companion` 的活引用:热改的键现读即生效。
  create: (ctx) => new ScreenCompanionWorld({ cfg: ctx.cfg, timezone: ctx.timezone }),
  // 自描述:可能出现的全部工具与会推出的全部事件,不进提示词。
  describe: {
    tools: describeTools(SCREEN_COMPANION_TOOL_DECLS, {
      screen_companion_look_now: {
        zh: '立刻截取当前屏幕，把截图作为图片附件交给模型，结合用户的问题回答。',
        en: 'Takes a fresh screenshot of the current screen, attaches it to the receipt, and answers the user\'s question about it.',
      },
    }),
    events: [
      {
        type: 'screen_companion.started',
        description: { zh: 'World 挂载完成。', en: 'The World was mounted.' },
        trigger: 'flush',
      },
      {
        type: 'screen_companion.observed',
        description: { zh: '自动观察到屏幕画面变化，附上当前截图。', en: 'The screen changed; a fresh screenshot is attached.' },
        trigger: 'debounce',
      },
    ],
  },
};
