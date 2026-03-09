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
 * Mirrors the handleInferenceResult logic in app.js.
 */
export async function runEnsembleInference(
  tensorsStd: Float32Array[],
  tensorsFg: Float32Array[]
): Promise<EnsembleResult> {
  const probsStd = await inferWindows(tensorsStd);
  const probsFg = tensorsFg.length > 0 ? await inferWindows(tensorsFg) : [];

  const nClasses = probsStd[0].length;

  // Average standard probs across windows
  const avgStd = new Float32Array(nClasses);
  for (const p of probsStd) for (let i = 0; i < nClasses; i++) avgStd[i] += p[i];
  for (let i = 0; i < nClasses; i++) avgStd[i] /= probsStd.length;

  // Combine with foreground
  const avg = new Float32Array(nClasses);
  if (probsFg.length > 0) {
    const avgFg = new Float32Array(nClasses);
    for (const p of probsFg) for (let i = 0; i < nClasses; i++) avgFg[i] += p[i];
    for (let i = 0; i < nClasses; i++) avgFg[i] /= probsFg.length;
    for (let i = 0; i < nClasses; i++) avg[i] = avgStd[i] * WEIGHT_STD + avgFg[i] * WEIGHT_FG;
  } else {
    for (let i = 0; i < nClasses; i++) avg[i] = avgStd[i];
  }

  return { avg, nClasses };
}
