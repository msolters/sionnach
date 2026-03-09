import { useCallback, useRef, useState } from 'react';
import { processAudio } from '../dsp/pipeline';
import { runEnsembleInference } from '../inference/run-inference';
import { getTuneIndex } from '../data/tune-index';
import {
  CONSENSUS_WINDOW, CONFIDENCE_FLOOR,
  NOISE_CYCLES, SILENCE_CYCLES,
  MIN_DISPLAY_CONFIDENCE, N_CHROMA,
} from '../constants';
import type { Prediction, TuneIndex } from '../types';

/** Confidence at or above this = locked on, show sheet music */
const LOCK_CONFIDENCE = 0.72;

/**
 * Composite confidence weights.
 * Dominance: does top-1 dominate top-2 in the consensus probability average?
 * Frequency: does the leading tune keep appearing across cycles?
 * Agreement: does current audio agree with the consensus leader? (EMA-smoothed)
 * Accumulation: do we have enough data to be sure?
 */
const W_DOMINANCE = 0.25;
const W_FREQUENCY = 0.35;
const W_AGREEMENT = 0.15;
const W_ACCUMULATION = 0.25;

/** EMA smoothing factor for agreement (fit). Higher = more responsive. */
const FIT_EMA_ALPHA = 0.35;

/** How many recent cycles to track for frequency analysis */
const HISTORY_WINDOW = 8;

/** How many top-K results to record per cycle (captures climbing tunes) */
const HISTORY_TOP_K = 5;

/** Minimum cycles before frequency signal is trusted (prevents instant lock) */
const MIN_HISTORY_CYCLES = 3;

/** Minimum frequency of the leading tune to not be considered noise */
const NOISE_FREQUENCY = 0.25;

/**
 * Spectral flatness threshold for noise gating.
 * Computed on RAW (pre-normalized) chroma energy where noise is genuinely flat.
 * 1.0 = perfectly flat (noise), 0.0 = one dominant pitch (melodic).
 * Ported from web app's chromaFlatness / FLATNESS_THRESH.
 */
const FLATNESS_THRESH = 0.45;
const FLATNESS_NOISE_RATIO = 0.7; // skip inference if >70% of frames are flat

/** Entry in the per-cycle history ring buffer */
interface CycleEntry {
  cycle: number;   // cycle counter — groups entries from same inference cycle
  tuneId: number;
  score: number;   // consensus probability for this tune in this cycle
}

export interface IdentifierState {
  predictions: Prediction[];
  confidence: number;
  status: 'idle' | 'listening' | 'identifying' | 'noise' | 'silence';
  lockedTuneId: number | null;
  tempo: number | null;
}

/**
 * Find the most persistently appearing tune in recent history.
 * Now tracks top-K per cycle, so a tune consistently at rank 2-3
 * still builds frequency credit.
 *
 * Frequency = cycles where tune appeared (any rank) / total cycles.
 * avgScore = mean consensus probability across appearances.
 */
function findLeadingTune(history: CycleEntry[]): {
  tuneId: number;
  frequency: number;
  avgScore: number;
} | null {
  if (history.length === 0) return null;

  // Find total unique cycles
  const allCycles = new Set<number>();
  for (const entry of history) allCycles.add(entry.cycle);
  const totalCycles = allCycles.size;
  if (totalCycles === 0) return null;

  // Per tune: count unique cycles where it appeared + accumulate scores
  const stats = new Map<number, { cycles: Set<number>; totalScore: number }>();
  for (const entry of history) {
    const existing = stats.get(entry.tuneId);
    if (existing) {
      existing.cycles.add(entry.cycle);
      existing.totalScore += entry.score;
    } else {
      stats.set(entry.tuneId, { cycles: new Set([entry.cycle]), totalScore: entry.score });
    }
  }

  // Find tune present in the most cycles (break ties by total score)
  let bestId = -1;
  let bestCycleCount = 0;
  let bestTotalScore = 0;
  for (const [id, { cycles, totalScore }] of stats) {
    const cycleCount = cycles.size;
    if (cycleCount > bestCycleCount || (cycleCount === bestCycleCount && totalScore > bestTotalScore)) {
      bestId = id;
      bestCycleCount = cycleCount;
      bestTotalScore = totalScore;
    }
  }

  // Frequency = fraction of cycles where this tune appeared
  const appearances = stats.get(bestId)!;
  return {
    tuneId: bestId,
    frequency: bestCycleCount / totalCycles,
    avgScore: bestTotalScore / appearances.cycles.size,
  };
}

