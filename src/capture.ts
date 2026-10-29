/**
 * 截屏封装：调用 Windows 自带的 PowerShell + .NET System.Drawing 截取当前屏幕，产出 JPEG 字节。
 *
 * 不用第三方截图二进制（screenshot-desktop 在本机受 NoDefaultCurrentDirectoryInExePath=1 影响，
 * 其 polyglot .bat 里 `%~n0.exe` 依赖「当前目录可解析裸名 exe」，会被该环境变量禁用而失败）。
 * PowerShell 是 Windows 10 自带组件，无 csc.exe 编译、无裸名 exe 依赖，更稳。
 * 区域框选用 WinForms 全屏半透明遮罩 + 鼠标拖拽，输出矩形后交给 captureRegion 截取。
 */
import { execFile } from 'node:child_process';
import { TextDecoder } from 'node:util';
import { Jimp } from 'jimp';
import type { ScreenRegion } from './config.ts';

export interface CapturedFrame {
  bytes: Buffer;
  mime: 'image/jpeg';
}

/**
 * 所有脚本共用的开头，必须放在最前（含 `Add-Type` 之前）：
 * - `$ProgressPreference="SilentlyContinue"`：静默「正在准备首次使用模块」等进度消息，否则它们会以 GBK 混进输出、盖住真正报错。
 * - `$ErrorActionPreference="Stop"`：任何语句出错立即抛异常。
 * - stdout 统一 UTF-8，避免中文被系统代码页（GBK）输出后被 Node 按 UTF-8 读成乱码。
 */
const PS_COMMON_PRELUDE = [
  '$ProgressPreference="SilentlyContinue";',
  '$ErrorActionPreference="Stop";',
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
].join('\n');

/** 让 PowerShell 进程按系统 DPI 感知工作，避免高 DPI 缩放下逻辑坐标与截图像素错位。 */
const PS_DPI_AWARE = [
  "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class D{[DllImport(\"user32.dll\")]public static extern bool SetProcessDPIAware();}';",
  '[D]::SetProcessDPIAware()|Out-Null;',
].join('\n');

/** PowerShell 的报错多为中文、按系统代码页（GBK）写 stderr；按 GBK 解码，否则乱码盖住真实错误。 */
function decodeGbk(buf: Buffer): string {
  if (!buf || buf.length === 0) return '';
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/** 运行一段 PowerShell 脚本，返回 stdout；非零退出或 stderr 抛错。 */
function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'buffer' },
      (err, stdout, stderr) => {
        const errBuf = stderr as unknown as Buffer;
        if (err) {
          reject(new Error(decodeGbk(errBuf) || err.message));
          return;
        }
        const errText = decodeGbk(errBuf);
        if (errText) {
          reject(new Error(errText));
          return;
        }
        resolve((stdout as unknown as Buffer).toString('utf8'));
      },
    );
  });
}

/** 把显示器 id 安全地嵌入 PowerShell 单引号字符串（单引号内反斜杠为字面量）。 */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** 校验并规范化选区：坐标与宽高取整，宽高须为正；非法返回 null。 */
export function sanitizeRegion(region: ScreenRegion | null | undefined): ScreenRegion | null {
  if (!region) return null;
  const x = Math.round(region.x);
  const y = Math.round(region.y);
  const width = Math.round(region.width);
  const height = Math.round(region.height);
  if (![x, y, width, height].every((v) => Number.isFinite(v))) return null;
  if (width < 1 || height < 1) return null;
  return { x, y, width, height };
}

