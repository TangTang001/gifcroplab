import { createFile, DataStream, MP4BoxBuffer } from 'mp4box';
import { LIMITS } from '../config.js';
import { MAX_VIDEO_MS } from './settings.js';

export function readMp4(buffer, extract) {
  const file = createFile();
  return new Promise((resolve, reject) => {
    file.onError = () => reject(new Error('This MP4 could not be read.'));
    file.onReady = info => {
      const track = info.videoTracks[0];
      if (!track?.codec.startsWith('avc1.')) throw new Error('Choose an MP4 encoded with H.264.');
      const { width, height } = track.video;
      const duration = Math.round(1000 * (track.movie_duration / track.movie_timescale || track.duration / track.timescale));
      if (!(duration > 0)) throw new Error('This MP4 has no readable duration.');
      if (duration > MAX_VIDEO_MS) throw new Error('Choose an MP4 that is 30 seconds or shorter.');
      if (!(width > 0 && height > 0 && width * height <= LIMITS.maxCanvasPixels)) {
        throw new Error('Video dimensions are too large. Try an MP4 at 1080p.');
      }
      const rotation = Math.round(Math.atan2(track.matrix[1], track.matrix[0]) * 2 / Math.PI) * 90;
      const portrait = Math.abs(rotation) === 90;
      const meta = { width: portrait ? height : width, height: portrait ? width : height, duration, rotation };
      if (!extract) {
        resolve({ meta });
        return;
      }
      if (!track.nb_samples || track.nb_samples > 3600) throw new Error('This MP4 has an unsupported frame count.');
      const samples = [];
      file.onSamples = (_, __, batch) => {
        samples.push(...batch);
        if (samples.length === track.nb_samples) resolve({ meta, track, samples });
      };
      file.setExtractionOptions(track.id, null, { nbSamples: 100 });
      file.start();
    };
    file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buffer, 0));
    file.flush();
    reject(new Error('This MP4 could not be read.'));
  });
}

export async function readVideoFrames(track, samples, start, end, addFrame) {
  if (typeof VideoDecoder === 'undefined') throw new Error('MP4 conversion requires a browser with WebCodecs. Try current Chrome or Safari.');
  const entry = samples[0].description;
  if (!entry.avcC) throw new Error('This MP4 is missing H.264 decoder settings.');
  const stream = new DataStream();
  entry.avcC.write(stream);
  const config = { codec: track.codec, description: new Uint8Array(stream.buffer, 8) };
  if (!(await VideoDecoder.isConfigSupported(config)).supported) {
    throw new Error('This browser cannot decode this H.264 video.');
  }

  const firstCts = samples.reduce((min, sample) => Math.min(min, sample.cts), Infinity);
  const firstEdit = track.edits?.find(edit => edit.media_time >= 0);
  const origin = firstEdit?.media_time ?? firstCts;
  let next = start;
  let previous;
  let failure;
  let unblock;
  const decoder = new VideoDecoder({
    output(frame) {
      const time = frame.timestamp / 1000;
      try {
        if (time >= next) {
          while (next < end && next < time) {
            const duration = Math.min(100, end - next);
            if (duration >= 8) addFrame(previous || frame, duration);
            next += duration;
          }
        }
        previous?.close();
        previous = frame;
      } catch (error) {
        failure = error;
        frame.close();
        unblock?.();
      }
    },
    error(error) { failure = error; unblock?.(); },
  });
  decoder.addEventListener('dequeue', () => unblock?.());

  try {
    decoder.configure(config);
    for (const sample of samples) {
      if (decoder.decodeQueueSize >= 8) await new Promise(resolve => { unblock = resolve; });
      unblock = undefined;
      if (failure) throw failure;
      if (next >= end) break;
      if (sample.description !== entry) throw new Error('This MP4 changes encoding settings mid-video.');
      decoder.decode(new EncodedVideoChunk({
        type: sample.is_sync ? 'key' : 'delta',
        timestamp: Math.round((sample.cts - origin) * 1_000_000 / sample.timescale),
        data: sample.data,
      }));
    }
    await decoder.flush();
    if (failure) throw failure;
    if (previous) {
      while (end - next >= 8) {
        const duration = Math.min(100, end - next);
        addFrame(previous, duration);
        next += duration;
      }
    }
  } finally {
    previous?.close();
    if (decoder.state !== 'closed') decoder.close();
  }
}
