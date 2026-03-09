import { useCallback, useRef, useState } from 'react';
import { processAudio } from '../dsp/pipeline';
import { runEnsembleInference } from '../inference/run-inference';
import { getTuneIndex } from '../data/tune-index';
import {
  CONSENSUS_WINDOW, CONFIDENCE_FLOOR,
  NOISE_CONFIDENCE, NOISE_CYCLES, SILENCE_CYCLES,
  LOCK_THRESHOLD,
} from '../constants';
import type { Prediction, TuneIndex } from '../types';

export interface IdentifierState {
  predictions: Prediction[];
  confidence: number;
  tempo: number | null;
  status: 'idle' | 'listening' | 'identifying' | 'noise' | 'silence';
  lockedTuneId: number | null;
}

/**
 * Core tune identification logic.
 * Call processSamples() each analysis cycle with accumulated PCM data.
 */
export function useTuneIdentifier() {
  const [state, setState] = useState<IdentifierState>({
    predictions: [],
    confidence: 0,
    tempo: null,
    status: 'idle',
    lockedTuneId: null,
  });

  const recentProbs = useRef<Float32Array[]>([]);
  const silenceCount = useRef(0);
  const noiseCount = useRef(0);
  const lockCount = useRef(0);
  const lastTopId = useRef<number | null>(null);
  const musicActive = useRef(false);

  const reset = useCallback(() => {
    recentProbs.current = [];
    silenceCount.current = 0;
    noiseCount.current = 0;
    lockCount.current = 0;
    lastTopId.current = null;
    musicActive.current = false;
    setState({
      predictions: [],
      confidence: 0,
      tempo: null,
      status: 'idle',
      lockedTuneId: null,
    });
  }, []);

  const processSamples = useCallback(async (
    samples: Float32Array,
    inputLevel: number
  ) => {
    const tuneIndex = getTuneIndex();
    if (tuneIndex.length === 0) return;

    // Silence detection
    const isQuiet = inputLevel < 0.005;
    if (isQuiet) {
      silenceCount.current++;
      if (silenceCount.current >= SILENCE_CYCLES && musicActive.current) {
        musicActive.current = false;
        lockCount.current = 0;
        noiseCount.current = 0;
        recentProbs.current = recentProbs.current.slice(
          -Math.ceil(recentProbs.current.length / 2)
        );
        setState(s => ({ ...s, confidence: 0, status: 'silence', predictions: [] }));
        return;
      }
    } else {
      silenceCount.current = 0;
      if (!musicActive.current) {
        musicActive.current = true;
        lockCount.current = 0;
        noiseCount.current = 0;
        recentProbs.current = [];
        setState(s => ({ ...s, status: 'listening' }));
      }
    }

    if (!musicActive.current) return;

    // Run DSP pipeline
    const dsp = processAudio(samples);
    if (!dsp || dsp.tensorsStd.length === 0) return;

    // Run inference
    const { avg, nClasses } = await runEnsembleInference(dsp.tensorsStd, dsp.tensorsFg);

    // Rolling consensus
    recentProbs.current.push(avg);
    if (recentProbs.current.length > CONSENSUS_WINDOW) recentProbs.current.shift();

    const consensus = new Float32Array(nClasses);
    for (const p of recentProbs.current) {
      for (let i = 0; i < nClasses; i++) consensus[i] += p[i];
    }
    const windowLen = recentProbs.current.length;
    for (let i = 0; i < nClasses; i++) consensus[i] /= windowLen;

    // Sort by probability
    const indices = Array.from({ length: nClasses }, (_, i) => i);
    indices.sort((a, b) => consensus[b] - consensus[a]);

    const topProb = consensus[indices[0]];
    const secondProb = consensus[indices[1]] || 0;
    const ratio = secondProb > 0 ? topProb / secondProb : (topProb > 0 ? 10 : 0);
    const confidence = Math.min(Math.max((ratio - 1) / 2, 0), 1);

    // Noise detection
    const isNoise = topProb < CONFIDENCE_FLOOR || confidence < NOISE_CONFIDENCE;

    if (isNoise) {
      noiseCount.current++;
      if (noiseCount.current >= NOISE_CYCLES) {
        lockCount.current = 0;
        setState(s => ({
          ...s,
          confidence: 0,
          status: 'noise',
          predictions: [],
          lockedTuneId: s.lockedTuneId, // preserve user lock
        }));
        return;
      }
    } else {
      noiseCount.current = 0;
    }

    if (!isNoise && topProb >= CONFIDENCE_FLOOR) {
      const predictions: Prediction[] = indices.slice(0, 10).map((idx, rank) => ({
        rank: rank + 1,
        prob: consensus[idx],
        id: tuneIndex[idx]?.id ?? 0,
        name: tuneIndex[idx]?.name ?? `Unknown #${idx}`,
        type: tuneIndex[idx]?.type ?? '',
      }));

      const top = predictions[0];

      // Lock-on tracking
      if (top.id === lastTopId.current) {
        lockCount.current++;
      } else {
        lockCount.current = 1;
        lastTopId.current = top.id;
      }

      const newLockedId = lockCount.current >= LOCK_THRESHOLD ? top.id : state.lockedTuneId;

      setState(s => ({
        ...s,
        predictions,
        confidence,
        tempo: dsp.tempo ?? s.tempo,
        status: confidence >= 0.5 ? 'identifying' : 'listening',
        lockedTuneId: newLockedId,
      }));
    }
  }, [state.lockedTuneId]);

  return { state, processSamples, reset };
}
