"use client";

import { useEffect, useMemo, useRef } from "react";

import { clockLabel, filterLog, seekTargetFor, type LogEntry, type LogFilter } from "@/lib/log";
import { AGENT_COLORS } from "@/lib/office/sprites";
import type { AgentName } from "@/lib/types";

import { ROLE } from "./AgentCard";

const FILTERS: LogFilter[] = ["all", "lead", "tester", "coder", "reviewer", "orchestrator"];

const TONE: Record<LogEntry["tone"], string> = {
  info: "",
  tool: "",
  wait: "text-[#8b6f55]",
  phase: "font-bold",
  good: "text-moss",
  bad: "text-terracotta",
};

interface Props {
  entries: LogEntry[];
  // events applied so far: entries[index - 1] is the current one
  index: number;
  filter: LogFilter;
  onFilter: (filter: LogFilter) => void;
  onSeek: (index: number) => void;
}

/** Every event as a readable line. Future lines are dimmed; clicking one seeks there. */
export default function ActivityLog({ entries, index, filter, onFilter, onSeek }: Props) {
  const listRef = useRef<HTMLOListElement>(null);
  const shown = useMemo(() => filterLog(entries, filter), [entries, filter]);
  const present = new Set(entries.map((e) => e.agent));

  // Keep the current line in view as playback moves (scroll the list, not the page).
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const current = [...list.querySelectorAll<HTMLElement>("[data-index]")].filter((el) => Number(el.dataset.index) < index).pop();
    if (!current) {
      list.scrollTop = 0;
      return;
    }
    const top = current.offsetTop; // the list is `relative`, so this is within it
    if (top < list.scrollTop || top + current.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = Math.max(0, top - list.clientHeight * 0.6);
    }
  }, [index, shown]);

  return (
    <section aria-label="Activity log" className="pixel-box flex min-w-0 flex-col gap-3 bg-paper p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-pixel text-base font-bold">Activity log</h2>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter the log by agent">
          {FILTERS.filter((f) => f === "all" || present.has(f as AgentName)).map((f) => (
            <button
              key={f}
              type="button"
              className="pixel-btn flex items-center gap-1.5 px-2 py-0.5 text-xs"
              aria-pressed={filter === f}
              onClick={() => onFilter(f)}
            >
              {f !== "all" && <span aria-hidden className="inline-block h-2 w-2" style={{ background: AGENT_COLORS[f] }} />}
              {f === "all" ? "All" : ROLE[f]}
            </button>
          ))}
        </div>
      </div>
      <ol ref={listRef} className="pixel-scroll relative h-[22rem] overflow-y-auto overflow-x-hidden bg-cream/60 font-mono text-xs [font-variant-ligatures:none]" aria-label="Events">
        {shown.length === 0 && <li className="p-3 text-ink-soft">No events for this agent.</li>}
        {shown.map((entry) => {
          const past = entry.index < index;
          const current = entry.index === index - 1;
          return (
            <li key={entry.index} data-index={entry.index}>
              <button
                type="button"
                onClick={() => onSeek(seekTargetFor(entry))}
                aria-current={current ? "step" : undefined}
                title={`Jump to event ${entry.index + 1}`}
                className={`flex w-full min-w-0 items-baseline gap-2 border-l-4 px-2 py-1 text-left hover:bg-[#fff6dc] ${current ? "bg-[#fff1c7]" : ""} ${past ? "" : "opacity-45"}`}
                style={{ borderColor: AGENT_COLORS[entry.agent] }}
              >
                <span className="w-9 shrink-0 tabular-nums text-ink-soft">{clockLabel(entry.at)}</span>
                <span className="w-16 shrink-0 truncate font-pixel text-[11px] font-bold" style={{ color: entry.agent === "orchestrator" ? "#5a4f4a" : undefined }}>
                  <span aria-hidden className="mr-1 inline-block h-2 w-2" style={{ background: AGENT_COLORS[entry.agent] }} />
                  {ROLE[entry.agent] ?? entry.agent}
                </span>
                <span className={`min-w-0 flex-1 break-words ${TONE[entry.tone]}`}>{entry.text}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
