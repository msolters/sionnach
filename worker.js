// Unified Web Worker: DSP processing + ONNX inference
// Handles FFT, STFT, chromagram, HPSS extraction, and model inference
// all off the main thread so the UI stays responsive.

importScripts('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.min.js');

const SAMPLE_RATE = 22050;
const N_FFT = 2048;
const HOP_LENGTH = 512;
const N_CHROMA = 12;
const WINDOW_FRAMES = 344;
const HOP_FRAMES = 172;
const SOFTMAX_TEMP = 0.15;
const MEDIAN_WIDTH = 9;
const PEAK_THRESHOLD = 0.15;
const HPSS_KERNEL = 31;  // median filter kernel for HPSS (must be odd)

// Melody frequency range for Irish trad instruments (whistle, flute, fiddle, concertina)
// Below ~250Hz is guitar/bouzouki/accordion bass; above ~3500Hz is mostly noise
const MELODY_FREQ_LO = 250;
const MELODY_FREQ_HI = 3500;
// Sliding window for drone removal (catches chord changes, not just constant drones)
const DRONE_WINDOW = 172;  // ~4 seconds at 43 frames/sec

let chromaFB = null;
let chromaFB_melody = null;  // frequency-restricted filter bank for foreground
let hannWindow = null;

// ONNX inference session
let session = null;

// ---- FFT (radix-2 Cooley-Tukey) ----

function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        while (j & bit) { j ^= bit; bit >>= 1; }
        j ^= bit;
        if (i < j) {
            let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
            tmp = im[i]; im[i] = im[j]; im[j] = tmp;
        }
    }
    for (let len = 2; len <= n; len *= 2) {
        const half = len >> 1;
        const angle = -2 * Math.PI / len;
        const wRe = Math.cos(angle);
        const wIm = Math.sin(angle);
        for (let i = 0; i < n; i += len) {
            let curRe = 1, curIm = 0;
            for (let j = 0; j < half; j++) {
                const k = i + j + half;
                const tRe = curRe * re[k] - curIm * im[k];
                const tIm = curRe * im[k] + curIm * re[k];
                re[k] = re[i + j] - tRe;
                im[k] = im[i + j] - tIm;
                re[i + j] += tRe;
                im[i + j] += tIm;
                const newRe = curRe * wRe - curIm * wIm;
                curIm = curRe * wIm + curIm * wRe;
                curRe = newRe;
            }
        }
    }
}

// ---- STFT ----

function computeSTFT(samples) {
    const n = samples.length;
    const nBins = (N_FFT >> 1) + 1;
    const pad = N_FFT >> 1;
    const padded = new Float32Array(n + 2 * pad);
    padded.set(samples, pad);

    const nFrames = Math.floor((padded.length - N_FFT) / HOP_LENGTH) + 1;
    if (nFrames <= 0) return null;

    // Store magnitude spectrogram (nBins x nFrames, row-major by bin)
    const mag = new Float32Array(nBins * nFrames);
    const re = new Float32Array(N_FFT);
    const im = new Float32Array(N_FFT);

    for (let f = 0; f < nFrames; f++) {
        const offset = f * HOP_LENGTH;
        for (let i = 0; i < N_FFT; i++) {
            re[i] = padded[offset + i] * hannWindow[i];
            im[i] = 0;
        }
        fft(re, im);
        for (let b = 0; b < nBins; b++) {
            mag[b * nFrames + f] = re[b] * re[b] + im[b] * im[b];  // power spectrum
        }
    }

    return { mag, nFrames, nBins };
}

// ---- HPSS (Harmonic-Percussive Source Separation) ----
// Harmonic = median filter along time axis (each frequency bin)
// Percussive = median filter along frequency axis (each time frame)
// Soft mask separates them.

// Pre-allocated sort buffer for median1d (reused across calls)
let _medianSortBuf = new Float32Array(HPSS_KERNEL);

function median1d(arr, len, kernel, out) {
    const half = kernel >> 1;
    if (_medianSortBuf.length < kernel) _medianSortBuf = new Float32Array(kernel);
    const buf = _medianSortBuf;
    for (let i = 0; i < len; i++) {
        const start = Math.max(0, i - half);
        const end = Math.min(len - 1, i + half);
        const count = end - start + 1;
        for (let j = 0; j < count; j++) buf[j] = arr[start + j];
        const sub = buf.subarray(0, count);
        sub.sort();
        out[i] = sub[count >> 1];
    }
    return out;
}

