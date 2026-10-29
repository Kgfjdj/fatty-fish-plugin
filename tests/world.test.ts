import { describe, expect, it, vi } from 'vitest';
import { Jimp } from 'jimp';
import type { DeepPartial } from 'cortico/world.ts';
import { SCREEN_COMPANION_DEFAULTS, type ScreenCompanionConfigSection, type ScreenRegion } from '../src/config.ts';
import { ScreenCompanionWorld } from '../src/world.ts';
import type { CapturedFrame } from '../src/capture.ts';
import { makeFakeHost, type FakeStoreEvent } from './helpers/fake-host.ts';

/** 造一张真实 JPEG，走通 resize/frameInfo 的完整路径。 */
async function makeJpeg(width: number, height: number, color = 0xffffffff): Promise<Buffer> {
  const image = new Jimp({ width, height, color });
  return image.getBuffer('image/jpeg');
}

interface Rig {
  world: ScreenCompanionWorld;
  cfg: ScreenCompanionConfigSection;
  host: ReturnType<typeof makeFakeHost>;
  tool: (name?: string) => ReturnType<ScreenCompanionWorld['tools']>[0];
}

function makeRig(
  opts: {
    capture?: (screen?: string) => Promise<CapturedFrame>;
    captureRegion?: (region: ScreenRegion) => Promise<CapturedFrame>;
    selectRegion?: () => Promise<ScreenRegion | null>;
    persist?: (patch: DeepPartial<ScreenCompanionConfigSection>) => void;
    acceptsImage?: boolean;
    now?: () => number;
    storeEvents?: FakeStoreEvent[];
  } = {},
): Rig {
  const cfg: ScreenCompanionConfigSection = { ...SCREEN_COMPANION_DEFAULTS };
  const host = makeFakeHost({ acceptsImage: opts.acceptsImage, storeEvents: opts.storeEvents });
  const world = new ScreenCompanionWorld({
    cfg,
    timezone: 'Asia/Shanghai',
    capture: opts.capture,
    captureRegion: opts.captureRegion,
    selectRegion: opts.selectRegion,
    persist: opts.persist,
    acceptsImage: opts.acceptsImage === undefined ? undefined : () => opts.acceptsImage!,
    now: opts.now,
  });
  return {
    world,
    cfg,
    host,
    tool: (name = 'screen_companion_look_now') => world.tools().find((t) => t.name === name)!,
  };
}

