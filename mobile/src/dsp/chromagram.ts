import {
  N_CHROMA, N_FFT, SAMPLE_RATE,
  MELODY_FREQ_LO, MELODY_FREQ_HI, DRONE_WINDOW,
} from '../constants';
import { hpss } from './hpss';
import { medianFilter, peakNormalize } from './normalize';

let chromaFB: Float32Array | null = null;
let chromaFB_melody: Float32Array | null = null;

export function initFilterBanks(fb: Float32Array): void {
  chromaFB = fb;

  // Build melody-range filter bank: zero out bins outside melody frequencies
  const nBins = fb.length / N_CHROMA;
  const minBin = Math.round(MELODY_FREQ_LO * N_FFT / SAMPLE_RATE);
  const maxBin = Math.round(MELODY_FREQ_HI * N_FFT / SAMPLE_RATE);
  chromaFB_melody = new Float32Array(fb.length);
  for (let c = 0; c < N_CHROMA; c++) {
    for (let b = minBin; b <= maxBin && b < nBins; b++) {
      chromaFB_melody[c * nBins + b] = fb[c * nBins + b];
    }
  }
}

export function specToChroma(
  spec: Float32Array, nFrames: number, nBins: number,
  fb?: Float32Array
): Float32Array {
  const filterBank = fb || chromaFB!;
  const chroma = new Float32Array(N_CHROMA * nFrames);
  for (let f = 0; f < nFrames; f++) {
    for (let c = 0; c < N_CHROMA; c++) {
      let sum = 0;
      const cBase = c * nBins;
      for (let b = 0; b < nBins; b++) {
        sum += filterBank[cBase + b] * spec[b * nFrames + f];
      }
      chroma[c * nFrames + f] = sum;
    }
  }
  return chroma;
}

export interface StandardResult {
  chroma: Float32Array;
  rawEnergy: Float32Array;
}

export function processStandard(
  mag: Float32Array, nFrames: number, nBins: number
): StandardResult {
  const chroma = specToChroma(mag, nFrames, nBins);
  const filtered = medianFilter(chroma, nFrames);
  const rawEnergy = new Float32Array(filtered);
  peakNormalize(filtered, nFrames);
  return { chroma: filtered, rawEnergy };
}

function removeDrone(chroma: Float32Array, nFrames: number): Float32Array {
  const out = new Float32Array(chroma.length);
  const half = DRONE_WINDOW >> 1;
  const buf = new Float32Array(DRONE_WINDOW + 1);

  for (let c = 0; c < N_CHROMA; c++) {
    const row = c * nFrames;
    for (let f = 0; f < nFrames; f++) {
      const start = Math.max(0, f - half);
      const end = Math.min(nFrames - 1, f + half);
      const count = end - start + 1;
      for (let j = 0; j < count; j++) buf[j] = chroma[row + start + j];
      buf.subarray(0, count).sort();
      const median = buf[count >> 1];
      out[row + f] = Math.max(0, chroma[row + f] - median);
    }
  }
  return out;
}

export function processForeground(
  mag: Float32Array, nFrames: number, nBins: number
): Float32Array {
  const harmonicSpec = hpss(mag, nFrames, nBins);
  const chroma = specToChroma(harmonicSpec, nFrames, nBins, chromaFB_melody!);
  const deDroned = removeDrone(chroma, nFrames);
  const filtered = medianFilter(deDroned, nFrames);
  peakNormalize(filtered, nFrames);
  return filtered;
}
