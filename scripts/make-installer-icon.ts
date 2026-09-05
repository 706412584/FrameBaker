// 生成 build\installer-icon.ico —— 像素风「帧格」图标（256/48/32/16 四尺寸，Vista+ PNG-in-ICO）。
// ICO 容器手工构造：6 字节头 + 每尺寸 16 字节目录项 + PNG 数据（Windows Vista+ 与 NSIS 均支持）。
// 像素画由 System.Drawing 经 PowerShell 生成 PNG；本脚本只做容器封装。
// 已存在则跳过；被 package-windows.ts 在 makensis 前调用。
import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const ICON = join(ROOT, "build", "installer-icon.ico");
if (existsSync(ICON)) {
  console.log("[framebaker] installer icon 已存在，跳过");
  process.exit(0);
}
mkdirSync(join(ROOT, "build"), { recursive: true });

const PS = `
Add-Type -AssemblyName System.Drawing
function New-Canvas([int]$px) {
  $bmp = New-Object System.Drawing.Bitmap($px, $px)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
  $g.Clear([System.Drawing.Color]::FromArgb(255, 26, 22, 35))
  $cell = [Math]::Floor($px / 8)
  $frame = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 205, 74))
  $play = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 74, 147))
  foreach ($i in @(1, 4)) { $g.FillRectangle($frame, ($i * $cell), ($cell), (2 * $cell), (6 * $cell)) }
  $g.FillRectangle($play, (6 * $cell), ($cell), ($cell), (6 * $cell))
  $g.Dispose()
  return $bmp
}
foreach ($px in @(256, 48, 32, 16)) {
  $bmp = New-Canvas $px
  $bmp.Save((Join-Path $env:TEMP "fb-icon-$px.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
`;

await Bun.write(join(process.env.TEMP ?? ".", "_fb-icon-gen.ps1"), "\ufeff" + PS);
const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(process.env.TEMP ?? ".", "_fb-icon-gen.ps1")], { stdio: ["ignore", "inherit", "inherit"] });
if ((await proc.exited) !== 0) throw new Error("图标 PNG 生成失败（System.Drawing）");

// ICO 容器：头(6) + 目录项(16×N) + 数据。PNG-in-ICO 要求尺寸字段：256 编码为 0。
const SIZES = [256, 48, 32, 16];
const pngs = SIZES.map((px) => Bun.file(join(process.env.TEMP ?? ".", `fb-icon-${px}.png`)));
const buffers: Buffer[] = [];
for (const f of pngs) buffers.push(Buffer.from(await f.arrayBuffer()));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(SIZES.length, 4);

const dirSize = 16 * SIZES.length;
let offset = 6 + dirSize;
const entries: Buffer[] = [];
SIZES.forEach((px, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(px >= 256 ? 0 : px, 0);
  e.writeUInt8(px >= 256 ? 0 : px, 1);
  e.writeUInt8(0, 2); // palette
  e.writeUInt8(0, 3); // reserved
  e.writeUInt16LE(1, 4); // color planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(buffers[i]!.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += buffers[i]!.length;
  entries.push(e);
});

await Bun.write(ICON, Buffer.concat([header, ...entries, ...buffers]));
console.log(`[framebaker] installer icon -> ${ICON}`);
