import { N_CHROMA, MEDIAN_WIDTH, PEAK_THRESHOLD, SOFTMAX_TEMP } from '../constants';

export function medianFilter(chroma: Float32Array, nFrames: number): Float32Array {
  const half = MEDIAN_WIDTH >> 1;
  const out = new Float32Array(chroma.length);
  const buf = new Float32Array(MEDIAN_WIDTH);
  for (let c = 0; c < N_CHROMA; c++) {
    const row = c * nFrames;
    for (let f = 0; f < nFrames; f++) {
      const start = Math.max(0, f - half);
      const end = Math.min(nFrames - 1, f + half);
      const count = end - start + 1;
      for (let j = 0; j < count; j++) buf[j] = chroma[row + start + j];
      buf.subarray(0, count).sort();
      out[row + f] = buf[count >> 1];
    }
  }
  return out;
}

export function peakNormalize(chroma: Float32Array, nFrames: number): void {
  for (let f = 0; f < nFrames; f++) {
    let max = 1e-10;
    for (let c = 0; c < N_CHROMA; c++) {
      const v = chroma[c * nFrames + f];
      if (v > max) max = v;
    }
    for (let c = 0; c < N_CHROMA; c++) {
      const idx = c * nFrames + f;
      chroma[idx] /= max;
      if (chroma[idx] < PEAK_THRESHOLD) chroma[idx] *= 0.1;
    }
  }
}

export function softmaxNormalize(chroma: Float32Array, nFrames: number): Float32Array {
  const out = new Float32Array(chroma.length);
  for (let f = 0; f < nFrames; f++) {
    let max = -Infinity;
    for (let c = 0; c < N_CHROMA; c++) {
      const v = chroma[c * nFrames + f] / SOFTMAX_TEMP;
      if (v > max) max = v;
    }
    let sum = 0;
    for (let c = 0; c < N_CHROMA; c++) {
      const idx = c * nFrames + f;
      const e = Math.exp(chroma[idx] / SOFTMAX_TEMP - max);
      out[idx] = e;
      sum += e;
    }
    for (let c = 0; c < N_CHROMA; c++) {
      out[c * nFrames + f] /= sum;
    }
  }
  return out;
}
