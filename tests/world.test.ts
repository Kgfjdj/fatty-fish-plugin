import { describe, expect, it, vi } from 'vitest';
import { Jimp } from 'jimp';
import { SCREEN_COMPANION_DEFAULTS, type ScreenCompanionConfigSection } from '../src/config.ts';
import { ScreenCompanionWorld } from '../src/world.ts';
import type { CapturedFrame } from '../src/capture.ts';
import { makeFakeHost } from './helpers/fake-host.ts';

/** 造一张真实 JPEG，走通 resize/frameInfo 的完整路径。 */
async function makeJpeg(width: number, height: number, color = 0xffffffff): Promise<Buffer> {
  const image = new Jimp({ width, height, color });
  return image.getBuffer('image/jpeg');
}

interface Rig {
  world: ScreenCompanionWorld;
  cfg: ScreenCompanionConfigSection;
  host: ReturnType<typeof makeFakeHost>;
  tool: () => ReturnType<ScreenCompanionWorld['tools']>[0];
}

function makeRig(
  opts: { capture?: (screen?: string) => Promise<CapturedFrame>; acceptsImage?: boolean; now?: () => number } = {},
): Rig {
  const cfg: ScreenCompanionConfigSection = { ...SCREEN_COMPANION_DEFAULTS };
  const host = makeFakeHost({ acceptsImage: opts.acceptsImage });
  const world = new ScreenCompanionWorld({
    cfg,
    timezone: 'Asia/Shanghai',
    capture: opts.capture,
    acceptsImage: opts.acceptsImage === undefined ? undefined : () => opts.acceptsImage!,
    now: opts.now,
  });
  return {
    world,
    cfg,
    host,
    tool: () => world.tools().find((t) => t.name === 'screen_companion_look_now')!,
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
