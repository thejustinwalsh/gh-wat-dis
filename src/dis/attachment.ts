import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, inflateSync } from 'node:zlib';
import { Resvg } from '@resvg/resvg-js';
import { toPng } from '../tools/raster.ts';
import type { Artifact } from './cache.ts';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_SIDE = 10000;
const MAX_PIXELS = 20_000_000;

/** Download only GitHub-served attachments, never forwarding gh credentials. Check every redirect. */
export function attachmentUrl(raw: string): URL {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  const allowed = host === 'github.com' && /^\/user-attachments\/assets\//.test(url.pathname)
    || host === 'user-images.githubusercontent.com' || host === 'private-user-images.githubusercontent.com'
    || host === 'objects.githubusercontent.com' || /^github-production-user-asset-[\w-]+\.s3\.amazonaws\.com$/.test(host);
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || !allowed) throw new Error('the image is not a supported HTTPS GitHub attachment');
  return url;
}

export function attachmentLinks(body: string): string[] {
  const md = [...body.matchAll(/!\[[^\]\n]*\]\(\s*<?(https:\/\/[^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/gi)].map((m) => m[1]!);
  const html = [...body.matchAll(/<img\b[^>]*\bsrc=["'](https:\/\/[^"']+)["'][^>]*>/gi)].map((m) => m[1]!);
  return [...new Set([...md, ...html])].slice(0, 4);
}

export async function downloadAttachment(raw: string, fetcher: typeof fetch = fetch): Promise<Uint8Array> {
  let url = attachmentUrl(raw);
  const signal = AbortSignal.timeout(15000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetcher(url, { redirect: 'manual', signal, headers: { Accept: 'image/svg+xml,image/png,image/jpeg,image/gif,image/webp' } });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error('the attachment redirect has no destination');
      url = attachmentUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`the attachment could not be downloaded (HTTP ${response.status})`); }
    if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); throw new Error('the attachment is larger than 10 MiB'); }
    if (!response.body) throw new Error('the attachment response is empty');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) throw new Error('the attachment is larger than 10 MiB');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
  }
  throw new Error('the attachment redirected more than five times');
}

/** Validate image bytes before publishing them. SVGs may contain no active or external resources. */
export function saveAttachment(bytes: Uint8Array, directory: string): Partial<Record<Artifact, string>> {
  const data = Buffer.from(bytes);
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (data.length < 33 || data.toString('ascii', 12, 16) !== 'IHDR') throw new Error('the PNG attachment has no image header');
    const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
    if (!width || !height || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) throw new Error('the attachment image is too large to preview');
    const depth = data[24]!, colour = data[25]!, channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colour];
    const depths = colour === 0 ? [1, 2, 4, 8, 16] : colour === 3 ? [1, 2, 4, 8] : [8, 16];
    if (!channels || !depths.includes(depth) || data[26] !== 0 || data[27] !== 0 || data[28] !== 0) throw new Error('the attachment PNG uses an unsupported image encoding');
    const compressed: Buffer[] = [];
    let ended = false, header = false, palette = 0;
    let phase: 'before' | 'during' | 'after' = 'before';
    for (let at = 8; at + 12 <= data.length;) {
      const length = data.readUInt32BE(at), end = at + 8 + length;
      if (end + 4 > data.length || crc32(data.subarray(at + 4, end)) !== data.readUInt32BE(end)) throw new Error('the attachment PNG is truncated or has a damaged chunk');
      const type = data.toString('ascii', at + 4, at + 8);
      if (!/^[A-Za-z]{4}$/.test(type) || !header && type !== 'IHDR') throw new Error('the attachment PNG has an invalid chunk order');
      if (type === 'IHDR') {
        if (header || at !== 8 || length !== 13) throw new Error('the attachment PNG needs one first IHDR chunk');
        header = true;
      } else if (type === 'PLTE') {
        if (palette || phase !== 'before' || colour === 0 || colour === 4 || !length || length % 3 || length > 768 || colour === 3 && length / 3 > 2 ** depth) throw new Error('the attachment PNG has an invalid or misplaced palette');
        palette = length / 3;
      } else if (type === 'IDAT') {
        if (phase === 'after' || colour === 3 && !palette) throw new Error('the attachment PNG needs contiguous image data and an indexed palette before it');
        phase = 'during'; compressed.push(data.subarray(at + 8, end));
      } else if (type === 'IEND') {
        ended = phase !== 'before' && end + 4 === data.length && length === 0;
        break;
      } else {
        if ((type.charCodeAt(0) & 32) === 0) throw new Error(`the attachment PNG has an unknown critical chunk ${type}`);
        if (phase === 'during') phase = 'after';
      }
      at = end + 4;
    }
    if (!ended || !compressed.length) throw new Error('the attachment PNG has no complete image data');
    const stride = Math.ceil(width * channels * depth / 8) + 1, expected = stride * height;
    const pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
    if (pixels.length !== expected) throw new Error('the attachment PNG has incomplete pixel data');
    for (let row = 0; row < height; row++) if (pixels[row * stride]! > 4) throw new Error('the attachment PNG has an invalid scanline');
    writeFileSync(join(directory, 'diagram.png'), data);
    return { png: 'diagram.png' };
  }
  const text = data.toString('utf8').replace(/^\uFEFF/, '').trim();
  if (/^(?:<\?xml[^>]*>\s*)?<svg\b/i.test(text) && /<\/svg>\s*$/i.test(text)) {
    const plain = text.replace(/^<\?xml\s+[^?]*\?>\s*/i, '');
    if (/<\s*\/?\s*[^\s<>/]+:|<\?|\bxml:base\s*=/i.test(plain)) throw new Error('the SVG attachment contains namespaced elements or processing instructions');
    const decoded = plain.replace(/&#(?:x([a-f\d]+)|(\d+));/gi, (_, hex: string | undefined, decimal: string | undefined) => String.fromCodePoint(parseInt(hex ?? decimal!, hex ? 16 : 10)));
    const resources = decoded.replace(/url\(\s*['"]?#[\w:.-]+['"]?\s*\)/gi, '');
    if (data.length > 1024 * 1024 || /<!DOCTYPE|<!ENTITY|<\s*(?:script|foreignObject|iframe|object|embed|image|use|feImage|filter|animate\w*|set)\b|\b(?:[\w-]+:)?href\s*=|\bon\w+\s*=|url\s*\(|@import|\\/i.test(resources)) throw new Error('the SVG attachment contains active or external resources');
    // The preview renderer resolves viewBox, CSS sizes and XML for us. Bound intrinsic size before rasterizing.
    const svg = new Resvg(text, { font: { loadSystemFonts: false } });
    const width = svg.width, height = svg.height;
    if (!Number.isFinite(width * height) || width <= 0 || height <= 0 || width > MAX_SIDE / 2 || height > MAX_SIDE / 2 || width * height * 4 > MAX_PIXELS) throw new Error('the attachment image is too large to preview');
    const png = toPng(text).png;
    writeFileSync(join(directory, 'diagram.svg'), data);
    writeFileSync(join(directory, 'diagram.png'), png);
    return { svg: 'diagram.svg', png: 'diagram.png' };
  }
  throw new Error('the attachment is not a supported PNG or SVG image');
}
