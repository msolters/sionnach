/**
 * Streaming audio capture for React Native.
 *
 * Uses react-native-live-audio-stream for real-time PCM streaming,
 * matching the web app's AudioWorklet approach.
 *
 * The web app flow:
 *   AudioWorklet (audio-processor.js) -> resamples to 22050Hz -> posts PCM chunks
 *
 * The mobile flow:
 *   LiveAudioStream -> emits PCM chunks at configured sample rate
 *   We configure it at 22050Hz directly when the platform supports it,
 *   or resample from the native rate using the same linear interpolation
 *   algorithm from audio-processor.js.
 */
import { Animated } from 'react-native';
import { SAMPLE_RATE, MAX_AUDIO_SEC } from '../constants';

// Buffer management (mirrors app.js audioSamples array)
let audioChunks: Float32Array[] = [];
let totalSamples = 0;
let inputLevel = 0;


/**
 * Shared animated value for the ListenRing visualization.
 * Updated directly from the audio callback — bypasses React state/render
 * so the ring stays responsive even when the JS thread is busy with DSP.
 *
 * Value range: 0-1 (adaptively normalized audio level).
 */
export const normalizedLevelAnim = new Animated.Value(0);

// Adaptive normalization state for the ring
let emaLevelForRing = 0.01;

export function getInputLevel(): number {
  return inputLevel;
}

export function getAudioBuffer(): Float32Array {
  const max = MAX_AUDIO_SEC * SAMPLE_RATE;
  let total = 0;
  for (const c of audioChunks) total += c.length;
  const keep = Math.min(total, max);
  const drop = total - keep;
  const merged = new Float32Array(keep);
  let written = 0, skipped = 0;
  for (const c of audioChunks) {
    const end = skipped + c.length;
    if (end <= drop) { skipped = end; continue; }
    const from = Math.max(0, drop - skipped);
    const usable = c.subarray(from);
    merged.set(usable, written);
    written += usable.length;
    skipped = end;
  }
  return merged;
}

export function clearAudioBuffer(): void {
  audioChunks = [];
  totalSamples = 0;
  inputLevel = 0;
  emaLevelForRing = 0.01;
  normalizedLevelAnim.setValue(0);
}

/**
 * Process incoming PCM data chunk.
 * Called by the audio stream listener.
 */
export function onAudioData(pcmData: Float32Array): void {
  audioChunks.push(pcmData);
  totalSamples += pcmData.length;

  // Compute RMS level with exponential smoothing for fluid response
  let sum = 0;
  for (let i = 0; i < pcmData.length; i++) sum += pcmData[i] * pcmData[i];
  const rms = Math.sqrt(sum / pcmData.length);
  // Smoothing: fast attack (0.6), slow decay (0.15) — feels responsive but not jittery
  const alpha = rms > inputLevel ? 0.6 : 0.15;
  inputLevel = inputLevel + alpha * (rms - inputLevel);

  // Adaptive normalization for ring visualization — direct Animated.Value update
  // bypasses React state so the ring responds even when DSP is running
  emaLevelForRing = emaLevelForRing + 0.08 * (inputLevel - emaLevelForRing);
  const baseline = Math.max(emaLevelForRing, 0.005);
  const normalized = Math.min(inputLevel / (baseline * 2), 1);
  normalizedLevelAnim.setValue(normalized);

  // Compact if too large
  const max = MAX_AUDIO_SEC * SAMPLE_RATE;
  if (totalSamples > max * 1.5) {
    const buffer = getAudioBuffer();
    audioChunks = [buffer];
    totalSamples = buffer.length;
  }
}

/**
 * Linear interpolation resampling.
 * Ported from audio-processor.js for cases where native rate != target rate.
 */
export function resample(
  samples: Float32Array,
  fromRate: number,
  toRate: number
): Float32Array {
  if (Math.abs(fromRate - toRate) < 1) return samples;

  const ratio = fromRate / toRate;
  const outLen = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLen);
  let pos = 0;
  for (let i = 0; i < outLen; i++) {
    const idx = Math.floor(pos);
    const frac = pos - idx;
    if (idx + 1 < samples.length) {
      out[i] = samples[idx] * (1 - frac) + samples[idx + 1] * frac;
    } else {
      out[i] = idx < samples.length ? samples[idx] : 0;
    }
    pos += ratio;
  }
  return out;
}
