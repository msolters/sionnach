import { SAMPLE_RATE } from '../constants';
import { fft } from './fft';

export function estimateTempo(samples: Float32Array): number | null {
  const frameLen = 1024;
  const hopLen = 512;
  const nFrames = Math.floor((samples.length - frameLen) / hopLen) + 1;
  if (nFrames < 10) return null;

  const re = new Float32Array(frameLen);
  const im = new Float32Array(frameLen);
  const nBins = (frameLen >> 1) + 1;
  let prevMag = new Float32Array(nBins);
  const flux = new Float32Array(nFrames);

  const onsetHann = new Float32Array(frameLen);
  for (let i = 0; i < frameLen; i++)
    onsetHann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / frameLen));

  for (let f = 0; f < nFrames; f++) {
    const offset = f * hopLen;
    for (let i = 0; i < frameLen; i++) {
      re[i] = (offset + i < samples.length) ? samples[offset + i] * onsetHann[i] : 0;
      im[i] = 0;
    }
    fft(re, im);

    let fluxSum = 0;
    for (let b = 0; b < nBins; b++) {
      const mag = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
      const diff = mag - prevMag[b];
      if (diff > 0) fluxSum += diff;
      prevMag[b] = mag;
    }
    flux[f] = fluxSum;
  }

  let maxFlux = 0;
  for (let i = 0; i < nFrames; i++) if (flux[i] > maxFlux) maxFlux = flux[i];
  if (maxFlux < 1e-10) return null;
  for (let i = 0; i < nFrames; i++) flux[i] /= maxFlux;

  const threshold = 0.15;
  const onsets: number[] = [];
  for (let i = 2; i < nFrames - 2; i++) {
    if (flux[i] > threshold &&
      flux[i] > flux[i - 1] && flux[i] > flux[i - 2] &&
      flux[i] >= flux[i + 1] && flux[i] >= flux[i + 2]) {
      onsets.push(i * hopLen / SAMPLE_RATE);
    }
  }

  if (onsets.length < 4) return null;

  const iois: number[] = [];
  for (let i = 1; i < onsets.length; i++) {
    const dt = onsets[i] - onsets[i - 1];
    if (dt > 0.08 && dt < 1.5) iois.push(dt);
  }
  if (iois.length < 3) return null;

  const maxLag = Math.min(nFrames, Math.floor(2.0 * SAMPLE_RATE / hopLen));
  const minLag = Math.floor(0.2 * SAMPLE_RATE / hopLen);
  let bestLag = minLag;
  let bestCorr = -Infinity;

  for (let lag = minLag; lag < maxLag && lag < nFrames; lag++) {
    let corr = 0;
    let count = 0;
    for (let i = 0; i < nFrames - lag; i++) {
      corr += flux[i] * flux[i + lag];
      count++;
    }
    corr /= Math.max(count, 1);
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }

  const beatPeriod = bestLag * hopLen / SAMPLE_RATE;
  const bpm = 60.0 / beatPeriod;

  let adjustedBpm = bpm;
  if (adjustedBpm < 60) adjustedBpm *= 2;
  if (adjustedBpm < 60) adjustedBpm *= 2;
  if (adjustedBpm > 250) adjustedBpm /= 2;
  if (adjustedBpm > 250) adjustedBpm /= 2;

  return Math.round(adjustedBpm);
}
