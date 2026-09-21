// One-off script that hand-builds the PWA icon PNGs (no image libraries
// available/needed). Draws a simple dark rounded square with a two-peak
// mountain glyph in the accent color. Run with `node generate-icons.js`.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [15, 18, 23]; // #0f1217
const PEAK = [232, 115, 74]; // accent orange
const SNOW = [230, 236, 240];

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function pixelAt(x, y, size) {
  const cx = size / 2;
  const r = size * 0.47;
  const dx = x - cx;
  const dy = y - cx;
  const inCircle = dx * dx + dy * dy <= r * r;
  if (!inCircle) return null; // transparent handled as background fill instead

  // Two overlapping triangular peaks near the bottom two-thirds of the icon.
  const gy = y / size;
  const gx = x / size;
  const peak1 = Math.abs(gx - 0.38) < (0.62 - gy) * 0.55 && gy > 0.34 && gy < 0.66;
  const peak2 = Math.abs(gx - 0.66) < (0.72 - gy) * 0.5 && gy > 0.4 && gy < 0.72;
  const snowCap1 = peak1 && gy < 0.42;
  const snowCap2 = peak2 && gy < 0.48;

  if (snowCap1 || snowCap2) return SNOW;
  if (peak1 || peak2) return PEAK;
  return BG;
}

function buildPng(size) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0; // filter type 0
    for (let x = 0; x < size; x++) {
      const p = pixelAt(x, y, size) || BG;
      raw[offset++] = p[0];
      raw[offset++] = p[1];
      raw[offset++] = p[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw, { level: 9 });
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const outDir = path.join(__dirname, 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [32, 180, 192, 512]) {
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), buildPng(size));
  console.log('wrote icon-' + size + '.png');
}
