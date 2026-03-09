import { N_CHROMA, WINDOW_FRAMES, HOP_FRAMES } from '../constants';
import { softmaxNormalize } from './normalize';

/**
 * Build 2-channel model input tensors from a chromagram.
 * Channel 0: softmax-normalized chromagram
 * Channel 1: delta (frame-to-frame transitions)
 */
export function prepareModelInputs(chroma: Float32Array, nFrames: number): Float32Array[] {
  const chromaSoft = softmaxNormalize(chroma, nFrames);

  // Slice windows
  const windows: Float32Array[] = [];
  if (nFrames < WINDOW_FRAMES) {
    const win = new Float32Array(N_CHROMA * WINDOW_FRAMES);
    for (let c = 0; c < N_CHROMA; c++)
      for (let f = 0; f < nFrames; f++)
        win[c * WINDOW_FRAMES + f] = chromaSoft[c * nFrames + f];
    windows.push(win);
  } else {
    for (let start = 0; start <= nFrames - WINDOW_FRAMES; start += HOP_FRAMES) {
      const win = new Float32Array(N_CHROMA * WINDOW_FRAMES);
      for (let c = 0; c < N_CHROMA; c++)
        for (let f = 0; f < WINDOW_FRAMES; f++)
          win[c * WINDOW_FRAMES + f] = chromaSoft[c * nFrames + start + f];
      windows.push(win);
    }
  }

  // Build 2-channel tensors: [absolute, delta]
  const tensors: Float32Array[] = [];
  for (const win of windows) {
    const data = new Float32Array(2 * N_CHROMA * WINDOW_FRAMES);
    // Channel 0: absolute
    data.set(win);
    // Channel 1: delta
    const ch1 = N_CHROMA * WINDOW_FRAMES;
    for (let c = 0; c < N_CHROMA; c++) {
      data[ch1 + c * WINDOW_FRAMES] = 0;
      for (let f = 1; f < WINDOW_FRAMES; f++)
        data[ch1 + c * WINDOW_FRAMES + f] =
          win[c * WINDOW_FRAMES + f] - win[c * WINDOW_FRAMES + f - 1];
    }
    tensors.push(data);
  }
  return tensors;
}
