import { MAX_CLIP_MS, MIN_CLIP_MS, MAX_FILE_BYTES, STICKER_SIZE, squareCrop } from './sticker/settings.js';

const $ = id => document.getElementById(id);
const form = $('sticker-form');
const file = $('file');
const stage = $('stage');
const sourceFrame = $('source-frame');
const crop = $('sticker-crop');
const original = $('original');
const video = $('original-video');
const preview = $('result');
const download = $('download');
const submit = $('sticker-submit');
const startInput = $('clip-start');
const endInput = $('clip-end');
const positionInput = $('crop-position');
const timeline = $('clip-timeline');
const sampleButton = document.querySelector('[data-sticker-example]');
const gifPreviewStatus = $('gif-preview-status');
const sampleName = 'sticker-reaction-cat-before.gif';
const timelineAxis = $('timeline-axis');
const handles = { start: $('timeline-start'), end: $('timeline-end') };
let source, sourceURL, resultURL, drag, timelineClip;
let busy = false;
let gifPreviewURL, gifPreviewKey, gifPreviewTimer, gifPreviewRequest;

function message(text, error = false) {
  const status = $('status');
  status.textContent = text;
  status.classList.toggle('error', error);
  status.setAttribute('role', error ? 'alert' : 'status');
}

function clipSettings() {
  return {
    start: Math.round(startInput.valueAsNumber * 1000),
    end: Math.round(endInput.valueAsNumber * 1000),
    position: positionInput.valueAsNumber / 100,
  };
}

function validClip({ start, end }) {
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 &&
    end <= source.meta.duration && end - start >= MIN_CLIP_MS && end - start <= MAX_CLIP_MS;
}

function setBusy(value) {
  busy = value;
  $('choose').disabled = $('replace-file').disabled = $('clear-file').disabled = file.disabled = busy;
  sampleButton.disabled = busy;
  $('sticker-controls').disabled = busy || !source;
  handles.start.disabled = handles.end.disabled = busy || !timelineClip;
  submit.disabled = busy || !source || !validClip(clipSettings());
  $('editor').setAttribute('aria-busy', String(busy));
}

function clearResult() {
  if (resultURL) URL.revokeObjectURL(resultURL);
  resultURL = undefined;
  preview.removeAttribute('src');
  download.removeAttribute('href');
  download.removeAttribute('download');
  $('result-filled').hidden = true;
  $('result-empty').hidden = false;
}

function timelineBounds(edge, clip) {
  return edge === 'start'
    ? [Math.max(0, clip.end - MAX_CLIP_MS), clip.end - MIN_CLIP_MS]
    : [clip.start + MIN_CLIP_MS, Math.min(source.meta.duration, clip.start + MAX_CLIP_MS)];
}

function syncTimeline(clip, valid) {
  if (valid) timelineClip = clip;
  timeline.hidden = !timelineClip;
  if (!timelineClip) return;

  const { start, end } = timelineClip;
  const { duration } = source.meta;
  timelineAxis.style.setProperty('--clip-start', `${100 * start / duration}%`);
  timelineAxis.style.setProperty('--clip-end', `${100 * end / duration}%`);
  $('timeline-selection').textContent = `${start / 1000}–${end / 1000} s`;
  const seconds = Math.round(duration / 100) / 10;
  const remainder = (seconds % 60).toFixed(1).replace(/\.0$/, '');
  $('timeline-duration').textContent = `${Math.floor(seconds / 60)}:${seconds % 60 < 10 ? '0' : ''}${remainder}`;

  for (const [edge, handle] of Object.entries(handles)) {
    const [min, max] = timelineBounds(edge, timelineClip);
    handle.setAttribute('aria-valuemin', min / 1000);
    handle.setAttribute('aria-valuemax', max / 1000);
    handle.setAttribute('aria-valuenow', timelineClip[edge] / 1000);
    handle.setAttribute('aria-valuetext', `${timelineClip[edge] / 1000} seconds`);
  }
}

