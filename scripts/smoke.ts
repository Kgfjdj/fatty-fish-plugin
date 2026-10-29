/**
 * 冒烟测试：验证本机真实截屏路径（不经过 Coopanion）。
 * 运行：pnpm smoke
 */
import { captureScreen, frameInfo, listScreens, resizeToMaxWidth } from '../src/capture.ts';

const displays = await listScreens();
console.log('显示器列表:', displays.map((d) => `${d.id} ${d.width}×${d.height}`).join('、'));

const frame = await captureScreen(undefined);
const info = await frameInfo(frame);
console.log(`主屏截图：${info.width}×${info.height}，${info.bytes} 字节，${frame.mime}`);

const resized = await resizeToMaxWidth(frame, 1280);
const rinfo = await frameInfo(resized);
console.log(`缩到 1280 宽后：${rinfo.width}×${rinfo.height}，${rinfo.bytes} 字节`);
console.log('OK');