/**
 * Spectral flatness of a single frame of raw chroma energy.
 * Geometric mean / arithmetic mean. High = flat = noise.
 */
function chromaFlatness(
  rawEnergy: Float32Array, nFrames: number, frame: number,
): number {
  let logSum = 0, sum = 0;
  for (let c = 0; c < N_CHROMA; c++) {
    const v = Math.max(rawEnergy[c * nFrames + frame], 1e-10);
    logSum += Math.log(v);
    sum += v;
  }
  const geoMean = Math.exp(logSum / N_CHROMA);
  const ariMean = sum / N_CHROMA;
  return ariMean > 1e-10 ? geoMean / ariMean : 1.0;
}

/** Check if the chromagram is mostly noise (flat spectral energy). */
function isChromaticallyFlat(
  rawEnergy: Float32Array, nFrames: number,
): boolean {
  let noisyFrames = 0;
  for (let f = 0; f < nFrames; f++) {
    if (chromaFlatness(rawEnergy, nFrames, f) > FLATNESS_THRESH) noisyFrames++;
  }
  return noisyFrames / nFrames > FLATNESS_NOISE_RATIO;
}

export function useTuneIdentifier() {
  const [state, setState] = useState<IdentifierState>({
    predictions: [],
    confidence: 0,
    status: 'idle',
    lockedTuneId: null,
    tempo: null,
  });

  const recentProbs = useRef<Float32Array[]>([]);
  const silenceCount = useRef(0);
  const noiseCount = useRef(0);
  const musicActive = useRef(false);
  const lastTempo = useRef<number | null>(null);
  const prevLockedId = useRef<number | null>(null);

  // Per-cycle history for frequency analysis
  const cycleHistory = useRef<CycleEntry[]>([]);
  const cycleCounter = useRef(0);
  const smoothedFit = useRef(0);

  const resetAll = useCallback(() => {
    recentProbs.current = [];
    silenceCount.current = 0;
    noiseCount.current = 0;
    musicActive.current = false;
    lastTempo.current = null;
    prevLockedId.current = null;
    cycleHistory.current = [];
    cycleCounter.current = 0;
    smoothedFit.current = 0;
    setState({
      predictions: [],
      confidence: 0,
      status: 'idle',
      lockedTuneId: null,
      tempo: null,
    });
  }, []);

  const processSamples = useCallback(async (
    samples: Float32Array,
    inputLevel: number
  ) => {
    const tuneIndex = getTuneIndex();
    if (tuneIndex.length === 0) return;

    // Silence detection — low energy
    const isQuiet = inputLevel < 0.005;
    if (isQuiet) {
      silenceCount.current++;
      if (silenceCount.current >= SILENCE_CYCLES) {
        if (musicActive.current) {
          musicActive.current = false;
          noiseCount.current = 0;
          recentProbs.current = [];
          prevLockedId.current = null;
          cycleHistory.current = [];
          cycleCounter.current = 0;
          smoothedFit.current = 0;
          setState({
            predictions: [],
            confidence: 0,
            status: 'silence',
            lockedTuneId: null,
            tempo: null,
          });
        }
        return;
      }
    } else {
      silenceCount.current = 0;
      if (!musicActive.current) {
        musicActive.current = true;
        noiseCount.current = 0;
        recentProbs.current = [];
        prevLockedId.current = null;
        cycleHistory.current = [];
        cycleCounter.current = 0;
        smoothedFit.current = 0;
        setState(s => ({ ...s, status: 'listening', predictions: [], confidence: 0, lockedTuneId: null }));
      }
    }

    if (!musicActive.current) return;

    // Run DSP pipeline (async — yields to UI between phases)
    const dsp = await processAudio(samples);
    if (!dsp) return;

    // Track tempo (only updated on standard cycles)
    if (dsp.tempo !== null) lastTempo.current = dsp.tempo;

    const hasStd = dsp.tensorsStd.length > 0;
    const hasFg = dsp.tensorsFg.length > 0;
    if (!hasStd && !hasFg) return;

    // Flatness gate: skip inference if the chromagram is mostly noise.
    // Prevents garbage-collector classes (e.g. Queen of Sheba) from appearing
    // on microphone warmup, ambient noise, or non-musical audio.
    // Only check on standard cycles (foreground cycles don't produce rawEnergy).
    let hasRawEnergy = false;
    for (let i = 0; i < dsp.rawEnergy.length; i++) {
      if (dsp.rawEnergy[i] > 0) { hasRawEnergy = true; break; }
    }
    if (hasRawEnergy && isChromaticallyFlat(dsp.rawEnergy, dsp.nFrames)) {
      noiseCount.current++;
      if (noiseCount.current >= NOISE_CYCLES) {
        recentProbs.current = [];
        cycleHistory.current = [];
        cycleCounter.current = 0;
        smoothedFit.current = 0;
        prevLockedId.current = null;
        setState({
          confidence: 0,
          status: 'noise',
          predictions: [],
          lockedTuneId: null,
          tempo: lastTempo.current,
        });
      }
      return;
    }

    // Run inference
    const { avg, nClasses } = await runEnsembleInference(dsp.tensorsStd, dsp.tensorsFg);

    // Find this cycle's instant winner and its score
    let instantTopIdx = 0;
    for (let i = 1; i < nClasses; i++) {
      if (avg[i] > avg[instantTopIdx]) instantTopIdx = i;
    }
    const instantTopId = tuneIndex[instantTopIdx]?.id ?? -1;
    const instantTopScore = avg[instantTopIdx];

    // Rolling consensus — exponentially weighted so recent cycles count more.
    // A tune climbing from rank 15 → 5 → 2 → 1 will break through faster
    // because its strong recent signal isn't diluted by weak early cycles.
    recentProbs.current.push(avg);
    if (recentProbs.current.length > CONSENSUS_WINDOW) recentProbs.current.shift();

    const windowLen = recentProbs.current.length;
    const consensus = new Float32Array(nClasses);
    // Exponential weights: most recent = highest weight, decay = 0.6 per step back
    const EXP_DECAY = 0.6;
    let wSum = 0;
    for (let t = 0; t < windowLen; t++) {
      const w = Math.pow(EXP_DECAY, windowLen - 1 - t); // oldest=smallest, newest=1.0
      wSum += w;
      const p = recentProbs.current[t];
      for (let i = 0; i < nClasses; i++) consensus[i] += p[i] * w;
    }
    for (let i = 0; i < nClasses; i++) consensus[i] /= wSum;

    // Sort by consensus probability
    const indices = Array.from({ length: nClasses }, (_, i) => i);
    indices.sort((a, b) => consensus[b] - consensus[a]);

    const topProb = consensus[indices[0]];
    const secondProb = consensus[indices[1]] || 0;

    // Record top-K consensus results in history.
    // Tracking top-K (not just top-1) means a tune that consistently
    // appears at rank 2-3 still builds frequency credit.
    const thisCycle = cycleCounter.current++;
    for (let k = 0; k < HISTORY_TOP_K && k < nClasses; k++) {
      const idx = indices[k];
      cycleHistory.current.push({
        cycle: thisCycle,
        tuneId: tuneIndex[idx]?.id ?? -1,
        score: consensus[idx],
      });
    }
    // Trim old cycles (each cycle has TOP_K entries)
    const maxEntries = HISTORY_WINDOW * HISTORY_TOP_K;
    while (cycleHistory.current.length > maxEntries) {
      cycleHistory.current.shift();
    }

    // If locked and this cycle's consensus top-1 disagrees, check if lock should break.
    // IMPORTANT: Don't nuke accumulated state — just release the lock and let
    // confidence naturally recalculate. Nuking state caused slow reconvergence.
    const consensusTopId = tuneIndex[indices[0]]?.id ?? -1;
    if (prevLockedId.current !== null && consensusTopId !== prevLockedId.current) {
      const leading = findLeadingTune(cycleHistory.current);
      if (!leading || leading.tuneId !== prevLockedId.current || leading.frequency < 0.4) {
        // Lock is broken — the locked tune is no longer dominant.
        // Release lock but keep consensus/history intact so the new tune
        // can build on existing data rather than starting from scratch.
        prevLockedId.current = null;
      }
      // Otherwise: locked tune is still frequent in history, keep lock
    }

    // Find the leading tune from history (most persistent across cycles)
    const leading = findLeadingTune(cycleHistory.current);

    // --- Signal 1: DOMINANCE ---
    // How much does the consensus top-1 lead top-2?
    const ratio = secondProb > 0 ? topProb / secondProb : (topProb > 0 ? 10 : 0);
    const dominance = Math.min(Math.max((ratio - 1) / 1.5, 0), 1);

    // --- Signal 2: FREQUENCY (persistence) ---
    // How often does the leading tune appear in recent history?
    // Now tracks top-K per cycle, so rank 2-3 appearances count too.
    const rawFrequency = leading ? leading.frequency : 0;
    const scoreBoost = leading ? Math.min(leading.avgScore * 3, 1) : 0;
    const baseFrequency = Math.min(rawFrequency * (0.85 + 0.15 * scoreBoost), 1);
    // Scale by history maturity — prevent inflated frequency on early cycles
    // (1 cycle = 0.33, 2 cycles = 0.67, 3+ cycles = 1.0)
    const totalCycles = new Set(cycleHistory.current.map(e => e.cycle)).size;
    const maturity = Math.min(totalCycles / MIN_HISTORY_CYCLES, 1);
    const frequency = baseFrequency * maturity;

    // --- Signal 3: AGREEMENT (smoothed fit) ---
    // Does this specific cycle agree with the consensus leader?
    const instantRankForConsensusTop = avg[indices[0]] ?? 0;
    const instantTopProb = avg[instantTopIdx];
    const rawFit = instantTopProb > 0
      ? Math.min(instantRankForConsensusTop / instantTopProb, 1)
      : 0;
    smoothedFit.current = smoothedFit.current === 0
      ? rawFit
      : smoothedFit.current + FIT_EMA_ALPHA * (rawFit - smoothedFit.current);
    const agreement = smoothedFit.current;

    // --- Signal 4: ACCUMULATION ---
    // Ramps 0→1 as consensus window fills. Prevents premature lock.
    const accumulation = Math.min(windowLen / CONSENSUS_WINDOW, 1);

    // --- Composite confidence ---
    const confidence = dominance * W_DOMINANCE
      + frequency * W_FREQUENCY
      + agreement * W_AGREEMENT
      + accumulation * W_ACCUMULATION;

    // --- Noise detection ---
    // Noise = we're hearing things but no tune keeps showing up.
    // Low top probability OR the most frequent tune barely appears.
    const isNoise = topProb < CONFIDENCE_FLOOR
      || (rawFrequency < NOISE_FREQUENCY && cycleHistory.current.length >= 3);

    if (isNoise) {
      noiseCount.current++;
      if (noiseCount.current >= NOISE_CYCLES) {
        recentProbs.current = [];
        cycleHistory.current = [];
        cycleCounter.current = 0;
        smoothedFit.current = 0;
        prevLockedId.current = null;
        setState({
          confidence: 0,
          status: 'noise',
          predictions: [],
          lockedTuneId: null,
          tempo: lastTempo.current,
        });
        return;
      }
    } else {
      noiseCount.current = 0;
    }

    if (!isNoise && topProb >= CONFIDENCE_FLOOR) {
      // Use the leading tune from history as our "best guess" for predictions display,
      // but show consensus-ordered predictions for the pills
      const predictions: Prediction[] = indices.slice(0, 10).map((idx, rank) => ({
        rank: rank + 1,
        prob: consensus[idx],
        id: tuneIndex[idx]?.id ?? 0,
        name: tuneIndex[idx]?.name ?? `Unknown #${idx}`,
        type: tuneIndex[idx]?.type ?? '',
      }));

      const top = predictions[0];

      // Lock = confidence-driven. Full ring = locked = show sheet music.
      const lockedTuneId = confidence >= LOCK_CONFIDENCE ? top.id : null;
      if (lockedTuneId) prevLockedId.current = lockedTuneId;

      let status: IdentifierState['status'];
      if (confidence >= 0.5) {
        status = 'identifying';
      } else {
        status = 'listening';
      }

      const showPredictions = confidence >= MIN_DISPLAY_CONFIDENCE;

      setState({
        predictions: showPredictions ? predictions : [],
        confidence: showPredictions ? confidence : 0,
        status,
        lockedTuneId: showPredictions ? lockedTuneId : null,
        tempo: lastTempo.current,
      });
    }
  }, []);

  return { state, processSamples, reset: resetAll };
}