function setTimelineTime(edge, time) {
  const [min, max] = timelineBounds(edge, timelineClip);
  const clip = { ...timelineClip, [edge]: Math.min(max, Math.max(min, time)) };
  startInput.value = clip.start / 1000;
  endInput.value = clip.end / 1000;
  updateSettings(edge);
}

function updateSettings(seekEdge) {
  clearResult();
  if (!source) return;
  const { width, height, duration } = source.meta;
  const clip = clipSettings();
  const { x, y, side } = squareCrop(width, height, clip.position);
  crop.style.left = `${100 * x / width}%`;
  crop.style.top = `${100 * y / height}%`;
  crop.style.width = `${100 * side / width}%`;
  crop.style.height = `${100 * side / height}%`;
  const valid = validClip(clip);
  syncTimeline(clip, valid);
  if (source.kind === 'gif') updateGifPreview(valid ? clip : null);
  if (valid && seekEdge && source.kind === 'mp4' && video.readyState) {
    video.currentTime = Math.min(clip[seekEdge], duration - 1) / 1000;
  }
  $('sticker-target').textContent = valid
    ? `${((clip.end - clip.start) / 1000).toFixed(2)} s · ${STICKER_SIZE} × ${STICKER_SIZE} px`
    : 'Choose a start and end within the source, up to 10 seconds apart.';
  message(valid ? 'Ready to make a sticker.' : 'Adjust the clip to continue.');
  setBusy(false);
}

function resetSettings() {
  const { duration } = source.meta;
  startInput.value = source.example ? 2.2 : 0;
  endInput.value = Math.min(source.example ? 5000 : 3000, duration) / 1000;
  startInput.max = endInput.max = duration / 1000;
  positionInput.value = 50;
  updateSettings('start');
}

function runWorker(buffer, kind, clip, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./sticker/worker.js', import.meta.url), { type: 'module' });
    const abort = () => settle(signal.reason);
    function settle(error, result) {
      signal?.removeEventListener('abort', abort);
      clearTimeout(timer);
      worker.terminate();
      if (error) reject(error);
      else resolve(result);
    }
    const timer = setTimeout(() => settle(new Error('Processing took too long. Try a shorter clip or a smaller file.')), 60_000);
    worker.onmessage = ({ data }) => settle(data.error ? new Error(data.error) : undefined, data);
    worker.onerror = worker.onmessageerror = () => settle(new Error('Could not start the sticker editor. Reload the page and try again.'));
    signal?.addEventListener('abort', abort, { once: true });
    const copy = buffer.slice(0);
    worker.postMessage({ buffer: copy, kind, clip }, [copy]);
  });
}

function clearGifPreview() {
  clearTimeout(gifPreviewTimer);
  gifPreviewRequest?.abort();
  gifPreviewRequest = undefined;
  if (gifPreviewURL) URL.revokeObjectURL(gifPreviewURL);
  gifPreviewURL = gifPreviewKey = undefined;
  original.hidden = gifPreviewStatus.hidden = true;
  original.removeAttribute('src');
}

function updateGifPreview(clip) {
  const key = clip ? `${clip.start}:${clip.end}` : 'invalid';
  if (key === gifPreviewKey) return;
  clearGifPreview();
  gifPreviewKey = key;
  gifPreviewStatus.hidden = false;
  gifPreviewStatus.textContent = clip ? 'Updating GIF preview…' : 'Choose a valid time range to preview.';
  if (!clip) return;

  gifPreviewTimer = setTimeout(async () => {
    const request = new AbortController();
    gifPreviewRequest = request;
    try {
      const { bytes } = await runWorker(source.buffer, 'gif', { ...clip, preview: true }, request.signal);
      if (request.signal.aborted) return;
      gifPreviewURL = URL.createObjectURL(new Blob([bytes], { type: 'image/gif' }));
      original.src = gifPreviewURL;
      await original.decode();
      if (request.signal.aborted) return;
      original.hidden = false;
      gifPreviewStatus.hidden = true;
    } catch {
      if (!request.signal.aborted) {
        clearGifPreview();
        gifPreviewStatus.textContent = 'Could not preview this selection. Try a shorter clip.';
        gifPreviewStatus.hidden = false;
      }
    }
  }, 140);
}

