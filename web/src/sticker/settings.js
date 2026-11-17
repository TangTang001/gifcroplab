export const STICKER_SIZE = 512;
export const MAX_FILE_BYTES = 20_000_000;
export const MAX_VIDEO_MS = 30_000;
export const MIN_CLIP_MS = 16;
export const MAX_CLIP_MS = 10_000;
export const MAX_STICKER_BYTES = 500_000;

export function squareCrop(width, height, position) {
  const side = Math.min(width, height);
  return { x: Math.round((width - side) * position), y: Math.round((height - side) * position), side };
}
