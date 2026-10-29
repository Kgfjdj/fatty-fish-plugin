/**
 * 截屏封装：调用 Windows 自带的 PowerShell + .NET System.Drawing 截取当前屏幕，产出 JPEG 字节。
 *
 * 不用第三方截图二进制（screenshot-desktop 在本机受 NoDefaultCurrentDirectoryInExePath=1 影响，
 * 其 polyglot .bat 里 `%~n0.exe` 依赖「当前目录可解析裸名 exe」，会被该环境变量禁用而失败）。
 * PowerShell 是 Windows 10 自带组件，无 csc.exe 编译、无裸名 exe 依赖，更稳。
 */
import { execFile } from 'node:child_process';
import { Jimp } from 'jimp';

export interface CapturedFrame {
  bytes: Buffer;
  mime: 'image/jpeg';
}

/** 运行一段 PowerShell 脚本，返回 stdout；非零退出或 stderr 抛错。 */
function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr?.trim() || err.message));
          return;
        }
        if (stderr && stderr.trim()) {
          reject(new Error(stderr.trim()));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** 把显示器 id 安全地嵌入 PowerShell 单引号字符串（单引号内反斜杠为字面量）。 */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** 截一帧当前画面；screen 为显示器 id（如 \\.\DISPLAY1），省略截主屏。 */
export async function captureScreen(screen?: string): Promise<CapturedFrame> {
  const script = [
    '$ProgressPreference="SilentlyContinue";',
    '$ErrorActionPreference="Stop";',
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
    '$screens=[System.Windows.Forms.Screen]::AllScreens;',
    `$want=${psQuote(screen ?? '')};`,
    "if ($want -eq '') { $target=[System.Windows.Forms.Screen]::PrimaryScreen }",
    'else {',
    '  $target=$null;',
    '  foreach ($s in $screens) {',
    '    $id=$s.DeviceName -replace "^\\\\\\\\.\\\\", "";',
    '    if ($id -eq $want -or $s.DeviceName -eq $want) { $target=$s; break }',
    '  }',
    '  if ($null -eq $target) { throw ("display not found: " + $want) }',
    '};',
    '$b=$target.Bounds;',
    '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;',
    '$g=[System.Drawing.Graphics]::FromImage($bmp);',
    '$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);',
    '$g.Dispose();',
    '$ms=New-Object System.IO.MemoryStream;',
    '$bmp.Save($ms,[System.Drawing.Imaging.ImageFormat]::Jpeg);',
    '$bmp.Dispose();',
    '[Convert]::ToBase64String($ms.ToArray());',
  ].join('\n');
  const b64 = (await runPowerShell(script)).trim();
  if (!b64) throw new Error('PowerShell 未返回截图数据');
  return { bytes: Buffer.from(b64, 'base64'), mime: 'image/jpeg' };
}

/** 等比缩放到最大宽度，节省视觉模型 token；原帧已小于等于该宽度时原样返回。 */
export async function resizeToMaxWidth(frame: CapturedFrame, maxWidth: number): Promise<CapturedFrame> {
  if (!Number.isFinite(maxWidth) || maxWidth <= 0 || !frame.bytes) return frame;
  const image = await Jimp.fromBuffer(frame.bytes);
  if (image.bitmap.width <= maxWidth) return frame;
  image.scaleToFit({ w: maxWidth, h: image.bitmap.height });
  const bytes = await image.getBuffer('image/jpeg');
  return { bytes, mime: 'image/jpeg' };
}

export interface FrameInfo {
  width: number;
  height: number;
  bytes: number;
}

/** 读一帧的宽高与字节数，供回执说明使用。 */
export async function frameInfo(frame: CapturedFrame): Promise<FrameInfo> {
  const image = await Jimp.fromBuffer(frame.bytes);
  return { width: image.bitmap.width, height: image.bitmap.height, bytes: frame.bytes.length };
}

export interface ScreenInfo {
  id: string;
  width: number;
  height: number;
}

/** 列出系统显示器，供配置参考。 */
export async function listScreens(): Promise<ScreenInfo[]> {
  const script = [
    '$ProgressPreference="SilentlyContinue";',
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
    '$out=@();',
    'foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {',
    '  $out += ($s.DeviceName + ";" + $s.Bounds.Width + ";" + $s.Bounds.Height);',
    '};',
    '$out -join [char]10;',
  ].join('\n');
  const stdout = (await runPowerShell(script)).trim();
  if (!stdout) return [];
  return stdout.split(/\r?\n/).map((line) => {
    const [id, width, height] = line.split(';');
    return { id, width: Number(width), height: Number(height) };
  });
}
