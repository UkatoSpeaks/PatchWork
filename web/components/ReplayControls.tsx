"use client";

export const SPEEDS = [1, 2, 4, 8];

interface Props {
  playing: boolean;
  speed: number;
  index: number;
  total: number;
  current: string;
  onPlayPause: () => void;
  onRestart: () => void;
  onSpeed: (speed: number) => void;
  onSeek: (index: number) => void;
}

export default function ReplayControls({ playing, speed, index, total, current, onPlayPause, onRestart, onSpeed, onSeek }: Props) {
  return (
    <div className="pixel-box flex flex-col gap-4 bg-paper p-4">
      <div className="flex flex-wrap items-center gap-4">
        <button type="button" className="pixel-btn min-w-24 px-3 py-1.5 text-sm font-bold" onClick={onPlayPause}>
          {playing ? "❚❚ pause" : "▶ play"}
        </button>
        <button type="button" className="pixel-btn px-3 py-1.5 text-sm" onClick={onRestart}>
          ↺ restart
        </button>
        <div className="flex items-center gap-3" role="group" aria-label="Replay speed">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              className="pixel-btn px-2 py-1 text-sm"
              aria-pressed={speed === s}
              onClick={() => onSpeed(s)}
            >
              {s}x
            </button>
          ))}
        </div>
        <span className="ml-auto min-w-0 max-w-full truncate font-mono text-xs text-ink-soft">{current}</span>
      </div>
      <div className="flex items-center gap-4 px-1">
        <input
          type="range"
          className="pixel-range"
          min={0}
          max={total}
          value={index}
          onChange={(e) => onSeek(Number(e.target.value))}
          aria-label="Event position"
        />
        <span className="shrink-0 font-pixel text-sm tabular-nums">
          {index} / {total}
        </span>
      </div>
    </div>
  );
}
