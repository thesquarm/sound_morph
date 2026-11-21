import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_MASTER_EFFECTS,
  MorphAudioEngine,
  type CompressionPreset,
  type MasterEffectsSettings,
  type ReverbType,
  type SaturationType,
} from './audio/engine';
import {
  CORNERS,
  DEFAULT_MORPH_SETTINGS,
  bilinearWeights,
  type CornerId,
  type MorphAlgorithm,
  type MorphSettings,
} from './audio/morph';
import {
  generateDemoSounds,
  loadAudioFile,
  startMicRecording,
  type CornerSample,
  type MicRecordingSession,
} from './audio/samples';
import { CornerSlot } from './components/CornerSlot';
import {
  Download,
  Lock,
  PadGridIcon,
  Square,
  Trash2,
  Unlock,
  Waves,
  X,
} from './components/Icons';
import { MorphPad, type TouchVoicePoint } from './components/MorphPad';
import { Slider } from './components/Slider';

const ALGORITHMS: { id: MorphAlgorithm; label: string; summary: string }[] = [
  {
    id: 'blend',
    label: 'Blend',
    summary: 'Equal-power crossfade across the four loaded corners.',
  },
  {
    id: 'filter',
    label: 'Filter',
    summary: 'Distant corners stay warm and muted while nearby corners open.',
  },
  {
    id: 'grain',
    label: 'Grain',
    summary: 'Weighted granular cloud; edges increase position and pitch scatter.',
  },
  {
    id: 'tape',
    label: 'Tape',
    summary: 'Crossfade plus X-axis tape speed and Y-axis lowpass brightness.',
  },
  {
    id: 'formant',
    label: 'Formant',
    summary: 'Dual resonant vocal filters morphing vowel openness across XY.',
  },
  {
    id: 'chop',
    label: 'Chop',
    summary: 'Rhythmic pulse gate slicing the morphed corner blend.',
  },
  {
    id: 'ring',
    label: 'Ring',
    summary: 'Ring modulation mapped to X frequency and Y modulation depth.',
  },
];

type FxTab = 'reverb' | 'delay' | 'saturation' | 'compression';

const REVERB_TYPES: { id: ReverbType; label: string }[] = [
  { id: 'room', label: 'Room' },
  { id: 'hall', label: 'Hall' },
  { id: 'plate', label: 'Plate' },
  { id: 'cathedral', label: 'Cathedral' },
];

const SATURATION_TYPES: { id: SaturationType; label: string }[] = [
  { id: 'warm', label: 'Warm' },
  { id: 'tape', label: 'Tape' },
  { id: 'crunch', label: 'Crunch' },
];

const COMP_PRESETS: { id: CompressionPreset; label: string }[] = [
  { id: 'off', label: 'Off' },
  { id: 'glue', label: 'Glue' },
  { id: 'punch', label: 'Punch' },
  { id: 'squash', label: 'Squash' },
];