describe('ScreenCompanionWorld', () => {
  it('注册了 screen_companion_look_now 工具，且声明可被 describeTools 消费', () => {
    const rig = makeRig();
    const tool = rig.tool();
    expect(tool.name).toBe('screen_companion_look_now');
    expect(tool.tags).toContain('read');
    expect(tool.tags).toContain('snapshot');
    expect(tool.parameters).toHaveProperty('properties');
  });

  it('成功截屏：回执带 image/jpeg 附件与尺寸说明', async () => {
    const jpeg = await makeJpeg(1280, 720);
    const rig = makeRig({ capture: async () => ({ bytes: jpeg, mime: 'image/jpeg' }) });
    await rig.world.start(rig.host.host);
    const outcome = await rig.tool().handler({}, { role: 'test', log: rig.host.host.log });
    const o = outcome as { text: string; failed?: true; blobs?: Array<{ bytes: Uint8Array; mime: string; name: string; fallbackText: string }> };
    expect(o.failed).toBeUndefined();
    expect(o.blobs).toHaveLength(1);
    expect(o.blobs![0].mime).toBe('image/jpeg');
    expect(o.blobs![0].name).toBe('screen.jpg');
    expect(o.blobs![0].bytes.length).toBeGreaterThan(0);
    expect(o.text).toContain('1280×720');
    await rig.world.stop();
  });

  it('用户问题透传进回执正文', async () => {
    const jpeg = await makeJpeg(800, 600);
    const rig = makeRig({ capture: async () => ({ bytes: jpeg, mime: 'image/jpeg' }) });
    await rig.world.start(rig.host.host);
    const outcome = await rig.tool().handler({ question: '帮我解释屏幕上的这段文字' }, { role: 'test', log: rig.host.host.log });
    expect(String((outcome as { text: string }).text)).toContain('帮我解释屏幕上的这段文字');
    await rig.world.stop();
  });

  it('未挂载时调用失败', async () => {
    const rig = makeRig();
    const outcome = await rig.tool().handler({}, { role: 'test', log: rig.host.host.log });
    expect(outcome).toMatchObject({ failed: true });
    expect(String((outcome as { text: string }).text)).toContain('未挂载');
  });

  it('模型无法处理图像时给出明确失败回执', async () => {
    const jpeg = await makeJpeg(800, 600);
    const rig = makeRig({ capture: async () => ({ bytes: jpeg, mime: 'image/jpeg' }), acceptsImage: false });
    await rig.world.start(rig.host.host);
    const outcome = await rig.tool().handler({}, { role: 'test', log: rig.host.host.log });
    expect(outcome).toMatchObject({ failed: true });
    expect(String((outcome as { text: string }).text)).toContain('无法处理图像');
    await rig.world.stop();
  });

  it('截屏失败时给出明确失败回执', async () => {
    const rig = makeRig({
      capture: async () => {
        throw new Error('截屏权限被拒绝');
      },
    });
    await rig.world.start(rig.host.host);
    const outcome = await rig.tool().handler({}, { role: 'test', log: rig.host.host.log });
    expect(outcome).toMatchObject({ failed: true });
    expect(String((outcome as { text: string }).text)).toContain('截屏权限被拒绝');
    await rig.world.stop();
  });

  it('配置热改：screen 现读即生效', async () => {
    const calls: Array<string | undefined> = [];
    const jpeg = await makeJpeg(800, 600);
    const rig = makeRig({
      capture: async (screen) => {
        calls.push(screen);
        return { bytes: jpeg, mime: 'image/jpeg' };
      },
    });
    await rig.world.start(rig.host.host);
    rig.cfg.screen = '\\\\.\\DISPLAY2';
    await rig.tool().handler({}, { role: 'test', log: rig.host.host.log });
    expect(calls[0]).toBe('\\\\.\\DISPLAY2');
    await rig.world.stop();
  });
});

describe('自动观察', () => {
  it('画面变化超过阈值且过了冷却时，pushEvent 推送截图附件', async () => {
    vi.useFakeTimers();
    const red = await makeJpeg(800, 600, 0xff0000ff);
    const blue = await makeJpeg(800, 600, 0x0000ffff);
    const frames = [red, blue];
    let i = 0;
    let clock = 0;
    const rig = makeRig({
      capture: async () => ({ bytes: frames[i++ % frames.length], mime: 'image/jpeg' }),
      now: () => clock,
    });
    await rig.world.start(rig.host.host);

    await vi.advanceTimersByTimeAsync(3000); // 首帧，变化比例 0
    expect(rig.host.events.filter((e) => e.event.type === 'screen_companion.observed')).toHaveLength(0);

    clock = 30000; // 越过 20 秒冷却
    await vi.advanceTimersByTimeAsync(3000); // 第二帧变化，推送
    await rig.world.stop();

    const observed = rig.host.events.filter((e) => e.event.type === 'screen_companion.observed');
    expect(observed).toHaveLength(1);
    expect(observed[0].event.blobs).toHaveLength(1);
    expect((observed[0].event.blobs![0] as { mime: string }).mime).toBe('image/jpeg');
    expect(observed[0].opts?.trigger).toBe('debounce');
    vi.useRealTimers();
  });

  it('画面变化但未过冷却时不重复推送', async () => {
    vi.useFakeTimers();
    const red = await makeJpeg(800, 600, 0xff0000ff);
    const blue = await makeJpeg(800, 600, 0x0000ffff);
    const frames = [red, blue];
    let i = 0;
    let clock = 0;
    const rig = makeRig({
      capture: async () => ({ bytes: frames[i++ % frames.length], mime: 'image/jpeg' }),
      now: () => clock,
    });
    await rig.world.start(rig.host.host);

    await vi.advanceTimersByTimeAsync(3000); // 首帧
    clock = 30000;
    await vi.advanceTimersByTimeAsync(3000); // 第二帧，推送一次
    await vi.advanceTimersByTimeAsync(3000); // 第三帧又变，但冷却未过
    await rig.world.stop();

    expect(rig.host.events.filter((e) => e.event.type === 'screen_companion.observed')).toHaveLength(1);
    vi.useRealTimers();
  });

  it('自动观察关闭时不推送', async () => {
    vi.useFakeTimers();
    const red = await makeJpeg(800, 600, 0xff0000ff);
    const blue = await makeJpeg(800, 600, 0x0000ffff);
    const frames = [red, blue];
    let i = 0;
    let clock = 0;
    const rig = makeRig({
      capture: async () => ({ bytes: frames[i++ % frames.length], mime: 'image/jpeg' }),
      now: () => clock,
    });
    rig.cfg.autoObserve = false;
    await rig.world.start(rig.host.host);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    await rig.world.stop();

    expect(rig.host.events.filter((e) => e.event.type === 'screen_companion.observed')).toHaveLength(0);
    vi.useRealTimers();
  });
});

