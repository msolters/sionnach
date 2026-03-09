import { N_FFT, HOP_LENGTH } from '../constants';
import { fft } from './fft';
import type { STFTResult } from '../types';

let hannWindow: Float32Array | null = null;

export function initHannWindow(): void {
  hannWindow = new Float32Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) {
    hannWindow[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / N_FFT));
  }
}

export function computeSTFT(samples: Float32Array): STFTResult | null {
  if (!hannWindow) initHannWindow();

  const n = samples.length;
  const nBins = (N_FFT >> 1) + 1;
  const pad = N_FFT >> 1;
  const padded = new Float32Array(n + 2 * pad);
  padded.set(samples, pad);

  const nFrames = Math.floor((padded.length - N_FFT) / HOP_LENGTH) + 1;
  if (nFrames <= 0) return null;

  const mag = new Float32Array(nBins * nFrames);
  const re = new Float32Array(N_FFT);
  const im = new Float32Array(N_FFT);

  for (let f = 0; f < nFrames; f++) {
    const offset = f * HOP_LENGTH;
    for (let i = 0; i < N_FFT; i++) {
      re[i] = padded[offset + i] * hannWindow![i];
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < nBins; b++) {
      mag[b * nFrames + f] = re[b] * re[b] + im[b] * im[b];
    }
  }

  return { mag, nFrames, nBins };
}
