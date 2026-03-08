// AudioWorklet processor: captures raw PCM samples, resamples if needed,
// and forwards to main thread at the target sample rate.
class PCMProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const opts = options.processorOptions || {};
        this.targetRate = opts.targetRate || 22050;
        this.nativeRate = opts.nativeRate || sampleRate;
        this.ratio = this.nativeRate / this.targetRate;
        this.needsResample = Math.abs(this.ratio - 1) > 0.01;
        this.srcPos = 0; // fractional position in source stream
    }

    process(inputs) {
        const input = inputs[0];
        if (input.length === 0) return true;
        const samples = input[0];
        if (!samples || samples.length === 0) return true;

        if (!this.needsResample) {
            this.port.postMessage(new Float32Array(samples));
            return true;
        }

        // Linear interpolation downsampling
        // ratio = nativeRate / targetRate (e.g. 48000/22050 ≈ 2.177)
        // For each output sample, advance by `ratio` in the input
        const ratio = this.ratio;
        const outLen = Math.floor((samples.length - this.srcPos) / ratio);
        if (outLen <= 0) {
            this.srcPos -= samples.length;
            return true;
        }

        const out = new Float32Array(outLen);
        let pos = this.srcPos;
        for (let i = 0; i < outLen; i++) {
            const idx = Math.floor(pos);
            const frac = pos - idx;
            if (idx + 1 < samples.length) {
                out[i] = samples[idx] * (1 - frac) + samples[idx + 1] * frac;
            } else {
                out[i] = idx < samples.length ? samples[idx] : 0;
            }
            pos += ratio;
        }
        // Carry over fractional position for next block
        this.srcPos = pos - samples.length;

        this.port.postMessage(out);
        return true;
    }
}

registerProcessor('pcm-processor', PCMProcessor);
