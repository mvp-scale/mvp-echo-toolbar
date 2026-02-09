#!/usr/bin/env node
/**
 * Generate tray icon PNGs from the same SVG paths used in the welcome screen.
 * Outputs 32x32 PNG files for each tray state color.
 *
 * Usage: node scripts/generate-tray-icons.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ICON_SIZE = 32;
const VIEWBOX = 24; // SVG viewBox is 0 0 24 24
const SCALE = ICON_SIZE / VIEWBOX;

const STATES = {
  ready:      '#4285f4',
  recording:  '#ea4335',
  processing: '#f57c00',
  done:       '#34a853',
  error:      '#9aa0a6',
};

const OUTPUT_DIR = path.join(__dirname, '..', 'app', 'main', 'icons');

// -- SVG path rasterization --

/**
 * Parse a simplified SVG path into line segments for point-in-polygon testing.
 * Supports M, C, V, H, Z commands (absolute only).
 */
function parseSVGPath(d) {
  const commands = [];
  const regex = /([MCLHVZmclhvz])([^MCLHVZmclhvz]*)/g;
  let match;
  while ((match = regex.exec(d)) !== null) {
    const cmd = match[1];
    const args = match[2].trim().split(/[\s,]+/).filter(s => s).map(Number);
    commands.push({ cmd, args });
  }
  return commands;
}

/**
 * Convert parsed SVG path commands to a polygon (array of {x,y} points).
 * Approximates cubic bezier curves with line segments.
 */
function pathToPolygon(d) {
  const commands = parseSVGPath(d);
  const points = [];
  let cx = 0, cy = 0;

  for (const { cmd, args } of commands) {
    switch (cmd) {
      case 'M':
        cx = args[0]; cy = args[1];
        points.push({ x: cx, y: cy });
        // Implicit lineTo for additional pairs
        for (let i = 2; i < args.length; i += 2) {
          cx = args[i]; cy = args[i + 1];
          points.push({ x: cx, y: cy });
        }
        break;
      case 'L':
        for (let i = 0; i < args.length; i += 2) {
          cx = args[i]; cy = args[i + 1];
          points.push({ x: cx, y: cy });
        }
        break;
      case 'H':
        for (const a of args) {
          cx = a;
          points.push({ x: cx, y: cy });
        }
        break;
      case 'V':
        for (const a of args) {
          cy = a;
          points.push({ x: cx, y: cy });
        }
        break;
      case 'C':
        // Cubic bezier: approximate with 8 segments per curve
        for (let i = 0; i < args.length; i += 6) {
          const x0 = cx, y0 = cy;
          const x1 = args[i], y1 = args[i + 1];
          const x2 = args[i + 2], y2 = args[i + 3];
          const x3 = args[i + 4], y3 = args[i + 5];
          const steps = 8;
          for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            const mt = 1 - t;
            const px = mt * mt * mt * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3;
            const py = mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3;
            points.push({ x: px, y: py });
          }
          cx = x3; cy = y3;
        }
        break;
      case 'Z':
      case 'z':
        // Close path - connect back to start
        if (points.length > 0) {
          points.push({ x: points[0].x, y: points[0].y });
        }
        break;
    }
  }
  return points;
}

/**
 * Test if a point is inside a polygon using ray-casting.
 */
