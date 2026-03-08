// Inference Worker: runs ONNX model inference off the main thread.
// Receives tensor data from the main thread, runs inference, returns probabilities.

importScripts('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.min.js');

const N_CHROMA = 12;
const WINDOW_FRAMES = 344;

let session = null;

self.onmessage = async function(e) {
    const { type, data } = e.data;

    if (type === 'init') {
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

    if (type === 'infer') {
        if (!session) return;
        const { tensorsStd, tensorsFg, requestId } = data;

        const probsStd = await inferWindows(tensorsStd);
        const probsFg = tensorsFg && tensorsFg.length > 0 ? await inferWindows(tensorsFg) : [];

        const transferables = [
            ...probsStd.map(p => p.buffer),
            ...probsFg.map(p => p.buffer),
        ];
        self.postMessage({ type: 'result', data: { probsStd, probsFg, requestId } }, transferables);
    }
};

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
