/**
 * Image accounting — estimated, because exact attribution is impossible.
 *
 * Anthropic bills images as ordinary input tokens: `message.usage` has no image
 * counter, and no price table carries an Anthropic image rate (genai-prices has
 * no image category at all; LiteLLM's image fields exist but Anthropic models
 * only declare `supports_vision` — correctly, since there is no separate rate).
 *
 * What we *can* do is read each image's dimensions straight out of its header
 * and apply Anthropic's published approximation, `tokens ≈ w × h / 750`.
 * Verified on the baseline corpus: 148/148 images yielded dimensions.
 *
 * The caveat that must reach the UI: this is an approximation of an
 * approximation. Claude Code may downscale before sending, so these numbers
 * carry a systematic upward bias, and there is no ground-truth counter to
 * reconcile against — the one place in this pipeline with no check.
 *
 * Why it still matters: an image, once in context, is re-read as **cache-read
 * tokens on every subsequent turn until compaction**, and cache reads are 62.7%
 * of spend. The interesting quantity is not what an image cost once, but how
 * many turns it rode along for.
 */

import type { Rec } from "./fields.ts";
import { arr, obj, str } from "./fields.ts";

/** Anthropic's documented approximation. */
export const IMAGE_TOKENS_PER_PIXEL = 1 / 750;

export interface ImageDims {
  width: number;
  height: number;
}

/**
 * PNG: dimensions live in the IHDR chunk, always the first chunk, at a fixed
 * offset. 24 bytes is enough — no need to decode a 600 KB payload.
 */
export function pngDims(bytes: Uint8Array): ImageDims | undefined {
  if (bytes.length < 24) return undefined;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return undefined;
  if (String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") return undefined;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

/**
 * JPEG: walk the marker segments to the first SOFn frame header. Needs more of
 * the file than PNG, but still stops at the frame header rather than decoding.
 */
export function jpegDims(bytes: Uint8Array): ImageDims | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 2;
  while (i < bytes.length - 9) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1];
    // SOF0/1/2/3 carry the frame header; SOF4+ are arithmetic/progressive
    // variants that share the layout, but these four cover everything Claude
    // Code has emitted.
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
    }
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) {
      i += 2;
      continue;
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      i += 2;
      continue;
    }
    i += 2 + dv.getUint16(i + 2);
  }
  return undefined;
}

export function imageDims(mediaType: string | undefined, bytes: Uint8Array): ImageDims | undefined {
  if (mediaType === "image/png") return pngDims(bytes);
  if (mediaType === "image/jpeg" || mediaType === "image/jpg") return jpegDims(bytes);
  // Unknown type: try both rather than give up — media_type is self-reported.
  return pngDims(bytes) ?? jpegDims(bytes);
}

export const estimateImageTokens = (d: ImageDims): number =>
  Math.round(d.width * d.height * IMAGE_TOKENS_PER_PIXEL);

/** Where an image payload was found. All three sit on `user` records. */
export type ImageCarrier = "content" | "tool_result" | "toolUseResult";

export interface ImageRef {
  carrier: ImageCarrier;
  mediaType?: string;
  /** Length of the base64 string — a cheap proxy for payload weight. */
  base64Length: number;
  width?: number;
  height?: number;
  estTokens?: number;
  /** FNV-1a of the base64, to spot the same screenshot pasted twice. */
  hash: string;
}

/**
 * PNG needs 24 bytes; JPEG may need to walk several segments. Decoding 4 KB of
 * base64 covers both without materialising a multi-megabyte buffer per image.
 */
const HEADER_B64_CHARS = 8192;

function decodeHeader(b64: string): Uint8Array {
  const slice = b64.slice(0, HEADER_B64_CHARS);
  const padded = slice.slice(0, slice.length - (slice.length % 4));
  try {
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array(0);
  }
}

/** FNV-1a over the base64 text. Not cryptographic — just a dedup key. */
function hash64(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16)}-${s.length.toString(36)}`;
}

function refFrom(source: unknown, carrier: ImageCarrier): ImageRef | undefined {
  const src = obj(source);
  const data = str(src?.data);
  if (!data) return undefined;
  const mediaType = str(src?.media_type);
  const dims = imageDims(mediaType, decodeHeader(data));
  return {
    carrier,
    mediaType,
    base64Length: data.length,
    width: dims?.width,
    height: dims?.height,
    estTokens: dims ? estimateImageTokens(dims) : undefined,
    hash: hash64(data),
  };
}

/**
 * Every image payload on one record. Images ride in three places, all on `user`
 * records; `toolUseResult[]` is a sidecar copy of the `tool_result` content, so
 * callers that want distinct images should dedup on `hash`.
 */
export function imageRefs(rec: Rec): ImageRef[] {
  const out: ImageRef[] = [];
  for (const block of arr(obj(rec.message)?.content)) {
    const b = obj(block);
    if (!b) continue;
    if (b.type === "image") {
      const r = refFrom(b.source, "content");
      if (r) out.push(r);
    }
    // A Read of an image, or a screenshot tool, returns image blocks nested
    // inside the tool_result block's own content array.
    for (const sub of arr(b.content)) {
      const s = obj(sub);
      if (s?.type === "image") {
        const r = refFrom(s.source, "tool_result");
        if (r) out.push(r);
      }
    }
  }
  for (const item of arr(rec.toolUseResult)) {
    const it = obj(item);
    if (it?.type === "image") {
      const r = refFrom(it.source, "toolUseResult");
      if (r) out.push(r);
    }
  }
  return out;
}