function pointInPolygon(px, py, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

// -- Microphone SVG paths (from welcome screen) --

// Mic body capsule
const MIC_BODY = "M12 5C10.9 5 10 5.9 10 7V12C10 13.1 10.9 14 12 14C13.1 14 14 13.1 14 12V7C14 5.9 13.1 5 12 5Z";
// Mic cradle + stand
const MIC_CRADLE = "M16.5 12C16.5 14.5 14.5 16.5 12 16.5C9.5 16.5 7.5 14.5 7.5 12H6C6 15.1 8.5 17.6 11.5 18V19.5H12.5V18C15.5 17.6 18 15.1 18 12H16.5Z";

const micBodyPoly = pathToPolygon(MIC_BODY);
const micCradlePoly = pathToPolygon(MIC_CRADLE);

/**
 * Check if a pixel (in viewBox coordinates) is part of the microphone.
 */
function isMicPixel(vx, vy) {
  return pointInPolygon(vx, vy, micBodyPoly) || pointInPolygon(vx, vy, micCradlePoly);
}

/**
 * Compute rounded-rect alpha for a pixel (in viewBox coordinates).
 * rx=6 on a 24x24 viewBox.
 */
function squircleAlpha(vx, vy) {
  const size = VIEWBOX;
  const r = 6;

  let dx = 0, dy = 0;
  if (vx < r) dx = r - vx;
  else if (vx > size - r) dx = vx - (size - r);
  if (vy < r) dy = r - vy;
  else if (vy > size - r) dy = vy - (size - r);

  if (dx <= 0 && dy <= 0) return 1.0;

  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist <= r - 0.5) return 1.0;
  if (dist > r + 0.5) return 0.0;
  return Math.max(0, Math.min(1, r + 0.5 - dist));
}

/**
 * Render a single icon at ICON_SIZE x ICON_SIZE.
 */
function renderIcon(hexColor) {
  const canvas = Buffer.alloc(ICON_SIZE * ICON_SIZE * 4, 0);

  const r = parseInt(hexColor.slice(1, 3), 16);
  const g = parseInt(hexColor.slice(3, 5), 16);
  const b = parseInt(hexColor.slice(5, 7), 16);

  // Supersample 4x for anti-aliasing
  const SS = 4;

  for (let py = 0; py < ICON_SIZE; py++) {
    for (let px = 0; px < ICON_SIZE; px++) {
      let bgAlphaSum = 0;
      let micAlphaSum = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          // Map pixel sub-sample to viewBox coordinates
          const vx = ((px + (sx + 0.5) / SS) / ICON_SIZE) * VIEWBOX;
          const vy = ((py + (sy + 0.5) / SS) / ICON_SIZE) * VIEWBOX;

          const sqAlpha = squircleAlpha(vx, vy);
          if (sqAlpha <= 0) continue;

          bgAlphaSum += sqAlpha;
          if (isMicPixel(vx, vy)) {
            micAlphaSum += sqAlpha;
          }
        }
      }

      const totalSamples = SS * SS;
      const bgCoverage = bgAlphaSum / totalSamples;
      const micCoverage = micAlphaSum / totalSamples;

      if (bgCoverage <= 0) continue;

      const idx = (py * ICON_SIZE + px) * 4;
      const alpha = Math.round(bgCoverage * 255);

      // Blend: mic pixels are white, bg pixels are the state color
      const micFrac = micCoverage / bgCoverage;
      canvas[idx]     = Math.round(r * (1 - micFrac) + 255 * micFrac);
      canvas[idx + 1] = Math.round(g * (1 - micFrac) + 255 * micFrac);
      canvas[idx + 2] = Math.round(b * (1 - micFrac) + 255 * micFrac);
      canvas[idx + 3] = alpha;
    }
  }

  return canvas;
}

// -- PNG encoding --

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? ((crc >>> 1) ^ 0xedb88320) : (crc >>> 1);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeBuffer, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function createPNG(rgba, width, height) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = y * (1 + width * 4) + 1 + x * 4;
      rawData[dst] = rgba[src];
      rawData[dst + 1] = rgba[src + 1];
      rawData[dst + 2] = rgba[src + 2];
      rawData[dst + 3] = rgba[src + 3];
    }
  }

  const compressed = zlib.deflateSync(rawData);
  return Buffer.concat([
    signature,
    createChunk('IHDR', ihdr),
    createChunk('IDAT', compressed),
    createChunk('IEND', Buffer.alloc(0)),
  ]);
}

// -- Main --

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

for (const [state, color] of Object.entries(STATES)) {
  const rgba = renderIcon(color);
  const png = createPNG(rgba, ICON_SIZE, ICON_SIZE);
  const outPath = path.join(OUTPUT_DIR, `tray-${state}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`Generated: ${outPath} (${png.length} bytes)`);
}

console.log('Done. All tray icons generated.');
