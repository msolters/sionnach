import { computeSTFT, cancelDSP, resetDSPCancel, isDSPCancelled } from './stft';
import { processStandard, processForeground } from './chromagram';
import { prepareModelInputs } from './prepare-inputs';
import { estimateTempo } from './tempo';
import type { DSPResult } from '../types';

export { cancelDSP };

let cycleCount = 0;

/** Yield the JS thread */
function yieldToUI(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Full DSP pipeline: raw audio samples -> model-ready tensors.
 *
 * Fully async — STFT, HPSS, and chromagram all yield to the UI thread
 * in small batches so animations and audio callbacks never stall.
 *
 * Supports cancellation via cancelDSP() — checked between all phases
 * so the Stop button responds immediately.
 */
export async function processAudio(samples: Float32Array): Promise<DSPResult | null> {
  resetDSPCancel();
  const cycle = cycleCount++;
  const doForeground = cycle % 2 === 1;

  let t0 = Date.now();
  const stft = await computeSTFT(samples);
  if (!stft || isDSPCancelled()) return null;
  console.log(`  STFT: ${Date.now() - t0}ms`);

  await yieldToUI();

  const { mag, nFrames, nBins } = stft;

  let tensorsStd: Float32Array[] = [];
  let tensorsFg: Float32Array[] = [];
  let chroma: Float32Array;
  let rawEnergy: Float32Array;

  if (doForeground) {
    t0 = Date.now();
    const chromaFg = await processForeground(mag, nFrames, nBins);
    if (isDSPCancelled()) return null;
    console.log(`  Chroma-fg: ${Date.now() - t0}ms`);

    await yieldToUI();
    if (isDSPCancelled()) return null;

    t0 = Date.now();
    tensorsFg = prepareModelInputs(chromaFg, nFrames);
    console.log(`  Tensors-fg: ${Date.now() - t0}ms (${tensorsFg.length} windows)`);

    chroma = chromaFg;
    rawEnergy = new Float32Array(chromaFg.length);
  } else {
    t0 = Date.now();
    const stdResult = processStandard(mag, nFrames, nBins);
    if (isDSPCancelled()) return null;
    console.log(`  Chroma-std: ${Date.now() - t0}ms`);

    await yieldToUI();
    if (isDSPCancelled()) return null;

    t0 = Date.now();
    tensorsStd = prepareModelInputs(stdResult.chroma, nFrames);
    console.log(`  Tensors-std: ${Date.now() - t0}ms (${tensorsStd.length} windows)`);

    chroma = stdResult.chroma;
    rawEnergy = stdResult.rawEnergy;
  }

  await yieldToUI();
  if (isDSPCancelled()) return null;

  const tempo = !doForeground ? estimateTempo(samples) : null;

  return {
    chroma,
    rawEnergy,
    nFrames,
    tensorsStd,
    tensorsFg,
    tempo,
  };
}

export function resetCycleCount(): void {
  cycleCount = 0;
}