export default function App() {
  const engineRef = useRef<MorphAudioEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new MorphAudioEngine();
  }
  const engine = engineRef.current;

  const [samples, setSamples] = useState<Partial<Record<CornerId, CornerSample>>>({});
  const [voices, setVoices] = useState<TouchVoicePoint[]>([]);
  const [algorithm, setAlgorithm] = useState<MorphAlgorithm>('blend');
  const [settings, setSettings] = useState<MorphSettings>(DEFAULT_MORPH_SETTINGS);
  const [masterFx, setMasterFx] = useState<MasterEffectsSettings>(DEFAULT_MASTER_EFFECTS);
  const [activeFxTab, setActiveFxTab] = useState<FxTab>('reverb');
  const [latchMode, setLatchMode] = useState<boolean>(false);

  // Mic recording state
  const [recordingCorner, setRecordingCorner] = useState<CornerId | null>(null);
  const [micElapsed, setMicElapsed] = useState<number>(0);
  const [micLevel, setMicLevel] = useState<number>(0);
  const micSessionRef = useRef<MicRecordingSession | null>(null);

  // Master output performance recording state
  const [isRecordingOutput, setIsRecordingOutput] = useState<boolean>(false);
  const [outputRecElapsed, setOutputRecElapsed] = useState<number>(0);
  const [recordedTake, setRecordedTake] = useState<{
    url: string;
    duration: number;
    sizeKb: number;
  } | null>(null);

  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const scopeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const latestAudioLevelRef = useRef<number>(0);

  const handleLoadDemos = useCallback(() => {
    try {
      const ctx = engine.ensureContext();
      const demos = generateDemoSounds(ctx);
      for (const id of CORNERS) {
        engine.setSample(id, demos[id]);
      }
      setSamples(demos);
      setErrorMsg(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to initialize audio engine.');
    }
  }, [engine]);

  useEffect(() => {
    handleLoadDemos();
    return () => {
      micSessionRef.current?.cancel();
      engine.dispose();
    };
  }, [engine, handleLoadDemos]);

  useEffect(() => {
    return () => {
      if (recordedTake?.url) URL.revokeObjectURL(recordedTake.url);
    };
  }, [recordedTake]);

  useEffect(() => {
    engine.setAlgorithm(algorithm);
  }, [engine, algorithm]);

  useEffect(() => {
    engine.setSettings(settings);
  }, [engine, settings]);

  useEffect(() => {
    engine.setMasterEffects(masterFx);
  }, [engine, masterFx]);

  useEffect(() => {
    if (!isRecordingOutput) return;
    const start = performance.now();
    const id = window.setInterval(() => {
      setOutputRecElapsed((performance.now() - start) / 1000);
    }, 80);
    return () => clearInterval(id);
  }, [isRecordingOutput]);

  useEffect(() => {
    const buffer = new Uint8Array(512);
    let rafId = 0;

    const drawScope = () => {
      const level = engine.getWaveformData(buffer);
      latestAudioLevelRef.current = level;

      const canvas = scopeCanvasRef.current;
      if (canvas) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (w > 0 && h > 0) {
          if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
            canvas.width = Math.floor(w * dpr);
            canvas.height = Math.floor(h * dpr);
          }
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.save();
            ctx.scale(dpr, dpr);
            ctx.fillStyle = '#fafafa';
            ctx.fillRect(0, 0, w, h);

            ctx.strokeStyle = '#e4e4e7';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, h * 0.5);
            ctx.lineTo(w, h * 0.5);
            ctx.stroke();

            ctx.strokeStyle = level > 0.015 ? '#ea580c' : '#a1a1aa';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            for (let i = 0; i < buffer.length; i++) {
              const x = (i / (buffer.length - 1)) * w;
              const y = ((buffer[i] - 128) / 128) * (h * 0.42) + h * 0.5;
              if (i === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            }
            ctx.stroke();
            ctx.restore();
          }
        }
      }

      rafId = requestAnimationFrame(drawScope);
    };

    rafId = requestAnimationFrame(drawScope);
    return () => cancelAnimationFrame(rafId);
  }, [engine]);

  const getOutputLevel = useCallback(() => latestAudioLevelRef.current, []);

  const handleVoiceStart = useCallback(
    (voiceId: string, x: number, y: number, pointerId: number) => {
      engine.startVoice(voiceId, x, y);
      setVoices((prev) => [...prev, { id: voiceId, x, y, latched: false, pointerId }]);
    },
    [engine]
  );

  const handleVoiceMove = useCallback(
    (voiceId: string, x: number, y: number) => {
      engine.moveVoice(voiceId, x, y);
      setVoices((prev) => prev.map((v) => (v.id === voiceId ? { ...v, x, y } : v)));
    },
    [engine]
  );

  const handleVoiceGrab = useCallback((voiceId: string, pointerId: number) => {
    setVoices((prev) =>
      prev.map((v) => (v.id === voiceId ? { ...v, pointerId } : v))
    );
  }, []);

  const handleVoiceEnd = useCallback(
    (voiceId: string, shouldLatch: boolean) => {
      if (shouldLatch) {
        setVoices((prev) =>
          prev.map((v) =>
            v.id === voiceId ? { ...v, latched: true, pointerId: null } : v
          )
        );
      } else {
        engine.stopVoice(voiceId);
        setVoices((prev) => prev.filter((v) => v.id !== voiceId));
      }
    },
    [engine]
  );

  const handleVoiceRemove = useCallback(
    (voiceId: string) => {
      engine.stopVoice(voiceId);
      setVoices((prev) => prev.filter((v) => v.id !== voiceId));
    },
    [engine]
  );

  const handleClearVoices = useCallback(() => {
    engine.stopAllVoices();
    setVoices([]);
  }, [engine]);

  const handleUploadFile = useCallback(
    async (id: CornerId, file: File) => {
      try {
        setErrorMsg(null);
        const ctx = engine.ensureContext();
        const sample = await loadAudioFile(ctx, id, file);
        engine.setSample(id, sample);
        setSamples((prev) => ({ ...prev, [id]: sample }));
      } catch (err) {
        setErrorMsg(
          err instanceof Error
            ? `Could not decode "${file.name}": ${err.message}`
            : `Could not load "${file.name}".`
        );
      }
    },
    [engine]
  );

  const handleToggleMicRecord = useCallback(
    async (id: CornerId) => {
      setErrorMsg(null);
      if (recordingCorner === id && micSessionRef.current) {
        try {
          const session = micSessionRef.current;
          micSessionRef.current = null;
          setRecordingCorner(null);
          setMicElapsed(0);
          setMicLevel(0);
          const sample = await session.stop();
          engine.setSample(id, sample);
          setSamples((prev) => ({ ...prev, [id]: sample }));
        } catch (err) {
          setErrorMsg(err instanceof Error ? err.message : 'Recording stopped early.');
        }
        return;
      }

      if (micSessionRef.current) {
        micSessionRef.current.cancel();
        micSessionRef.current = null;
      }

      try {
        const ctx = engine.ensureContext();
        setRecordingCorner(id);
        setMicElapsed(0);
        setMicLevel(0);

        const session = await startMicRecording(
          ctx,
          id,
          (elapsed, level) => {
            setMicElapsed(elapsed);
            setMicLevel(level);
          },
          (sample) => {
            micSessionRef.current = null;
            setRecordingCorner(null);
            setMicElapsed(0);
            setMicLevel(0);
            engine.setSample(id, sample);
            setSamples((prev) => ({ ...prev, [id]: sample }));
          },
          (err) => {
            micSessionRef.current = null;
            setRecordingCorner(null);
            setMicElapsed(0);
            setMicLevel(0);
            setErrorMsg(err);
          }
        );
        micSessionRef.current = session;
      } catch (err) {
        setRecordingCorner(null);
        setMicElapsed(0);
        setMicLevel(0);
        setErrorMsg(
          err instanceof Error
            ? err.message
            : 'Microphone permission was denied or unavailable.'
        );
      }
    },
    [engine, recordingCorner]
  );

  const handlePreviewCorner = useCallback(
    (id: CornerId) => {
      engine.previewCorner(id);
    },
    [engine]
  );

  const handleClearCorner = useCallback(
    (id: CornerId) => {
      engine.setSample(id, null);
      setSamples((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    },
    [engine]
  );

  const handleToggleOutputRecording = useCallback(() => {
    if (!isRecordingOutput) {
      if (recordedTake?.url) {
        URL.revokeObjectURL(recordedTake.url);
        setRecordedTake(null);
      }
      setOutputRecElapsed(0);
      engine.startOutputRecording();
      setIsRecordingOutput(true);
    } else {
      const duration = outputRecElapsed;
      const blob = engine.stopOutputRecording();
      setIsRecordingOutput(false);
      if (blob) {
        const url = URL.createObjectURL(blob);
        setRecordedTake({
          url,
          duration,
          sizeKb: Math.max(1, Math.round(blob.size / 1024)),
        });
      }
    }
  }, [engine, isRecordingOutput, outputRecElapsed, recordedTake]);

  const cornerWeights = useMemo(() => {
    const totals: Record<CornerId, number> = { A: 0, B: 0, C: 0, D: 0 };
    if (voices.length === 0) return totals;
    for (const v of voices) {
      const bw = bilinearWeights(v.x, v.y);
      for (const id of CORNERS) totals[id] += bw[id];
    }
    for (const id of CORNERS) {
      totals[id] = Math.min(1, totals[id] / Math.max(1, voices.length));
    }
    return totals;
  }, [voices]);

  const activeAlgoMeta = ALGORITHMS.find((a) => a.id === algorithm) ?? ALGORITHMS[0];

  const fxTabBadges: Record<FxTab, string> = {
    reverb: `${Math.round((masterFx.reverbMix / 0.9) * 100)}%`,
    delay: masterFx.delayMix > 0.01 ? `${Math.round((masterFx.delayMix / 0.85) * 100)}%` : 'Off',
    saturation:
      masterFx.saturationDrive > 0.01
        ? `${Math.round(masterFx.saturationDrive * 100)}%`
        : 'Off',
    compression:
      masterFx.compressionPreset === 'off' || masterFx.compressionAmount <= 0.01
        ? 'Off'
        : masterFx.compressionPreset,
  };

  return (
    <div id="top" className="min-h-screen bg-[#f4f4f5] text-zinc-950 flex flex-col">
      {/* 3-Zone Top Bar */}
      <header className="sticky top-0 z-30 bg-[#f4f4f5]/90 backdrop-blur-md border-b border-zinc-200/90">
        <div className="max-w-[1360px] mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4 sm:gap-8">
          <a
            href="#top"
            className="text-base sm:text-lg font-semibold tracking-tight text-zinc-950 whitespace-nowrap shrink-0"
          >
            sound_morph
          </a>

          <nav
            aria-label="Morph algorithms"
            className="hidden md:flex items-center gap-5"
          >
            {ALGORITHMS.map((algo) => {
              const active = algorithm === algo.id;
              return (
                <button
                  key={algo.id}
                  type="button"
                  onClick={() => setAlgorithm(algo.id)}
                  className={`relative py-1 text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    active
                      ? 'text-zinc-950'
                      : 'text-zinc-500 hover:text-zinc-900'
                  }`}
                >
                  {algo.label}
                  {active && (
                    <span className="absolute inset-x-0 -bottom-[15px] h-[2px] bg-orange-600 rounded-full" />
                  )}
                </button>
              );
            })}
          </nav>

          <button
            type="button"
            onClick={handleLoadDemos}
            className="px-3.5 py-2 text-xs font-medium text-white bg-zinc-950 rounded-lg hover:bg-zinc-800 active:scale-[0.98] transition-all whitespace-nowrap shrink-0 cursor-pointer"
          >
            Demo Sounds
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-[1360px] w-full mx-auto px-4 sm:px-6 py-4 sm:py-5 flex flex-col gap-4">
        {errorMsg && (
          <div
            role="alert"
            className="bg-white border border-orange-300 text-zinc-900 rounded-xl px-4 py-2.5 text-sm flex items-center justify-between gap-3"
          >
            <span>{errorMsg}</span>
            <button
              type="button"
              onClick={() => setErrorMsg(null)}
              aria-label="Dismiss error"
              className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 shrink-0 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Mobile / Tablet Algorithm Selector */}
        <div className="md:hidden flex flex-wrap gap-1 p-1 bg-zinc-200/75 rounded-xl">
          {ALGORITHMS.map((algo) => {
            const active = algorithm === algo.id;
            return (
              <button
                key={algo.id}
                type="button"
                onClick={() => setAlgorithm(algo.id)}
                className={`flex-1 min-w-[72px] min-h-[40px] px-2.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  active
                    ? 'bg-white text-zinc-950 shadow-xs'
                    : 'text-zinc-600 hover:text-zinc-950'
                }`}
              >
                {algo.label}
              </button>
            );
          })}
        </div>

        {/* Main Studio Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_356px] gap-5 items-start">
          {/* Left Stage: Corners A/B -> Multitouch XY Pad -> Corners C/D */}
          <section aria-label="XY Morph Stage" className="flex flex-col gap-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <CornerSlot
                id="A"
                sample={samples.A ?? null}
                weight={cornerWeights.A}
                isRecording={recordingCorner === 'A'}
                recordingElapsed={micElapsed}
                recordingLevel={micLevel}
                isBusy={recordingCorner !== null}
                onUploadFile={handleUploadFile}
                onToggleRecord={handleToggleMicRecord}
                onPreview={handlePreviewCorner}
                onClear={handleClearCorner}
              />
              <CornerSlot
                id="B"
                sample={samples.B ?? null}
                weight={cornerWeights.B}
                isRecording={recordingCorner === 'B'}
                recordingElapsed={micElapsed}
                recordingLevel={micLevel}
                isBusy={recordingCorner !== null}
                onUploadFile={handleUploadFile}
                onToggleRecord={handleToggleMicRecord}
                onPreview={handlePreviewCorner}
                onClear={handleClearCorner}
              />
            </div>

            <MorphPad
              samples={samples}
              voices={voices}
              algorithm={algorithm}
              latchMode={latchMode}
              getOutputLevel={getOutputLevel}
              onVoiceStart={handleVoiceStart}
              onVoiceMove={handleVoiceMove}
              onVoiceEnd={handleVoiceEnd}
              onVoiceGrab={handleVoiceGrab}
              onVoiceRemove={handleVoiceRemove}
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <CornerSlot
                id="C"
                sample={samples.C ?? null}
                weight={cornerWeights.C}
                isRecording={recordingCorner === 'C'}
                recordingElapsed={micElapsed}
                recordingLevel={micLevel}
                isBusy={recordingCorner !== null}
                onUploadFile={handleUploadFile}
                onToggleRecord={handleToggleMicRecord}
                onPreview={handlePreviewCorner}
                onClear={handleClearCorner}
              />
              <CornerSlot
                id="D"
                sample={samples.D ?? null}
                weight={cornerWeights.D}
                isRecording={recordingCorner === 'D'}
                recordingElapsed={micElapsed}
                recordingLevel={micLevel}
                isBusy={recordingCorner !== null}
                onUploadFile={handleUploadFile}
                onToggleRecord={handleToggleMicRecord}
                onPreview={handlePreviewCorner}
                onClear={handleClearCorner}
              />
            </div>
          </section>

          {/* Right Control Console */}
          <aside
            aria-label="Morph controls, master effects, and output recorder"
            className="bg-white border border-zinc-200 rounded-2xl p-4 sm:p-5 flex flex-col gap-5"
          >
            {/* Pad Voice Controls */}
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-zinc-950 flex items-center gap-2">
                  <PadGridIcon className="w-4 h-4 text-zinc-500" />
                  <span>Pad Voices</span>
                </h2>
                <span className="text-xs font-mono tabular-nums text-zinc-500">
                  {voices.length} active
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setLatchMode((v) => !v)}
                  aria-pressed={latchMode}
                  className={`min-h-[44px] px-3 rounded-xl text-xs font-medium flex items-center justify-center gap-2 border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    latchMode
                      ? 'bg-zinc-950 text-white border-zinc-950'
                      : 'bg-zinc-50 text-zinc-800 border-zinc-200 hover:bg-zinc-100'
                  }`}
                >
                  {latchMode ? (
                    <Lock className="w-3.5 h-3.5 text-orange-400" />
                  ) : (
                    <Unlock className="w-3.5 h-3.5 text-zinc-500" />
                  )}
                  <span>{latchMode ? 'Latch On' : 'Latch Off'}</span>
                </button>

                <button
                  type="button"
                  disabled={voices.length === 0}
                  onClick={handleClearVoices}
                  className="min-h-[44px] px-3 rounded-xl text-xs font-medium flex items-center justify-center gap-2 border border-zinc-200 bg-zinc-50 text-zinc-800 hover:bg-zinc-100 disabled:opacity-40 disabled:pointer-events-none transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5 text-zinc-500" />
                  <span>Clear Voices</span>
                </button>
              </div>
              <p className="text-xs text-zinc-500 leading-relaxed">
                {latchMode
                  ? 'Points stay latched after release. Drag to move or tap a point to remove it.'
                  : 'Hold fingers to play, or hold Shift while releasing to latch a point.'}
              </p>
            </div>

            <hr className="border-zinc-100" />

            {/* Algorithm Parameters */}
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-zinc-950">
                  {activeAlgoMeta.label} Morph
                </h2>
                <span className="text-xs text-zinc-500 font-mono">XY Engine</span>
              </div>
              <p className="text-xs text-zinc-500 leading-relaxed">
                {activeAlgoMeta.summary}
              </p>

              {algorithm === 'blend' && (
                <div className="grid grid-cols-4 gap-2 pt-1">
                  {CORNERS.map((id) => (
                    <div
                      key={id}
                      className="bg-zinc-50 border border-zinc-100 rounded-lg px-2 py-1.5 text-center"
                    >
                      <div className="text-[11px] font-mono text-zinc-500">{id}</div>
                      <div className="text-xs font-mono tabular-nums font-medium text-zinc-900">
                        {Math.round(cornerWeights[id] * 100)}%
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {algorithm === 'filter' && (
                <Slider
                  id="resonance"
                  label="Resonance (Q)"
                  min={0.7}
                  max={14}
                  step={0.1}
                  value={settings.resonance}
                  displayValue={settings.resonance.toFixed(1)}
                  onChange={(resonance) =>
                    setSettings((s) => ({ ...s, resonance }))
                  }
                />
              )}

              {algorithm === 'grain' && (
                <div className="flex flex-col gap-3">
                  <Slider
                    id="grain-size"
                    label="Grain Size"
                    min={30}
                    max={320}
                    step={5}
                    value={settings.grainSizeMs}
                    displayValue={`${Math.round(settings.grainSizeMs)} ms`}
                    onChange={(grainSizeMs) =>
                      setSettings((s) => ({ ...s, grainSizeMs }))
                    }
                  />
                  <Slider
                    id="grain-density"
                    label="Grain Density"
                    min={6}
                    max={45}
                    step={1}
                    value={settings.grainDensity}
                    displayValue={`${Math.round(settings.grainDensity)} /s`}
                    onChange={(grainDensity) =>
                      setSettings((s) => ({ ...s, grainDensity }))
                    }
                  />
                </div>
              )}

              {algorithm === 'tape' && (
                <Slider
                  id="tape-range"
                  label="Speed Range"
                  min={0.25}
                  max={2.0}
                  step={0.05}
                  value={settings.tapeSpeedRange}
                  displayValue={`±${settings.tapeSpeedRange.toFixed(2)} oct`}
                  onChange={(tapeSpeedRange) =>
                    setSettings((s) => ({ ...s, tapeSpeedRange }))
                  }
                />
              )}

              {algorithm === 'formant' && (
                <Slider
                  id="formant-q"
                  label="Formant Focus (Q)"
                  min={1.5}
                  max={12.0}
                  step={0.2}
                  value={settings.formantQ}
                  displayValue={settings.formantQ.toFixed(1)}
                  onChange={(formantQ) =>
                    setSettings((s) => ({ ...s, formantQ }))
                  }
                />
              )}

              {algorithm === 'chop' && (
                <div className="flex flex-col gap-3">
                  <Slider
                    id="chop-rate"
                    label="Chop Rate"
                    min={2}
                    max={16}
                    step={0.5}
                    value={settings.chopRateHz}
                    displayValue={`${settings.chopRateHz.toFixed(1)} Hz`}
                    onChange={(chopRateHz) =>
                      setSettings((s) => ({ ...s, chopRateHz }))
                    }
                  />
                  <Slider
                    id="chop-gate"
                    label="Gate Length"
                    min={0.15}
                    max={0.9}
                    step={0.05}
                    value={settings.chopGate}
                    displayValue={`${Math.round(settings.chopGate * 100)}%`}
                    onChange={(chopGate) =>
                      setSettings((s) => ({ ...s, chopGate }))
                    }
                  />
                </div>
              )}

              {algorithm === 'ring' && (
                <Slider
                  id="ring-max-hz"
                  label="Mod Range (Max Freq)"
                  min={40}
                  max={600}
                  step={10}
                  value={settings.ringMaxHz}
                  displayValue={`${Math.round(settings.ringMaxHz)} Hz`}
                  onChange={(ringMaxHz) =>
                    setSettings((s) => ({ ...s, ringMaxHz }))
                  }
                />
              )}
            </div>

            <hr className="border-zinc-100" />

            {/* Master Output & Effects Bus */}
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-zinc-950">Master Effects</h2>
                <span className="text-xs font-mono tabular-nums text-zinc-500">
                  Limiter On
                </span>
              </div>

              <Slider
                id="master-volume"
                label="Output Level"
                min={0}
                max={1}
                step={0.01}
                value={masterFx.volume}
                displayValue={`${Math.round(masterFx.volume * 100)}%`}
                onChange={(volume) =>
                  setMasterFx((prev) => ({ ...prev, volume }))
                }
              />

              {/* 4-Tab Effects Rack */}
              <div className="grid grid-cols-4 gap-1 p-1 bg-zinc-100 rounded-xl">
                {(
                  [
                    { id: 'reverb', label: 'Reverb' },
                    { id: 'delay', label: 'Delay' },
                    { id: 'saturation', label: 'Drive' },
                    { id: 'compression', label: 'Comp' },
                  ] as { id: FxTab; label: string }[]
                ).map((tab) => {
                  const active = activeFxTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setActiveFxTab(tab.id)}
                      className={`min-h-[40px] px-1.5 py-1 rounded-lg flex flex-col items-center justify-center transition-colors cursor-pointer ${
                        active
                          ? 'bg-white text-zinc-950 shadow-xs'
                          : 'text-zinc-600 hover:text-zinc-950'
                      }`}
                    >
                      <span className="text-[11px] font-medium leading-tight">
                        {tab.label}
                      </span>
                      <span className="text-[10px] font-mono tabular-nums text-zinc-500 capitalize leading-tight">
                        {fxTabBadges[tab.id]}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Active FX Module Controls */}
              {activeFxTab === 'reverb' && (
                <div className="flex flex-col gap-3 pt-1">
                  <div className="grid grid-cols-4 gap-1 p-1 bg-zinc-50 border border-zinc-200/80 rounded-lg">
                    {REVERB_TYPES.map((rt) => {
                      const active = masterFx.reverbType === rt.id;
                      return (
                        <button
                          key={rt.id}
                          type="button"
                          onClick={() =>
                            setMasterFx((prev) => ({ ...prev, reverbType: rt.id }))
                          }
                          className={`min-h-[32px] rounded-md text-[11px] font-medium transition-colors whitespace-nowrap cursor-pointer ${
                            active
                              ? 'bg-zinc-950 text-white'
                              : 'text-zinc-600 hover:text-zinc-950'
                          }`}
                        >
                          {rt.label}
                        </button>
                      );
                    })}
                  </div>
                  <Slider
                    id="reverb-mix"
                    label="Reverb Mix"
                    min={0}
                    max={0.9}
                    step={0.01}
                    value={masterFx.reverbMix}
                    displayValue={`${Math.round((masterFx.reverbMix / 0.9) * 100)}%`}
                    onChange={(reverbMix) =>
                      setMasterFx((prev) => ({ ...prev, reverbMix }))
                    }
                  />
                </div>
              )}

              {activeFxTab === 'delay' && (
                <div className="flex flex-col gap-2.5 pt-1">
                  <Slider
                    id="delay-mix"
                    label="Delay Mix"
                    min={0}
                    max={0.85}
                    step={0.01}
                    value={masterFx.delayMix}
                    displayValue={`${Math.round((masterFx.delayMix / 0.85) * 100)}%`}
                    onChange={(delayMix) =>
                      setMasterFx((prev) => ({ ...prev, delayMix }))
                    }
                  />
                  <Slider
                    id="delay-time"
                    label="Delay Time"
                    min={60}
                    max={750}
                    step={10}
                    value={masterFx.delayTimeMs}
                    displayValue={`${Math.round(masterFx.delayTimeMs)} ms`}
                    onChange={(delayTimeMs) =>
                      setMasterFx((prev) => ({ ...prev, delayTimeMs }))
                    }
                  />
                  <Slider
                    id="delay-feedback"
                    label="Feedback"
                    min={0}
                    max={0.78}
                    step={0.01}
                    value={masterFx.delayFeedback}
                    displayValue={`${Math.round(masterFx.delayFeedback * 100)}%`}
                    onChange={(delayFeedback) =>
                      setMasterFx((prev) => ({ ...prev, delayFeedback }))
                    }
                  />
                </div>
              )}

              {activeFxTab === 'saturation' && (
                <div className="flex flex-col gap-3 pt-1">
                  <div className="grid grid-cols-3 gap-1 p-1 bg-zinc-50 border border-zinc-200/80 rounded-lg">
                    {SATURATION_TYPES.map((st) => {
                      const active = masterFx.saturationType === st.id;
                      return (
                        <button
                          key={st.id}
                          type="button"
                          onClick={() =>
                            setMasterFx((prev) => ({ ...prev, saturationType: st.id }))
                          }
                          className={`min-h-[32px] rounded-md text-[11px] font-medium transition-colors whitespace-nowrap cursor-pointer ${
                            active
                              ? 'bg-zinc-950 text-white'
                              : 'text-zinc-600 hover:text-zinc-950'
                          }`}
                        >
                          {st.label}
                        </button>
                      );
                    })}
                  </div>
                  <Slider
                    id="saturation-drive"
                    label="Saturation Drive"
                    min={0}
                    max={1}
                    step={0.01}
                    value={masterFx.saturationDrive}
                    displayValue={`${Math.round(masterFx.saturationDrive * 100)}%`}
                    onChange={(saturationDrive) =>
                      setMasterFx((prev) => ({ ...prev, saturationDrive }))
                    }
                  />
                </div>
              )}

              {activeFxTab === 'compression' && (
                <div className="flex flex-col gap-3 pt-1">
                  <div className="grid grid-cols-4 gap-1 p-1 bg-zinc-50 border border-zinc-200/80 rounded-lg">
                    {COMP_PRESETS.map((cp) => {
                      const active = masterFx.compressionPreset === cp.id;
                      return (
                        <button
                          key={cp.id}
                          type="button"
                          onClick={() =>
                            setMasterFx((prev) => ({
                              ...prev,
                              compressionPreset: cp.id,
                            }))
                          }
                          className={`min-h-[32px] rounded-md text-[11px] font-medium transition-colors whitespace-nowrap cursor-pointer ${
                            active
                              ? 'bg-zinc-950 text-white'
                              : 'text-zinc-600 hover:text-zinc-950'
                          }`}
                        >
                          {cp.label}
                        </button>
                      );
                    })}
                  </div>
                  <Slider
                    id="compression-amount"
                    label="Compression Amount"
                    min={0}
                    max={1}
                    step={0.01}
                    value={masterFx.compressionAmount}
                    displayValue={`${Math.round(masterFx.compressionAmount * 100)}%`}
                    onChange={(compressionAmount) =>
                      setMasterFx((prev) => ({ ...prev, compressionAmount }))
                    }
                  />
                </div>
              )}
            </div>

            <hr className="border-zinc-100" />

            {/* Live Scope & Performance Recorder */}
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-zinc-950 flex items-center gap-2">
                  <Waves className="w-4 h-4 text-zinc-500" />
                  <span>Performance Recording</span>
                </h2>
                {isRecordingOutput && (
                  <span className="text-xs font-mono tabular-nums text-orange-600 font-medium">
                    ● {outputRecElapsed.toFixed(1)}s
                  </span>
                )}
              </div>

              <div className="h-14 rounded-xl border border-zinc-200 overflow-hidden bg-zinc-50">
                <canvas
                  ref={scopeCanvasRef}
                  className="w-full h-full block"
                  aria-label="Master audio output oscilloscope"
                />
              </div>

              <button
                type="button"
                onClick={handleToggleOutputRecording}
                className={`min-h-[44px] w-full px-4 rounded-xl text-xs font-medium flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  isRecordingOutput
                    ? 'bg-orange-600 text-white hover:bg-orange-700'
                    : 'bg-zinc-950 text-white hover:bg-zinc-800'
                }`}
              >
                {isRecordingOutput ? (
                  <>
                    <Square className="w-3.5 h-3.5 fill-current" />
                    <span>Stop Recording</span>
                  </>
                ) : (
                  <span>Record Output</span>
                )}
              </button>

              {recordedTake && (
                <div className="flex items-center justify-between gap-2 bg-zinc-50 border border-zinc-200 rounded-xl p-2.5">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-zinc-900 truncate">
                      Session Take Ready
                    </div>
                    <div className="text-[11px] font-mono tabular-nums text-zinc-500">
                      {recordedTake.duration.toFixed(1)}s · {recordedTake.sizeKb} KB WAV
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <a
                      href={recordedTake.url}
                      download={`sound_morph-take-${new Date()
                        .toISOString()
                        .slice(0, 19)
                        .replace(/[:T]/g, '-')}.wav`}
                      className="min-h-[36px] px-3 rounded-lg bg-white border border-zinc-200 text-xs font-medium text-zinc-900 hover:bg-zinc-100 flex items-center gap-1.5 whitespace-nowrap"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Save WAV</span>
                    </a>
                    <button
                      type="button"
                      onClick={() => {
                        URL.revokeObjectURL(recordedTake.url);
                        setRecordedTake(null);
                      }}
                      aria-label="Discard recording"
                      className="w-9 h-9 rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-900 hover:bg-zinc-200/60 cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </aside>
        </div>
      </main>

      {/* Footer Credits & Privacy */}
      <footer className="border-t border-zinc-200/90 mt-4">
        <div className="max-w-[1360px] mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs text-zinc-500">
          <p>
            App by Philip with Claude &amp; Google AI Studio / If you have any questions or
            feedback, please contact me:{' '}
            <a
              href="mailto:p.stade@mh-freiburg.de"
              className="text-zinc-800 underline underline-offset-2 hover:text-zinc-950 transition-colors"
            >
              p.stade@mh-freiburg.de
            </a>
          </p>
          <p className="text-zinc-500">
            • GDPR Compliant: 100% client-side Web Audio. Self-hosted fonts, zero cookies,
            zero external trackers, no server audio storage.
          </p>
        </div>
      </footer>
    </div>
  );
}
