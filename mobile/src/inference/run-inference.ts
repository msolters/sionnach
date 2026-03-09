import { Tensor } from 'onnxruntime-react-native';
import { getSession } from './onnx-session';
import { N_CHROMA, WINDOW_FRAMES, WEIGHT_STD, WEIGHT_FG } from '../constants';

/**
 * Run inference on a batch of window tensors.
 * Returns softmax probabilities for each window.
 */
async function inferWindows(windowTensors: Float32Array[]): Promise<Float32Array[]> {
  const session = getSession();
  const allProbs: Float32Array[] = [];

  for (const tensorData of windowTensors) {
    const input = new Tensor('float32', tensorData, [1, 2, N_CHROMA, WINDOW_FRAMES]);
    const output = await session.run({ input });
    const logits = output.output.data as Float32Array;

    // Softmax
    let maxL = -Infinity;
    for (let i = 0; i < logits.length; i++) if (logits[i] > maxL) maxL = logits[i];
    const probs = new Float32Array(logits.length);
    let sum = 0;
    for (let i = 0; i < logits.length; i++) {
      probs[i] = Math.exp(logits[i] - maxL);
      sum += probs[i];
    }
    for (let i = 0; i < probs.length; i++) probs[i] /= sum;
    allProbs.push(probs);
  }

  return allProbs;
}

export interface EnsembleResult {
  /** Averaged probability vector across all windows */
  avg: Float32Array;
  /** Number of classes */
  nClasses: number;
}

/**
 * Run ensemble inference: standard + foreground chromagram paths.
 *
 * Matches web app behavior (inference-worker.js):
 * - Both present: combined[i] = std[i]*W_STD + fg[i]*W_FG per window
 * - Only std: combined[i] = std[i] (100% standard)
 * - Only fg: combined[i] = fg[i] (100% foreground)
 *
 * On mobile, the pipeline alternates between std-only and fg-only cycles,
 * so the consensus window accumulates both types over time.
 */
export async function runEnsembleInference(
  tensorsStd: Float32Array[],
  tensorsFg: Float32Array[]
): Promise<EnsembleResult> {
  const hasStd = tensorsStd.length > 0;
  const hasFg = tensorsFg.length > 0;

  let t0 = Date.now();
  const probsStd = hasStd ? await inferWindows(tensorsStd) : [];
  if (hasStd) console.log(`  Inference-std (${tensorsStd.length} windows): ${Date.now() - t0}ms`);

  t0 = Date.now();
  const probsFg = hasFg ? await inferWindows(tensorsFg) : [];
  if (hasFg) console.log(`  Inference-fg (${tensorsFg.length} windows): ${Date.now() - t0}ms`);

  const refProbs = hasStd ? probsStd[0] : probsFg[0];
  const nClasses = refProbs.length;
  const avg = new Float32Array(nClasses);

  if (hasStd && hasFg) {
    // Both paths: per-window ensemble then average (matches web app)
    const nWindows = Math.max(probsStd.length, probsFg.length);
    for (let w = 0; w < nWindows; w++) {
      const pStd = w < probsStd.length ? probsStd[w] : probsStd[probsStd.length - 1];
      const pFg = w < probsFg.length ? probsFg[w] : pStd; // fallback to std if fewer fg windows
      for (let i = 0; i < nClasses; i++) {
        avg[i] += pStd[i] * WEIGHT_STD + pFg[i] * WEIGHT_FG;
      }
    }
    for (let i = 0; i < nClasses; i++) avg[i] /= nWindows;
  } else if (hasStd) {
    // Standard only — average across windows
    for (const p of probsStd) for (let i = 0; i < nClasses; i++) avg[i] += p[i];
    for (let i = 0; i < nClasses; i++) avg[i] /= probsStd.length;
  } else {
    // Foreground only — average across windows
    for (const p of probsFg) for (let i = 0; i < nClasses; i++) avg[i] += p[i];
    for (let i = 0; i < nClasses; i++) avg[i] /= probsFg.length;
  }

  return { avg, nClasses };
}
