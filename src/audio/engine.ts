import {
  CORNERS,
  computeMorphParams,
  DEFAULT_MORPH_SETTINGS,
  type CornerId,
  type MorphAlgorithm,
  type MorphSettings,
} from './morph';
import type { CornerSample } from './samples';

export type ReverbType = 'room' | 'hall' | 'plate' | 'cathedral';
export type SaturationType = 'warm' | 'tape' | 'crunch';
export type CompressionPreset = 'off' | 'glue' | 'punch' | 'squash';

export interface MasterEffectsSettings {
  volume: number;
  reverbType: ReverbType;
  reverbMix: number;
  delayMix: number;
  delayTimeMs: number;
  delayFeedback: number;
  saturationType: SaturationType;
  saturationDrive: number;
  compressionPreset: CompressionPreset;
  compressionAmount: number;
}

export const DEFAULT_MASTER_EFFECTS: MasterEffectsSettings = {
  volume: 0.85,
  reverbType: 'hall',
  reverbMix: 0.24,
  delayMix: 0,
  delayTimeMs: 280,
  delayFeedback: 0.35,
  saturationType: 'warm',
  saturationDrive: 0,
  compressionPreset: 'glue',
  compressionAmount: 0.35,
};

interface CornerVoiceNodes {
  source: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  gain: GainNode;
}

interface InternalVoice {
  id: string;
  x: number;
  y: number;
  voiceGain: GainNode;
  preFxBus: GainNode;
  // Formant nodes
  formantDry: GainNode;
  formantF1: BiquadFilterNode;
  formantF2: BiquadFilterNode;
  // Chop gate node
  chopGateGain: GainNode;
  nextChopTime: number;
  // Ring-mod nodes
  ringDry: GainNode;
  ringWet: GainNode;
  ringGain: GainNode;
  ringOsc: OscillatorNode;
  ringOscDepth: GainNode;
  // Corner sample nodes
  cornerNodes: Partial<Record<CornerId, CornerVoiceNodes>>;
  nextGrainTime: number;
}

function createReverbImpulse(ctx: AudioContext, type: ReverbType): AudioBuffer {
  const rate = ctx.sampleRate;
  const specs: Record<
    ReverbType,
    { seconds: number; decay: number; damping: number; preDelayMs: number; density: number }
  > = {
    room: { seconds: 0.85, decay: 3.4, damping: 0.35, preDelayMs: 6, density: 0.9 },
    hall: { seconds: 2.2, decay: 2.6, damping: 0.48, preDelayMs: 18, density: 0.75 },
    plate: { seconds: 1.65, decay: 2.2, damping: 0.18, preDelayMs: 4, density: 1.0 },
    cathedral: { seconds: 4.2, decay: 1.9, damping: 0.56, preDelayMs: 32, density: 0.65 },
  };

  const cfg = specs[type];
  const len = Math.floor(rate * cfg.seconds);
  const preDelaySamples = Math.floor((cfg.preDelayMs / 1000) * rate);
  const impulse = ctx.createBuffer(2, len, rate);

  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    let last = 0;
    for (let i = 0; i < len; i++) {
      if (i < preDelaySamples) {
        data[i] = 0;
        continue;
      }
      const n = (i - preDelaySamples) / Math.max(1, len - preDelaySamples);
      const env = Math.pow(1 - n, cfg.decay);
      const white = Math.random() < cfg.density ? Math.random() * 2 - 1 : 0;
      last = last * cfg.damping + white * (1 - cfg.damping);
      // Early reflections burst for room/plate character
      const earlyBoost = i - preDelaySamples < rate * 0.04 ? 1.25 : 1.0;
      data[i] = last * env * earlyBoost * 0.68;
    }
  }
  return impulse;
}

