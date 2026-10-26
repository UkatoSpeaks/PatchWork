"use client";

import { useEffect, useState } from "react";

import { PHASE_COLORS, type PhaseSegment } from "@/lib/stats";

export const SPEEDS = [1, 2, 4, 8];

interface Props {
  playing: boolean;
  speed: number;
  index: number;
  total: number;
  current: string;
  phases: PhaseSegment[];
  // following a running run as it happens
  live: boolean;
  // the run is still going but we're not at its newest event
  canGoLive: boolean;
  onGoLive: () => void;
  onPlayPause: () => void;
  onRestart: () => void;
  onSpeed: (speed: number) => void;
  onSeek: (index: number) => void;
  // open the current event in the drawer
  onInspect?: () => void;
  onHelp?: () => void;
}

const HINT_KEY = "patchwork:help-hint-seen";

/** A one-time "press ? for shortcuts" nudge, remembered per browser. */
function useHelpHint(): [boolean, () => void] {
  const [show, setShow] = useState(false);
  useEffect(() => {
    let seen = true;
    try {
      seen = localStorage.getItem(HINT_KEY) === "1";
    } catch {
      // no storage: don't nag
    }
    if (seen) return;
    const timer = setTimeout(() => setShow(true), 1500);
    return () => clearTimeout(timer);
  }, []);
  const dismiss = () => {
    setShow(false);
    try {
      localStorage.setItem(HINT_KEY, "1");
    } catch {
      // fine
    }
  };
  return [show, dismiss];
}

export default function ReplayControls({ playing, speed, index, total, current, phases, live, canGoLive, onGoLive, onPlayPause, onRestart, onSpeed, onSeek, onInspect, onHelp }: Props) {
  const [hint, dismissHint] = useHelpHint();
  return (
    <div className="pixel-box flex flex-col gap-4 bg-paper p-4">
      <div className="flex flex-wrap items-center gap-4">
        <button type="button" className="pixel-btn min-w-24 px-3 py-1.5 text-sm font-bold" onClick={onPlayPause} title="Play / pause (space)">
          {playing ? "❚❚ pause" : "▶ play"}
        </button>
        <button type="button" className="pixel-btn px-3 py-1.5 text-sm" onClick={onRestart}>
          ↺ restart
        </button>
        {live && (
          <span className="inline-flex items-center gap-1.5 bg-terracotta px-2 py-1 font-pixel text-sm font-bold text-paper" role="status">
            <span aria-hidden className="live-dot" /> live
          </span>
        )}
        {canGoLive && (
          <button type="button" className="pixel-btn inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-bold text-terracotta" onClick={onGoLive} title="Jump to now and follow the run (L)">
            <span aria-hidden className="live-dot" /> go live
          </button>
        )}
        <div className={`flex items-center gap-3 ${live ? "opacity-50" : ""}`} role="group" aria-label="Replay speed">
          {SPEEDS.map((s, i) => (
            <button
              key={s}
              type="button"
              className="pixel-btn px-2 py-1 text-sm"
              aria-pressed={speed === s}
              disabled={live}
              title={live ? "Live events play as they happen" : `${s}x speed (key ${i + 1})`}
              onClick={() => onSpeed(s)}
            >
              {s}x
            </button>
          ))}
        </div>
        {onInspect ? (
          <button
            type="button"
            onClick={onInspect}
            className="pixel-link ml-auto min-w-0 max-w-full truncate font-mono text-xs text-ink-soft underline decoration-dotted underline-offset-4 hover:text-terracotta"
            title="Show this event's details"
          >
            {current} ›
          </button>
        ) : (
          <span className="ml-auto min-w-0 max-w-full truncate font-mono text-xs text-ink-soft">{current}</span>
        )}
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
        {onHelp && (
          <span className="relative shrink-0">
            <button
              type="button"
              className="pixel-btn h-7 w-7 text-sm font-bold"
              onClick={() => {
                dismissHint();
                onHelp();
              }}
              title="Keys and clicks (?)"
              aria-label="Keys and clicks"
            >
              ?
            </button>
            {hint && (
              <span role="status" className="help-hint absolute bottom-full right-0 mb-3 flex w-max items-center gap-2 bg-ink px-2.5 py-1.5 font-pixel text-xs text-paper">
                New here? Press ? for keys and clicks
                <button type="button" onClick={dismissHint} className="text-paper/70 hover:text-paper" aria-label="Dismiss the tip">
                  ✕
                </button>
              </span>
            )}
          </span>
        )}
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
