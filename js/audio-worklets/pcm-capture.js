// AudioWorkletProcessor that takes the AudioContext's native-rate mono mic
// stream and downsamples it to 16 kHz PCM16, posting chunks as Int16Array
// buffers every ~40 ms to the main thread.
//
// Downsample strategy: per-output-sample linear interpolation between the
// two nearest input samples. Not as sharp as a polyphase filter but fine for
// 16 kHz speech → Gemini STT/VAD. No ScriptProcessorNode anywhere.

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { outputSampleRate = 16000, frameMs = 40 } = options?.processorOptions || {};
    this.outputSampleRate = outputSampleRate;
    this.inputSampleRate = sampleRate; // provided by the worklet global
    this.ratio = this.inputSampleRate / this.outputSampleRate;
    this.frameSamples = Math.round((outputSampleRate * frameMs) / 1000);

    // Resample state: fractional position into input-sample buffer.
    this.pos = 0;
    this.prev = 0; // last input sample, for cross-quantum interpolation
    this.out = new Int16Array(this.frameSamples);
    this.outIdx = 0;
    this.muted = false;

    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'mute') this.muted = !!e.data.value;
    };
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;

    if (this.muted) {
      // Still consume input quantum, but emit nothing.
      return true;
    }

    // Sample-rate convert channel (Float32) -> this.out (Int16), frame-fill as we go.
    const outRate = this.outputSampleRate;
    const inRate = this.inputSampleRate;
    const ratio = inRate / outRate;

    // We traverse the output grid. For each output sample, compute its time in
    // input-samples (`pos`) and linearly interpolate between floor/ceil.
    // `pos` persists across callbacks so downsampling is continuous.
    let pos = this.pos;
    let prev = this.prev;

    // Max output samples we could emit from this quantum:
    //   (channel.length + cushion from `prev`) / ratio
    // but emit only what's in-range.
    while (true) {
      const idx = Math.floor(pos);
      if (idx >= channel.length) break;
      const frac = pos - idx;
      const a = idx > 0 ? channel[idx - 1] : prev;
      const b = channel[idx];
      const sample = a * (1 - frac) + b * frac;
      // Convert [-1, 1] float to Int16 LE (clamped).
      let s = sample * 32767;
      if (s > 32767) s = 32767; else if (s < -32768) s = -32768;
      this.out[this.outIdx++] = s | 0;

      if (this.outIdx === this.frameSamples) {
        // Emit as a fresh ArrayBuffer for transferable post.
        const copy = new Int16Array(this.out);
        this.port.postMessage(copy.buffer, [copy.buffer]);
        this.out = new Int16Array(this.frameSamples);
        this.outIdx = 0;
      }
      pos += ratio;
    }

    // Keep `pos` relative to the start of the NEXT quantum by subtracting the
    // current quantum length.
    this.pos = pos - channel.length;
    this.prev = channel[channel.length - 1];

    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
