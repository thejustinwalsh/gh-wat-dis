// Draws every example spec to PNG with the CLI and checks what came out: the file is a PNG, it is
// twice the size of the SVG, shapes were drawn, and text was drawn. CI runs this on Linux, Windows
// and macOS against the packed package, and uploads the PNGs so a person can look at them.
//
// Run: node scripts/check-png.ts [--bin <path to bin.js>] [--out <dir>]
//
// The text check exists because resvg reports no error when it finds no font: it leaves every label
// out. So each PNG is compared with a second render of the same SVG with its <text> removed.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { toPng } from '../src/tools/raster.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** The example labels add about 100 pixels for each character at 2x. With no font they add none. */
const MIN_PIXELS_PER_CHARACTER = 20;

export interface Pixels { width: number; height: number; rgba: Uint8Array }

/** Decode an 8-bit RGBA PNG without interlacing, which is what resvg writes. */
export function decodePng(png: Uint8Array): Pixels {
  if (!SIGNATURE.every((b, i) => png[i] === b)) throw new Error('not a PNG: the signature is missing');
  const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  let width = 0, height = 0;
  const data: Buffer[] = [];
  for (let at = 8; at < buf.length;) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) throw new Error(`PNG is not 8-bit RGBA without interlacing (depth ${body[8]}, colour type ${body[9]}, interlace ${body[12]})`);
    }
    if (type === 'IDAT') data.push(body);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * 4;
  const rgba = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? rgba[y * stride + x - 4]! : 0;
      const up = y ? rgba[(y - 1) * stride + x]! : 0;
      const upLeft = y && x >= 4 ? rgba[(y - 1) * stride + x - 4]! : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - upLeft);
        predicted = a <= b && a <= c ? left : b <= c ? up : upLeft;
      }
      rgba[y * stride + x] = (line[x]! + predicted) & 0xff;
    }
  }
  return { width, height, rgba };
}

export function colours(p: Pixels): number {
  const seen = new Set<number>();
  for (let i = 0; i < p.rgba.length; i += 4) seen.add(((p.rgba[i]! << 24) | (p.rgba[i + 1]! << 16) | (p.rgba[i + 2]! << 8) | p.rgba[i + 3]!) >>> 0);
  return seen.size;
}

/** Pixels that differ between two images of one size. */
export function differing(a: Pixels, b: Pixels): number {
  let n = 0;
  for (let i = 0; i < a.rgba.length; i += 4) {
    if (a.rgba[i] !== b.rgba[i] || a.rgba[i + 1] !== b.rgba[i + 1] || a.rgba[i + 2] !== b.rgba[i + 2] || a.rgba[i + 3] !== b.rgba[i + 3]) n++;
  }
  return n;
}

export interface Row { name: string; width: number; height: number; colours: number; characters: number; textPixels: number; problems: string[] }

/** Check one PNG against the fixed-theme SVG it was drawn from. */
export function checkPng(name: string, svg: string, png: Uint8Array): Row {
  const row: Row = { name, width: 0, height: 0, colours: 0, characters: 0, textPixels: 0, problems: [] };
  if (!png.length) { row.problems.push('the PNG is empty'); return row; }
  let image: Pixels;
  try { image = decodePng(png); } catch (e) { row.problems.push((e as Error).message); return row; }
  const box = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  Object.assign(row, { width: image.width, height: image.height, colours: colours(image) });
  if (!box) row.problems.push('the SVG has no viewBox to compare with');
  else if (image.width !== Number(box[1]) * 2 || image.height !== Number(box[2]) * 2) {
    row.problems.push(`the PNG is ${image.width} x ${image.height}, expected ${Number(box[1]) * 2} x ${Number(box[2]) * 2}: twice the SVG viewBox`);
  }
  if (row.colours < 3) row.problems.push(`the PNG is blank: it holds ${row.colours} colour${row.colours === 1 ? '' : 's'}`);
  const labels = [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, 'x').replace(/\s/g, ''));
  row.characters = labels.join('').length;
  if (!row.characters) { row.problems.push('the SVG holds no text, so the text check has nothing to compare'); return row; }
  const bare = decodePng(toPng(svg.replace(/<text\b[^>]*>[\s\S]*?<\/text>/g, '')).png);
  if (bare.width !== image.width || bare.height !== image.height) return row;
  row.textPixels = differing(image, bare);
  if (row.textPixels < row.characters * MIN_PIXELS_PER_CHARACTER) {
    row.problems.push(`no text was drawn: ${row.textPixels} pixels differ from a render with the text removed, for ${row.characters} characters of labels. resvg found no font it can use on this machine.`);
  }
  return row;
}

function main(argv: string[]): number {
  const arg = (flag: string, fallback: string): string => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback; };
  const bin = resolve(arg('--bin', join(ROOT, 'src', 'bin.ts')));
  const out = resolve(arg('--out', join(ROOT, '.wat-tmp', 'png')));
  mkdirSync(out, { recursive: true });
  const dir = join(ROOT, 'examples', 'diagrams');
  const rows: Row[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const name = file.replace(/\.json$/, '');
    const svgPath = join(out, `${name}.svg`), pngPath = join(out, `${name}.png`);
    // --theme light, so the SVG on disk is the one the PNG was drawn from.
    const run = spawnSync(process.execPath, [bin, 'diagram', join(dir, file), '--theme', 'light', '-o', svgPath, '--png', pngPath], { encoding: 'utf8' });
    if (run.status !== 0) { rows.push({ name, width: 0, height: 0, colours: 0, characters: 0, textPixels: 0, problems: [`diagram exited ${run.status}: ${(run.stderr || run.error?.message || '').trim().split('\n').pop()}`] }); continue; }
    let png: Uint8Array;
    try { png = readFileSync(pngPath); } catch { rows.push({ name, width: 0, height: 0, colours: 0, characters: 0, textPixels: 0, problems: [`diagram wrote no file at ${pngPath}`] }); continue; }
    rows.push(checkPng(name, readFileSync(svgPath, 'utf8'), png));
  }
  const table = [
    `PNG check on ${process.platform} ${process.arch}, node ${process.version}, ${bin}`,
    '',
    '| Spec | PNG size | Colours | Label characters | Pixels the text adds | Result |',
    '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.name} | ${r.width} x ${r.height} | ${r.colours} | ${r.characters} | ${r.textPixels} | ${r.problems.length ? r.problems.join('; ') : 'ok'} |`),
    '',
  ].join('\n');
  console.log(table);
  writeFileSync(join(out, 'report.md'), table);
  const failed = rows.filter((r) => r.problems.length);
  if (!rows.length) { console.error(`error: no specs in ${dir}`); return 1; }
  for (const r of failed) for (const p of r.problems) console.error(`error: ${r.name}: ${p}`);
  return failed.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
