// AudioWorklet processor: captures raw PCM samples and forwards to main thread.
class PCMProcessor extends AudioWorkletProcessor {
    process(inputs) {
        const input = inputs[0];
        if (input.length > 0) {
            // Send a copy of the first channel's samples
            this.port.postMessage(new Float32Array(input[0]));
        }
        return true;
    }
}

registerProcessor('pcm-processor', PCMProcessor);
