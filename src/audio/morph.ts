export type CornerId = 'A' | 'B' | 'C' | 'D';

export const CORNERS: readonly CornerId[] = ['A', 'B', 'C', 'D'] as const;

export const CORNER_META: Record<
  CornerId,
  {
    label: string;
    position: string;
    x: number;
    y: number;
    accentHex: string;
  }
> = {
  A: { label: 'A', position: 'Top Left', x: 0, y: 0, accentHex: '#ea580c' },
  B: { label: 'B', position: 'Top Right', x: 1, y: 0, accentHex: '#0284c7' },
  C: { label: 'C', position: 'Bottom Left', x: 0, y: 1, accentHex: '#059669' },
  D: { label: 'D', position: 'Bottom Right', x: 1, y: 1, accentHex: '#7c3aed' },
};

export type MorphAlgorithm =
  | 'blend'
  | 'filter'
  | 'grain'
  | 'tape'
  | 'formant'
  | 'chop'
  | 'ring';

export interface MorphSettings {
  resonance: number; // Filter Q: 0.7 - 14.0
  grainSizeMs: number; // Grain duration in ms: 30 - 320
  grainDensity: number; // Grains per second per voice: 6 - 45
  tapeSpeedRange: number; // Octaves +/- on X axis: 0.25 - 2.0
  formantQ: number; // Vocal formant bandpass Q: 1.5 - 12.0
  chopRateHz: number; // Rhythmic gate rate in Hz: 2.0 - 16.0
  chopGate: number; // Gate duty cycle: 0.15 - 0.9
  ringMaxHz: number; // Max ring-mod frequency on X axis: 40 - 600 Hz
}

export const DEFAULT_MORPH_SETTINGS: MorphSettings = {
  resonance: 4.5,
  grainSizeMs: 115,
  grainDensity: 20,
  tapeSpeedRange: 1.0,
  formantQ: 5.5,
  chopRateHz: 6.0,
  chopGate: 0.55,
  ringMaxHz: 220,
};

export interface CornerVoiceParams {
  gain: number;
  filterFreq: number;
  filterQ: number;
  playbackRate: number;
}

export interface MorphComputation {
  x: number;
  y: number;
  weights: Record<CornerId, number>;
  equalPower: Record<CornerId, number>;
  corners: Record<CornerId, CornerVoiceParams>;
  grainScatter: number;
  formantF1: number;
  formantF2: number;
  ringFreq: number;
  ringDepth: number;
}

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

export function bilinearWeights(x: number, y: number): Record<CornerId, number> {
  const cx = clamp01(x);
  const cy = clamp01(y);
  return {
    A: (1 - cx) * (1 - cy),
    B: cx * (1 - cy),
    C: (1 - cx) * cy,
    D: cx * cy,
  };
}

export function equalPowerWeights(x: number, y: number): Record<CornerId, number> {
  const cx = clamp01(x);
  const cy = clamp01(y);
  const gx0 = Math.cos(cx * Math.PI * 0.5);
  const gx1 = Math.sin(cx * Math.PI * 0.5);
  const gy0 = Math.cos(cy * Math.PI * 0.5);
  const gy1 = Math.sin(cy * Math.PI * 0.5);

  return {
    A: gx0 * gy0,
    B: gx1 * gy0,
    C: gx0 * gy1,
    D: gx1 * gy1,
  };
}

export function computeMorphParams(
  rawX: number,
  rawY: number,
  algorithm: MorphAlgorithm,
  settings: MorphSettings
): MorphComputation {
  const x = clamp01(rawX);
  const y = clamp01(rawY);
  const weights = bilinearWeights(x, y);
  const eq = equalPowerWeights(x, y);

  // Normalized distance from center (0 at center, 1 at corners)
  const grainScatter = Math.min(1, Math.hypot(x - 0.5, y - 0.5) / Math.SQRT1_2);

  // Formant frequencies mapped across XY vowel space
  const formantF1 = 260 + x * 640; // 260 Hz (closed) -> 900 Hz (open)
  const formantF2 = 2400 - y * 1650; // 2400 Hz (front) -> 750 Hz (back)

  // Ring / AM frequency (exponential 14 Hz .. ringMaxHz) & depth
  const ringFreq = 14 * Math.pow(Math.max(2, settings.ringMaxHz / 14), x);
  const ringDepth = 0.15 + 0.85 * (1 - y);

  const corners: Record<CornerId, CornerVoiceParams> = {
    A: { gain: 0, filterFreq: 20000, filterQ: 0.7, playbackRate: 1 },
    B: { gain: 0, filterFreq: 20000, filterQ: 0.7, playbackRate: 1 },
    C: { gain: 0, filterFreq: 20000, filterQ: 0.7, playbackRate: 1 },
    D: { gain: 0, filterFreq: 20000, filterQ: 0.7, playbackRate: 1 },
  };

  if (algorithm === 'blend' || algorithm === 'formant' || algorithm === 'ring') {
    for (const id of CORNERS) {
      corners[id] = {
        gain: eq[id],
        filterFreq: 20000,
        filterQ: 0.7,
        playbackRate: 1,
      };
    }
  } else if (algorithm === 'filter') {
    for (const id of CORNERS) {
      const meta = CORNER_META[id];
      const dist = Math.hypot(x - meta.x, y - meta.y);
      const proximity = Math.max(0, 1 - dist / 1.15);
      const gain = 0.18 + 0.82 * eq[id];
      const filterFreq = 150 * Math.pow(128, Math.pow(proximity, 1.35));
      corners[id] = {
        gain,
        filterFreq: Math.min(19500, filterFreq),
        filterQ: settings.resonance,
        playbackRate: 1,
      };
    }
  } else if (algorithm === 'tape') {
    const octaves = (x - 0.5) * 2 * settings.tapeSpeedRange;
    const rate = Math.pow(2, octaves);
    const brightness = 1 - y;
    const filterFreq = 240 * Math.pow(80, Math.pow(brightness, 1.4));
    for (const id of CORNERS) {
      corners[id] = {
        gain: eq[id],
        filterFreq: Math.min(19500, filterFreq),
        filterQ: 1.1,
        playbackRate: rate,
      };
    }
  } else {
    // Grain and Chop expose bilinear/equal-power weights for scheduler & meters
    for (const id of CORNERS) {
      corners[id] = {
        gain: algorithm === 'chop' ? eq[id] : weights[id],
        filterFreq: 20000,
        filterQ: 0.7,
        playbackRate: 1,
      };
    }
  }

  return {
    x,
    y,
    weights,
    equalPower: eq,
    corners,
    grainScatter,
    formantF1,
    formantF2,
    ringFreq,
    ringDepth,
  };
}
