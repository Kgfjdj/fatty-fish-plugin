import { describe, expect, it } from 'vitest';
import { Jimp } from 'jimp';
import { frameInfo, resizeToMaxWidth, sanitizeRegion, type CapturedFrame } from '../src/capture.ts';

async function makeFrame(width: number, height: number): Promise<CapturedFrame> {
  const image = new Jimp({ width, height, color: 0xff224466 });
  return { bytes: await image.getBuffer('image/jpeg'), mime: 'image/jpeg' };
}

describe('resizeToMaxWidth', () => {
  it('超过最大宽度时等比缩小', async () => {
    const frame = await makeFrame(2000, 1000);
    const resized = await resizeToMaxWidth(frame, 1000);
    expect(resized).not.toBe(frame);
    const info = await frameInfo(resized);
    expect(info.width).toBe(1000);
    expect(info.height).toBe(500);
  });

  it('未超过最大宽度时原样返回', async () => {
    const frame = await makeFrame(800, 600);
    const resized = await resizeToMaxWidth(frame, 1920);
    expect(resized).toBe(frame);
  });

  it('maxWidth 非法时原样返回，不缩图', async () => {
    const frame = await makeFrame(800, 600);
    expect(await resizeToMaxWidth(frame, 0)).toBe(frame);
    expect(await resizeToMaxWidth(frame, Number.NaN)).toBe(frame);
  });
});

describe('frameInfo', () => {
  it('读回正确的宽高与字节数', async () => {
    const frame = await makeFrame(640, 480);
    const info = await frameInfo(frame);
    expect(info.width).toBe(640);
    expect(info.height).toBe(480);
    expect(info.bytes).toBe(frame.bytes.length);
  });
});

describe('sanitizeRegion', () => {
  it('合法区域取整后原样返回', () => {
    expect(sanitizeRegion({ x: 1.4, y: 2.6, width: 100.2, height: 50.8 })).toEqual({ x: 1, y: 3, width: 100, height: 51 });
  });

  it('null、缺失或非法宽高返回 null', () => {
    expect(sanitizeRegion(null)).toBeNull();
    expect(sanitizeRegion(undefined)).toBeNull();
    expect(sanitizeRegion({ x: 0, y: 0, width: 0, height: 10 })).toBeNull();
    expect(sanitizeRegion({ x: 0, y: 0, width: 10, height: -1 })).toBeNull();
    expect(sanitizeRegion({ x: Number.NaN, y: 0, width: 10, height: 10 })).toBeNull();
  });
});
