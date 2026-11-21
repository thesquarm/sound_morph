import type { CornerId } from './morph';

export const MAX_RECORD_SECONDS = 15;

export interface CornerSample {
  id: CornerId;
  name: string;
  buffer: AudioBuffer;
  duration: number;
  peaks: number[];
  source: 'demo' | 'file' | 'mic';
}

export function extractPeaks(buffer: AudioBuffer, bins = 64): number[] {
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const total = ch0.length;
  if (total === 0) return Array(bins).fill(0);

  const step = Math.max(1, Math.floor(total / bins));
  const peaks: number[] = new Array(bins).fill(0);
  let maxPeak = 0;

  for (let b = 0; b < bins; b++) {
    const start = Math.floor((b * total) / bins);
    const end = Math.min(total, start + step);
    let peak = 0;
    const stride = Math.max(1, Math.floor((end - start) / 48));
    for (let i = start; i < end; i += stride) {
      const a0 = Math.abs(ch0[i]);
      const a1 = ch1 ? Math.abs(ch1[i]) : 0;
      const m = a0 > a1 ? a0 : a1;
      if (m > peak) peak = m;
    }
    peaks[b] = peak;
    if (peak > maxPeak) maxPeak = peak;
  }

  if (maxPeak > 0.0001) {
    for (let b = 0; b < bins; b++) {
      peaks[b] = Math.min(1, peaks[b] / maxPeak);
    }
  }
  return peaks;
}

export function trimAndNormalize(ctx: AudioContext, input: AudioBuffer): AudioBuffer {
  const sr = input.sampleRate;
  const numChannels = input.numberOfChannels;
  const len = input.length;

  if (len === 0) return input;

  const threshold = 0.012;
  let firstActive = 0;
  let lastActive = len - 1;

  // Find first non-silent sample
  outerStart: for (let i = 0; i < len; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      if (Math.abs(input.getChannelData(ch)[i]) > threshold) {
        firstActive = i;
        break outerStart;
      }
    }
  }

  // Find last non-silent sample
  outerEnd: for (let i = len - 1; i >= firstActive; i--) {
    for (let ch = 0; ch < numChannels; ch++) {
      if (Math.abs(input.getChannelData(ch)[i]) > threshold) {
        lastActive = i;
        break outerEnd;
      }
    }
  }

  const prePad = Math.floor(sr * 0.008);
  const postPad = Math.floor(sr * 0.02);
  const startIdx = Math.max(0, firstActive - prePad);
  const endIdx = Math.min(len - 1, lastActive + postPad);
  const outLen = Math.max(Math.floor(sr * 0.1), endIdx - startIdx + 1);

  const output = ctx.createBuffer(numChannels, outLen, sr);

  // Measure peak in trimmed region
  let maxAmp = 0;
  for (let ch = 0; ch < numChannels; ch++) {
    const src = input.getChannelData(ch);
    for (let i = 0; i < outLen; i++) {
      const idx = startIdx + i;
      const val = idx < len ? src[idx] : 0;
      const abs = Math.abs(val);
      if (abs > maxAmp) maxAmp = abs;
    }
  }

  const targetPeak = 0.89;
  const normGain = maxAmp > 0.001 ? targetPeak / maxAmp : 1;
  const fadeInSamples = Math.min(Math.floor(sr * 0.006), Math.floor(outLen * 0.1));
  const fadeOutSamples = Math.min(Math.floor(sr * 0.012), Math.floor(outLen * 0.1));

  for (let ch = 0; ch < numChannels; ch++) {
    const src = input.getChannelData(ch);
    const dst = output.getChannelData(ch);
    for (let i = 0; i < outLen; i++) {
      const idx = startIdx + i;
      let sample = (idx < len ? src[idx] : 0) * normGain;
      if (i < fadeInSamples) {
        sample *= i / fadeInSamples;
      } else if (i >= outLen - fadeOutSamples) {
        sample *= (outLen - 1 - i) / fadeOutSamples;
      }
      dst[i] = sample;
    }
  }

  return output;
}

export async function loadAudioFile(
  ctx: AudioContext,
  id: CornerId,
  file: File
): Promise<CornerSample> {
  const arrayBuffer = await file.arrayBuffer();
  const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
  const processed = trimAndNormalize(ctx, decoded);
  const baseName = file.name.replace(/\.[^/.]+$/, '').slice(0, 24) || `Sample ${id}`;

  return {
    id,
    name: baseName,
    buffer: processed,
    duration: processed.duration,
    peaks: extractPeaks(processed),
    source: 'file',
  };
}

export interface MicRecordingSession {
  stop: () => Promise<CornerSample>;
  cancel: () => void;
}

