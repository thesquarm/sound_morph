import React, { useEffect, useRef } from 'react';
import {
  CORNER_META,
  CORNERS,
  bilinearWeights,
  clamp01,
  type CornerId,
  type MorphAlgorithm,
} from '../audio/morph';
import type { CornerSample } from '../audio/samples';

export interface TouchVoicePoint {
  id: string;
  x: number;
  y: number;
  latched: boolean;
  pointerId: number | null;
}

interface MorphPadProps {
  samples: Partial<Record<CornerId, CornerSample>>;
  voices: TouchVoicePoint[];
  algorithm: MorphAlgorithm;
  latchMode: boolean;
  getOutputLevel: () => number;
  onVoiceStart: (voiceId: string, x: number, y: number, pointerId: number) => void;
  onVoiceMove: (voiceId: string, x: number, y: number) => void;
  onVoiceEnd: (voiceId: string, shouldLatch: boolean) => void;
  onVoiceGrab: (voiceId: string, pointerId: number) => void;
  onVoiceRemove: (voiceId: string) => void;
}

interface GrainParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
}

export const MorphPad: React.FC<MorphPadProps> = ({
  samples,
  voices,
  algorithm,
  latchMode,
  getOutputLevel,
  onVoiceStart,
  onVoiceMove,
  onVoiceEnd,
  onVoiceGrab,
  onVoiceRemove,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Track active pointer gestures for tap-to-remove & drag-to-move
  const pointerStateRef = useRef(
    new Map<
      number,
      {
        voiceId: string;
        startX: number;
        startY: number;
        startTime: number;
        moved: boolean;
        grabbedExisting: boolean;
      }
    >()
  );

  // Latest props in ref for 60fps animation loop without re-binding
  const stateRef = useRef({ samples, voices, algorithm, getOutputLevel });
  stateRef.current = { samples, voices, algorithm, getOutputLevel };

  const particlesRef = useRef<GrainParticle[]>([]);
  const nextVoiceSeq = useRef(1);

  const getNormalizedCoords = (clientX: number, clientY: number) => {
    const el = canvasRef.current;
    if (!el) return { x: 0.5, y: 0.5 };
    const rect = el.getBoundingClientRect();
    const x = clamp01((clientX - rect.left) / Math.max(1, rect.width));
    const y = clamp01((clientY - rect.top) / Math.max(1, rect.height));
    return { x, y };
  };

  const findNearestLatchedVoice = (clientX: number, clientY: number): TouchVoicePoint | null => {
    const el = canvasRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const hitRadiusPx = 30;
    let best: TouchVoicePoint | null = null;
    let bestDist = Infinity;

    for (const v of stateRef.current.voices) {
      if (v.pointerId !== null) continue; // already held by another finger
      const vx = rect.left + v.x * rect.width;
      const vy = rect.top + v.y * rect.height;
      const d = Math.hypot(clientX - vx, clientY - vy);
      if (d <= hitRadiusPx && d < bestDist) {
        best = v;
        bestDist = d;
      }
    }
    return best;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (canvas && canvas.setPointerCapture) {
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    }

    const { x, y } = getNormalizedCoords(e.clientX, e.clientY);
    const existing = findNearestLatchedVoice(e.clientX, e.clientY);

    if (existing) {
      pointerStateRef.current.set(e.pointerId, {
        voiceId: existing.id,
        startX: e.clientX,
        startY: e.clientY,
        startTime: performance.now(),
        moved: false,
        grabbedExisting: true,
      });
      onVoiceGrab(existing.id, e.pointerId);
    } else {
      const voiceId = `v-${nextVoiceSeq.current++}`;
      pointerStateRef.current.set(e.pointerId, {
        voiceId,
        startX: e.clientX,
        startY: e.clientY,
        startTime: performance.now(),
        moved: false,
        grabbedExisting: false,
      });
      onVoiceStart(voiceId, x, y, e.pointerId);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const gesture = pointerStateRef.current.get(e.pointerId);
    if (!gesture) return;
    const dist = Math.hypot(e.clientX - gesture.startX, e.clientY - gesture.startY);
    if (dist > 6) {
      gesture.moved = true;
    }
    const { x, y } = getNormalizedCoords(e.clientX, e.clientY);
    onVoiceMove(gesture.voiceId, x, y);
  };

  const handlePointerUpOrCancel = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const gesture = pointerStateRef.current.get(e.pointerId);
    if (!gesture) return;
    pointerStateRef.current.delete(e.pointerId);

    const canvas = canvasRef.current;
    if (canvas && canvas.hasPointerCapture?.(e.pointerId)) {
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    }

    const elapsed = performance.now() - gesture.startTime;
    // Quick tap on an already-latched voice removes it (README behavior)
    if (gesture.grabbedExisting && !gesture.moved && elapsed < 280) {
      onVoiceRemove(gesture.voiceId);
      return;
    }

    const shouldLatch = latchMode || e.shiftKey;
    onVoiceEnd(gesture.voiceId, shouldLatch);
  };

  useEffect(() => {
    let rafId = 0;

    const render = () => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (canvas && container) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w > 0 && h > 0) {
          if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
            canvas.width = Math.floor(w * dpr);
            canvas.height = Math.floor(h * dpr);
          }

          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.save();
            ctx.scale(dpr, dpr);

            const { samples: smp, voices: vcs, algorithm: algo, getOutputLevel: getLevel } =
              stateRef.current;
            const audioLevel = getLevel();

            // Background canvas
            ctx.fillStyle = '#09090b';
            ctx.fillRect(0, 0, w, h);

            // Subtle radial corner glow proportional to loaded sample & current weights
            const cornerSums: Record<CornerId, number> = { A: 0, B: 0, C: 0, D: 0 };
            for (const v of vcs) {
              const bw = bilinearWeights(v.x, v.y);
              for (const id of CORNERS) cornerSums[id] += bw[id];
            }

            for (const id of CORNERS) {
              const meta = CORNER_META[id];
              const cx = meta.x * w;
              const cy = meta.y * h;
              const isLoaded = Boolean(smp[id]);
              const activeBoost = Math.min(1, cornerSums[id]);
              const radius = Math.max(w, h) * (0.42 + activeBoost * 0.14);
              const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
              const alpha = isLoaded ? 0.08 + activeBoost * 0.18 : 0.02;
              grad.addColorStop(0, hexToRgba(meta.accentHex, alpha));
              grad.addColorStop(1, hexToRgba(meta.accentHex, 0));
              ctx.fillStyle = grad;
              ctx.fillRect(0, 0, w, h);
            }

            // Precision coordinate grid
            const divs = 8;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.055)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let i = 1; i < divs; i++) {
              const gx = Math.round((w * i) / divs) + 0.5;
              const gy = Math.round((h * i) / divs) + 0.5;
              ctx.moveTo(gx, 0);
              ctx.lineTo(gx, h);
              ctx.moveTo(0, gy);
              ctx.lineTo(w, gy);
            }
            ctx.stroke();

            // Center crosshairs
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.13)';
            ctx.beginPath();
            ctx.moveTo(Math.round(w * 0.5) + 0.5, 0);
            ctx.lineTo(Math.round(w * 0.5) + 0.5, h);
            ctx.moveTo(0, Math.round(h * 0.5) + 0.5);
            ctx.lineTo(w, Math.round(h * 0.5) + 0.5);
            ctx.stroke();

            // Corner labels inside pad
            ctx.font = '500 11px "IBM Plex Mono", monospace';
            for (const id of CORNERS) {
              const meta = CORNER_META[id];
              const pad = 14;
              const tx = meta.x === 0 ? pad : w - pad;
              const ty = meta.y === 0 ? pad + 10 : h - pad;
              ctx.textAlign = meta.x === 0 ? 'left' : 'right';
              ctx.fillStyle = smp[id] ? hexToRgba(meta.accentHex, 0.95) : 'rgba(161, 161, 170, 0.45)';
              const labelText = smp[id] ? `${id} · ${smp[id]!.name}` : `${id} · Empty`;
              ctx.fillText(labelText, tx, ty);
            }

            // Grain particles when in grain mode
            if (algo === 'grain' && vcs.length > 0) {
              for (const v of vcs) {
                if (Math.random() < 0.45) {
                  const scatter = Math.min(1, Math.hypot(v.x - 0.5, v.y - 0.5) / Math.SQRT1_2);
                  const spreadPx = 14 + scatter * 48;
                  const bw = bilinearWeights(v.x, v.y);
                  const dominant = CORNERS.reduce((a, b) => (bw[a] >= bw[b] ? a : b));
                  particlesRef.current.push({
                    x: v.x * w + (Math.random() - 0.5) * spreadPx,
                    y: v.y * h + (Math.random() - 0.5) * spreadPx,
                    vx: (Math.random() - 0.5) * 0.8,
                    vy: (Math.random() - 0.5) * 0.8,
                    life: 1.0,
                    color: CORNER_META[dominant].accentHex,
                  });
                }
              }
            }

            // Update & draw grain particles
            const nextParticles: GrainParticle[] = [];
            for (const p of particlesRef.current) {
              p.x += p.vx;
              p.y += p.vy;
              p.life -= 0.045;
              if (p.life > 0) {
                ctx.fillStyle = hexToRgba(p.color, p.life * 0.75);
                ctx.beginPath();
                ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
                ctx.fill();
                nextParticles.push(p);
              }
            }
            particlesRef.current = nextParticles.slice(-140);

            // Draw tethers and voice nodes
            vcs.forEach((v, index) => {
              const px = v.x * w;
              const py = v.y * h;
              const bw = bilinearWeights(v.x, v.y);
              const isHeld = v.pointerId !== null;

              // Tether lines to loaded corners
              for (const id of CORNERS) {
                if (!smp[id] || bw[id] < 0.04) continue;
                const meta = CORNER_META[id];
                ctx.strokeStyle = hexToRgba(meta.accentHex, 0.1 + bw[id] * 0.42);
                ctx.lineWidth = 1 + bw[id] * 1.5;
                ctx.beginPath();
                ctx.moveTo(px, py);
                ctx.lineTo(meta.x * w, meta.y * h);
                ctx.stroke();
              }

              // Acoustic pulse halo
              const pulseR = 22 + audioLevel * 20;
              ctx.strokeStyle = isHeld
                ? 'rgba(249, 115, 22, 0.35)'
                : 'rgba(255, 255, 255, 0.2)';
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.arc(px, py, pulseR, 0, Math.PI * 2);
              ctx.stroke();

              // Main voice ring
              ctx.fillStyle = isHeld ? 'rgba(234, 88, 12, 0.22)' : 'rgba(255, 255, 255, 0.12)';
              ctx.strokeStyle = isHeld ? '#fb923c' : '#fafafa';
              ctx.lineWidth = 2;
              ctx.beginPath();
              ctx.arc(px, py, 16, 0, Math.PI * 2);
              ctx.fill();
              ctx.stroke();

              // Center pip
              ctx.fillStyle = isHeld ? '#fb923c' : '#fafafa';
              ctx.beginPath();
              ctx.arc(px, py, 3.5, 0, Math.PI * 2);
              ctx.fill();

              // Voice index & coordinates readout
              ctx.font = '500 10px "IBM Plex Mono", monospace';
              ctx.textAlign = px > w - 85 ? 'right' : 'left';
              const labelX = px > w - 85 ? px - 24 : px + 24;
              const labelY = py < 26 ? py + 14 : py - 10;
              ctx.fillStyle = 'rgba(250, 250, 250, 0.88)';
              ctx.fillText(
                `${index + 1} (${v.x.toFixed(2)}, ${v.y.toFixed(2)})`,
                labelX,
                labelY
              );
            });

            // Empty pad prompt
            if (vcs.length === 0) {
              ctx.textAlign = 'center';
              ctx.font = '500 13px "IBM Plex Sans", sans-serif';
              ctx.fillStyle = 'rgba(244, 244, 245, 0.55)';
              ctx.fillText('Touch or click anywhere to morph between corners', w * 0.5, h * 0.5 - 6);
              ctx.font = '400 11px "IBM Plex Mono", monospace';
              ctx.fillStyle = 'rgba(161, 161, 170, 0.55)';
              ctx.fillText('Multitouch supported · Enable Latch to hold multiple voices', w * 0.5, h * 0.5 + 14);
            }

            ctx.restore();
          }
        }
      }
      rafId = requestAnimationFrame(render);
    };

    rafId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(rafId);
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-[340px] sm:h-[410px] lg:h-[460px] rounded-2xl overflow-hidden border border-zinc-800 bg-zinc-950 select-none"
    >
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUpOrCancel}
        onPointerCancel={handlePointerUpOrCancel}
        style={{ touchAction: 'none' }}
        className="w-full h-full block cursor-crosshair"
        aria-label="Multitouch XY sample morph pad"
      />
    </div>
  );
};

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
