// Irish Tune Identifier — Client-side web app
// DSP runs in a Web Worker; ONNX inference is async via WASM.
// The main thread only handles audio capture and UI updates.

const SAMPLE_RATE = 22050;
const N_CHROMA = 12;
const WINDOW_FRAMES = 344;
const HOP_LENGTH = 512;
const HOP_FRAMES = 172;
const MAX_AUDIO_SEC = 15;
const MIN_AUDIO_SEC = 4;      // start predicting early with zero-padded windows
const UPDATE_INTERVAL_MS = 1000;
const COMPACT_THRESHOLD = 500;
const SESSION_URL = 'https://thesession.org/tunes';

// Time signatures by tune type
const TYPE_INFO = {
    'reel':       { timeSig: '4/4', label: 'Reel' },
    'hornpipe':   { timeSig: '4/4', label: 'Hornpipe' },
    'barndance':  { timeSig: '4/4', label: 'Barndance' },
    'march':      { timeSig: '4/4', label: 'March' },
    'strathspey': { timeSig: '4/4', label: 'Strathspey' },
    'jig':        { timeSig: '6/8', label: 'Jig' },
    'slide':      { timeSig: '12/8', label: 'Slide' },
    'slip jig':   { timeSig: '9/8', label: 'Slip Jig' },
    'polka':      { timeSig: '2/4', label: 'Polka' },
    'waltz':      { timeSig: '3/4', label: 'Waltz' },
    'mazurka':    { timeSig: '3/4', label: 'Mazurka' },
    'three-two':  { timeSig: '3/2', label: 'Three-Two' },
};

// ---- State ----
let audioContext = null;
let workletNode = null;
let mediaStream = null;
let audioSamples = [];
let totalSamples = 0;
let tuneIndex = null;
let tuneById = {};  // tune ID -> tune entry (built after loading index)
let onnxSession = null;
let dspWorker = null;
let isRecording = false;
let startTime = 0;
let timerHandle = null;
let updateHandle = null;
let workerBusy = false;
let inputLevel = 0;
let currentTempo = null;
let sessionHistory = [];
let lastTopTuneId = null;
let lockedTuneId = null;
let lockCount = 0;
const LOCK_THRESHOLD = 2;  // consecutive same-tune updates to trigger fetch
let sheetSettings = [];
let sheetSettingIdx = 0;
let sheetFetchId = null;  // tune ID currently being fetched/displayed
let musicActive = false;   // true when signal is above noise floor
let silenceCount = 0;      // consecutive quiet analysis cycles
const SILENCE_THRESHOLD = 0.005;  // RMS below this = silence/noise
const SILENCE_CYCLES = 2;  // cycles of quiet before declaring "stopped"
let autoScrollTimer = null;  // delayed auto-scroll after lock-on
const AUTO_SCROLL_DELAY = 3000;  // ms after lock-on before auto-scrolling
let heroObserver = null;  // IntersectionObserver for hero card visibility
let windowRegions = [];   // per-window predictions for chromagram overlay
let lastNFrames = 0;      // nFrames from last analysis (for overlay scaling)
let sheetLocked = false;        // user pinned the sheet music
let silenceUnlockTimer = null;  // 120s silence before countdown starts
let unlockInterval = null;      // 1s tick for countdown
let unlockCountdown = 0;        // seconds remaining in unlock countdown
const LOCK_SILENCE_WAIT = 120;  // seconds of no music before countdown
const LOCK_COUNTDOWN = 15;      // countdown duration in seconds

const $ = id => document.getElementById(id);

// ---- Audio buffer management ----

function compactBuffer() {
    const max = MAX_AUDIO_SEC * SAMPLE_RATE;
    let total = 0;
    for (const c of audioSamples) total += c.length;
    const keep = Math.min(total, max);
    const drop = total - keep;
    const merged = new Float32Array(keep);
    let written = 0, skipped = 0;
    for (const c of audioSamples) {
        const end = skipped + c.length;
        if (end <= drop) { skipped = end; continue; }
        const from = Math.max(0, drop - skipped);
        const slice = c.subarray(from);
        merged.set(slice, written);
        written += slice.length;
        skipped = end;
    }
    audioSamples = [merged];
    totalSamples = keep;
}

function getAudioBuffer() {
    if (audioSamples.length > COMPACT_THRESHOLD) compactBuffer();
    const max = MAX_AUDIO_SEC * SAMPLE_RATE;
    let total = 0;
    for (const c of audioSamples) total += c.length;
    const keep = Math.min(total, max);
    const drop = total - keep;
    const buf = new Float32Array(keep);
    let written = 0, skipped = 0;
    for (const c of audioSamples) {
        const end = skipped + c.length;
        if (end <= drop) { skipped = end; continue; }
        const from = Math.max(0, drop - skipped);
        const slice = c.subarray(from);
        buf.set(slice, written);
        written += slice.length;
        skipped = end;
    }
    return buf;
}