describe('活跃度与推送冷却', () => {
  it('envPromptVars 暴露当前活跃度中文名，且随配置热改', () => {
    const rig = makeRig();
    expect(rig.world.envPromptVars()['screenCompanion.activity']).toBe('适中');
    rig.cfg.activity = '活跃';
    expect(rig.world.envPromptVars()['screenCompanion.activity']).toBe('活跃');
    rig.cfg.activity = '安静';
    expect(rig.world.envPromptVars()['screenCompanion.activity']).toBe('安静');
  });

  it('推送冷却可独立配置：调小后更短间隔即可再次推送', async () => {
    vi.useFakeTimers();
    const red = await makeJpeg(800, 600, 0xff0000ff);
    const blue = await makeJpeg(800, 600, 0x0000ffff);
    const frames = [red, blue];
    let i = 0;
    let clock = 0;
    const rig = makeRig({
      capture: async () => ({ bytes: frames[i++ % frames.length], mime: 'image/jpeg' }),
      now: () => clock,
    });
    rig.cfg.pushCooldownMs = 5000;
    await rig.world.start(rig.host.host);

    await vi.advanceTimersByTimeAsync(3000); // 首帧，变化比例 0
    clock = 10_000; // 越过 5 秒冷却（但不到默认的 20 秒）
    await vi.advanceTimersByTimeAsync(3000); // 第二帧变化，推送
    await rig.world.stop();

    expect(rig.host.events.filter((e) => e.event.type === 'screen_companion.observed')).toHaveLength(1);
    vi.useRealTimers();
  });
});

