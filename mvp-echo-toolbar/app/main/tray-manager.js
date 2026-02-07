/**
 * Tray Manager - System tray icon with state management
 * Generates icons programmatically (no external icon files needed)
 */

const { Tray, Menu, nativeImage } = require('electron');

// Tray states
const STATES = {
  ready: { color: '#4285f4', tooltip: 'MVP-Echo - Ready (Ctrl+Alt+Z)' },
  recording: { color: '#ea4335', tooltip: 'MVP-Echo - Recording...' },
  processing: { color: '#fbbc04', tooltip: 'MVP-Echo - Processing...' },
  done: { color: '#34a853', tooltip: 'MVP-Echo - Copied!' },
  error: { color: '#9aa0a6', tooltip: 'MVP-Echo - Error' },
};

class TrayManager {
  constructor() {
    this.tray = null;
    this.state = 'ready';
    this.doneTimeout = null;
    this.onTogglePopup = null;
    this.onQuit = null;
    this.iconCache = {};
  }

  /**
   * Create a 16x16 tray icon with a colored circle and microphone silhouette
   */
  createIcon(color) {
    if (this.iconCache[color]) {
      return this.iconCache[color];
    }

    // Create a 16x16 PNG via data URL
    // Using a simple canvas-like approach with raw pixel data
    const size = 16;
    const canvas = Buffer.alloc(size * size * 4, 0); // RGBA

    const hexToRgb = (hex) => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return { r, g, b };
    };

    const rgb = hexToRgb(color);
    const cx = 7.5, cy = 7.5, radius = 7;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const idx = (y * size + x) * 4;

        if (dist <= radius) {
          // Anti-aliasing at edge
          const alpha = dist > radius - 1 ? Math.max(0, (radius - dist)) * 255 : 255;

          // Check if pixel is part of microphone silhouette (white)
          const isMic = this.isMicrophonePixel(x, y, size);

          if (isMic) {
            canvas[idx] = 255;     // R
            canvas[idx + 1] = 255; // G
            canvas[idx + 2] = 255; // B
            canvas[idx + 3] = Math.round(alpha); // A
          } else {
            canvas[idx] = rgb.r;
            canvas[idx + 1] = rgb.g;
            canvas[idx + 2] = rgb.b;
            canvas[idx + 3] = Math.round(alpha);
          }
        }
      }
    }

    const icon = nativeImage.createFromBuffer(this.createPNG(canvas, size, size), {
      width: size,
      height: size,
    });

    this.iconCache[color] = icon;
    return icon;
  }

  /**
   * Check if a pixel is part of the microphone silhouette
   */
  isMicrophonePixel(x, y, _size) {
    // Microphone body (vertical rectangle centered)
    if (x >= 6 && x <= 9 && y >= 2 && y <= 8) return true;
    // Microphone base arc (bottom curve)
    if (y === 10 && x >= 4 && x <= 11) return true;
    if (y === 9 && (x === 4 || x === 11)) return true;
    // Stand
    if (x >= 7 && x <= 8 && y >= 11 && y <= 12) return true;
    // Base
    if (x >= 5 && x <= 10 && y === 13) return true;

    return false;
  }

  /**
   * Create a minimal PNG from raw RGBA buffer
   */
  createPNG(data, width, height) {
    // PNG signature
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

    // IHDR chunk
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 6;  // color type (RGBA)
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace

    const ihdrChunk = this.createChunk('IHDR', ihdr);

    // IDAT chunk - raw image data with filter bytes
    const rawData = Buffer.alloc(height * (1 + width * 4));
    for (let y = 0; y < height; y++) {
      rawData[y * (1 + width * 4)] = 0; // filter: none
      for (let x = 0; x < width; x++) {
        const srcIdx = (y * width + x) * 4;
        const dstIdx = y * (1 + width * 4) + 1 + x * 4;
        rawData[dstIdx] = data[srcIdx];
        rawData[dstIdx + 1] = data[srcIdx + 1];
        rawData[dstIdx + 2] = data[srcIdx + 2];
        rawData[dstIdx + 3] = data[srcIdx + 3];
      }
    }

    const zlib = require('zlib');
    const compressed = zlib.deflateSync(rawData);
    const idatChunk = this.createChunk('IDAT', compressed);

    // IEND chunk
    const iendChunk = this.createChunk('IEND', Buffer.alloc(0));

    return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
  }

  /**
   * Create a PNG chunk with CRC
   */
  createChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);

    const typeBuffer = Buffer.from(type, 'ascii');
    const crcData = Buffer.concat([typeBuffer, data]);

    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(this.crc32(crcData) >>> 0, 0);

    return Buffer.concat([length, typeBuffer, data, crc]);
  }

  /**
   * CRC32 for PNG chunks
   */
  crc32(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i];
      for (let j = 0; j < 8; j++) {
        if (crc & 1) {
          crc = (crc >>> 1) ^ 0xedb88320;
        } else {
          crc = crc >>> 1;
        }
      }
    }
    return crc ^ 0xffffffff;
  }

  /**
   * Initialize the tray icon
   */
  create(callbacks = {}) {
    this.onTogglePopup = callbacks.onTogglePopup || (() => {});
    this.onQuit = callbacks.onQuit || (() => {});

    const icon = this.createIcon(STATES.ready.color);
    this.tray = new Tray(icon);
    this.tray.setToolTip(STATES.ready.tooltip);

    // Left-click toggles popup
    this.tray.on('click', () => {
      this.onTogglePopup();
    });

    // Right-click context menu
    this.updateContextMenu();

    return this.tray;
  }

  updateContextMenu() {
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show Transcription',
        click: () => this.onTogglePopup(),
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => this.onQuit(),
      },
    ]);
    this.tray.setContextMenu(contextMenu);
  }

  /**
   * Update tray state (icon + tooltip)
   */
  setState(state) {
    if (!this.tray || !STATES[state]) return;

    // Clear any pending done→ready timeout
    if (this.doneTimeout) {
      clearTimeout(this.doneTimeout);
      this.doneTimeout = null;
    }

    this.state = state;
    const stateConfig = STATES[state];
    this.tray.setImage(this.createIcon(stateConfig.color));
    this.tray.setToolTip(stateConfig.tooltip);

    // Auto-revert done → ready after 3 seconds
    if (state === 'done') {
      this.doneTimeout = setTimeout(() => {
        this.setState('ready');
      }, 3000);
    }
  }

  /**
   * Get tray bounds for popup positioning
   */
  getBounds() {
    if (!this.tray) return null;
    return this.tray.getBounds();
  }

  destroy() {
    if (this.doneTimeout) {
      clearTimeout(this.doneTimeout);
    }
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

module.exports = TrayManager;