function hpss(mag, nFrames, nBins) {
    // Harmonic: median along time for each frequency bin
    const harmonic = new Float32Array(nBins * nFrames);
    const medOutH = new Float32Array(Math.max(nFrames, nBins));
    for (let b = 0; b < nBins; b++) {
        const row = mag.subarray(b * nFrames, b * nFrames + nFrames);
        median1d(row, nFrames, HPSS_KERNEL, medOutH);
        harmonic.set(medOutH.subarray(0, nFrames), b * nFrames);
    }

    // Percussive: median along frequency for each time frame
    const percussive = new Float32Array(nBins * nFrames);
    const col = new Float32Array(nBins);
    const medOutP = new Float32Array(nBins);
    for (let f = 0; f < nFrames; f++) {
        for (let b = 0; b < nBins; b++) col[b] = mag[b * nFrames + f];
        median1d(col, nBins, HPSS_KERNEL, medOutP);
        for (let b = 0; b < nBins; b++) percussive[b * nFrames + f] = medOutP[b];
    }

    // Soft mask: H_mask = H^2 / (H^2 + P^2 + eps)
    const harmonicMasked = new Float32Array(nBins * nFrames);
    const eps = 1e-10;
    for (let i = 0; i < harmonicMasked.length; i++) {
        const h2 = harmonic[i] * harmonic[i];
        const p2 = percussive[i] * percussive[i];
        const mask = h2 / (h2 + p2 + eps);
        harmonicMasked[i] = mag[i] * mask;
    }

    return harmonicMasked;
}

// ---- Spectrogram -> Chromagram ----

function specToChroma(spec, nFrames, nBins, fb) {
    fb = fb || chromaFB;
    const chroma = new Float32Array(N_CHROMA * nFrames);
    for (let f = 0; f < nFrames; f++) {
        for (let c = 0; c < N_CHROMA; c++) {
            let sum = 0;
            const cBase = c * nBins;
            for (let b = 0; b < nBins; b++) {
                sum += fb[cBase + b] * spec[b * nFrames + f];
            }
            chroma[c * nFrames + f] = sum;
        }
    }
    return chroma;
}

// ---- Standard chromagram pipeline ----

function processStandard(mag, nFrames, nBins) {
    const chroma = specToChroma(mag, nFrames, nBins);
    const filtered = medianFilter(chroma, nFrames);
    // Keep a copy before peak normalization for noise detection
    const rawEnergy = new Float32Array(filtered);
    peakNormalize(filtered, nFrames);
    return { chroma: filtered, rawEnergy };
}

// ---- Drone / accompaniment removal ----
// Sliding-window per-bin median subtraction.
// A short window (~4s) catches chord changes and strummed patterns,
// not just constant drones. For each chroma bin at each frame,
// subtract the local median — whatever is persistently present nearby
// in time gets removed, leaving transient melodic content.

