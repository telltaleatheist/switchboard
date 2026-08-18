import { nativeImage, type NativeImage } from 'electron';

/**
 * A simple generated placeholder icon: a flat 16x16 square in a single
 * accent color. Built from a raw RGBA buffer at runtime instead of shipping
 * a binary asset file — there is nothing to design-review yet, and this
 * keeps the app/ package free of binary checked-in assets. Swap for a real
 * icon whenever branding happens.
 */
export function createPlaceholderIcon(): NativeImage {
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
