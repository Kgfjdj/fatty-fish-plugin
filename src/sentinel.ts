/**
 * 画面哨兵：把截屏降采样成小图，与上一帧逐像素比对，得出 0..1 的变化比例。
 * 纯 JS（jimp 解码），不引入原生模块。
 */
import { Jimp } from 'jimp';

export const SENTINEL_WIDTH = 320;
/** 单通道平均差超过该值记为一个变化像素。 */
export const PIXEL_TOLERANCE = 32;

/** 两份等长 RGBA 缓冲的变化像素占比。 */
export function diffRatio(a: Uint8Array, b: Uint8Array, tolerance = PIXEL_TOLERANCE): number {
  if (a.length !== b.length || a.length === 0) return 1;
  let changed = 0;
  const pixels = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    const d = (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
    if (d > tolerance) changed += 1;
  }
  return changed / pixels;
}

interface Frame {
  data: Buffer;
  width: number;
  height: number;
}

export class MotionSentinel {
  private last: Frame | null = null;

  constructor(private readonly width = SENTINEL_WIDTH) {}

  /** 喂入一帧图像字节（jpeg/png），返回与上一帧的变化比例；首帧或尺寸变化返回 0。 */
  async ingest(bytes: Buffer): Promise<number> {
    const image = await Jimp.read(bytes);
    image.scaleToFit({ w: this.width, h: this.width });
    const { data, width, height } = image.bitmap;
    const frame: Frame = { data: Buffer.from(data), width, height };
    const prev = this.last;
    this.last = frame;
    if (!prev || prev.width !== width || prev.height !== height) return 0;
    return diffRatio(prev.data, frame.data);
  }

  reset(): void {
    this.last = null;
  }
}
