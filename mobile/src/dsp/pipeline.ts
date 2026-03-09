import { computeSTFT } from './stft';
import { processStandard, processForeground } from './chromagram';
import { prepareModelInputs } from './prepare-inputs';
import { estimateTempo } from './tempo';
import type { DSPResult } from '../types';

/**
 * Full DSP pipeline: raw audio samples -> model-ready tensors.
 * Mirrors the 'process' handler in worker.js.
 */
export function processAudio(samples: Float32Array): DSPResult | null {
  const stft = computeSTFT(samples);
  if (!stft) return null;

  const { mag, nFrames, nBins } = stft;

  // Standard chromagram path
  const stdResult = processStandard(mag, nFrames, nBins);
  const tensorsStd = prepareModelInputs(stdResult.chroma, nFrames);

  // Foreground (harmonic-only) chromagram path
  const chromaFg = processForeground(mag, nFrames, nBins);
  const tensorsFg = prepareModelInputs(chromaFg, nFrames);

  const tempo = estimateTempo(samples);

  return {
    chroma: stdResult.chroma,
    rawEnergy: stdResult.rawEnergy,
    nFrames,
    tensorsStd,
    tensorsFg,
    tempo,
  };
}
