// UI metadata only. Transcription and metering use the service's own decoded audio.
export function audioMetadata(file) {
  const duration = file?.duration, waveform = file?.waveform;
  if (!Number.isFinite(duration) || duration <= 0 || duration > 86400 || !Array.isArray(waveform) || waveform.length !== 64 || waveform.some(n => !Number.isFinite(n) || n < 0 || n > 100)) return {};
  return {duration, waveform: [...waveform]};
}
export function summarizeAudio(buffer) {
  const channels = Array.from({length: buffer.numberOfChannels}, (_, i) => buffer.getChannelData(i));
  const bars = Array.from({length: 64}, (_, i) => {
    const start = Math.floor(i * buffer.length / 64), end = Math.min(buffer.length, Math.max(start + 1, Math.floor((i + 1) * buffer.length / 64)));
    let sum = 0;
    for (const channel of channels) for (let n = start; n < end; n++) sum += channel[n] ** 2;
    return end > start && channels.length ? Math.sqrt(sum / ((end - start) * channels.length)) : 0;
  });
  const high = Math.max(...bars);
  return {duration: buffer.duration, waveform: bars.map(n => high ? Math.round(n / high * 100) : 0)};
}