export async function startMicRecording(
  ctx: AudioContext,
  id: CornerId,
  onTick: (elapsedSec: number, level: number) => void,
  onAutoStop: (sample: CornerSample) => void,
  onError: (err: string) => void
): Promise<MicRecordingSession> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone capture is not supported in this browser.');
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  } catch {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }

  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);

  // Raw PCM capture buffer ensures recording works across Safari/Chrome/Firefox
  const pcmChunks: Float32Array[] = [];
  const processor = ctx.createScriptProcessor(2048, 1, 1);
  const muteSink = ctx.createGain();
  muteSink.gain.value = 0;

  processor.onaudioprocess = (e) => {
    const inputData = e.inputBuffer.getChannelData(0);
    pcmChunks.push(new Float32Array(inputData));
  };

  source.connect(processor);
  processor.connect(muteSink);
  muteSink.connect(ctx.destination);

  const timeData = new Uint8Array(analyser.fftSize);
  const startTime = performance.now();
  let finished = false;
  let rafId = 0;

  const cleanup = () => {
    cancelAnimationFrame(rafId);
    try {
      source.disconnect();
      processor.disconnect();
      muteSink.disconnect();
    } catch {
      // Ignore already disconnected
    }
    stream.getTracks().forEach((t) => t.stop());
  };

  const finalize = async (): Promise<CornerSample> => {
    if (finished) {
      throw new Error('Recording already finalized');
    }
    finished = true;
    cleanup();

    const totalLen = pcmChunks.reduce((acc, c) => acc + c.length, 0);
    const minSamples = Math.floor(ctx.sampleRate * 0.15);
    if (totalLen < minSamples) {
      throw new Error('Recording was too short.');
    }

    const rawBuffer = ctx.createBuffer(1, totalLen, ctx.sampleRate);
    const channel = rawBuffer.getChannelData(0);
    let offset = 0;
    for (const chunk of pcmChunks) {
      channel.set(chunk, offset);
      offset += chunk.length;
    }

    const processed = trimAndNormalize(ctx, rawBuffer);
    const now = new Date();
    const stamp = `${String(now.getMinutes()).padStart(2, '0')}:${String(
      now.getSeconds()
    ).padStart(2, '0')}`;

    return {
      id,
      name: `Mic ${id} (${stamp})`,
      buffer: processed,
      duration: processed.duration,
      peaks: extractPeaks(processed),
      source: 'mic',
    };
  };

  const tick = () => {
    if (finished) return;
    const elapsed = (performance.now() - startTime) / 1000;
    analyser.getByteTimeDomainData(timeData);
    let peak = 0;
    for (let i = 0; i < timeData.length; i++) {
      const v = Math.abs(timeData[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    onTick(Math.min(MAX_RECORD_SECONDS, elapsed), Math.min(1, peak * 1.8));

    if (elapsed >= MAX_RECORD_SECONDS) {
      finalize()
        .then(onAutoStop)
        .catch((err) => onError(err instanceof Error ? err.message : 'Recording failed'));
      return;
    }
    rafId = requestAnimationFrame(tick);
  };

  rafId = requestAnimationFrame(tick);

  return {
    stop: finalize,
    cancel: () => {
      if (finished) return;
      finished = true;
      cleanup();
    },
  };
}

/**
 * Generates 4 seamlessly looping synthetic soundscapes for immediate playability:
 * A: Drone (Warm harmonic chordal pad)
 * B: Pulse (Rhythmic 120 BPM resonant synth pulse)
 * C: Pluck (Poly-harmonic FM kalimba/bell plucks)
 * D: Voice (Formant-filtered choral vowel glide)
 */
export function generateDemoSounds(ctx: AudioContext): Record<CornerId, CornerSample> {
  const sr = ctx.sampleRate;

  const makeSeamlessLoop = (
    durationSec: number,
    renderSample: (t: number, ch: number) => number
  ): AudioBuffer => {
    const len = Math.floor(sr * durationSec);
    const buf = ctx.createBuffer(2, len, sr);
    const fadeLen = Math.floor(sr * 0.04);

    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        data[i] = renderSample(i / sr, ch);
      }
      // Crossfade loop seam so playback loops seamlessly
      for (let i = 0; i < fadeLen; i++) {
        const a = i / fadeLen;
        const tailIdx = len - fadeLen + i;
        const head = data[i];
        const tail = data[tailIdx];
        data[i] = head * a + tail * (1 - a);
        data[tailIdx] = tail * (1 - a) + head * a;
      }
    }

    // Peak normalize to 0.85
    let maxAmp = 0;
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const v = Math.abs(data[i]);
        if (v > maxAmp) maxAmp = v;
      }
    }
    const norm = maxAmp > 0.001 ? 0.85 / maxAmp : 1;
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) data[i] *= norm;
    }
    return buf;
  };

  // A: Drone (4.0s) — Warm Csus2/add9 harmonic pad with slow breathing
  const droneBuf = makeSeamlessLoop(4.0, (t, ch) => {
    const freqs = [130.81, 196.0, 261.63, 293.66, 329.63]; // C3, G3, C4, D4, E4
    const panDetune = ch === 0 ? -0.0025 : 0.0025;
    const lfo = 0.55 + 0.45 * Math.sin(2 * Math.PI * 0.25 * t);
    let sum = 0;
    for (let k = 0; k < freqs.length; k++) {
      const f = freqs[k] * (1 + panDetune * (k % 2 === 0 ? 1 : -1));
      const p1 = Math.sin(2 * Math.PI * f * t);
      const p2 = 0.4 * lfo * Math.sin(2 * Math.PI * f * 2 * t + k);
      const p3 = 0.15 * lfo * Math.sin(2 * Math.PI * f * 3 * t);
      sum += (p1 + p2 + p3) * (1 / (1 + k * 0.35));
    }
    return sum * 0.22;
  });

  // B: Pulse (2.0s @ 120 BPM = 4 beats, 16 sixteenth steps)
  const pulseBuf = makeSeamlessLoop(2.0, (t, ch) => {
    const stepDur = 0.125; // 16th note at 120 BPM
    const stepIdx = Math.floor(t / stepDur) % 16;
    const localT = t % stepDur;
    const pattern = [1, 0, 0.5, 1, 0, 0.7, 1, 0, 1, 0.4, 0, 1, 0.6, 0, 0.9, 0.3];
    const notes = [65.41, 65.41, 98.0, 130.81, 65.41, 146.83, 98.0, 65.41];
    const accent = pattern[stepIdx];
    if (accent === 0) return 0;

    const baseFreq = notes[stepIdx % notes.length];
    const env = Math.exp(-localT * (accent > 0.8 ? 16 : 24));
    const attack = Math.min(1, localT / 0.003);
    const bright = 1 + 4 * Math.exp(-localT * 30);
    const stereoOffset = ch === 0 ? 0.0 : 0.004;
    const wave =
      Math.sin(2 * Math.PI * baseFreq * (t + stereoOffset)) +
      0.5 * Math.sin(2 * Math.PI * baseFreq * 2 * t) * Math.min(1, bright * 0.35) +
      0.25 * Math.sin(2 * Math.PI * baseFreq * 3 * t) * Math.min(1, bright * 0.2);

    return wave * env * attack * accent * 0.45;
  });

  // C: Pluck (2.0s) — Shimmering FM kalimba/bell arpeggio
  const pluckBuf = makeSeamlessLoop(2.0, (t, ch) => {
    const hits = [0.0, 0.375, 0.75, 1.0, 1.375, 1.625];
    const freqs = [523.25, 659.25, 783.99, 987.77, 783.99, 587.33]; // C5 E5 G5 B5 G5 D5
    let out = 0;
    for (let h = 0; h < hits.length; h++) {
      let dt = t - hits[h];
      if (dt < 0) dt += 2.0;
      if (dt > 0.8) continue;
      const f = freqs[h] * (ch === 0 ? 0.999 : 1.001);
      const env = Math.exp(-dt * 8.5) * Math.min(1, dt / 0.002);
      const modEnv = Math.exp(-dt * 18);
      const mod = Math.sin(2 * Math.PI * f * 2.0 * dt) * (2.6 * modEnv);
      out += Math.sin(2 * Math.PI * f * dt + mod) * env * 0.45;
    }
    return out;
  });

  // D: Voice (4.0s) — Synthetic choral formant vowel sweep ("Ah -> Oo -> Eh")
  const voiceBuf = makeSeamlessLoop(4.0, (t, ch) => {
    const pitch = 196.0 * (1 + 0.008 * Math.sin(2 * Math.PI * 5.2 * t)); // G3 vibrato
    const phase = (t % 4.0) / 4.0;
    // Interpolate 3 vocal formants over 4 seconds
    const f1 = 720 - 380 * Math.sin(Math.PI * phase); // 720 -> 340 -> 720 Hz
    const f2 = 1200 + 700 * Math.sin(2 * Math.PI * phase);
    const f3 = 2500 + 250 * Math.cos(2 * Math.PI * phase);

    let glottal = 0;
    const stereoShift = ch === 0 ? 0 : 0.003;
    for (let harm = 1; harm <= 16; harm++) {
      const hf = pitch * harm;
      // Sum resonant Lorentzian-like formant peaks
      const r1 = 1 / (1 + Math.pow((hf - f1) / 90, 2));
      const r2 = 0.7 / (1 + Math.pow((hf - f2) / 140, 2));
      const r3 = 0.35 / (1 + Math.pow((hf - f3) / 220, 2));
      const formantGain = (r1 + r2 + r3) / Math.pow(harm, 0.35);
      glottal += Math.sin(2 * Math.PI * hf * (t + stereoShift)) * formantGain;
    }
    return glottal * 0.25;
  });

  return {
    A: {
      id: 'A',
      name: 'Drone',
      buffer: droneBuf,
      duration: droneBuf.duration,
      peaks: extractPeaks(droneBuf),
      source: 'demo',
    },
    B: {
      id: 'B',
      name: 'Pulse',
      buffer: pulseBuf,
      duration: pulseBuf.duration,
      peaks: extractPeaks(pulseBuf),
      source: 'demo',
    },
    C: {
      id: 'C',
      name: 'Pluck',
      buffer: pluckBuf,
      duration: pluckBuf.duration,
      peaks: extractPeaks(pluckBuf),
      source: 'demo',
    },
    D: {
      id: 'D',
      name: 'Voice',
      buffer: voiceBuf,
      duration: voiceBuf.duration,
      peaks: extractPeaks(voiceBuf),
      source: 'demo',
    },
  };
}
