import React, { useMemo, useRef, useState } from 'react';
import { CORNER_META, type CornerId } from '../audio/morph';
import { MAX_RECORD_SECONDS, type CornerSample } from '../audio/samples';
import { Mic, Play, Square, Upload, X } from './Icons';

interface CornerSlotProps {
  id: CornerId;
  sample: CornerSample | null;
  weight: number;
  isRecording: boolean;
  recordingElapsed: number;
  recordingLevel: number;
  isBusy: boolean;
  onUploadFile: (id: CornerId, file: File) => void;
  onToggleRecord: (id: CornerId) => void;
  onPreview: (id: CornerId) => void;
  onClear: (id: CornerId) => void;
}

function detectAppleMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ reports MacIntel with touch points
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

export const CornerSlot: React.FC<CornerSlotProps> = ({
  id,
  sample,
  weight,
  isRecording,
  recordingElapsed,
  recordingLevel,
  isBusy,
  onUploadFile,
  onToggleRecord,
  onPreview,
  onClear,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const isAppleMobile = useMemo(() => detectAppleMobile(), []);
  const meta = CORNER_META[id];
  const activePct = Math.round(Math.max(0, Math.min(1, weight)) * 100);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onUploadFile(id, file);
    }
    e.target.value = '';
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (isRecording) return;
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    if (isRecording) return;
    const file = e.dataTransfer.files?.[0];
    if (file) {
      onUploadFile(id, file);
    }
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`relative bg-white border rounded-xl p-3 transition-colors duration-150 ${
        isRecording || isDragOver
          ? 'border-orange-600 ring-1 ring-orange-600/20'
          : sample
          ? 'border-zinc-200 hover:border-zinc-300'
          : 'border-zinc-200/80 border-dashed'
      }`}
    >
      {/* Subtle top modulation energy bar */}
      <div className="absolute inset-x-3 top-0 h-[2px] bg-zinc-100 rounded-full overflow-hidden">
        <div
          className="h-full transition-[width] duration-75"
          style={{
            width: `${activePct}%`,
            backgroundColor: meta.accentHex,
          }}
        />
      </div>

      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="w-6 h-6 rounded-md text-xs font-mono font-semibold flex items-center justify-center shrink-0 text-white"
            style={{ backgroundColor: sample || isRecording ? meta.accentHex : '#a1a1aa' }}
          >
            {meta.label}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-sm font-medium text-zinc-950 truncate">
              <span className="truncate">
                {isRecording
                  ? 'Recording...'
                  : sample
                  ? sample.name
                  : `${meta.position} Empty`}
              </span>
            </div>
            <div className="text-[11px] font-mono tabular-nums text-zinc-500 flex items-center gap-1.5">
              {isRecording ? (
                <span className="text-orange-600 font-medium">
                  {recordingElapsed.toFixed(1)}s / {MAX_RECORD_SECONDS}s
                </span>
              ) : sample ? (
                <>
                  <span>{sample.duration.toFixed(2)}s</span>
                  <span aria-hidden="true">·</span>
                  <span>{activePct}%</span>
                </>
              ) : (
                <span>Load or record sample</span>
              )}
            </div>
          </div>
        </div>

        {/* Action controls: min 40-44px hit targets */}
        <div className="flex items-center gap-1 shrink-0">
          {sample && !isRecording && (
            <button
              type="button"
              onClick={() => onPreview(id)}
              title={`Preview ${sample.name}`}
              aria-label={`Preview ${sample.name}`}
              className="w-9 h-9 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center text-zinc-600 hover:text-zinc-950 hover:bg-zinc-100 transition-colors cursor-pointer"
            >
              <Play className="w-3.5 h-3.5" />
            </button>
          )}

          <button
            type="button"
            disabled={isBusy && !isRecording}
            onClick={() => onToggleRecord(id)}
            title={isRecording ? `Stop recording corner ${id}` : `Record mic into corner ${id}`}
            aria-label={isRecording ? `Stop recording corner ${id}` : `Record mic into corner ${id}`}
            className={`w-9 h-9 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center transition-colors cursor-pointer disabled:opacity-40 ${
              isRecording
                ? 'bg-orange-600 text-white hover:bg-orange-700'
                : 'text-zinc-600 hover:text-zinc-950 hover:bg-zinc-100'
            }`}
          >
            {isRecording ? <Square className="w-3.5 h-3.5 fill-current" /> : <Mic className="w-3.5 h-3.5" />}
          </button>

          <button
            type="button"
            disabled={isRecording}
            onClick={() => fileInputRef.current?.click()}
            title={`Upload audio file to corner ${id}`}
            aria-label={`Upload audio file to corner ${id}`}
            className="w-9 h-9 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center text-zinc-600 hover:text-zinc-950 hover:bg-zinc-100 transition-colors cursor-pointer disabled:opacity-40"
          >
            <Upload className="w-3.5 h-3.5" />
          </button>

          {sample && !isRecording && (
            <button
              type="button"
              onClick={() => onClear(id)}
              title={`Clear corner ${id}`}
              aria-label={`Clear corner ${id}`}
              className="w-9 h-9 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 transition-colors cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Waveform or Recording input meter */}
      <div className="h-7 bg-zinc-50 border border-zinc-100 rounded-md px-1.5 flex items-center gap-[2px] overflow-hidden">
        {isRecording ? (
          <div className="w-full h-2 bg-zinc-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-orange-600 transition-[width] duration-75"
              style={{ width: `${Math.round(recordingLevel * 100)}%` }}
            />
          </div>
        ) : sample ? (
          sample.peaks.slice(0, 48).map((p, idx) => (
            <div
              key={idx}
              className="flex-1 rounded-full transition-opacity"
              style={{
                height: `${Math.max(12, Math.round(p * 100))}%`,
                backgroundColor: meta.accentHex,
                opacity: 0.28 + weight * 0.72,
              }}
            />
          ))
        ) : (
          <div className="w-full text-center text-[11px] text-zinc-400 select-none">
            Drop or upload audio
          </div>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept={
          isAppleMobile
            ? undefined
            : 'audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac,.aiff,.aif,.caf,.webm'
        }
        onChange={handleFileChange}
        className="hidden"
      />
    </div>
  );
};
