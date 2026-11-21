import React from 'react';

interface SliderProps {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  displayValue: string;
  onChange: (value: number) => void;
}

export const Slider: React.FC<SliderProps> = ({
  id,
  label,
  value,
  min,
  max,
  step,
  displayValue,
  onChange,
}) => {
  const pct = ((value - min) / Math.max(0.0001, max - min)) * 100;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-xs">
        <label htmlFor={id} className="font-medium text-zinc-700 select-none">
          {label}
        </label>
        <span className="font-mono tabular-nums text-zinc-900 font-medium">
          {displayValue}
        </span>
      </div>
      <div className="relative flex items-center min-h-[36px] sm:min-h-[32px]">
        <div className="w-full h-1.5 bg-zinc-200 rounded-full overflow-hidden">
          <div
            className="h-full bg-zinc-900 rounded-full transition-[width] duration-75"
            style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
          />
        </div>
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        />
        <div
          className="pointer-events-none absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 rounded-full bg-white border-2 border-zinc-900 shadow-xs"
          style={{ left: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      </div>
    </div>
  );
};
