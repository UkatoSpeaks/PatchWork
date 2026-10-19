"use client";

import { PHASE_COLORS, type PhaseSegment } from "@/lib/stats";

export const SPEEDS = [1, 2, 4, 8];

interface Props {
  playing: boolean;
  speed: number;
  index: number;
  total: number;
  current: string;
  phases: PhaseSegment[];
  onPlayPause: () => void;
  onRestart: () => void;
  onSpeed: (speed: number) => void;
  onSeek: (index: number) => void;
}

export default function ReplayControls({ playing, speed, index, total, current, phases, onPlayPause, onRestart, onSpeed, onSeek }: Props) {
  return (
    <div className="pixel-box flex flex-col gap-4 bg-paper p-4">
      <div className="flex flex-wrap items-center gap-4">
        <button type="button" className="pixel-btn min-w-24 px-3 py-1.5 text-sm font-bold" onClick={onPlayPause} title="Play / pause (space)">
          {playing ? "❚❚ pause" : "▶ play"}
        </button>
        <button type="button" className="pixel-btn px-3 py-1.5 text-sm" onClick={onRestart}>
          ↺ restart
        </button>
        <div className="flex items-center gap-3" role="group" aria-label="Replay speed">
          {SPEEDS.map((s, i) => (
            <button
              key={s}
              type="button"
              className="pixel-btn px-2 py-1 text-sm"
              aria-pressed={speed === s}
              title={`${s}x speed (key ${i + 1})`}
              onClick={() => onSpeed(s)}
            >
              {s}x
            </button>
          ))}
        </div>
        <span className="ml-auto min-w-0 max-w-full truncate font-mono text-xs text-ink-soft">{current}</span>
      </div>
      <div className="flex items-start gap-4 px-1">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <input
            type="range"
            className="pixel-range"
            min={0}
            max={total}
            value={index}
            onChange={(e) => onSeek(Number(e.target.value))}
            aria-label="Event position (left / right arrow keys step one event)"
          />
          {phases.length > 0 && total > 0 && <PhaseTimeline phases={phases} index={index} total={total} onSeek={onSeek} />}
        </div>
        <span className="shrink-0 font-pixel text-sm tabular-nums">
          {index} / {total}
        </span>
      </div>
    </div>
  );
}

/** Coloured segments per phase, under the scrubber: click one to jump to its start. */
function PhaseTimeline({ phases, index, total, onSeek }: { phases: PhaseSegment[]; index: number; total: number; onSeek: (index: number) => void }) {
  return (
    <div className="mx-[6px] flex h-5 gap-[2px]" role="group" aria-label="Jump to a phase">
      {phases.map((segment) => {
        const current = index > segment.start && index <= segment.end;
        const share = (segment.end - segment.start) / total;
        return (
          <button
            key={`${segment.start}-${segment.phase}`}
            type="button"
            onClick={() => onSeek(segment.start + 1)}
            title={`${segment.label}: events ${segment.start + 1}–${segment.end}`}
            aria-label={`Jump to ${segment.label}`}
            aria-current={current ? "step" : undefined}
            className={`group relative min-w-[6px] overflow-hidden text-left font-pixel text-[10px] leading-5 text-ink ${current ? "outline-2 outline-ink" : "opacity-75 hover:opacity-100"}`}
            style={{ flexGrow: share, flexBasis: 0, background: PHASE_COLORS[segment.phase] ?? "#cbbf9f" }}
          >
            {share > 0.07 && <span className="absolute inset-y-0 left-1 truncate rounded-none bg-paper/80 px-0.5 leading-4 my-0.5">{segment.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
