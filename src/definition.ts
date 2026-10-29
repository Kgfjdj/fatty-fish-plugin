import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { SCREEN_COMPANION_DEFAULTS, SCREEN_COMPANION_ID, type ScreenCompanionConfigSection } from './config.ts';
import { SCREEN_COMPANION_TOOL_DECLS, ScreenCompanionWorld } from './world.ts';

export const SCREEN_COMPANION: WorldDefinition<ScreenCompanionConfigSection> = {
  id: SCREEN_COMPANION_ID,
  label: '屏幕陪伴桌宠',
  defaults: () => ({ ...SCREEN_COMPANION_DEFAULTS }),
  // `ctx.cfg` 是 `worlds.screen-companion` 的活引用:热改的键现读即生效。
  create: (ctx) => new ScreenCompanionWorld({ cfg: ctx.cfg, timezone: ctx.timezone, persist: (patch) => ctx.persist(patch) }),
  // 自描述:可能出现的全部工具与会推出的全部事件,不进提示词。
  describe: {
    tools: describeTools(SCREEN_COMPANION_TOOL_DECLS, {
      screen_companion_look_now: {
        zh: '立刻截取当前屏幕，把截图作为图片附件交给模型，结合用户的问题回答。',
        en: 'Takes a fresh screenshot of the current screen, attaches it to the receipt, and answers the user\'s question about it.',
      },
      screen_companion_select_region: {
        zh: '弹出全屏遮罩，让用户用鼠标框选一块矩形区域；之后只截取这块区域。',
        en: 'Pops up a full-screen overlay so the user can drag-select a rectangular region to capture.',
      },
      screen_companion_clear_region: {
        zh: '清除已框选的区域，恢复全屏截图。',
        en: 'Clears the selected region and returns to full-screen capture.',
      },
      screen_companion_memory_record: {
        zh: '把对当前截图的简短摘要写进短期观察记忆，帮助后续接续同一本书/视频/项目。',
        en: 'Saves a short summary of the current screenshot into short-term observation memory.',
      },
      screen_companion_memory_recent: {
        zh: '读取当前场景的有效短期观察摘要，回顾用户刚才在看什么。',
        en: 'Reads the currently valid short-term observation summaries for the current scene.',
      },
      screen_companion_memory_clear: {
        zh: '清空本插件的短期观察记忆。',
        en: 'Clears all short-term observation memory.',
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