// ---- Audio capture ----

async function startRecording() {
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
        $('topTuneName').innerHTML = '<a href="#" id="tapStart" class="start-link">Mic denied — retry</a>';
        $('tapStart').addEventListener('click', (ev) => { ev.preventDefault(); startRecording(); });
        return;
    }

    try {
    audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });

    await audioContext.audioWorklet.addModule('audio-processor.js');
    const source = audioContext.createMediaStreamSource(mediaStream);
    workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');

    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const levelBuf = new Float32Array(analyser.fftSize);
    function updateLevel() {
        if (!isRecording) return;
        analyser.getFloatTimeDomainData(levelBuf);
        let sum = 0;
        for (let i = 0; i < levelBuf.length; i++) sum += levelBuf[i] * levelBuf[i];
        inputLevel = Math.sqrt(sum / levelBuf.length);
        requestAnimationFrame(updateLevel);
    }

    workletNode.port.onmessage = (e) => {
        audioSamples.push(e.data);
        totalSamples += e.data.length;
    };
    source.connect(workletNode);

    audioSamples = [];
    totalSamples = 0;
    isRecording = true;
    startTime = Date.now();
    currentTempo = null;
    lastTopTuneId = null;
    musicActive = false;
    silenceCount = 0;
    lockCount = 0;
    sheetFetchId = null;
    $('controlsBar').classList.remove('hidden');
    $('topTuneName').textContent = 'Listening...';
    $('topTuneType').textContent = '';
    $('topTuneConf').textContent = '';
    $('topTuneLink').classList.add('hidden');
    $('metricTempo').textContent = '--';
    $('metricTimeSig').textContent = '--';
    document.body.classList.add('recording');

    requestAnimationFrame(updateLevel);
    timerHandle = setInterval(updateTimerAndLevel, 100);
    updateHandle = setInterval(requestAnalysis, UPDATE_INTERVAL_MS);
    } catch (e) {
        console.error('Failed to start recording:', e);
        $('topTuneName').innerHTML = `<a href="#" id="tapStart" class="start-link">Error — retry</a>`;
        $('tapStart').addEventListener('click', (ev) => { ev.preventDefault(); startRecording(); });
        $('controlsBar').classList.add('hidden');
    }
}

function stopRecording() {
    isRecording = false;
    clearInterval(timerHandle);
    clearInterval(updateHandle);

    if (workletNode) { workletNode.disconnect(); workletNode = null; }
    if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
    if (audioContext) { audioContext.close(); audioContext = null; }

    $('statusText').textContent = 'Stopped';
    $('topTuneName').innerHTML = '<a href="#" id="tapStart" class="start-link">Start</a>';
    $('tapStart').addEventListener('click', (ev) => { ev.preventDefault(); startRecording(); });
    $('controlsBar').classList.add('hidden');
    document.body.classList.remove('recording');

    requestAnalysis();
}

// ---- Timer and level meter ----

function updateTimerAndLevel() {
    const elapsed = (Date.now() - startTime) / 1000;
    const mins = Math.floor(elapsed / 60);
    const secs = Math.floor(elapsed % 60);
    $('timer').textContent = `${mins}:${secs.toString().padStart(2, '0')}`;

    const db = 20 * Math.log10(Math.max(inputLevel, 1e-10));
    const norm = Math.min(Math.max((db + 60) / 55, 0), 1);
    $('levelFill').style.width = `${norm * 100}%`;
    $('levelFill').style.background = norm > 0.8 ? '#c45c3e' : norm > 0.1 ? '#4c8c30' : '#4a6340';

    const secCaptured = Math.floor(totalSamples / SAMPLE_RATE);
    if (secCaptured < MIN_AUDIO_SEC) {
        $('statusText').textContent = `Capturing... need ${MIN_AUDIO_SEC - secCaptured}s more`;
    } else if (!workerBusy) {
        $('statusText').textContent = `Analysing last ${Math.min(secCaptured, MAX_AUDIO_SEC)}s`;
    }
}

// ---- Analysis pipeline (Worker + ONNX) ----

function requestAnalysis() {
    if (workerBusy) return;
    const minSamples = MIN_AUDIO_SEC * SAMPLE_RATE;
    if (totalSamples < minSamples) return;

    workerBusy = true;
    $('statusText').textContent = 'Processing audio...';

    const buffer = getAudioBuffer();
    dspWorker.postMessage(
        { type: 'process', data: { samples: buffer } },
        [buffer.buffer]
    );
}

