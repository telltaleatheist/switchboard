import { nativeImage, type NativeImage } from 'electron';
import { iconPath } from './paths';

/**
 * Loads the real app icon (build-resources/icon.png in dev, resources/icon.png
 * packaged). If the file is missing the old generated placeholder square comes
 * back instead — with a loud stderr line, never silently: a wrong-looking tray
 * icon should say why.
 */
export function loadAppIcon(): NativeImage {
  const image = nativeImage.createFromPath(iconPath());
  if (!image.isEmpty()) return image;
  console.error(`[switchboard-app] app icon not found at ${iconPath()}; using placeholder`);
  return createPlaceholderIcon();
}

/** The app icon scaled for the system tray (Windows wants 16px there). */
export function loadTrayIcon(): NativeImage {
  const image = loadAppIcon();
  return image.isEmpty() ? image : image.resize({ width: 16, height: 16 });
}

/**
 * A simple generated placeholder icon: a flat 16x16 square in a single
 * accent color, built from a raw RGBA buffer. Kept only as the loud fallback
 * for a missing icon file.
 */
function createPlaceholderIcon(): NativeImage {
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);

  // Flat teal-blue square, fully opaque.
  const r = 0x2b;
  const g = 0x8a;
  const b = 0xc8;
  const a = 0xff;

  for (let i = 0; i < size * size; i++) {
    buffer[i * 4 + 0] = r;
    buffer[i * 4 + 1] = g;
    buffer[i * 4 + 2] = b;
    buffer[i * 4 + 3] = a;
  }

  return nativeImage.createFromBuffer(buffer, { width: size, height: size });
}
