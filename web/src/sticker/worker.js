import { composedGifFrames, cropA } from '../gif/engine-a.js';
import { inspectGIF } from '../gif/inspect.js';
import { MAX_CLIP_MS, MIN_CLIP_MS, MAX_FILE_BYTES, STICKER_SIZE, squareCrop } from './settings.js';

function inspectAnimation(buffer) {
  const gif = inspectGIF(buffer);
  if (gif.frames.length < 2) throw new Error('Choose an animated GIF with at least two frames.');
  if (gif.plainText || !gif.trailer) throw new Error('This GIF could not be read as an animation.');
  const delays = gif.frames.map(frame => frame.delay || 100);
  return { gif, delays, meta: { width: gif.width, height: gif.height, duration: delays.reduce((sum, delay) => sum + delay, 0), rotation: 0 } };
}

function renderFrames(meta, position) {
  const { x, y, side } = squareCrop(meta.width, meta.height, position);
  const size = STICKER_SIZE;
  const context = new OffscreenCanvas(size, size).getContext('2d', { willReadFrequently: true });
  const frames = [];
  let lastImage;
  return {
    frames,
    add(image, duration, repeated = false) {
      if (repeated && lastImage === image && frames.length) {
        frames.at(-1).duration += duration;
        return;
      }
      lastImage = image;
      context.clearRect(0, 0, size, size);
      if (meta.rotation) {
        const scale = size / side;
        context.save();
        context.translate((meta.width / 2 - x) * scale, (meta.height / 2 - y) * scale);
        context.rotate(meta.rotation * Math.PI / 180);
        context.drawImage(image, -image.displayWidth * scale / 2, -image.displayHeight * scale / 2,
          image.displayWidth * scale, image.displayHeight * scale);
        context.restore();
      } else {
        context.drawImage(image, x, y, side, side, 0, 0, size, size);
      }
      const { data } = context.getImageData(0, 0, size, size);
      frames.push({ data: new Uint8Array(data.buffer), duration });
    },
  };
}

function renderGif(buffer, gif, delays, start, end, add) {
  let time = 0;
  const overlaps = delays.map(delay => {
    const overlap = Math.max(0, Math.min(time + delay, end) - Math.max(time, start));
    time += delay;
    return overlap;
  });
  const stride = Math.ceil(overlaps.filter(Boolean).length / 100);
  const source = new OffscreenCanvas(gif.width, gif.height);
  const context = source.getContext('2d');
  let selected = 0;
  let duration = 0;
  for (const { canvas, index } of composedGifFrames(buffer, gif)) {
    const overlap = overlaps[index];
    if (!overlap) continue;
    if (selected % stride === 0) {
      if (duration >= 8) {
        add(source, duration);
        duration = 0;
      }
      if (duration === 0) context.putImageData(new ImageData(canvas, gif.width, gif.height), 0, 0);
    }
    duration += overlap;
    selected++;
  }
  if (duration >= 8) add(source, duration);
}

self.onmessage = async ({ data: { buffer, kind, clip } }) => {
  try {
    if (buffer.byteLength > MAX_FILE_BYTES) throw new Error('Choose a file of 20 MB or less.');
    const mp4 = kind === 'mp4' ? await import('./mp4.js') : undefined;
    const { meta, gif, delays, track, samples } = mp4 ? await mp4.readMp4(buffer, Boolean(clip)) : inspectAnimation(buffer);
    if (!clip) {
      self.postMessage({ meta });
      return;
    }

    const { start, end, position } = clip;
    if (![start, end].every(Number.isInteger) || start < 0 || end > meta.duration ||
        end - start < MIN_CLIP_MS || end - start > MAX_CLIP_MS || !(position >= 0 && position <= 1)) {
      throw new Error('Choose a valid clip of up to 10 seconds.');
    }
    if (clip.preview && gif) {
      const frameDelays = new Map();
      let time = 0;
      for (const [index, delay] of delays.entries()) {
        if (time >= end) break;
        const from = Math.max(time, start);
        time += delay;
        const to = Math.min(time, end);
        if (to <= from) continue;
        const duration = 10 * (Math.round((to - start) / 10) - Math.round((from - start) / 10));
        if (duration > 0) frameDelays.set(index, duration);
      }
      const rect = { x: 0, y: 0, width: gif.width, height: gif.height };
      const { bytes } = cropA(buffer, rect, { ...gif, loop: 0 }, false, frameDelays);
      self.postMessage({ bytes }, [bytes.buffer]);
      return;
    }
    const { frames, add } = renderFrames(meta, position);
    if (mp4) {
      await mp4.readVideoFrames(track, samples, start, end, (image, duration) => add(image, duration, true));
    } else {
      renderGif(buffer, gif, delays, start, end, add);
    }
    if (frames.length < 2) throw new Error('Choose a segment with at least two frames of motion.');
    const remainder = end - start - frames.reduce((sum, frame) => sum + frame.duration, 0);
    if (remainder < 0 || remainder >= 8) throw new Error('Could not read the entire selected clip.');
    frames.at(-1).duration += remainder;
    const { encodeSticker } = await import('./webp.js');
    const result = await encodeSticker(frames);
    self.postMessage(result, [result.bytes.buffer]);
  } catch (error) {
    self.postMessage({ error: error.code ? 'This GIF could not be read or exceeds the processing limits.' : error.message || 'The file could not be processed.' });
  }
};
