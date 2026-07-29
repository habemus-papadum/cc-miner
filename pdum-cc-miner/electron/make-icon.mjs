/**
 * make-icon.mjs — draw build/icon.png, the source every platform icon derives from.
 *
 *   node electron/make-icon.mjs
 *
 * A committed generator rather than a committed binary blob nobody can edit:
 * the icon is three bars on a dark rounded square, which is a few lines of
 * arithmetic, and this way "make the middle bar taller" is a diff rather than a
 * trip through a drawing program.
 *
 * electron-builder derives `.icns` and every Linux size from a single ≥512px
 * `build/icon.png`, so this is the only raster that has to exist.
 *
 * PNG by hand, with no dependency: signature, IHDR, one zlib-compressed IDAT of
 * filter-0 scanlines, IEND. Node's zlib does the only hard part.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const SIZE = 1024;
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "build", "icon.png");

/** @param {string} hex @returns {[number, number, number]} */
const rgb = (hex) => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];

const BG = rgb("#14161a"); // --cco-bg, the app's own background
const BARS = [
  { x: 0.19, w: 0.15, top: 0.56, color: rgb("#58a6ff") },
  { x: 0.425, w: 0.15, top: 0.37, color: rgb("#7ee787") },
  { x: 0.66, w: 0.15, top: 0.19, color: rgb("#f0883e") },
];
const BASE = 0.81; // where every bar's foot sits
const RADIUS = 0.2237 * SIZE; // macOS's squircle corner ratio, near enough

/**
 * Coverage of a pixel by the rounded square, 0..1, sampled 3x3 for a soft edge.
 *
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
function bgCoverage(x, y) {
  let hits = 0;
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      const px = x + (sx + 0.5) / 3;
      const py = y + (sy + 0.5) / 3;
      // Distance into the corner region, if any.
      const dx = Math.max(RADIUS - px, px - (SIZE - RADIUS), 0);
      const dy = Math.max(RADIUS - py, py - (SIZE - RADIUS), 0);
      if (dx * dx + dy * dy <= RADIUS * RADIUS) hits++;
    }
  }
  return hits / 9;
}

const rows = [];
for (let y = 0; y < SIZE; y++) {
  const row = Buffer.alloc(1 + SIZE * 4); // leading filter byte, then RGBA
  for (let x = 0; x < SIZE; x++) {
    const cover = bgCoverage(x, y);
    let [r, g, b] = BG;
    for (const bar of BARS) {
      const x0 = bar.x * SIZE;
      const x1 = (bar.x + bar.w) * SIZE;
      if (x + 0.5 >= x0 && x + 0.5 < x1 && y + 0.5 >= bar.top * SIZE && y + 0.5 < BASE * SIZE) {
        [r, g, b] = bar.color;
      }
    }
    const o = 1 + x * 4;
    row[o] = r;
    row[o + 1] = g;
    row[o + 2] = b;
    row[o + 3] = Math.round(cover * 255);
  }
  rows.push(row);
}

/** @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
/** @param {Buffer} buf */
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
console.log(`  ${OUT}  ${SIZE}×${SIZE}, ${(png.length / 1024).toFixed(1)} kB`);