async function handleWorkerResult(data) {
    workerBusy = false;
    if (!data) return;

    const { chroma, rawEnergy, nFrames, tensors, tensorsFg, tempo } = data;

    // Detect silence: check if current input level is below noise floor
    const isQuiet = inputLevel < SILENCE_THRESHOLD;
    if (isQuiet) {
        silenceCount++;
        if (silenceCount >= SILENCE_CYCLES && musicActive) {
            // Transition from music to silence — freeze display, keep sheet music
            musicActive = false;
            lockCount = 0;
            sheetFetchId = null;
            if (sheetLocked) startSilenceUnlockTimer();
            if (isRecording) $('statusText').textContent = 'Waiting for music...';
        }
    } else {
        silenceCount = 0;
        if (!musicActive) {
            // Transition from silence to music — resume analysis
            musicActive = true;
            lockCount = 0;
            sheetFetchId = null;
        }
    }

    // Smooth tempo estimate (only when music active)
    if (tempo && musicActive) {
        if (currentTempo === null) {
            currentTempo = tempo;
        } else {
            currentTempo = Math.round(currentTempo * 0.6 + tempo * 0.4);
        }
    }

    lastNFrames = nFrames;
    drawChromagram(chroma, rawEnergy, nFrames);
    drawSilenceOverlay(rawEnergy, nFrames);

    if (tensors.length === 0) return;

    // If silent, skip inference — keep the last results on screen
    if (!musicActive) return;

    // Compute window frame positions (mirrors worker logic)
    const winStarts = [];
    if (nFrames < WINDOW_FRAMES) {
        winStarts.push(0);
    } else {
        for (let s = 0; s <= nFrames - WINDOW_FRAMES; s += HOP_FRAMES) winStarts.push(s);
    }

    // Run ONNX inference on both standard and foreground tensors
    const WEIGHT_STD = 0.35;
    const WEIGHT_FG = 0.65;

    // Helper: run inference on a set of tensors, return per-window probs
    async function inferWindows(windowTensors) {
        const allProbs = [];
        for (const tensorData of windowTensors) {
            const input = new ort.Tensor('float32', tensorData, [1, 2, N_CHROMA, WINDOW_FRAMES]);
            const output = await onnxSession.run({ input });
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

    const probsStd = await inferWindows(tensors);
    const probsFg = tensorsFg && tensorsFg.length > 0 ? await inferWindows(tensorsFg) : [];

    // Build per-window regions from ensemble for chromagram overlay
    const nClasses = probsStd[0].length;
    const regions = [];
    for (let w = 0; w < probsStd.length; w++) {
        // Ensemble this window's probs
        const combined = new Float32Array(nClasses);
        for (let i = 0; i < nClasses; i++) combined[i] = probsStd[w][i] * WEIGHT_STD;
        if (w < probsFg.length) {
            for (let i = 0; i < nClasses; i++) combined[i] += probsFg[w][i] * WEIGHT_FG;
        } else {
            for (let i = 0; i < nClasses; i++) combined[i] += probsStd[w][i] * WEIGHT_FG;
        }

        let topIdx = 0;
        for (let i = 1; i < nClasses; i++) if (combined[i] > combined[topIdx]) topIdx = i;
        const startFrame = winStarts[w] || 0;
        const endFrame = Math.min(startFrame + WINDOW_FRAMES, nFrames);
        regions.push({
            startFrame, endFrame,
            id: tuneIndex[topIdx]?.id,
            name: tuneIndex[topIdx]?.name || '?',
            prob: combined[topIdx],
        });
    }
    windowRegions = regions;
    drawWindowOverlay(nFrames);

    // Ensemble average across all windows
    const avg = new Float32Array(nClasses);
    // Normalize per-approach then combine
    const avgStd = new Float32Array(nClasses);
    for (const p of probsStd) for (let i = 0; i < nClasses; i++) avgStd[i] += p[i];
    for (let i = 0; i < nClasses; i++) avgStd[i] /= probsStd.length;

    if (probsFg.length > 0) {
        const avgFg = new Float32Array(nClasses);
        for (const p of probsFg) for (let i = 0; i < nClasses; i++) avgFg[i] += p[i];
        for (let i = 0; i < nClasses; i++) avgFg[i] /= probsFg.length;
        for (let i = 0; i < nClasses; i++) avg[i] = avgStd[i] * WEIGHT_STD + avgFg[i] * WEIGHT_FG;
    } else {
        for (let i = 0; i < nClasses; i++) avg[i] = avgStd[i];
    }

    const indices = Array.from({ length: nClasses }, (_, i) => i);
    indices.sort((a, b) => avg[b] - avg[a]);

    const predictions = indices.slice(0, 10).map((idx, rank) => ({
        rank: rank + 1,
        prob: avg[idx],
        id: tuneIndex[idx]?.id,
        name: tuneIndex[idx]?.name || `Unknown #${idx}`,
        type: tuneIndex[idx]?.type || '',
    }));

    renderResults(predictions);
    updateLockOn(predictions[0]);
    if (isRecording) $('statusText').textContent = `Analysing last ${MAX_AUDIO_SEC}s`;
}

// ---- UI: Chromagram ----

// Forest colormap: dark soil -> bark brown -> deep green -> leaf green -> bright canopy
const CMAP = [
    [15,12,8],[35,28,15],[60,42,18],[80,58,22],
    [40,70,25],[30,95,30],[50,130,40],[85,170,55],
    [140,200,80],[195,225,130],
];

function colorMap(v) {
    const t = Math.max(0, Math.min(1, v)) * (CMAP.length - 1);
    const i = Math.floor(t), f = t - i;
    const a = CMAP[Math.min(i, CMAP.length - 1)];
    const b = CMAP[Math.min(i + 1, CMAP.length - 1)];
    return [
        Math.round(a[0] + (b[0] - a[0]) * f),
        Math.round(a[1] + (b[1] - a[1]) * f),
        Math.round(a[2] + (b[2] - a[2]) * f),
    ];
}

function drawChromagram(chroma, rawEnergy, nFrames) {
    const canvas = $('chromaCanvas');
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const img = ctx.createImageData(w, h);
    const rowH = h / N_CHROMA;

    // Compute per-frame max raw energy for brightness scaling.
    // Quiet frames get dimmed so room noise doesn't look like signal.
    const frameMax = new Float32Array(nFrames);
    let globalMax = 0;
    for (let f = 0; f < nFrames; f++) {
        let mx = 0;
        for (let c = 0; c < N_CHROMA; c++) {
            const v = rawEnergy[c * nFrames + f];
            if (v > mx) mx = v;
        }
        frameMax[f] = mx;
        if (mx > globalMax) globalMax = mx;
    }

    for (let x = 0; x < w; x++) {
        const f = Math.floor((x / w) * nFrames);
        if (f >= nFrames) continue;
        // Brightness: log-scale ratio of frame energy to global max
        // so quiet frames are dark and loud frames are bright
        const rawRatio = globalMax > 0 ? frameMax[f] / globalMax : 0;
        const brightness = Math.max(0, Math.min(1, Math.pow(rawRatio, 0.4)));
        for (let c = 0; c < N_CHROMA; c++) {
            const row = N_CHROMA - 1 - c;
            const [r, g, b] = colorMap(chroma[c * nFrames + f]);
            const y0 = Math.floor(row * rowH);
            const y1 = Math.floor((row + 1) * rowH);
            for (let y = y0; y < y1 && y < h; y++) {
                const idx = (y * w + x) * 4;
                img.data[idx] = Math.round(r * brightness);
                img.data[idx+1] = Math.round(g * brightness);
                img.data[idx+2] = Math.round(b * brightness);
                img.data[idx+3] = 255;
            }
        }
    }
    ctx.putImageData(img, 0, 0);
}

// ---- UI: Window overlay on chromagram ----

// Deterministic forest-hue color from tune ID
function tuneColor(id) {
    // Spread across greens, teals, and warm earth tones
    let h = 80 + (((id * 2654435761) >>> 0) % 120);  // 80-200 range (greens to teals)
    return `hsla(${h}, 50%, 45%, 0.2)`;
}

function drawWindowOverlay(nFrames) {
    if (windowRegions.length === 0) return;
    const canvas = $('chromaCanvas');
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const bandH = 16;  // height of the label band at bottom

    // Group consecutive windows with same tune ID into merged regions
    const merged = [];
    for (const r of windowRegions) {
        const last = merged[merged.length - 1];
        if (last && last.id === r.id) {
            last.endFrame = r.endFrame;
            last.prob = Math.max(last.prob, r.prob);
        } else {
            merged.push({ ...r });
        }
    }

    for (const region of merged) {
        const x0 = Math.round((region.startFrame / nFrames) * w);
        const x1 = Math.round((region.endFrame / nFrames) * w);
        const rw = x1 - x0;

        // Tinted overlay across full height
        ctx.fillStyle = tuneColor(region.id);
        ctx.fillRect(x0, 0, rw, h);

        // Label band at bottom
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(x0, h - bandH, rw, bandH);

        // Tune name label
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0 + 2, h - bandH, rw - 4, bandH);
        ctx.clip();
        ctx.fillStyle = '#f0f4ec';
        ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText(region.name, x0 + 4, h - bandH / 2);
        ctx.restore();

        // Separator line between regions
        if (merged.indexOf(region) > 0) {
            ctx.strokeStyle = 'rgba(200,224,176,0.3)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x0, 0);
            ctx.lineTo(x0, h);
            ctx.stroke();
        }
    }
}

// Spectral flatness on RAW (pre-normalized) chroma energy.
// After peak normalization, noise looks peaky due to bin squashing,
// so we must use the raw values where noise is genuinely flat.
// 1.0 = perfectly flat (noise), 0.0 = one dominant pitch (melodic)
function chromaFlatness(rawEnergy, nFrames, f) {
    let logSum = 0, sum = 0;
    for (let c = 0; c < N_CHROMA; c++) {
        const v = Math.max(rawEnergy[c * nFrames + f], 1e-10);
        logSum += Math.log(v);
        sum += v;
    }
    const geoMean = Math.exp(logSum / N_CHROMA);
    const ariMean = sum / N_CHROMA;
    return ariMean > 1e-10 ? geoMean / ariMean : 1.0;
}

function drawSilenceOverlay(rawEnergy, nFrames) {
    const canvas = $('chromaCanvas');
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const bandH = 16;
    const FLATNESS_THRESH = 0.45;  // above this = noise/ambient

    // Collect contiguous noisy regions
    const regions = [];
    let inNoise = false;
    let noiseStart = 0;

    for (let x = 0; x <= w; x++) {
        const f = Math.floor((x / w) * nFrames);
        let isNoise;
        if (f >= nFrames) {
            isNoise = true;
        } else {
            const flatness = chromaFlatness(rawEnergy, nFrames, f);
            isNoise = flatness > FLATNESS_THRESH;
        }

        if (isNoise && !inNoise) {
            inNoise = true;
            noiseStart = x;
        } else if (!isNoise && inNoise) {
            inNoise = false;
            regions.push([noiseStart, x]);
        }
    }
    if (inNoise) regions.push([noiseStart, w]);

    for (const [x0, x1] of regions) {
        const rw = x1 - x0;
        ctx.fillStyle = 'rgba(10,18,12,0.93)';
        ctx.fillRect(x0, 0, rw, h);

        if (rw > 30) {
            ctx.fillStyle = 'rgba(0,0,0,0.5)';
            ctx.fillRect(x0, h - bandH, rw, bandH);
            ctx.save();
            ctx.beginPath();
            ctx.rect(x0 + 2, h - bandH, rw - 4, bandH);
            ctx.clip();
            ctx.fillStyle = '#c0c8b8';
            ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
            ctx.textBaseline = 'middle';
            ctx.fillText('Noise', x0 + 4, h - bandH / 2);
            ctx.restore();
        }
    }
}

// ---- UI: Results ----

function formatType(type) {
    const info = TYPE_INFO[type];
    return info ? info.label : type;
}

function renderResults(predictions) {
    if (!predictions || !predictions.length) return;

    const top = predictions[0];
    const topType = TYPE_INFO[top.type];

    // Hero card
    $('topTuneName').textContent = top.name;
    $('topTuneType').textContent = topType ? topType.label : (top.type || '');
    $('topTuneConf').textContent = `${(top.prob * 100).toFixed(1)}% confidence`;
    if (top.id) {
        $('topTuneLink').href = `${SESSION_URL}/${top.id}`;
        $('topTuneLink').classList.remove('hidden');
    } else {
        $('topTuneLink').classList.add('hidden');
    }

    // Metrics: tempo and time signature (from top prediction's type + onset detection)
    if (topType) {
        $('metricTimeSig').textContent = topType.timeSig;
    } else {
        $('metricTimeSig').textContent = '--';
    }
    $('metricTempo').textContent = currentTempo ? `${currentTempo}` : '--';

    // Predictions list (#2-#10)
    const list = $('predictionsList');
    const maxProb = top.prob;
    list.innerHTML = predictions.map(p => {
        const pct = (p.prob * 100).toFixed(1);
        const barW = maxProb > 0 ? (p.prob / maxProb * 100) : 0;
        const typeLabel = formatType(p.type);
        const typeHtml = typeLabel ? `<span class="pred-type">${typeLabel}</span>` : '';
        const topClass = p.rank === 1 ? ' pred-top' : '';
        return `<div class="pred-row${topClass}" data-tune-id="${p.id}" data-tune-name="${p.name}">
            <div class="pred-bar" style="width:${barW}%"></div>
            <span class="pred-rank">${p.rank}</span>
            <div class="pred-info">
                <span class="pred-name">${p.name} ${typeHtml}</span>
            </div>
            <span class="pred-pct">${pct}%</span>
        </div>`;
    }).join('');
}

// ---- Sheet Music ----

function updateLockOn(top) {
    if (!top || !top.id) return;
    if (!musicActive) return; // don't update lock-on during silence

    // If sheet is user-locked, still track history but don't change sheet music
    if (sheetLocked) {
        resetSilenceUnlock();  // music is active, cancel any unlock countdown
        updateHistory(top);
        return;
    }

    if (top.id === lockedTuneId) {
        // Same tune still locked — update confidence in history
        if (sessionHistory.length > 0 && sessionHistory[0].id === top.id) {
            sessionHistory[0].conf = top.prob;
            renderHistory();
        }
        return;
    }

    if (top.id === sheetFetchId) {
        lockCount++;
    } else {
        sheetFetchId = top.id;
        lockCount = 1;
    }

    if (lockCount >= LOCK_THRESHOLD) {
        updateHistory(top);
        loadSheetForTune(top.id);
    }
}

function loadSheetForTune(tuneId) {
    if (lockedTuneId === tuneId) return;
    lockedTuneId = tuneId;

    // Look up settings from our local tune index (dominant key only)
    const entry = tuneById[tuneId];
    if (!entry || !entry.settings || entry.settings.length === 0) return;

    sheetSettings = entry.settings;
    sheetSettingIdx = 0;
    renderSheet();
    $('sheetPanel').classList.add('open');
    updateSheetContext();
    renderHistory();
    scheduleAutoScroll();
}

// Map key strings from The Session archive to ABC K: field
function abcKeyField(keyStr) {
    if (!keyStr) return 'C';
    // e.g. "Gmajor" -> "Gmaj", "Edorian" -> "Edor", "Aminor" -> "Amin"
    const m = keyStr.match(/^([A-G][b#]?)(major|minor|dorian|mixolydian|lydian|phrygian|locrian)$/i);
    if (!m) return keyStr;
    const note = m[1];
    const mode = m[2].toLowerCase();
    const modeMap = { major: 'maj', minor: 'min', dorian: 'dor', mixolydian: 'mix', lydian: 'lyd', phrygian: 'phr', locrian: 'loc' };
    return note + (modeMap[mode] || mode);
}

function renderSheet() {
    if (sheetSettings.length === 0) return;
    const setting = sheetSettings[sheetSettingIdx];

    // Build ABC with proper headers from tune metadata
    const entry = tuneById[lockedTuneId];
    const tuneType = entry?.type || '';
    const keyStr = entry?.key || '';
    const typeInfo = TYPE_INFO[tuneType];
    const meter = typeInfo?.timeSig || '4/4';
    const noteLen = '1/8';
    const kField = abcKeyField(keyStr);

    // Strip any existing header lines (T:, M:, K:, L:, X:) from the body
    const body = setting.abc.split('\n').filter(l => !l.match(/^[TMLKXW]:/)).join('\n');
    const abc = `X:1\nM:${meter}\nL:${noteLen}\nK:${kField}\n${body}`;

    ABCJS.renderAbc('sheetRender', abc, {
        responsive: 'resize',
        staffwidth: 600,
        paddingtop: 10,
        paddingbottom: 10,
        scale: 1.2,
        foregroundColor: '#c8e0b0',
    });

    $('settingLabel').textContent = `Setting ${sheetSettingIdx + 1} of ${sheetSettings.length}`;
    $('prevSetting').disabled = sheetSettingIdx === 0;
    $('nextSetting').disabled = sheetSettingIdx === sheetSettings.length - 1;
}

function hideSheet() {
    $('sheetPanel').classList.remove('open');
    lockedTuneId = null;
    sheetSettings = [];
    sheetSettingIdx = 0;
    sheetFetchId = null;
    lockCount = 0;
    if (autoScrollTimer) { clearTimeout(autoScrollTimer); autoScrollTimer = null; }
    stopSheetContext();
}

// ---- Sheet lock ----

function toggleSheetLock() {
    if (sheetLocked) {
        unlockSheet();
    } else {
        lockSheet();
    }
}

function lockSheet() {
    sheetLocked = true;
    updateLockUI();
}

function unlockSheet() {
    sheetLocked = false;
    clearSilenceUnlock();
    updateLockUI();
}

function updateLockUI() {
    const btn = $('sheetLock');
    if (unlockCountdown > 0) {
        btn.textContent = unlockCountdown;
        btn.className = 'sheet-lock countdown';
        btn.title = `Auto-unlock in ${unlockCountdown}s`;
    } else if (sheetLocked) {
        btn.textContent = '\u{1F512}';
        btn.className = 'sheet-lock locked';
        btn.title = 'Sheet music pinned — tap to unpin';
    } else {
        btn.textContent = '\u{1F513}';
        btn.className = 'sheet-lock';
        btn.title = 'Pin sheet music';
    }
}

// When music is active, cancel any pending unlock timers
function resetSilenceUnlock() {
    if (silenceUnlockTimer) { clearTimeout(silenceUnlockTimer); silenceUnlockTimer = null; }
    if (unlockInterval) { clearInterval(unlockInterval); unlockInterval = null; }
    if (unlockCountdown > 0) {
        unlockCountdown = 0;
        updateLockUI();
    }
}

function clearSilenceUnlock() {
    if (silenceUnlockTimer) { clearTimeout(silenceUnlockTimer); silenceUnlockTimer = null; }
    if (unlockInterval) { clearInterval(unlockInterval); unlockInterval = null; }
    unlockCountdown = 0;
}

// Called when music goes silent while sheet is locked
function startSilenceUnlockTimer() {
    if (!sheetLocked) return;
    if (silenceUnlockTimer) return; // already waiting
    silenceUnlockTimer = setTimeout(() => {
        silenceUnlockTimer = null;
        if (!sheetLocked) return;
        // Start the 15s countdown
        unlockCountdown = LOCK_COUNTDOWN;
        updateLockUI();
        unlockInterval = setInterval(() => {
            unlockCountdown--;
            if (unlockCountdown <= 0) {
                clearInterval(unlockInterval);
                unlockInterval = null;
                unlockSheet();
            } else {
                updateLockUI();
            }
        }, 1000);
    }, LOCK_SILENCE_WAIT * 1000);
}

// ---- Auto-scroll to sheet music ----

function scheduleAutoScroll() {
    if (autoScrollTimer) clearTimeout(autoScrollTimer);
    autoScrollTimer = setTimeout(() => {
        autoScrollTimer = null;
        // Only scroll if user is still near the top of the page
        if (window.scrollY > 150) return;
        const panel = $('sheetPanel');
        if (!panel.classList.contains('open')) return;
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, AUTO_SCROLL_DELAY);
}

// ---- Sheet context fader (visible when hero card scrolled out of view) ----

function updateSheetContext() {
    const el = $('sheetContext');
    if (!lockedTuneId) { el.classList.remove('visible'); return; }
    const entry = tuneById[lockedTuneId];
    if (!entry) return;
    const typeInfo = TYPE_INFO[entry.type];
    const parts = [];
    if (typeInfo) parts.push(`<span class="ctx-type">${typeInfo.label}</span>`);
    if (typeInfo) parts.push(typeInfo.timeSig);
    if (currentTempo) parts.push(`${currentTempo} BPM`);
    el.innerHTML = `<span class="sheet-context-name">${entry.name}</span>` +
        (parts.length ? `<span class="sheet-context-meta">${parts.join(' · ')}</span>` : '');
}

function startSheetContext() {
    updateSheetContext();
    $('sheetContext').classList.add('visible');
}

function stopSheetContext() {
    $('sheetContext').classList.remove('visible');
}

function initHeroObserver() {
    if (heroObserver) return;
    const hero = document.querySelector('.hero');
    heroObserver = new IntersectionObserver((entries) => {
        const heroVisible = entries[0].isIntersecting;
        if (!heroVisible && lockedTuneId && $('sheetPanel').classList.contains('open')) {
            startSheetContext();
        } else {
            stopSheetContext();
        }
    }, { threshold: 0 });
    heroObserver.observe(hero);
}

// ---- Session History ----

function updateHistory(top) {
    if (!top || !top.id) return;

    // Skip if same tune as last entry
    if (lastTopTuneId === top.id) {
        // Update confidence of current entry
        if (sessionHistory.length > 0) {
            sessionHistory[0].conf = top.prob;
            renderHistory();
        }
        return;
    }

    lastTopTuneId = top.id;
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    sessionHistory.unshift({
        time: timeStr,
        name: top.name,
        type: top.type,
        id: top.id,
        conf: top.prob,
    });

    renderHistory();
}

function renderHistory() {
    const list = $('historyList');
    if (sessionHistory.length === 0) {
        list.innerHTML = '<div class="history-empty">Tunes will appear here as they are identified</div>';
        return;
    }

    list.innerHTML = sessionHistory.map((entry, i) => {
        const typeLabel = formatType(entry.type);
        const confPct = (entry.conf * 100).toFixed(0);
        const currentClass = i === 0 ? ' current' : '';
        const activeSheet = entry.id === lockedTuneId ? ' active-sheet' : '';
        return `<div class="history-entry${currentClass}${activeSheet}" data-tune-id="${entry.id}" data-tune-name="${entry.name}">
            <span class="history-time">${entry.time}</span>
            <div class="history-name">${entry.name}</div>
            <div class="history-meta">
                <span class="history-type">${typeLabel}</span>
                <span class="history-conf">${confPct}%</span>
            </div>
        </div>`;
    }).join('');
}

// ---- Initialization ----

async function init() {
    const status = $('loadText');
    const progress = $('loadProgress');

    status.textContent = 'Loading chroma filter bank...';
    progress.value = 0;
    let chromaFB;
    try {
        const r = await fetch('assets/chroma_fb.json');
        const arr = await r.json();
        const nBins = arr[0].length;
        chromaFB = new Float32Array(N_CHROMA * nBins);
        for (let c = 0; c < N_CHROMA; c++)
            for (let b = 0; b < nBins; b++)
                chromaFB[c * nBins + b] = arr[c][b];
    } catch (e) {
        status.textContent = 'Failed to load filter bank: ' + e.message;
        return;
    }

    status.textContent = 'Loading tune database...';
    progress.value = 1;
    try {
        const r = await fetch('assets/tune_index.json');
        tuneIndex = await r.json();
        // Build ID lookup
        for (const entry of Object.values(tuneIndex)) tuneById[entry.id] = entry;
    } catch (e) {
        status.textContent = 'Failed to load tune index: ' + e.message;
        return;
    }

    status.textContent = 'Initializing DSP worker...';
    progress.value = 1.5;
    dspWorker = new Worker('worker.js');
    dspWorker.onmessage = (e) => {
        if (e.data.type === 'ready') console.log('DSP worker ready');
        if (e.data.type === 'result') handleWorkerResult(e.data.data);
    };
    const fbCopy = new Float32Array(chromaFB);
    dspWorker.postMessage({ type: 'init', data: { chromaFB: fbCopy } }, [fbCopy.buffer]);

    status.textContent = 'Loading ML model (20 MB)...';
    progress.value = 2;
    try {
        ort.env.wasm.numThreads = 1;
        onnxSession = await ort.InferenceSession.create('assets/model.onnx', {
            executionProviders: ['wasm'],
        });
    } catch (e) {
        status.textContent = 'Failed to load model: ' + e.message;
        return;
    }

    progress.value = 3;
    $('loading').classList.add('hidden');
    $('mainUI').classList.remove('hidden');

    $('tapStart').addEventListener('click', (ev) => { ev.preventDefault(); startRecording(); });
    initHeroObserver();
    $('prevSetting').addEventListener('click', () => {
        if (sheetSettingIdx > 0) { sheetSettingIdx--; renderSheet(); }
    });
    $('nextSetting').addEventListener('click', () => {
        if (sheetSettingIdx < sheetSettings.length - 1) { sheetSettingIdx++; renderSheet(); }
    });

    $('sheetLock').addEventListener('click', toggleSheetLock);

    // Predictions click: load that tune's sheet music
    $('predictionsList').addEventListener('click', (e) => {
        const row = e.target.closest('.pred-row');
        if (!row) return;
        const tuneId = parseInt(row.dataset.tuneId, 10);
        if (!tuneId) return;
        lockedTuneId = null;
        loadSheetForTune(tuneId);
        $('topTuneName').textContent = row.dataset.tuneName;
        renderHistory();
    });

    // Rotating taglines
    const taglines = [
        'Irish Tune Identifier',
        'What the hell is going on?',
        'Chaos is a Ladder',
        'Who is playing that bodhr\u00e1n?',
        'Thinking',
        'Vibing',
        '\uD83E\uDD8A',
        'Is this a reel or a jig?',
        'Ah sure look it',
        'One more tune and then we\u2019ll go',
        'Grand so',
        'Not Drowsy Maggie again',
        'Will ye whisht',
        'The session starts at 9 (it\u2019s 11)',
        'Pint of plain please',
        'Who started that?',
    ];
    let tagIdx = 0;
    setInterval(() => {
        const el = $('tagline');
        el.classList.add('fading');
        setTimeout(() => {
            tagIdx = (tagIdx + 1) % taglines.length;
            el.textContent = taglines[tagIdx];
            el.classList.remove('fading');
        }, 600);
    }, 12000);

    // History click: load that tune's sheet music
    $('historyList').addEventListener('click', (e) => {
        const entry = e.target.closest('.history-entry');
        if (!entry) return;
        const tuneId = parseInt(entry.dataset.tuneId, 10);
        if (!tuneId) return;
        // Force-fetch this tune's sheet music
        lockedTuneId = null; // allow re-fetch even if same tune
        loadSheetForTune(tuneId);
        // Update hero card to show this tune
        const name = entry.dataset.tuneName;
        $('topTuneName').textContent = name;
        renderHistory(); // refresh to highlight active sheet
    });
}

init();
