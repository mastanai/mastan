import {$, h, icon, toast, fmtSize, api, csrfToken} from './ui.js';
import {t} from './strings.js';
import {audioMetadata as metadata, summarizeAudio} from './audio.js';
export const audioMetadata = file => metadata(file);
export function fileNodes(files, lightbox) {
  return (files || []).map(file => {
    const src = file.local || (file.artifact ? '/api/artifacts/' + file.artifact : '/api/uploads/' + file.id), inline = src + (file.local ? '' : '?inline=1');
    if (/^image\/(png|jpeg|gif|webp)$/.test(file.mime) || file.mime === 'image/svg+xml' && file.local?.startsWith('data:image/svg+xml;base64,')) return h('img', {class: 'message-image', src: inline, width: '300', height: '188', alt: file.name || '', loading: 'lazy', decoding: 'async', tabindex: '0', role: 'button', 'aria-label': file.name || 'Open image', onclick: () => lightbox(inline, file.name, file.caption, src), onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); lightbox(inline, file.name, file.caption, src); } }});
    if (file.mime?.startsWith('audio/')) return voiceNote(file, inline);
    return h('a', {class: 'file-card', href: src, download: file.name || 'file'}, h('span', {class: 'file-symbol', text: (file.name?.split('.').at(-1) || 'FILE').toUpperCase().slice(0, 4)}), h('span', null, h('span', {class: 'file-name', text: file.name || 'File'}), h('small', {text: fmtSize(file.size)})), icon('download'));
  }).flatMap((node, index) => files[index].caption ? [node, h('p', {class: 'attachment-caption', text: files[index].caption})] : [node]);
}
function voiceNote(file, src) {
  const audio = h('audio', {preload: 'metadata', src});
  const play = h('button', {class: 'voice-play', 'aria-label': file.transcript ? 'Play voice note: ' + file.transcript : 'Play voice note'}, icon('play'));
  const wave = h('div', {class: 'waveform', 'aria-hidden': 'true'}, Array.from({length: 35}, (_, i) => { const bar = h('i'); bar.style.height = (4 + (file.waveform?.[Math.floor(i * file.waveform.length / 35)] || 0) * .3) + 'px'; return bar; }));
  const speed = h('button', {class: 'voice-speed', text: '1×', 'aria-label': 'Playback speed'});
  const duration = file.duration || file.seconds || 0;
  const time = h('time', {class: 'voice-time', text: `${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, '0')}`, 'aria-label': 'Playback time'});
  const updateTime = () => { const seconds = Math.floor(audio.currentTime || (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration)); time.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };
  audio.ontimeupdate = audio.onloadedmetadata = updateTime;
  play.onclick = async () => { try { if (audio.paused) await audio.play(); else audio.pause(); } catch { toast(t('uploadFailed')); } };
  audio.onplay = () => play.replaceChildren(icon('pause')); audio.onpause = audio.onended = () => play.replaceChildren(icon('play'));
  speed.onclick = () => { audio.playbackRate = audio.playbackRate === 1 ? 1.5 : audio.playbackRate === 1.5 ? 2 : 1; speed.textContent = audio.playbackRate + '×'; };
  return h('div', {class: 'voice-note'}, play, h('div', {class: 'voice-track'}, wave, time), speed, audio);
}
export function showLightbox(src, name, caption, download = src) {
  const previous = document.activeElement, el = h('div', {class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': name || 'Image preview', tabindex: '-1'});
  const close = () => { el.remove(); $('#app').inert = false; previous?.focus(); };
  const button = h('button', {class: 'icon', 'aria-label': t('close'), onclick: close}, icon('close'));
  const save = h('a', {class: 'lightbox-download', href: download, download: name || 'image', 'aria-label': t('download')}, icon('download'), t('download'));
  el.append(h('figure', null, h('img', {src, alt: name || ''}), h('figcaption', {text: caption || name || ''})), h('div', {class: 'lightbox-tools'}, save, button));
  el.onkeydown = e => { if (e.key === 'Escape') close(); if (e.key === 'Tab') { e.preventDefault(); (document.activeElement === button ? save : button).focus(); } };
  el.onclick = e => { if (e.target === el) close(); }; $('#app').inert = true; $('#layers').append(el); button.focus();
}
export class Attachments {
  constructor({authenticated, requireLogin, session, limits}) { Object.assign(this, {authenticated, requireLogin, session, limits}); this.files = []; this.tray = $('#file-tray'); }
  async add(list) {
    if (!this.authenticated()) return this.requireLogin();
    for (const file of list) {
      if (this.files.length >= 6) { toast(t('tooMany')); break; }
      const max = file.type.startsWith('image/') ? this.limits.image : file.type.startsWith('audio/') ? this.limits.voice : this.limits.file;
      if (file.size > max) { toast(`${t('fileLimit')} ${Math.round(max / 1000000)} MB.`); continue; }
      const item = {file, local: URL.createObjectURL(file), progress: 0, measurable: false, id: null, error: null, controller: null};
      this.files.push(item); item.promise = this.upload(item); this.render();
    }
  }
  async upload(item, wantedSession) {
    try {
      const session = wantedSession || await this.session();
      if (item.cancelled) return null;
      return await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest(); item.controller = xhr;
        xhr.open('POST', '/api/uploads?session=' + encodeURIComponent(session));
        xhr.setRequestHeader('Content-Type', item.file.type || 'application/octet-stream'); xhr.setRequestHeader('X-File-Name', encodeURIComponent(item.file.name)); xhr.setRequestHeader('X-CSRF-Token', csrfToken());
        xhr.upload.onprogress = event => { item.measurable = event.lengthComputable && event.total > 0; item.progress = item.measurable ? Math.min(1, event.loaded / event.total) : 0; this.render(); };
        xhr.onerror = () => reject(new Error(t('uploadFailed'))); xhr.onabort = () => reject(new Error(t('cancel')));
        xhr.onload = () => {
          let out; try { out = JSON.parse(xhr.responseText); } catch { return reject(new Error(t('uploadFailed'))); }
          if (xhr.status >= 400) return reject(new Error(out.error || t('uploadFailed')));
          if (item.cancelled) { void api('/api/uploads/' + out.id, {method: 'DELETE'}).catch(() => {}); resolve(null); return; }
          Object.assign(item, out, {progress: 1}); this.render(); resolve(out.id);
        };
        xhr.send(item.file);
      });
    } catch (error) { item.error = error.message; this.render(); return null; }
  }
  remove(item) {
    item.cancelled = true; item.controller?.abort(); if (item.id) void api('/api/uploads/' + item.id, {method: 'DELETE'}).catch(() => {});
    URL.revokeObjectURL(item.local); this.files = this.files.filter(f => f !== item); this.render();
  }
  render() {
    this.tray.hidden = !this.files.length;
    this.tray.replaceChildren(...this.files.map(item => {
      const progress = !item.id && !item.error ? h('span', {class: 'upload-ring', 'aria-hidden': 'true'}) : null;
      progress?.style.setProperty('--progress', item.progress * 100 + '%');
      return h('div', {class: 'file-preview'}, h('div', {class: 'file-tile'}, item.file.type.startsWith('image/') ? h('img', {src: item.local, alt: ''}) : h('div', {text: item.file.name.split('.').at(-1).toUpperCase(), class: 'file-symbol'}), progress,
        h('button', {class: 'attachment-remove', 'aria-label': t('remove') + ' ' + item.file.name, title: t('remove'), onclick: () => this.remove(item)}, icon('close'))),
        h('div', {class: 'file-info'}, h('p', {text: item.error || item.file.name, title: item.error || item.file.name}), h('small', {text: fmtSize(item.file.size)}), !item.id && !item.error ? h('span', {class: 'upload-progress'}, h('progress', {max: '100', value: item.measurable ? String(Math.round(item.progress * 100)) : null, 'aria-label': item.file.name + ' upload'}), h('span', {text: item.measurable ? Math.round(item.progress * 100) + '%' : t('uploading')})) : null));
    }));
    dispatchEvent(new Event('mastan-composer'));
  }
  take() { const items = this.files; this.files = []; this.render(); return items; }
  clear() { for (const item of [...this.files]) this.remove(item); }
}
export function recorder({button, authenticated, requireLogin, onFile}) {
  let recording = null, request = null, holdTimer, origin, held = false, locked = false, previewClose, pointerDown = false, suppressClick = false;
  const composer = $('#composer'), area = $('#message'), attach = $('#attach'), emoji = $('#emoji');
  const restore = (focus = false) => {
    area.hidden = attach.hidden = emoji.hidden = button.hidden = false;
    button.dataset.mode = area.value.trim() ? 'send' : 'mic';
    button.replaceChildren(icon(button.dataset.mode)); button.setAttribute('aria-label', t(area.value.trim() ? 'send' : 'record'));
    dispatchEvent(new Event('mastan-composer')); if (focus) area.focus({preventScroll: true});
  };
  const preview = file => {
    const src = URL.createObjectURL(file), note = voiceNote(file, src), row = h('div', {class: 'record-preview'}, note);
    const close = (focus = true) => { note.querySelector('audio').pause(); row.remove(); previewClose = null; URL.revokeObjectURL(src); restore(focus); };
    previewClose = close;
    row.append(h('button', {class: 'icon', 'aria-label': t('cancel'), onclick: () => close()}, icon('trash')));
    area.hidden = attach.hidden = emoji.hidden = true; composer.insertBefore(row, button);
    button.hidden = false; button.dataset.mode = 'voice-send'; button.replaceChildren(icon('send')); button.setAttribute('aria-label', t('sendVoice'));
    row.file = file; dispatchEvent(new Event('mastan-composer'));
  };
  const stop = (action, focus = false) => {
    const state = recording; if (!state) return;
    if (state.stopping) { if (action === 'cancel') state.action = action; return; }
    state.action = action; state.stopping = true; state.duration = (performance.now() - state.began) / 1000;
    if (state.media.state !== 'inactive') state.media.stop();
    state.cleanup(); restore(focus);
  };
  const start = async () => {
    if (!authenticated()) return requireLogin();
    if (request || recording || previewClose) return;
    if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) return toast(t('noRecorder'));
    const attempt = {}; request = attempt;
    let stream, state;
    try {
      stream = await navigator.mediaDevices.getUserMedia({audio: true});
      if (request !== attempt || held && !pointerDown) { stream.getTracks().forEach(track => track.stop()); return; }
      const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(v => MediaRecorder.isTypeSupported(v));
      const media = new MediaRecorder(stream, mime ? {mimeType: mime} : undefined), chunks = [], levels = [];
      const row = h('div', {class: 'recording'}, h('span', {class: 'record-dot'})), timer = h('span', {text: '0:00'}), hint = h('small', {text: held ? t('slideCancel') : t('recording')});
      const canvas = h('canvas', {width: '260', height: '64', 'aria-hidden': 'true'});
      row.append(timer, canvas, hint, h('button', {class: 'icon recording-preview', 'aria-label': t('preview'), title: t('preview'), onclick: () => stop('preview')}, icon('play')),
        h('button', {class: 'icon', 'aria-label': t('cancel'), onclick: () => stop('cancel', true)}, icon('trash')));
      area.hidden = attach.hidden = emoji.hidden = true; composer.insertBefore(row, button);
      button.hidden = false; button.replaceChildren(icon('send')); button.dataset.mode = 'recording'; button.setAttribute('aria-label', t('sendVoice'));
      let frame, audioContext, analyser, sampledAt = 0;
      try { audioContext = new AudioContext(); analyser = audioContext.createAnalyser(); analyser.fftSize = 256; audioContext.createMediaStreamSource(stream).connect(analyser); } catch {}
      const began = performance.now(), ctx = canvas.getContext('2d'), samples = new Uint8Array(128);
      const draw = () => {
        const elapsed = performance.now() - began, seconds = Math.floor(elapsed / 1000); timer.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
        ctx.clearRect(0, 0, 260, 64); ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--lilac'); analyser?.getByteTimeDomainData(samples);
        let peak = 0;
        for (let i = 0; i < 43; i++) { const level = analyser ? Math.abs(samples[i * 2] - 128) : 0; peak = Math.max(peak, level); const height = Math.max(4, level * 1.6); ctx.fillRect(i * 6, (64 - height) / 2, 3, height); }
        if (elapsed >= sampledAt) { levels.push(Math.min(100, peak / 128 * 100)); sampledAt = elapsed + 100; }
        frame = requestAnimationFrame(draw);
      };
      state = recording = {media, row, hint, began, action: 'cancel', stopping: false, cleanup() { cancelAnimationFrame(frame); stream.getTracks().forEach(track => track.stop()); void audioContext?.close().catch(() => {}); row.remove(); }};
      media.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      media.onstop = async () => {
        state.cleanup(); held = locked = false;
        // Cancellation may arrive after stop(), before the browser delivers the final chunk.
        if (state.action === 'cancel') { if (recording === state) recording = null; restore(); return; }
        restore();
        if (!chunks.length) { if (recording === state) recording = null; return; }
        const type = media.mimeType || 'audio/webm', extension = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
        const file = new File(chunks, `voice-${Date.now()}.${extension}`, {type: type.split(';')[0]});
        let decoder;
        // Decode the completed recording, including Safari's MP4, before its optimistic bubble exists.
        try { decoder = new AudioContext(); Object.assign(file, summarizeAudio(await decoder.decodeAudioData(await file.arrayBuffer()))); }
        catch { Object.assign(file, {duration: state.duration, waveform: Array.from({length: 64}, (_, i) => levels[Math.min(levels.length - 1, Math.floor(i * levels.length / 64))] || 0)}); }
        finally { void decoder?.close().catch(() => {}); }
        if (recording === state) recording = null;
        if (state.action === 'cancel') return;
        if (state.action === 'preview') preview(file); else onFile(file);
      };
      request = null; media.start(200); draw(); dispatchEvent(new Event('mastan-composer'));
    } catch {
      stream?.getTracks().forEach(track => track.stop()); state?.cleanup();
      if (recording === state) recording = null;
      if (request === attempt || state) { restore(true); toast(t('permission')); }
    } finally { if (request === attempt) request = null; }
  };
  button.addEventListener('pointerdown', event => {
    if (request || recording || previewClose || area.value.trim() || button.dataset.mode === 'send') return;
    pointerDown = true; button.setPointerCapture?.(event.pointerId);
    origin = {x: event.clientX, y: event.clientY}; held = false;
    holdTimer = setTimeout(() => { held = true; suppressClick = true; void start(); }, 220);
  });
  button.addEventListener('pointermove', event => {
    if (!recording || recording.stopping || !held || locked || !origin) return;
    if (event.clientX - origin.x < -85) { stop('cancel', true); suppressClick = true; }
    if (origin.y - event.clientY > 75) { locked = true; recording.hint.textContent = t('locked'); suppressClick = true; }
  });
  const release = event => {
    pointerDown = false; clearTimeout(holdTimer);
    if (held && recording && !locked) stop(event.type === 'pointercancel' ? 'cancel' : 'send');
    // A cancelled pointer may produce no click; it must not swallow the next tap.
    setTimeout(() => { suppressClick = false; }, 0);
  };
  button.addEventListener('pointerup', release); button.addEventListener('pointercancel', release);
  return {
    click() {
      if (suppressClick) { suppressClick = false; return true; }
      if (recording) stop('send');
      else if (previewClose) { const file = composer.querySelector('.record-preview').file; previewClose(false); onFile(file); }
      else void start();
      return true;
    },
    cancel(focus = true) {
      const active = !!(request || recording || previewClose); clearTimeout(holdTimer); request = null; pointerDown = held = locked = suppressClick = false;
      if (recording) { stop('cancel', focus); if (focus) area.focus({preventScroll: true}); }
      else if (previewClose) previewClose(focus);
      else if (active) restore(focus);
      return active;
    },
    previewing: () => !!previewClose,
    active: () => !!request || !!recording && !recording.stopping,
  };
}

// IndexedDB keeps queued File blobs across a reload. Session cookies never enter browser storage.
export const queuedFiles = {
  async access(mode, key, value) {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('mastan-queued-files', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('files');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try { return await new Promise((resolve, reject) => {
      const transaction = database.transaction('files', mode === 'get' ? 'readonly' : 'readwrite'), store = transaction.objectStore('files');
      const request = mode === 'get' ? store.get(key) : mode === 'delete' ? store.delete(key) : store.put(value, key);
      let result;
      request.onsuccess = () => { result = request.result; };
      transaction.oncomplete = () => resolve(result); transaction.onerror = () => reject(transaction.error);
    }); } finally { database.close(); }
  },
  put(key, files) { return this.access('put', key, files.map(file => ({blob: file, name: file.name, type: file.type, ...audioMetadata(file)}))); },
  async get(key) { return (await this.access('get', key) || []).map(file => Object.assign(new File([file.blob], file.name, {type: file.type}), audioMetadata(file))); },
  remove(key) { return this.access('delete', key); },
};