function loadSourcePreview(selected, kind, meta) {
  if (sourceURL) URL.revokeObjectURL(sourceURL);
  clearGifPreview();
  sourceURL = kind === 'mp4' ? URL.createObjectURL(new Blob([selected], { type: 'video/mp4' })) : undefined;
  video.removeAttribute('src');
  video.load();
  video.hidden = kind !== 'mp4';
  if (sourceURL) video.src = sourceURL;
  sourceFrame.style.setProperty('--source-ratio', meta.width / meta.height);
  sourceFrame.hidden = false;
  $('upload-prompt').hidden = true;
  $('file-actions').hidden = false;
  $('filename').textContent = selected.name;
  $('file-summary').textContent = `${meta.width} × ${meta.height} · ${(meta.duration / 1000).toFixed(2)} s`;
  $('position-control').hidden = meta.width === meta.height;
  $('position-label').textContent = meta.width > meta.height ? 'Horizontal crop position' : 'Vertical crop position';
  crop.classList.toggle('movable', meta.width !== meta.height);
}

async function openFile(selected, example = false) {
  if (busy || (!selected && !example)) return;
  setBusy(true);
  $('file-error').textContent = '';
  message(example ? 'Opening the sample GIF…' : 'Opening your file…');
  try {
    if (example) {
      const response = await fetch(`/examples/${sampleName}`);
      if (!response.ok) throw new Error('Could not load the sample. Try again or choose a GIF.');
      selected = new File([await response.blob()], sampleName, { type: 'image/gif' });
    }
    if (selected.size > MAX_FILE_BYTES) throw new Error('Choose a file of 20 MB or less.');
    const buffer = await selected.arrayBuffer();
    const header = new TextDecoder().decode(buffer.slice(0, 8));
    const kind = header.startsWith('GIF87a') || header.startsWith('GIF89a') ? 'gif'
      : header.slice(4) === 'ftyp' ? 'mp4' : undefined;
    if (!kind) throw new Error('Choose an animated GIF or an H.264 MP4.');
    const { meta } = await runWorker(buffer, kind);
    source = { buffer, kind, meta, name: selected.name, example };
    timelineClip = undefined;
    loadSourcePreview(selected, kind, meta);
    resetSettings();
    startInput.focus({ preventScroll: true });
  } catch (error) {
    $('file-error').textContent = error.message;
    message(source ? 'Your previous file is still selected.' : 'Choose a local GIF or MP4 to begin.');
  } finally {
    file.value = '';
    setBusy(false);
  }
}

form.addEventListener('input', event => {
  if (!source || busy) return;
  const edge = event.target === startInput ? 'start' : event.target === endInput ? 'end' : undefined;
  updateSettings(edge);
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !source || !validClip(clipSettings())) return;
  clearResult();
  setBusy(true);
  message('Making your sticker…');
  try {
    const { bytes, frameCount, duration, reducedMotion } = await runWorker(source.buffer, source.kind, clipSettings());
    resultURL = URL.createObjectURL(new Blob([bytes], { type: 'image/webp' }));
    preview.src = resultURL;
    await preview.decode();
    const base = Array.from(source.name.replace(/\.(gif|mp4)$/i, '')).slice(0, 72).join('') || 'animation';
    download.href = resultURL;
    download.download = `${base}-sticker.webp`;
    $('result-info').textContent = `512 × 512 px · ${(duration / 1000).toFixed(2)} s · ${frameCount} frames · ${(bytes.byteLength / 1000).toFixed(1)} KB`;
    $('result-note').textContent = reducedMotion ? 'Some frames were skipped to fit within 500 KB.' : '';
    $('result-empty').hidden = true;
    $('result-filled').hidden = false;
    message('Your sticker is ready to download.');
  } catch (error) {
    clearResult();
    message(error.message, true);
  } finally {
    setBusy(false);
  }
});