function createSaturationCurve(type: SaturationType, drive: number): Float32Array<ArrayBuffer> {
  const samples = 2048;
  const buffer = new ArrayBuffer(samples * Float32Array.BYTES_PER_ELEMENT);
  const curve = new Float32Array(buffer);
  const amount = Math.max(0.01, drive);

  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / (samples - 1) - 1;
    if (drive <= 0.005) {
      curve[i] = x;
      continue;
    }

    if (type === 'warm') {
      // Even-harmonic subtle tube warmth
      const k = 1 + amount * 6;
      const y = Math.tanh(x * k + amount * 0.12 * x * x) / Math.tanh(k);
      curve[i] = y;
    } else if (type === 'tape') {
      // Smooth tape hysteresis soft-knee saturation
      const k = 1 + amount * 9;
      const y = (2 / Math.PI) * Math.atan(x * k) / ((2 / Math.PI) * Math.atan(k));
      curve[i] = y;
    } else {
      // Crunch asymmetric clip with controlled ceiling
      const k = 1 + amount * 18;
      const shaped = Math.tanh(x * k + (x > 0 ? amount * 0.25 * x : 0));
      curve[i] = shaped / Math.tanh(k);
    }
  }
  return curve;
}

function encodeWavStereo(
  leftChunks: Float32Array[],
  rightChunks: Float32Array[],
  sampleRate: number
): Blob {
  const totalSamples = leftChunks.reduce((acc, c) => acc + c.length, 0);
  const bytesPerSample = 2;
  const numChannels = 2;
  const dataSize = totalSamples * numChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let c = 0; c < leftChunks.length; c++) {
    const l = leftChunks[c];
    const r = rightChunks[c];
    for (let i = 0; i < l.length; i++) {
      const ls = Math.max(-1, Math.min(1, l[i]));
      const rs = Math.max(-1, Math.min(1, r[i]));
      view.setInt16(offset, ls < 0 ? ls * 0x8000 : ls * 0x7fff, true);
      view.setInt16(offset + 2, rs < 0 ? rs * 0x8000 : rs * 0x7fff, true);
      offset += 4;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

export class MorphAudioEngine {
  private ctx: AudioContext | null = null;
  private voiceBus: GainNode | null = null;

  // Master FX chain nodes
  private saturationDry: GainNode | null = null;
  private saturationWet: GainNode | null = null;
  private saturationShaper: WaveShaperNode | null = null;
  private saturationOut: GainNode | null = null;

  private busComp: DynamicsCompressorNode | null = null;
  private busCompMakeup: GainNode | null = null;

  private dryGain: GainNode | null = null;

  private delaySend: GainNode | null = null;
  private delayNode: DelayNode | null = null;
  private delayFilter: BiquadFilterNode | null = null;
  private delayFeedback: GainNode | null = null;
  private delayReturn: GainNode | null = null;

  private reverbSend: GainNode | null = null;
  private reverbNode: ConvolverNode | null = null;
  private reverbReturn: GainNode | null = null;

  private masterGain: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private analyser: AnalyserNode | null = null;
  private recProcessor: ScriptProcessorNode | null = null;

  private samples: Partial<Record<CornerId, CornerSample>> = {};
  private voices = new Map<string, InternalVoice>();
  private algorithm: MorphAlgorithm = 'blend';
  private settings: MorphSettings = { ...DEFAULT_MORPH_SETTINGS };
  private fx: MasterEffectsSettings = { ...DEFAULT_MASTER_EFFECTS };
  private loadedReverbType: ReverbType = 'hall';
  private loadedSatKey = '';

  private schedulerTimerId: number | null = null;
  private isRecording = false;
  private recLeft: Float32Array[] = [];
  private recRight: Float32Array[] = [];
  private previewSource: AudioBufferSourceNode | null = null;

  public ensureContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();

      this.voiceBus = this.ctx.createGain();

      // Saturation parallel stage
      this.saturationDry = this.ctx.createGain();
      this.saturationWet = this.ctx.createGain();
      this.saturationShaper = this.ctx.createWaveShaper();
      this.saturationShaper.oversample = '2x';
      this.saturationOut = this.ctx.createGain();

      // Bus Compression stage
      this.busComp = this.ctx.createDynamicsCompressor();
      this.busCompMakeup = this.ctx.createGain();

      // Dry / Delay / Reverb parallel bus
      this.dryGain = this.ctx.createGain();

      this.delaySend = this.ctx.createGain();
      this.delayNode = this.ctx.createDelay(1.5);
      this.delayFilter = this.ctx.createBiquadFilter();
      this.delayFilter.type = 'lowpass';
      this.delayFilter.frequency.value = 3400;
      this.delayFeedback = this.ctx.createGain();
      this.delayReturn = this.ctx.createGain();

      this.reverbSend = this.ctx.createGain();
      this.reverbNode = this.ctx.createConvolver();
      this.reverbNode.buffer = createReverbImpulse(this.ctx, this.fx.reverbType);
      this.loadedReverbType = this.fx.reverbType;
      this.reverbReturn = this.ctx.createGain();

      this.masterGain = this.ctx.createGain();

      // Final Brickwall Safety Limiter
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -1.5;
      this.limiter.knee.value = 2;
      this.limiter.ratio.value = 18;
      this.limiter.attack.value = 0.002;
      this.limiter.release.value = 0.07;

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.78;

      this.recProcessor = this.ctx.createScriptProcessor(2048, 2, 2);
      this.recProcessor.onaudioprocess = (e) => {
        if (!this.isRecording) return;
        this.recLeft.push(new Float32Array(e.inputBuffer.getChannelData(0)));
        this.recRight.push(new Float32Array(e.inputBuffer.getChannelData(1)));
      };

      // Wire signal path:
      // voiceBus -> saturation -> busComp -> [dry, delay, reverb] -> masterGain -> limiter -> analyser -> out
      this.voiceBus.connect(this.saturationDry);
      this.voiceBus.connect(this.saturationShaper);
      this.saturationShaper.connect(this.saturationWet);
      this.saturationDry.connect(this.saturationOut);
      this.saturationWet.connect(this.saturationOut);

      this.saturationOut.connect(this.busComp);
      this.busComp.connect(this.busCompMakeup);

      // Dry
      this.busCompMakeup.connect(this.dryGain);
      this.dryGain.connect(this.masterGain);

      // Delay loop
      this.busCompMakeup.connect(this.delaySend);
      this.delaySend.connect(this.delayNode);
      this.delayNode.connect(this.delayFilter);
      this.delayFilter.connect(this.delayFeedback);
      this.delayFeedback.connect(this.delayNode);
      this.delayFilter.connect(this.delayReturn);
      this.delayReturn.connect(this.masterGain);
      // Subtle delay-into-reverb glue
      const delayToVerb = this.ctx.createGain();
      delayToVerb.gain.value = 0.25;
      this.delayFilter.connect(delayToVerb);
      delayToVerb.connect(this.reverbNode);

      // Reverb
      this.busCompMakeup.connect(this.reverbSend);
      this.reverbSend.connect(this.reverbNode);
      this.reverbNode.connect(this.reverbReturn);
      this.reverbReturn.connect(this.masterGain);

      // Output + Limiter + Recorder tap
      this.masterGain.connect(this.limiter);
      this.limiter.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);

      this.limiter.connect(this.recProcessor);
      const silentRecSink = this.ctx.createGain();
      silentRecSink.gain.value = 0;
      this.recProcessor.connect(silentRecSink);
      silentRecSink.connect(this.ctx.destination);

      this.applyMasterEffects();
      this.startScheduler();
    }

    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }

    return this.ctx;
  }

  public setMasterEffects(next: MasterEffectsSettings) {
    this.fx = next;
    this.applyMasterEffects();
  }

  private applyMasterEffects() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;

    // Master Volume
    this.masterGain?.gain.setTargetAtTime(
      Math.max(0, Math.min(1, this.fx.volume)),
      now,
      0.015
    );

    // Saturation
    const satKey = `${this.fx.saturationType}:${this.fx.saturationDrive.toFixed(2)}`;
    if (this.saturationShaper && satKey !== this.loadedSatKey) {
      this.loadedSatKey = satKey;
      this.saturationShaper.curve = createSaturationCurve(
        this.fx.saturationType,
        this.fx.saturationDrive
      );
    }
    const driveMix = Math.max(0, Math.min(1, this.fx.saturationDrive));
    this.saturationDry?.gain.setTargetAtTime(1 - driveMix * 0.65, now, 0.02);
    this.saturationWet?.gain.setTargetAtTime(driveMix * 0.78, now, 0.02);

    // Bus Compression
    if (this.busComp && this.busCompMakeup) {
      const amt = Math.max(0, Math.min(1, this.fx.compressionAmount));
      if (this.fx.compressionPreset === 'off' || amt <= 0.01) {
        this.busComp.threshold.setTargetAtTime(0, now, 0.02);
        this.busComp.ratio.setTargetAtTime(1, now, 0.02);
        this.busComp.knee.setTargetAtTime(0, now, 0.02);
        this.busComp.attack.setTargetAtTime(0.01, now, 0.02);
        this.busComp.release.setTargetAtTime(0.1, now, 0.02);
        this.busCompMakeup.gain.setTargetAtTime(1, now, 0.02);
      } else if (this.fx.compressionPreset === 'glue') {
        this.busComp.threshold.setTargetAtTime(-4 - amt * 18, now, 0.02);
        this.busComp.ratio.setTargetAtTime(1.5 + amt * 2.5, now, 0.02);
        this.busComp.knee.setTargetAtTime(10, now, 0.02);
        this.busComp.attack.setTargetAtTime(0.02, now, 0.02);
        this.busComp.release.setTargetAtTime(0.22, now, 0.02);
        this.busCompMakeup.gain.setTargetAtTime(1 + amt * 0.45, now, 0.02);
      } else if (this.fx.compressionPreset === 'punch') {
        this.busComp.threshold.setTargetAtTime(-6 - amt * 22, now, 0.02);
        this.busComp.ratio.setTargetAtTime(2.5 + amt * 4.5, now, 0.02);
        this.busComp.knee.setTargetAtTime(6, now, 0.02);
        this.busComp.attack.setTargetAtTime(0.032, now, 0.02);
        this.busComp.release.setTargetAtTime(0.11, now, 0.02);
        this.busCompMakeup.gain.setTargetAtTime(1 + amt * 0.65, now, 0.02);
      } else {
        // squash
        this.busComp.threshold.setTargetAtTime(-10 - amt * 26, now, 0.02);
        this.busComp.ratio.setTargetAtTime(4 + amt * 8, now, 0.02);
        this.busComp.knee.setTargetAtTime(3, now, 0.02);
        this.busComp.attack.setTargetAtTime(0.004, now, 0.02);
        this.busComp.release.setTargetAtTime(0.09, now, 0.02);
        this.busCompMakeup.gain.setTargetAtTime(1 + amt * 0.9, now, 0.02);
      }
    }

    // Delay
    const dMix = Math.max(0, Math.min(0.9, this.fx.delayMix));
    const dTime = Math.max(0.04, Math.min(1.2, this.fx.delayTimeMs / 1000));
    const dFb = Math.max(0, Math.min(0.82, this.fx.delayFeedback));
    this.delaySend?.gain.setTargetAtTime(dMix, now, 0.02);
    this.delayReturn?.gain.setTargetAtTime(dMix > 0.005 ? 1 : 0, now, 0.02);
    this.delayNode?.delayTime.setTargetAtTime(dTime, now, 0.04);
    this.delayFeedback?.gain.setTargetAtTime(dFb, now, 0.02);

    // Reverb
    if (this.reverbNode && this.fx.reverbType !== this.loadedReverbType) {
      this.loadedReverbType = this.fx.reverbType;
      this.reverbNode.buffer = createReverbImpulse(this.ctx, this.fx.reverbType);
    }
    const rMix = Math.max(0, Math.min(0.95, this.fx.reverbMix));
    this.dryGain?.gain.setTargetAtTime(1 - rMix * 0.35, now, 0.02);
    this.reverbSend?.gain.setTargetAtTime(rMix, now, 0.02);
    this.reverbReturn?.gain.setTargetAtTime(1, now, 0.02);
  }

  public setAlgorithm(algo: MorphAlgorithm) {
    if (this.algorithm === algo) return;
    const prev = this.algorithm;
    this.algorithm = algo;

    if (!this.ctx) return;

    if (prev === 'grain' && algo !== 'grain') {
      for (const voice of this.voices.values()) {
        this.attachContinuousCorners(voice);
        this.routeVoiceForAlgorithm(voice);
        this.updateVoiceParams(voice);
      }
    } else if (prev !== 'grain' && algo === 'grain') {
      for (const voice of this.voices.values()) {
        this.detachContinuousCorners(voice);
        this.routeVoiceForAlgorithm(voice);
        voice.nextGrainTime = this.ctx.currentTime;
      }
    } else {
      for (const voice of this.voices.values()) {
        this.routeVoiceForAlgorithm(voice);
        this.updateVoiceParams(voice);
      }
    }
  }

  public setSettings(next: MorphSettings) {
    this.settings = next;
    if (!this.ctx) return;
    if (this.algorithm !== 'grain') {
      for (const voice of this.voices.values()) {
        this.updateVoiceParams(voice);
      }
    }
  }

  public setSample(id: CornerId, sample: CornerSample | null) {
    if (sample) {
      this.samples[id] = sample;
    } else {
      delete this.samples[id];
    }

    if (!this.ctx || this.algorithm === 'grain') return;

    for (const voice of this.voices.values()) {
      const existing = voice.cornerNodes[id];
      if (existing) {
        try {
          existing.source.stop();
          existing.source.disconnect();
          existing.filter.disconnect();
          existing.gain.disconnect();
        } catch {
          // ignore
        }
        delete voice.cornerNodes[id];
      }
      if (sample) {
        this.attachSingleCorner(voice, id, sample);
        this.updateVoiceParams(voice);
      }
    }
  }

  public startVoice(id: string, x: number, y: number) {
    const ctx = this.ensureContext();
    if (this.voices.has(id)) {
      this.moveVoice(id, x, y);
      return;
    }

    const preFxBus = ctx.createGain();
    const voiceGain = ctx.createGain();
    voiceGain.gain.setValueAtTime(0.0001, ctx.currentTime);
    voiceGain.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.02);
    voiceGain.connect(this.voiceBus!);

    // Formant stage
    const formantDry = ctx.createGain();
    const formantF1 = ctx.createBiquadFilter();
    formantF1.type = 'bandpass';
    formantF1.frequency.value = 500;
    formantF1.Q.value = this.settings.formantQ;

    const formantF2 = ctx.createBiquadFilter();
    formantF2.type = 'bandpass';
    formantF2.frequency.value = 1500;
    formantF2.Q.value = this.settings.formantQ;

    const formantBoost = ctx.createGain();
    formantBoost.gain.value = 1.65;

    // Chop gate stage
    const chopGateGain = ctx.createGain();
    chopGateGain.gain.value = 1;

    // Ring mod stage
    const ringDry = ctx.createGain();
    const ringWet = ctx.createGain();
    const ringGain = ctx.createGain();
    ringGain.gain.value = 0;

    const ringOsc = ctx.createOscillator();
    ringOsc.type = 'sine';
    ringOsc.frequency.value = 80;

    const ringOscDepth = ctx.createGain();
    ringOscDepth.gain.value = 1.0;

    ringOsc.connect(ringOscDepth);
    ringOscDepth.connect(ringGain.gain);
    ringOsc.start(ctx.currentTime);

    // Wire voice internal stages: preFxBus -> [Formant | Ring | Direct] -> chopGateGain -> voiceGain
    preFxBus.connect(formantDry);
    preFxBus.connect(formantF1);
    preFxBus.connect(formantF2);
    formantF1.connect(formantBoost);
    formantF2.connect(formantBoost);
    formantDry.connect(chopGateGain);
    formantBoost.connect(chopGateGain);

    preFxBus.connect(ringDry);
    preFxBus.connect(ringGain);
    ringGain.connect(ringWet);
    ringDry.connect(chopGateGain);
    ringWet.connect(chopGateGain);

    chopGateGain.connect(voiceGain);

    const voice: InternalVoice = {
      id,
      x,
      y,
      voiceGain,
      preFxBus,
      formantDry,
      formantF1,
      formantF2,
      chopGateGain,
      nextChopTime: ctx.currentTime,
      ringDry,
      ringWet,
      ringGain,
      ringOsc,
      ringOscDepth,
      cornerNodes: {},
      nextGrainTime: ctx.currentTime,
    };

    this.routeVoiceForAlgorithm(voice);
    if (this.algorithm !== 'grain') {
      this.attachContinuousCorners(voice);
      this.updateVoiceParams(voice);
    }

    this.voices.set(id, voice);
    this.rebalancePolyphonyGain();
  }

  private routeVoiceForAlgorithm(voice: InternalVoice) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;

    if (this.algorithm === 'formant') {
      voice.formantDry.gain.setTargetAtTime(0.18, now, 0.02);
      voice.formantF1.gain.value = 1;
      voice.ringDry.gain.setTargetAtTime(0, now, 0.02);
      voice.ringWet.gain.setTargetAtTime(0, now, 0.02);
      voice.chopGateGain.gain.cancelScheduledValues(now);
      voice.chopGateGain.gain.setTargetAtTime(1, now, 0.02);
    } else if (this.algorithm === 'ring') {
      voice.formantDry.gain.setTargetAtTime(0, now, 0.02);
      voice.chopGateGain.gain.cancelScheduledValues(now);
      voice.chopGateGain.gain.setTargetAtTime(1, now, 0.02);
    } else if (this.algorithm === 'chop') {
      voice.formantDry.gain.setTargetAtTime(1, now, 0.02);
      voice.ringDry.gain.setTargetAtTime(0, now, 0.02);
      voice.ringWet.gain.setTargetAtTime(0, now, 0.02);
      voice.nextChopTime = now;
    } else {
      voice.formantDry.gain.setTargetAtTime(1, now, 0.02);
      voice.ringDry.gain.setTargetAtTime(0, now, 0.02);
      voice.ringWet.gain.setTargetAtTime(0, now, 0.02);
      voice.chopGateGain.gain.cancelScheduledValues(now);
      voice.chopGateGain.gain.setTargetAtTime(1, now, 0.02);
    }

    // Mute formant bandpass branch when not in formant mode
    const formantActive = this.algorithm === 'formant';
    voice.formantF1.Q.setTargetAtTime(
      formantActive ? this.settings.formantQ : 0.001,
      now,
      0.02
    );
    voice.formantF2.Q.setTargetAtTime(
      formantActive ? this.settings.formantQ : 0.001,
      now,
      0.02
    );
  }

  public moveVoice(id: string, x: number, y: number) {
    const voice = this.voices.get(id);
    if (!voice) return;
    voice.x = x;
    voice.y = y;
    if (this.algorithm !== 'grain') {
      this.updateVoiceParams(voice);
    }
  }

  public stopVoice(id: string) {
    const voice = this.voices.get(id);
    if (!voice || !this.ctx) return;

    this.voices.delete(id);
    const now = this.ctx.currentTime;

    voice.voiceGain.gain.cancelScheduledValues(now);
    voice.voiceGain.gain.setValueAtTime(voice.voiceGain.gain.value, now);
    voice.voiceGain.gain.linearRampToValueAtTime(0.0001, now + 0.05);

    const nodes = Object.values(voice.cornerNodes);
    window.setTimeout(() => {
      for (const n of nodes) {
        if (!n) continue;
        try {
          n.source.stop();
          n.source.disconnect();
          n.filter.disconnect();
          n.gain.disconnect();
        } catch {
          // ignore
        }
      }
      try {
        voice.ringOsc.stop();
        voice.ringOsc.disconnect();
        voice.ringOscDepth.disconnect();
        voice.preFxBus.disconnect();
        voice.voiceGain.disconnect();
      } catch {
        // ignore
      }
    }, 80);

    this.rebalancePolyphonyGain();
  }

  public stopAllVoices() {
    for (const id of Array.from(this.voices.keys())) {
      this.stopVoice(id);
    }
  }

  private rebalancePolyphonyGain() {
    if (!this.ctx || !this.voiceBus) return;
    const count = Math.max(1, this.voices.size);
    const scale = 1 / Math.sqrt(count);
    this.voiceBus.gain.setTargetAtTime(scale, this.ctx.currentTime, 0.02);
  }

  private attachContinuousCorners(voice: InternalVoice) {
    for (const id of CORNERS) {
      const sample = this.samples[id];
      if (sample) {
        this.attachSingleCorner(voice, id, sample);
      }
    }
  }

  private attachSingleCorner(voice: InternalVoice, id: CornerId, sample: CornerSample) {
    if (!this.ctx) return;
    const source = this.ctx.createBufferSource();
    source.buffer = sample.buffer;
    source.loop = true;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 20000;
    filter.Q.value = 0.7;

    const gain = this.ctx.createGain();
    gain.gain.value = 0;

    source.connect(filter);
    filter.connect(gain);
    gain.connect(voice.preFxBus);

    const offset = sample.duration > 0.2 ? (Math.random() * 0.03) % sample.duration : 0;
    source.start(this.ctx.currentTime, offset);

    voice.cornerNodes[id] = { source, filter, gain };
  }

  private detachContinuousCorners(voice: InternalVoice) {
    const nodes = Object.values(voice.cornerNodes);
    voice.cornerNodes = {};
    for (const n of nodes) {
      if (!n) continue;
      try {
        n.source.stop();
        n.source.disconnect();
        n.filter.disconnect();
        n.gain.disconnect();
      } catch {
        // ignore
      }
    }
  }

  private updateVoiceParams(voice: InternalVoice) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const morph = computeMorphParams(voice.x, voice.y, this.algorithm, this.settings);

    for (const id of CORNERS) {
      const node = voice.cornerNodes[id];
      if (!node) continue;
      const p = morph.corners[id];
      node.gain.gain.setTargetAtTime(p.gain, now, 0.015);
      node.filter.frequency.setTargetAtTime(p.filterFreq, now, 0.018);
      node.filter.Q.setTargetAtTime(p.filterQ, now, 0.018);
      node.source.playbackRate.setTargetAtTime(p.playbackRate, now, 0.018);
    }

    if (this.algorithm === 'formant') {
      voice.formantF1.frequency.setTargetAtTime(morph.formantF1, now, 0.018);
      voice.formantF2.frequency.setTargetAtTime(morph.formantF2, now, 0.018);
      voice.formantF1.Q.setTargetAtTime(this.settings.formantQ, now, 0.018);
      voice.formantF2.Q.setTargetAtTime(this.settings.formantQ, now, 0.018);
    } else if (this.algorithm === 'ring') {
      voice.ringOsc.frequency.setTargetAtTime(morph.ringFreq, now, 0.015);
      voice.ringDry.gain.setTargetAtTime(1 - morph.ringDepth * 0.85, now, 0.018);
      voice.ringWet.gain.setTargetAtTime(morph.ringDepth, now, 0.018);
    }
  }

  private startScheduler() {
    if (this.schedulerTimerId !== null) return;
    this.schedulerTimerId = window.setInterval(() => {
      if (!this.ctx || this.voices.size === 0) return;

      const now = this.ctx.currentTime;
      const lookahead = now + 0.08;

      if (this.algorithm === 'grain') {
        const intervalSec = 1 / Math.max(4, this.settings.grainDensity);
        const grainDur = Math.max(0.025, this.settings.grainSizeMs / 1000);

        for (const voice of this.voices.values()) {
          if (voice.nextGrainTime < now - 0.05) {
            voice.nextGrainTime = now;
          }
          while (voice.nextGrainTime < lookahead) {
            this.spawnGrain(voice, voice.nextGrainTime, grainDur);
            const jitter = (Math.random() - 0.5) * intervalSec * 0.25;
            voice.nextGrainTime += Math.max(0.015, intervalSec + jitter);
          }
        }
      } else if (this.algorithm === 'chop') {
        const stepSec = 1 / Math.max(1.5, this.settings.chopRateHz);
        const openDur = Math.max(0.015, stepSec * Math.max(0.12, Math.min(0.95, this.settings.chopGate)));

        for (const voice of this.voices.values()) {
          if (voice.nextChopTime < now - 0.05) {
            voice.nextChopTime = now;
          }
          while (voice.nextChopTime < lookahead) {
            const t = voice.nextChopTime;
            const g = voice.chopGateGain.gain;
            g.setValueAtTime(0.02, t);
            g.linearRampToValueAtTime(1.0, t + Math.min(0.008, openDur * 0.2));
            g.setValueAtTime(1.0, t + Math.max(0.01, openDur * 0.72));
            g.linearRampToValueAtTime(0.02, t + openDur);
            voice.nextChopTime += stepSec;
          }
        }
      }
    }, 25);
  }

  private spawnGrain(voice: InternalVoice, startTime: number, grainDur: number) {
    if (!this.ctx) return;
    const morph = computeMorphParams(voice.x, voice.y, 'grain', this.settings);

    const loaded: { id: CornerId; weight: number; sample: CornerSample }[] = [];
    let totalWeight = 0;
    for (const id of CORNERS) {
      const s = this.samples[id];
      const w = morph.weights[id];
      if (s && w > 0.005) {
        loaded.push({ id, weight: w, sample: s });
        totalWeight += w;
      }
    }
    if (loaded.length === 0 || totalWeight <= 0) return;

    let r = Math.random() * totalWeight;
    let chosen = loaded[0];
    for (const item of loaded) {
      r -= item.weight;
      if (r <= 0) {
        chosen = item;
        break;
      }
    }

    const buf = chosen.sample.buffer;
    const scatter = morph.grainScatter;

    const semitoneSpread = scatter * 7;
    const semitones = (Math.random() * 2 - 1) * semitoneSpread;
    const rate = Math.pow(2, semitones / 12);

    const playableSpan = Math.max(0.02, buf.duration - grainDur * rate);
    const centerPos = playableSpan * 0.5;
    const offset = Math.max(
      0,
      Math.min(
        playableSpan,
        centerPos + (Math.random() - 0.5) * playableSpan * (0.35 + 0.65 * scatter)
      )
    );

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;

    const pan = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    if (pan) {
      pan.pan.value = (Math.random() * 2 - 1) * (0.2 + 0.65 * scatter);
    }

    const env = this.ctx.createGain();
    const atk = grainDur * 0.38;
    const rel = grainDur * 0.45;
    const peak = 0.55;

    env.gain.setValueAtTime(0.0001, startTime);
    env.gain.linearRampToValueAtTime(peak, startTime + atk);
    env.gain.setValueAtTime(peak, startTime + grainDur - rel);
    env.gain.linearRampToValueAtTime(0.0001, startTime + grainDur);

    if (pan) {
      src.connect(pan);
      pan.connect(env);
    } else {
      src.connect(env);
    }
    env.connect(voice.voiceGain);

    src.start(startTime, offset, grainDur * rate + 0.02);
    src.stop(startTime + grainDur + 0.02);
    src.onended = () => {
      try {
        src.disconnect();
        pan?.disconnect();
        env.disconnect();
      } catch {
        // ignore
      }
    };
  }

  public previewCorner(id: CornerId) {
    const sample = this.samples[id];
    if (!sample) return;
    const ctx = this.ensureContext();
    if (this.previewSource) {
      try {
        this.previewSource.stop();
        this.previewSource.disconnect();
      } catch {
        // ignore
      }
      this.previewSource = null;
    }

    const src = ctx.createBufferSource();
    src.buffer = sample.buffer;
    const g = ctx.createGain();
    g.gain.value = 0.7;
    src.connect(g);
    g.connect(this.voiceBus!);
    src.start(ctx.currentTime, 0, Math.min(sample.duration, 2.5));
    src.onended = () => {
      if (this.previewSource === src) this.previewSource = null;
      try {
        src.disconnect();
        g.disconnect();
      } catch {
        // ignore
      }
    };
    this.previewSource = src;
  }

  public startOutputRecording() {
    this.ensureContext();
    this.recLeft = [];
    this.recRight = [];
    this.isRecording = true;
  }

  public stopOutputRecording(): Blob | null {
    this.isRecording = false;
    if (!this.ctx || this.recLeft.length === 0) return null;
    const blob = encodeWavStereo(this.recLeft, this.recRight, this.ctx.sampleRate);
    this.recLeft = [];
    this.recRight = [];
    return blob;
  }

  public getWaveformData(target: Uint8Array<ArrayBuffer>): number {
    if (!this.analyser) {
      target.fill(128);
      return 0;
    }
    this.analyser.getByteTimeDomainData(target);
    let rmsSum = 0;
    for (let i = 0; i < target.length; i++) {
      const v = (target[i] - 128) / 128;
      rmsSum += v * v;
    }
    return Math.min(1, Math.sqrt(rmsSum / target.length) * 2.4);
  }

  public dispose() {
    if (this.schedulerTimerId !== null) {
      clearInterval(this.schedulerTimerId);
      this.schedulerTimerId = null;
    }
    this.stopAllVoices();
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }
}