function removeDrone(chroma, nFrames) {
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

// ---- Foreground (melody) chromagram pipeline ----
// 1. HPSS removes percussion (bodhrán, guitar strums, foot tapping)
// 2. Melody-range filter bank excludes bass frequencies (<250Hz)
//    where guitar/bouzouki/accordion bass accompaniment lives
// 3. Sliding-window drone removal catches chord changes and pads
// Result: primarily the melodic line from whistle/flute/fiddle/concertina

function processForeground(mag, nFrames, nBins) {
    const harmonicSpec = hpss(mag, nFrames, nBins);
    const chroma = specToChroma(harmonicSpec, nFrames, nBins, chromaFB_melody);
    const deDroned = removeDrone(chroma, nFrames);
    const filtered = medianFilter(deDroned, nFrames);
    peakNormalize(filtered, nFrames);
    return filtered;
}

// ---- Shared utilities ----

function medianFilter(chroma, nFrames) {
    const half = MEDIAN_WIDTH >> 1;
    const out = new Float32Array(chroma.length);
    const buf = new Float32Array(MEDIAN_WIDTH);
    for (let c = 0; c < N_CHROMA; c++) {
        const row = c * nFrames;
        for (let f = 0; f < nFrames; f++) {
            const start = Math.max(0, f - half);
            const end = Math.min(nFrames - 1, f + half);
            const count = end - start + 1;
            for (let j = 0; j < count; j++) buf[j] = chroma[row + start + j];
            buf.subarray(0, count).sort();
            out[row + f] = buf[count >> 1];
        }
    }
    return out;
}

function peakNormalize(chroma, nFrames) {
    for (let f = 0; f < nFrames; f++) {
        let max = 1e-10;
        for (let c = 0; c < N_CHROMA; c++) {
            const v = chroma[c * nFrames + f];
            if (v > max) max = v;
        }
        for (let c = 0; c < N_CHROMA; c++) {
            const idx = c * nFrames + f;
            chroma[idx] /= max;
            if (chroma[idx] < PEAK_THRESHOLD) chroma[idx] *= 0.1;
        }
    }
}

function softmaxNormalize(chroma, nFrames) {
    const out = new Float32Array(chroma.length);
    for (let f = 0; f < nFrames; f++) {
        let max = -Infinity;
        for (let c = 0; c < N_CHROMA; c++) {
            const v = chroma[c * nFrames + f] / SOFTMAX_TEMP;
            if (v > max) max = v;
        }
        let sum = 0;
        for (let c = 0; c < N_CHROMA; c++) {
            const idx = c * nFrames + f;
            const e = Math.exp(chroma[idx] / SOFTMAX_TEMP - max);
            out[idx] = e;
            sum += e;
        }
        for (let c = 0; c < N_CHROMA; c++) {
            out[c * nFrames + f] /= sum;
        }
    }
    return out;
}

function prepareModelInputs(chroma, nFrames) {
    const chromaSoft = softmaxNormalize(chroma, nFrames);

    // Slice windows
    const windows = [];
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
    const tensors = [];
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

// ---- Tempo estimation ----

function estimateTempo(samples) {
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
    const onsets = [];
    for (let i = 2; i < nFrames - 2; i++) {
        if (flux[i] > threshold &&
            flux[i] > flux[i-1] && flux[i] > flux[i-2] &&
            flux[i] >= flux[i+1] && flux[i] >= flux[i+2]) {
            onsets.push(i * hopLen / SAMPLE_RATE);
        }
    }

    if (onsets.length < 4) return null;

    const iois = [];
    for (let i = 1; i < onsets.length; i++) {
        const dt = onsets[i] - onsets[i-1];
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

// ---- ONNX inference ----

async function inferWindows(windowTensors) {
    const allProbs = [];
    for (const tensorData of windowTensors) {
        const input = new ort.Tensor('float32', tensorData, [1, 2, N_CHROMA, WINDOW_FRAMES]);
        const output = await session.run({ input });
        const logits = output.output.data;
        let maxL = -Infinity;
        for (let i = 0; i < logits.length; i++) if (logits[i] > maxL) maxL = logits[i];
        const probs = new Float32Array(logits.length);
        let sum = 0;
        for (let i = 0; i < logits.length; i++) { probs[i] = Math.exp(logits[i] - maxL); sum += probs[i]; }
        for (let i = 0; i < probs.length; i++) probs[i] /= sum;
        allProbs.push(probs);
    }
    return allProbs;
}

// ---- Message handling ----

self.onmessage = async function(e) {
    const { type, data } = e.data;

    if (type === 'init') {
        // Initialize DSP
        chromaFB = new Float32Array(data.chromaFB);
        hannWindow = new Float32Array(N_FFT);
        for (let i = 0; i < N_FFT; i++)
            hannWindow[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / N_FFT));

        // Build melody-range filter bank: zero out bins outside melody frequencies
        const nBins = chromaFB.length / N_CHROMA;
        const minBin = Math.round(MELODY_FREQ_LO * N_FFT / SAMPLE_RATE);
        const maxBin = Math.round(MELODY_FREQ_HI * N_FFT / SAMPLE_RATE);
        chromaFB_melody = new Float32Array(chromaFB.length);
        for (let c = 0; c < N_CHROMA; c++) {
            for (let b = minBin; b <= maxBin && b < nBins; b++) {
                chromaFB_melody[c * nBins + b] = chromaFB[c * nBins + b];
            }
        }

        // Initialize ONNX session
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/';
        try {
            session = await ort.InferenceSession.create(data.modelUrl, {
                executionProviders: ['wasm'],
            });
            self.postMessage({ type: 'ready' });
        } catch (err) {
            self.postMessage({ type: 'error', error: err.message });
        }
    }

    if (type === 'chroma-only') {
        const samples = new Float32Array(data.samples);
        const stft = computeSTFT(samples);
        if (!stft) {
            self.postMessage({ type: 'chroma-only', data: null });
            return;
        }
        const { mag, nFrames, nBins } = stft;
        const stdResult = processStandard(mag, nFrames, nBins);
        self.postMessage({
            type: 'chroma-only',
            data: { chroma: stdResult.chroma, rawEnergy: stdResult.rawEnergy, nFrames }
        }, [stdResult.chroma.buffer, stdResult.rawEnergy.buffer]);
    }

    if (type === 'process') {
        try {
            const samples = new Float32Array(data.samples);

            // Compute STFT once, reuse for both paths
            const stft = computeSTFT(samples);
            if (!stft) {
                self.postMessage({ type: 'result', data: null });
                return;
            }

            const { mag, nFrames, nBins } = stft;

            // Standard chromagram path
            const stdResult = processStandard(mag, nFrames, nBins);
            const tensorsStd = prepareModelInputs(stdResult.chroma, nFrames);

            // Foreground (harmonic-only) chromagram path
            const chromaFg = processForeground(mag, nFrames, nBins);
            const tensorsFg = prepareModelInputs(chromaFg, nFrames);

            const tempo = estimateTempo(samples);

            // Run inference internally (no round-trip to main thread)
            let probsStd = [];
            let probsFg = [];
            if (session && tensorsStd.length > 0) {
                probsStd = await inferWindows(tensorsStd);
                probsFg = tensorsFg.length > 0 ? await inferWindows(tensorsFg) : [];
            }

            const transferables = [
                stdResult.chroma.buffer,
                stdResult.rawEnergy.buffer,
                ...probsStd.map(p => p.buffer),
                ...probsFg.map(p => p.buffer),
            ];
            self.postMessage({
                type: 'result',
                data: {
                    chroma: stdResult.chroma,
                    rawEnergy: stdResult.rawEnergy,
                    nFrames: nFrames,
                    probsStd: probsStd,
                    probsFg: probsFg,
                    tempo: tempo,
                }
            }, transferables);
        } catch (err) {
            console.error('Worker process error:', err);
            self.postMessage({ type: 'result', data: null });
        }
    }

    if (type === 'release') {
        if (session) {
            session.release();
            session = null;
        }
        self.postMessage({ type: 'released' });
    }
};