$('choose').onclick = $('replace-file').onclick = () => file.click();
file.onchange = () => openFile(file.files[0]);
sampleButton.addEventListener('click', () => {
  $('editor').scrollIntoView();
  openFile(undefined, true);
});
$('reset-settings').onclick = () => { if (!busy && source) resetSettings(); };
$('clear-file').onclick = () => {
  if (busy || !source) return;
  if (sourceURL) URL.revokeObjectURL(sourceURL);
  clearGifPreview();
  source = sourceURL = timelineClip = undefined;
  timeline.hidden = true;
  video.removeAttribute('src');
  video.load();
  sourceFrame.hidden = $('file-actions').hidden = $('position-control').hidden = true;
  $('upload-prompt').hidden = false;
  $('filename').textContent = 'No file selected';
  $('file-summary').textContent = $('file-error').textContent = $('sticker-target').textContent = '';
  form.reset();
  clearResult();
  setBusy(false);
  message('Choose a local GIF or MP4 to begin.');
  $('choose').focus({ preventScroll: true });
};

stage.addEventListener('dragover', event => {
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
  if (!busy) stage.classList.add('drag-over');
});
stage.addEventListener('dragleave', event => {
  if (!stage.contains(event.relatedTarget)) stage.classList.remove('drag-over');
});
stage.addEventListener('drop', event => {
  event.preventDefault();
  stage.classList.remove('drag-over');
  openFile(event.dataTransfer.files[0]);
});

crop.addEventListener('pointerdown', event => {
  if (!source || busy || !event.isPrimary || event.button !== 0) return;
  const { width, height } = source.meta;
  if (width === height) return;
  const horizontal = width > height;
  const bounds = sourceFrame.getBoundingClientRect();
  drag = {
    id: event.pointerId,
    horizontal,
    start: horizontal ? event.clientX : event.clientY,
    distance: horizontal ? bounds.width * (1 - height / width) : bounds.height * (1 - width / height),
    position: positionInput.valueAsNumber,
  };
  crop.setPointerCapture(event.pointerId);
  event.preventDefault();
});
crop.addEventListener('pointermove', event => {
  if (event.pointerId !== drag?.id || busy || !drag.distance) return;
  const delta = (drag.horizontal ? event.clientX : event.clientY) - drag.start;
  positionInput.value = Math.round(Math.max(0, Math.min(100, drag.position + 100 * delta / drag.distance)));
  updateSettings();
});
crop.addEventListener('lostpointercapture', () => { drag = undefined; });


for (const [edge, handle] of Object.entries(handles)) {
  let pointer;
  handle.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || handle.disabled) return;
    pointer = { id: event.pointerId, originX: event.clientX, time: timelineClip[edge] };
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', event => {
    if (event.pointerId !== pointer?.id || handle.disabled) return;
    const delta = (event.clientX - pointer.originX) * source.meta.duration / timelineAxis.clientWidth;
    setTimelineTime(edge, Math.round(pointer.time + delta));
  });
  handle.addEventListener('lostpointercapture', () => { pointer = undefined; });
  handle.addEventListener('keydown', event => {
    if (handle.disabled) return;
    const increment = event.shiftKey ? 1000 : 100;
    const [min, max] = timelineBounds(edge, timelineClip);
    let time = timelineClip[edge];
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowDown': time -= increment; break;
      case 'ArrowRight':
      case 'ArrowUp': time += increment; break;
      case 'Home': time = min; break;
      case 'End': time = max; break;
      default: return;
    }
    event.preventDefault();
    setTimelineTime(edge, time);
  });
}