describe('自定义截图区域', () => {
  it('框选区域后保存，切换为自定义区域模式', async () => {
    const region = { x: 100, y: 50, width: 300, height: 200 };
    const persisted: Array<DeepPartial<ScreenCompanionConfigSection>> = [];
    const rig = makeRig({
      selectRegion: async () => region,
      persist: (patch) => {
        persisted.push(patch);
        Object.assign(rig.cfg, patch);
      },
    });
    await rig.world.start(rig.host.host);
    const outcome = await rig.tool('screen_companion_select_region').handler({}, { role: 'test', log: rig.host.host.log });
    expect((outcome as { failed?: true }).failed).toBeUndefined();
    expect(String((outcome as { text: string }).text)).toContain('300');
    expect(rig.cfg.captureMode).toBe('自定义区域');
    expect(rig.cfg.region).toEqual(region);
    expect(persisted).toHaveLength(1);
    await rig.world.stop();
  });

  it('框选取消时不改变区域', async () => {
    const rig = makeRig({ selectRegion: async () => null });
    await rig.world.start(rig.host.host);
    const outcome = await rig.tool('screen_companion_select_region').handler({}, { role: 'test', log: rig.host.host.log });
    expect(String((outcome as { text: string }).text)).toContain('取消');
    expect(rig.cfg.captureMode).toBe('全屏');
    expect(rig.cfg.region).toBeNull();
    await rig.world.stop();
  });

  it('清除区域后恢复全屏', async () => {
    const rig = makeRig();
    rig.cfg.captureMode = '自定义区域';
    rig.cfg.region = { x: 1, y: 2, width: 10, height: 20 };
    await rig.world.start(rig.host.host);
    const outcome = await rig.tool('screen_companion_clear_region').handler({}, { role: 'test', log: rig.host.host.log });
    expect((outcome as { failed?: true }).failed).toBeUndefined();
    expect(rig.cfg.captureMode).toBe('全屏');
    expect(rig.cfg.region).toBeNull();
    await rig.world.stop();
  });

  it('自定义区域模式下，手动截图只取框选区域', async () => {
    const region = { x: 100, y: 50, width: 300, height: 200 };
    const jpeg = await makeJpeg(300, 200);
    let regionCalls = 0;
    let fullCalls = 0;
    const rig = makeRig({
      capture: async () => {
        fullCalls += 1;
        return { bytes: jpeg, mime: 'image/jpeg' };
      },
      captureRegion: async (r) => {
        regionCalls += 1;
        expect(r).toEqual(region);
        return { bytes: jpeg, mime: 'image/jpeg' };
      },
    });
    rig.cfg.captureMode = '自定义区域';
    rig.cfg.region = region;
    await rig.world.start(rig.host.host);
    const outcome = await rig.tool().handler({}, { role: 'test', log: rig.host.host.log });
    expect((outcome as { failed?: true }).failed).toBeUndefined();
    expect(regionCalls).toBe(1);
    expect(fullCalls).toBe(0);
    await rig.world.stop();
  });
});

