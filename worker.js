// Web Worker: DSP processing (FFT, STFT, chromagram extraction)
// Runs off the main thread so the UI stays responsive.

const SAMPLE_RATE = 22050;
const N_FFT = 2048;
const HOP_LENGTH = 512;
const N_CHROMA = 12;
const WINDOW_FRAMES = 344;
const HOP_FRAMES = 172;
const SOFTMAX_TEMP = 0.15;
const MEDIAN_WIDTH = 9;
const PEAK_THRESHOLD = 0.15;

let chromaFB = null;
let hannWindow = null;

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

// ---- STFT -> Chromagram pipeline ----

function processAudio(samples) {
    const n = samples.length;
    const nBins = (N_FFT >> 1) + 1;
    const pad = N_FFT >> 1;
    const padded = new Float32Array(n + 2 * pad);
    padded.set(samples, pad);

    const nFrames = Math.floor((padded.length - N_FFT) / HOP_LENGTH) + 1;
    if (nFrames <= 0) return null;

    // STFT -> power spectrogram -> chromagram in one pass to save memory
    const chroma = new Float32Array(N_CHROMA * nFrames);
    const re = new Float32Array(N_FFT);
    const im = new Float32Array(N_FFT);

    for (let f = 0; f < nFrames; f++) {
        const offset = f * HOP_LENGTH;
        for (let i = 0; i < N_FFT; i++) {
            re[i] = padded[offset + i] * hannWindow[i];
            im[i] = 0;
        }
        fft(re, im);
        // Multiply power spectrum by filter bank directly
        for (let c = 0; c < N_CHROMA; c++) {
            let sum = 0;
            const cBase = c * nBins;
            for (let b = 0; b < nBins; b++) {
                sum += chromaFB[cBase + b] * (re[b] * re[b] + im[b] * im[b]);
            }
            chroma[c * nFrames + f] = sum;
        }
    }

    // Median filter
    const filtered = medianFilter(chroma, nFrames);
    // Peak normalize
    peakNormalize(filtered, nFrames);

    return { chroma: filtered, nFrames };
}

function medianFilter(chroma, nFrames) {
    const half = MEDIAN_WIDTH >> 1;
    const out = new Float32Array(chroma.length);
    for (let c = 0; c < N_CHROMA; c++) {
        const row = c * nFrames;
        for (let f = 0; f < nFrames; f++) {
            // Collect neighbours
            const start = Math.max(0, f - half);
            const end = Math.min(nFrames - 1, f + half);
            const count = end - start + 1;
            const buf = new Float32Array(count);
            for (let j = 0; j < count; j++) buf[j] = chroma[row + start + j];
            buf.sort();
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
// Onset-based: compute spectral flux, pick peaks, measure inter-onset intervals.

function estimateTempo(samples) {
    // Compute energy in short frames for onset detection
    const frameLen = 1024;
    const hopLen = 512;
    const nFrames = Math.floor((samples.length - frameLen) / hopLen) + 1;
    if (nFrames < 10) return null;

    // Spectral flux: sum of positive differences in magnitude spectrum between frames
    const re = new Float32Array(frameLen);
    const im = new Float32Array(frameLen);
    const nBins = (frameLen >> 1) + 1;
    let prevMag = new Float32Array(nBins);
    const flux = new Float32Array(nFrames);

    // Small Hann window for onset detection
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

    // Normalize flux
    let maxFlux = 0;
    for (let i = 0; i < nFrames; i++) if (flux[i] > maxFlux) maxFlux = flux[i];
    if (maxFlux < 1e-10) return null;
    for (let i = 0; i < nFrames; i++) flux[i] /= maxFlux;

    // Pick onset peaks (flux > threshold and local maximum)
    const threshold = 0.15;
    const onsets = []; // in seconds
    for (let i = 2; i < nFrames - 2; i++) {
        if (flux[i] > threshold &&
            flux[i] > flux[i-1] && flux[i] > flux[i-2] &&
            flux[i] >= flux[i+1] && flux[i] >= flux[i+2]) {
            onsets.push(i * hopLen / SAMPLE_RATE);
        }
    }

    if (onsets.length < 4) return null;

    // Compute inter-onset intervals
    const iois = [];
    for (let i = 1; i < onsets.length; i++) {
        const dt = onsets[i] - onsets[i-1];
        if (dt > 0.08 && dt < 1.5) iois.push(dt); // filter extreme values
    }
    if (iois.length < 3) return null;

    // Use autocorrelation of the onset signal to find the dominant periodicity
    // This is more robust than just averaging IOIs
    const maxLag = Math.min(nFrames, Math.floor(2.0 * SAMPLE_RATE / hopLen)); // up to 2s
    const minLag = Math.floor(0.2 * SAMPLE_RATE / hopLen); // at least 0.2s (300 BPM max)
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

    // Irish tunes are typically 80-180 BPM. If we got a subdivision,
    // multiply up; if a super-period, divide down.
    let adjustedBpm = bpm;
    if (adjustedBpm < 60) adjustedBpm *= 2;
    if (adjustedBpm < 60) adjustedBpm *= 2;
    if (adjustedBpm > 250) adjustedBpm /= 2;
    if (adjustedBpm > 250) adjustedBpm /= 2;

    return Math.round(adjustedBpm);
}

// ---- Message handling ----

self.onmessage = function(e) {
    const { type, data } = e.data;

    if (type === 'init') {
        // Receive filter bank and precompute Hann window
        chromaFB = new Float32Array(data.chromaFB);
        hannWindow = new Float32Array(N_FFT);
        for (let i = 0; i < N_FFT; i++)
            hannWindow[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / N_FFT));
        self.postMessage({ type: 'ready' });
    }

    if (type === 'process') {
        const samples = new Float32Array(data.samples);
        const result = processAudio(samples);
        if (!result) {
            self.postMessage({ type: 'result', data: null });
            return;
        }

        const tempo = estimateTempo(samples);
        const tensors = prepareModelInputs(result.chroma, result.nFrames);

        const transferables = [result.chroma.buffer, ...tensors.map(t => t.buffer)];
        self.postMessage({
            type: 'result',
            data: {
                chroma: result.chroma,
                nFrames: result.nFrames,
                tensors: tensors,
                tempo: tempo,
            }
        }, transferables);
    }
};
