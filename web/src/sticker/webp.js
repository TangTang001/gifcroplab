import { encodeAnimation } from 'wasm-webp';
import { MAX_CLIP_MS, MAX_STICKER_BYTES, STICKER_SIZE } from './settings.js';

// wasm-webp omits the end timestamp, so libwebp otherwise estimates the last frame delay.
function restoreDuration(bytes, duration) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames = [];
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = view.getUint32(offset + 4, true);
    if (offset + 8 + size > bytes.length) throw new Error('The WebP encoder returned an incomplete file.');
    if (view.getUint32(offset, false) === 0x414e4d46 && size >= 16) {
      const delay = offset + 20;
      frames.push({ offset: delay, duration: bytes[delay] | bytes[delay + 1] << 8 | bytes[delay + 2] << 16 });
    }
    offset += 8 + size + (size % 2);
  }
  if (frames.length < 2) throw new Error('Choose a segment with more visible motion.');
  const last = frames.at(-1);
  const elapsed = frames.slice(0, -1).reduce((total, frame) => total + frame.duration, 0);
  const corrected = duration - elapsed;
  if (corrected < 8 || duration > MAX_CLIP_MS || frames.slice(0, -1).some(frame => frame.duration < 8)) {
    throw new Error('The WebP encoder returned invalid frame timings.');
  }
  bytes[last.offset] = corrected & 255;
  bytes[last.offset + 1] = (corrected >> 8) & 255;
  bytes[last.offset + 2] = corrected >> 16;
  return frames.length;
}

export async function encodeSticker(frames) {
  const duration = frames.reduce((sum, frame) => sum + frame.duration, 0);
  for (const [quality, stride] of [[72, 1], [42, 1], [42, 2], [24, 3]]) {
    const selected = [];
    for (let index = 0; index < frames.length; index += stride) {
      selected.push({
        data: frames[index].data,
        duration: frames.slice(index, index + stride).reduce((sum, frame) => sum + frame.duration, 0),
        config: { quality, lossless: 0 },
      });
    }
    if (selected.length < 2) break;
    const bytes = await encodeAnimation(STICKER_SIZE, STICKER_SIZE, true, selected);
    if (!bytes) throw new Error('Could not encode a WebP from this clip.');
    if (bytes.length <= MAX_STICKER_BYTES) {
      const frameCount = restoreDuration(bytes, duration);
      return { bytes, duration, frameCount, reducedMotion: stride > 1 };
    }
  }
  throw new Error('The result is still over 500 KB. Shorten the selected clip and try again.');
}
