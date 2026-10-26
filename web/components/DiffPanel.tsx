"use client";

import { useState } from "react";

import type { FileRole } from "@/lib/diff";
import { AGENT_COLORS } from "@/lib/office/sprites";
import { snapshotAt, type Snapshot } from "@/lib/snapshots";

import DiffViewer from "./DiffViewer";

interface Props {
  snapshots: Snapshot[];
  // events applied in the replay so far
  index: number;
  roleOf: (path: string) => FileRole;
}

/**
 * The code at each step of the run. By default it follows the replay (the
 * newest version at this point); picking a version pins it. A retry can show
 * the whole result or just what that retry changed.
 */
export default function DiffPanel({ snapshots, index, roleOf }: Props) {
  // null: follow the replay
  const [pinned, setPinned] = useState<string | null>(null);
  const [onlyChange, setOnlyChange] = useState(false);

  if (!snapshots.length) {
    return <p className="p-2 text-sm text-ink-soft">No code changes in this run yet: nothing has been committed.</p>;
  }

  const following = pinned === null || !snapshots.some((s) => s.id === pinned);
  const current = following ? snapshotAt(snapshots, index) : snapshots.find((s) => s.id === pinned)!;
  const showChange = onlyChange && current?.change !== undefined;
  const diff = current ? (showChange ? current.change! : current.diff) : "";
  const later = snapshots.filter((s) => s.index >= index);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-pixel text-[11px] uppercase tracking-wider text-ink-soft">Versions</h3>
        <button
          type="button"
          className="pixel-btn inline-flex items-center gap-1.5 px-2 py-0.5 text-xs"
          aria-pressed={following}
          onClick={() => setPinned(following ? (current?.id ?? snapshots[0].id) : null)}
          title="Show the newest version at the replay's current moment"
        >
          {following ? "● following the replay" : "○ follow the replay"}
        </button>
      </div>

      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-2" aria-label="Versions of the code">
        {snapshots.map((s, i) => {
          const selected = current?.id === s.id;
          const future = s.index >= index;
          return (
            <li key={s.id} className="flex items-center gap-1.5">
              {i > 0 && <span aria-hidden className="font-pixel text-xs text-ink-soft">→</span>}
              <button
                type="button"
                onClick={() => setPinned(s.id)}
                aria-current={selected ? "true" : undefined}
                title={`${s.label}: ${s.detail}${future ? " (later in the replay)" : ""}`}
                className={`flex items-center gap-1.5 px-2 py-1 font-pixel text-xs ${selected ? "bg-ink text-paper" : "bg-cream-dark hover:bg-now"} ${future && !selected ? "opacity-50" : ""}`}
              >
                <span aria-hidden className="inline-block h-2 w-2 shrink-0" style={{ background: AGENT_COLORS[s.agent] }} />
                {s.label}
                {s.final && <span className={`px-1 text-[9px] uppercase ${selected ? "bg-paper text-ink" : "bg-moss text-on"}`}>final</span>}
              </button>
            </li>
          );
        })}
      </ol>

      {!current ? (
        <div className="flex flex-col items-start gap-2 border-l-4 border-ink/25 bg-cream/50 py-2 pl-3 pr-2 text-sm">
          <p>Nothing has been committed yet at this point in the replay.</p>
          {later.length > 0 && (
            <button type="button" className="pixel-btn px-2 py-0.5 text-xs" onClick={() => setPinned(later[0].id)}>
              Show the first version ({later[0].label}) →
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-l-4 bg-cream/50 py-1.5 pl-3 pr-2" style={{ borderColor: AGENT_COLORS[current.agent] }}>
            <p className="min-w-0 flex-1 text-sm">
              <span className="font-pixel font-bold">{current.label}</span>
              <span className="text-ink-soft"> · {current.detail}</span>
            </p>
            {current.change !== undefined && (
              <div className="flex gap-2" role="group" aria-label="What to show">
                <button type="button" className="pixel-btn px-2 py-0.5 text-[11px]" aria-pressed={!showChange} onClick={() => setOnlyChange(false)}>
                  whole result
                </button>
                <button type="button" className="pixel-btn px-2 py-0.5 text-[11px]" aria-pressed={showChange} onClick={() => setOnlyChange(true)}>
                  this retry only
                </button>
              </div>
            )}
          </div>
          {current.diffChars && !showChange && (
            <p className="font-pixel text-xs text-terracotta">This diff was cut to its first 100k characters (of {current.diffChars.toLocaleString("en-US")}).</p>
          )}
          {diff ? (
            <DiffViewer key={`${current.id}-${showChange}`} diff={diff} roleOf={roleOf} />
          ) : (
            <p className="p-2 text-sm text-ink-soft">{showChange ? "This retry changed nothing." : "No changes in this version."}</p>
          )}
        </>
      )}
    </div>
  );
}