/** 截一帧当前画面；screen 为显示器 id（如 \\.\DISPLAY1），省略截主屏。 */
export async function captureScreen(screen?: string): Promise<CapturedFrame> {
  const script = [
    PS_COMMON_PRELUDE,
    PS_DPI_AWARE,
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

/** 截取指定矩形区域（物理像素坐标）。 */
export async function captureRegion(region: ScreenRegion): Promise<CapturedFrame> {
  const r = sanitizeRegion(region);
  if (!r) throw new Error('截图区域无效：宽高须为正整数');
  const script = [
    PS_COMMON_PRELUDE,
    PS_DPI_AWARE,
    'Add-Type -AssemblyName System.Drawing;',
    `$x=${r.x}; $y=${r.y}; $w=${r.width}; $h=${r.height};`,
    '$bmp=New-Object System.Drawing.Bitmap $w,$h;',
    '$g=[System.Drawing.Graphics]::FromImage($bmp);',
    '$size=New-Object System.Drawing.Size($w,$h);',
    '$g.CopyFromScreen($x,$y,0,0,$size);',
    '$g.Dispose();',
    '$ms=New-Object System.IO.MemoryStream;',
    '$bmp.Save($ms,[System.Drawing.Imaging.ImageFormat]::Jpeg);',
    '$bmp.Dispose();',
    '[Convert]::ToBase64String($ms.ToArray());',
  ].join('\n');
  const b64 = (await runPowerShell(script)).trim();
  if (!b64) throw new Error('PowerShell 未返回区域截图数据');
  return { bytes: Buffer.from(b64, 'base64'), mime: 'image/jpeg' };
}

/** 弹出全屏半透明遮罩，用户鼠标拖拽框选；返回矩形或 null（取消 / 无效选区）。 */
export async function selectRegion(): Promise<ScreenRegion | null> {
  const script = [
    PS_COMMON_PRELUDE,
    PS_DPI_AWARE,
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
    '$vs=[System.Windows.Forms.SystemInformation]::VirtualScreen;',
    '$f=New-Object System.Windows.Forms.Form;',
    '$f.FormBorderStyle=[System.Windows.Forms.FormBorderStyle]::None;',
    '$f.StartPosition=[System.Windows.Forms.FormStartPosition]::Manual;',
    '$f.Location=New-Object System.Drawing.Point($vs.X,$vs.Y);',
    '$f.Size=New-Object System.Drawing.Size($vs.Width,$vs.Height);',
    '$f.BackColor=[System.Drawing.Color]::Black;',
    '$f.Opacity=0.25;',
    '$f.TopMost=$true;',
    '$f.ShowInTaskbar=$false;',
    '$f.Cursor=[System.Windows.Forms.Cursors]::Cross;',
    '$f.KeyPreview=$true;',
    '$script:start=$null; $script:rect=$null; $script:done=$false; $script:cancel=$false;',
    '$f.Add_MouseDown({ param($s,$e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { $script:start=$e.Location; $script:rect=New-Object System.Drawing.Rectangle($e.Location.X,$e.Location.Y,0,0); } });',
    '$f.Add_MouseMove({ param($s,$e) if ($script:start -ne $null) { $x=[Math]::Min($script:start.X,$e.X); $y=[Math]::Min($script:start.Y,$e.Y); $w=[Math]::Abs($e.X-$script:start.X); $h=[Math]::Abs($e.Y-$script:start.Y); $script:rect=New-Object System.Drawing.Rectangle($x,$y,$w,$h); $s.Invalidate(); } });',
    '$f.Add_MouseUp({ param($s,$e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { if ($script:rect -ne $null -and $script:rect.Width -ge 4 -and $script:rect.Height -ge 4) { $script:done=$true; $s.Close(); } else { $script:start=$null; $script:rect=$null; $s.Invalidate(); } } });',
    '$f.Add_Paint({ param($s,$e) if ($script:rect -ne $null) { $p=New-Object System.Drawing.Pen([System.Drawing.Color]::Red,2); $e.Graphics.DrawRectangle($p,$script:rect); $p.Dispose(); } });',
    '$f.Add_KeyDown({ param($s,$e) if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Escape) { $script:cancel=$true; $s.Close(); } });',
    '$f.Add_Shown({ $this.Activate(); });',
    '[void]$f.ShowDialog();',
    'if ($script:cancel -or -not $script:done -or $script:rect -eq $null) { "null" } else { $gx=$vs.X+$script:rect.X; $gy=$vs.Y+$script:rect.Y; $obj=@{ x=$gx; y=$gy; width=$script:rect.Width; height=$script:rect.Height }; $obj | ConvertTo-Json -Compress }',
  ].join('\n');
  const out = (await runPowerShell(script)).trim();
  if (!out || out === 'null') return null;
  try {
    const parsed = JSON.parse(out) as Record<string, unknown>;
    return sanitizeRegion({
      x: Number(parsed.x),
      y: Number(parsed.y),
      width: Number(parsed.width),
      height: Number(parsed.height),
    });
  } catch {
    return null;
  }
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
    PS_COMMON_PRELUDE,
    PS_DPI_AWARE,
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
