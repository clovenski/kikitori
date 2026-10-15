// Generates build/icon.png (512px) and build/icon.ico (16-256px) from build/icon.svg.
// The two smallest sizes use build/icon-small.svg, a simplified gate mark (the 門 of 聞) that stays legible at 16-24px.
// Rendering uses the installed Chrome or Edge (headless), because the kanji is drawn as text.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const SMALL_MAX = 24; // sizes up to this use icon-small.svg
const PNG_SIZE = 512;

const browser = [
  process.env['CHROME_PATH'],
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => p && existsSync(p));
if (!browser) throw new Error('Chrome or Edge is required to render the icon (set CHROME_PATH to its exe).');

const work = mkdtempSync(join(tmpdir(), 'kikitori-icon-'));

function render(svgFile, size) {
  const page = join(work, `${svgFile}-${size}.html`);
  const out = join(work, `${svgFile}-${size}.png`);
  const svg = pathToFileURL(join('build', svgFile)).href;
  writeFileSync(
    page,
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent;overflow:hidden}` +
      `img{display:block;width:${size}px;height:${size}px}</style><img src="${svg}">`,
  );
  execFileSync(
    browser,
    [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      '--default-background-color=00000000',
      `--window-size=${size},${size}`,
      `--screenshot=${out}`,
      pathToFileURL(page).href,
    ],
    { stdio: 'ignore' },
  );
  return readFileSync(out);
}

try {
  const frames = ICO_SIZES.map((size) => ({
    size,
    png: render(size <= SMALL_MAX ? 'icon-small.svg' : 'icon.svg', size),
  }));

  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(frames.length, 4);
  let offset = head.length + 16 * frames.length;
  const entries = frames.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry[0] = size === 256 ? 0 : size; // 0 means 256
    entry[1] = size === 256 ? 0 : size;
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });

  writeFileSync('build/icon.png', render('icon.svg', PNG_SIZE));
  writeFileSync('build/icon.ico', Buffer.concat([head, ...entries, ...frames.map((f) => f.png)]));
  console.log(`Wrote build/icon.png and build/icon.ico (${ICO_SIZES.join(', ')}px) using ${browser}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
