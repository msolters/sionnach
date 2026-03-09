import { HPSS_KERNEL } from '../constants';
import { isDSPCancelled } from './stft';

let _medianSortBuf = new Float32Array(HPSS_KERNEL);

export function median1d(
  arr: Float32Array, len: number, kernel: number, out: Float32Array
): Float32Array {
  const half = kernel >> 1;
  if (_medianSortBuf.length < kernel) _medianSortBuf = new Float32Array(kernel);
  const buf = _medianSortBuf;
  for (let i = 0; i < len; i++) {
    const start = Math.max(0, i - half);
    const end = Math.min(len - 1, i + half);
    const count = end - start + 1;
    for (let j = 0; j < count; j++) buf[j] = arr[start + j];
    const sub = buf.subarray(0, count);
    sub.sort();
    out[i] = sub[count >> 1];
  }
  return out;
}

/** Yield the JS thread */
function yieldToUI(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

const CHUNK_SIZE = 50; // bins or frames per batch

export async function hpss(
  mag: Float32Array, nFrames: number, nBins: number
): Promise<Float32Array> {
  // Harmonic: median along time for each frequency bin
  const harmonic = new Float32Array(nBins * nFrames);
  const medOutH = new Float32Array(Math.max(nFrames, nBins));
  for (let b = 0; b < nBins; b++) {
    const row = mag.subarray(b * nFrames, b * nFrames + nFrames);
    median1d(row, nFrames, HPSS_KERNEL, medOutH);
    harmonic.set(medOutH.subarray(0, nFrames), b * nFrames);

    if ((b + 1) % CHUNK_SIZE === 0) {
      if (isDSPCancelled()) return harmonic; // bail out
      await yieldToUI();
    }
  }

  if (isDSPCancelled()) return harmonic;
  await yieldToUI();

  // Percussive: median along frequency for each time frame
  const percussive = new Float32Array(nBins * nFrames);
  const col = new Float32Array(nBins);
  const medOutP = new Float32Array(nBins);
  for (let f = 0; f < nFrames; f++) {
    for (let b = 0; b < nBins; b++) col[b] = mag[b * nFrames + f];
    median1d(col, nBins, HPSS_KERNEL, medOutP);
    for (let b = 0; b < nBins; b++) percussive[b * nFrames + f] = medOutP[b];

    if ((f + 1) % CHUNK_SIZE === 0) {
      if (isDSPCancelled()) return harmonic;
      await yieldToUI();
    }
  }

  if (isDSPCancelled()) return harmonic;
  await yieldToUI();

  // Soft mask: H_mask = H^2 / (H^2 + P^2 + eps)
  const harmonicMasked = new Float32Array(nBins * nFrames);
  const eps = 1e-10;
  for (let i = 0; i < harmonicMasked.length; i++) {
    const h2 = harmonic[i] * harmonic[i];
    const p2 = percussive[i] * percussive[i];
    const mask = h2 / (h2 + p2 + eps);
    harmonicMasked[i] = mag[i] * mask;
  }

  return harmonicMasked;
}
