import {
  Download,
  Lock,
  Mic,
  Play,
  Square,
  Trash2,
  Unlock,
  Upload,
  Volume2,
  Waves,
  X,
} from 'lucide-react';

export {
  Download,
  Lock,
  Mic,
  Play,
  Square,
  Trash2,
  Unlock,
  Upload,
  Volume2,
  Waves,
  X,
};

export function PadGridIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <rect x="2.5" y="2.5" width="15" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <line x1="10" y1="2.5" x2="10" y2="17.5" stroke="currentColor" strokeWidth="1" opacity="0.45" />
      <line x1="2.5" y1="10" x2="17.5" y2="10" stroke="currentColor" strokeWidth="1" opacity="0.45" />
      <circle cx="7" cy="7" r="1.75" fill="currentColor" />
      <circle cx="13.2" cy="12.6" r="1.75" fill="currentColor" opacity="0.65" />
    </svg>
  );
}