describe('短期观察记忆', () => {
  it('record 写入摘要后，recent 能读回', async () => {
    const rig = makeRig();
    await rig.world.start(rig.host.host);
    const record = rig.tool('screen_companion_memory_record');
    const recOutcome = await record.handler(
      { summary: '主角叶文洁收到三体文明的回信，世界从此不同。', sceneType: 'reading', sceneLabel: '三体' },
      { role: 'test', log: rig.host.host.log },
    );
    expect((recOutcome as { failed?: true }).failed).toBeUndefined();
    const recent = rig.tool('screen_companion_memory_recent');
    const recRecent = await recent.handler({}, { role: 'test', log: rig.host.host.log });
    expect(String((recRecent as { text: string }).text)).toContain('三体');
    await rig.world.stop();
  });

  it('关闭短期记忆后 record 与 recent 返回已关闭', async () => {
    const rig = makeRig();
    rig.cfg.shortMemoryEnabled = false;
    await rig.world.start(rig.host.host);
    const record = rig.tool('screen_companion_memory_record');
    const out = await record.handler({ summary: '内容摘要……' }, { role: 'test', log: rig.host.host.log });
    expect(String((out as { text: string }).text)).toContain('已关闭');
    const recent = rig.tool('screen_companion_memory_recent');
    const rOut = await recent.handler({}, { role: 'test', log: rig.host.host.log });
    expect(String((rOut as { text: string }).text)).toContain('已关闭');
    await rig.world.stop();
  });

  it('onTurnEnded 只对非本插件的外部事件计数，自动观察不计', async () => {
    const rig = makeRig();
    await rig.world.start(rig.host.host);
    const record = rig.tool('screen_companion_memory_record');
    await record.handler(
      { summary: '一条足够长的摘要内容，用于过期测试。', sceneType: 'reading' },
      { role: 'test', log: rig.host.host.log },
    );

    // 自动观察轮不计
    rig.host.appendStoreEvent({ origin: 'external', source: 'screen-companion', type: 'screen_companion.observed', text: '截图', ts: '' });
    rig.world.onTurnEnded();
    // 9 轮用户输入
    for (let i = 0; i < 9; i++) {
      rig.host.appendStoreEvent({ origin: 'external', source: 'persona', type: 'chat', text: `用户消息 ${i}`, ts: '' });
      rig.world.onTurnEnded();
    }
    const recent = rig.tool('screen_companion_memory_recent');
    const still = await recent.handler({}, { role: 'test', log: rig.host.host.log });
    expect(String((still as { text: string }).text)).toContain('足够长');

    // 第 10 轮用户输入后过期
    rig.host.appendStoreEvent({ origin: 'external', source: 'persona', type: 'chat', text: '用户消息 10', ts: '' });
    rig.world.onTurnEnded();
    const gone = await recent.handler({}, { role: 'test', log: rig.host.host.log });
    expect(String((gone as { text: string }).text)).toContain('空');
    await rig.world.stop();
  });

  it('自动观察事件正文附上最近的摘要', async () => {
    vi.useFakeTimers();
    const red = await makeJpeg(800, 600, 0xff0000ff);
    const blue = await makeJpeg(800, 600, 0x0000ffff);
    const frames = [red, blue];
    let i = 0;
    let clock = 0;
    const rig = makeRig({
      capture: async () => ({ bytes: frames[i++ % frames.length], mime: 'image/jpeg' }),
      now: () => clock,
    });
    await rig.world.start(rig.host.host);
    const record = rig.tool('screen_companion_memory_record');
    await record.handler(
      { summary: '三体：叶文洁收到回信。', sceneType: 'reading', sceneLabel: '三体' },
      { role: 'test', log: rig.host.host.log },
    );

    await vi.advanceTimersByTimeAsync(3000); // 首帧
    clock = 30000;
    await vi.advanceTimersByTimeAsync(3000); // 第二帧变化，推送
    await rig.world.stop();
    vi.useRealTimers();

    const observed = rig.host.events.filter((e) => e.event.type === 'screen_companion.observed');
    expect(observed).toHaveLength(1);
    expect(observed[0].event.text).toContain('三体');
    expect(observed[0].event.text).toContain('观察 ID');
  });

  it('look_now 回执正文附上最近的摘要', async () => {
    const jpeg = await makeJpeg(800, 600);
    const rig = makeRig({ capture: async () => ({ bytes: jpeg, mime: 'image/jpeg' }) });
    await rig.world.start(rig.host.host);
    const record = rig.tool('screen_companion_memory_record');
    await record.handler(
      { summary: '三体：叶文洁收到回信。', sceneType: 'reading', sceneLabel: '三体' },
      { role: 'test', log: rig.host.host.log },
    );
    const outcome = await rig.tool().handler({}, { role: 'test', log: rig.host.host.log });
    expect(String((outcome as { text: string }).text)).toContain('三体');
    await rig.world.stop();
  });

  it('clear 清空后 recent 返回空', async () => {
    const rig = makeRig();
    await rig.world.start(rig.host.host);
    const record = rig.tool('screen_companion_memory_record');
    await record.handler(
      { summary: '一条摘要内容，足够长。', sceneType: 'reading' },
      { role: 'test', log: rig.host.host.log },
    );
    const clear = rig.tool('screen_companion_memory_clear');
    await clear.handler({}, { role: 'test', log: rig.host.host.log });
    const recent = rig.tool('screen_companion_memory_recent');
    const out = await recent.handler({}, { role: 'test', log: rig.host.host.log });
    expect(String((out as { text: string }).text)).toContain('空');
    await rig.world.stop();
  });
});
