// Irish Tune Identifier — Client-side web app
// DSP runs in a Web Worker; ONNX inference is async via WASM.
// The main thread only handles audio capture and UI updates.

const SAMPLE_RATE = 22050;
const N_CHROMA = 12;
const WINDOW_FRAMES = 344;
const HOP_LENGTH = 512;
const MAX_AUDIO_SEC = 15;
const MIN_AUDIO_SEC = 4;      // start predicting early with zero-padded windows
const UPDATE_INTERVAL_MS = 2000;
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
        $('tapStart').textContent = 'Microphone access denied — tap to retry';
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
    $('tapStart').classList.add('hidden');
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
        $('tapStart').textContent = 'Error: ' + e.message + ' — tap to retry';
        $('tapStart').classList.remove('hidden');
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
    $('tapStart').classList.remove('hidden');
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
    $('levelFill').style.background = norm > 0.8 ? '#f4212e' : norm > 0.1 ? '#2ecc71' : '#556677';

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

    const { chroma, nFrames, tensors, tempo } = data;

    // Detect silence: check if current input level is below noise floor
    const isQuiet = inputLevel < SILENCE_THRESHOLD;
    if (isQuiet) {
        silenceCount++;
        if (silenceCount >= SILENCE_CYCLES && musicActive) {
            // Transition from music to silence — freeze display, keep sheet music
            musicActive = false;
            lockCount = 0;
            sheetFetchId = null;
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

    drawChromagram(chroma, nFrames);

    if (tensors.length === 0) return;

    // If silent, skip inference — keep the last results on screen
    if (!musicActive) return;

    // Run ONNX inference
    const allProbs = [];
    for (const tensorData of tensors) {
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

    const nClasses = allProbs[0].length;
    const avg = new Float32Array(nClasses);
    for (const p of allProbs) for (let i = 0; i < nClasses; i++) avg[i] += p[i];
    for (let i = 0; i < nClasses; i++) avg[i] /= allProbs.length;

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

const CMAP = [
    [13,8,40],[56,15,95],[103,18,119],[146,27,107],
    [186,52,83],[219,89,60],[244,140,37],[253,199,39],[252,253,164],
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

function drawChromagram(chroma, nFrames) {
    const canvas = $('chromaCanvas');
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const img = ctx.createImageData(w, h);
    const rowH = h / N_CHROMA;

    for (let x = 0; x < w; x++) {
        const f = Math.floor((x / w) * nFrames);
        if (f >= nFrames) continue;
        for (let c = 0; c < N_CHROMA; c++) {
            const row = N_CHROMA - 1 - c;
            const [r, g, b] = colorMap(chroma[c * nFrames + f]);
            const y0 = Math.floor(row * rowH);
            const y1 = Math.floor((row + 1) * rowH);
            for (let y = y0; y < y1 && y < h; y++) {
                const idx = (y * w + x) * 4;
                img.data[idx] = r; img.data[idx+1] = g;
                img.data[idx+2] = b; img.data[idx+3] = 255;
            }
        }
    }
    ctx.putImageData(img, 0, 0);
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
        foregroundColor: '#d0d8e4',
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

    $('tapStart').addEventListener('click', startRecording);
    $('prevSetting').addEventListener('click', () => {
        if (sheetSettingIdx > 0) { sheetSettingIdx--; renderSheet(); }
    });
    $('nextSetting').addEventListener('click', () => {
        if (sheetSettingIdx < sheetSettings.length - 1) { sheetSettingIdx++; renderSheet(); }
    });

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
