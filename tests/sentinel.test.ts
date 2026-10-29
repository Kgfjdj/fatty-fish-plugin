import { describe, expect, it } from 'vitest';
import { Jimp } from 'jimp';
import { MotionSentinel, diffRatio } from '../src/sentinel.ts';

async function makeJpeg(width: number, height: number, color: number): Promise<Buffer> {
  const image = new Jimp({ width, height, color });
  return image.getBuffer('image/jpeg');
}

describe('diffRatio', () => {
  it('相同缓冲变化为 0', () => {
    const a = new Uint8Array(4 * 16).fill(120);
    expect(diffRatio(a, a)).toBe(0);
  });

  it('完全不同缓冲变化为 1', () => {
    const a = new Uint8Array(4 * 16).fill(0);
    const b = new Uint8Array(4 * 16).fill(255);
    expect(diffRatio(a, b)).toBe(1);
  });
});

describe('MotionSentinel', () => {
  it('首帧返回 0，画面变化后返回正比例', async () => {
    const sentinel = new MotionSentinel();
    const red = await makeJpeg(800, 600, 0xff0000ff);
    const blue = await makeJpeg(800, 600, 0x0000ffff);
    expect(await sentinel.ingest(red)).toBe(0);
    expect(await sentinel.ingest(blue)).toBeGreaterThan(0.9);
  });

  it('相同画面返回 0', async () => {
    const sentinel = new MotionSentinel();
    const red = await makeJpeg(800, 600, 0xff0000ff);
    await sentinel.ingest(red);
    expect(await sentinel.ingest(red)).toBe(0);
  });
});
