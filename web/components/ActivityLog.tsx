"use client";

import { useEffect, useMemo, useRef } from "react";

import { clockLabel, filterLog, type LogEntry, type LogFilter } from "@/lib/log";
import { AGENT_COLORS } from "@/lib/office/sprites";
import type { AgentName } from "@/lib/types";

import { ROLE } from "./AgentCard";
import Skeleton from "./Skeleton";

const FILTERS: LogFilter[] = ["all", "lead", "tester", "coder", "reviewer", "orchestrator"];

const TONE: Record<LogEntry["tone"], string> = {
  info: "",
  tool: "",
  wait: "text-wait",
  phase: "font-bold",
  good: "text-moss",
  bad: "text-terracotta",
};

interface Props {
  entries: LogEntry[];
  // events applied so far: entries[index - 1] is the current one
  index: number;
  // the event open in the drawer
  inspected: number | null;
  filter: LogFilter;
  onFilter: (filter: LogFilter) => void;
  // open an event's details (and seek there)
  onOpen: (index: number) => void;
  // as tall as the screen allows on wide screens (beside the office)
  tall?: boolean;
  // the events are still loading
  loading?: boolean;
}

/** Every event as a readable line. Future lines are dimmed; clicking one opens its details and seeks there. */
export default function ActivityLog({ entries, index, inspected, filter, onFilter, onOpen, tall = false, loading = false }: Props) {
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
      <ol ref={listRef} className={`pixel-scroll relative h-[22rem] ${tall ? "xl:h-[calc(100dvh-17rem)] xl:min-h-[22rem]" : ""} overflow-y-auto overflow-x-hidden bg-cream/60 font-mono text-xs [font-variant-ligatures:none]`} aria-label="Events">
        {loading &&
          Array.from({ length: 12 }, (_, i) => (
            <li key={i} aria-hidden className="flex items-center gap-2 border-l-4 border-cream-dark px-2 py-1.5">
              <Skeleton className="h-3 w-9" />
              <Skeleton className="h-3 w-16" />
              <Skeleton className={`h-3 ${["w-3/5", "w-2/5", "w-1/2", "w-2/3"][i % 4]}`} />
            </li>
          ))}
        {loading && <li className="sr-only">Loading events…</li>}
        {!loading && shown.length === 0 && <li className="p-3 text-ink-soft">No events for this agent.</li>}
        {shown.map((entry) => {
          const past = entry.index < index;
          const current = entry.index === index - 1;
          const open = entry.index === inspected;
          return (
            <li key={entry.index} data-index={entry.index}>
              <button
                type="button"
                onClick={() => onOpen(entry.index)}
                aria-current={current ? "step" : undefined}
                aria-expanded={open}
                title={`Details of event ${entry.index + 1}`}
                className={`group flex w-full min-w-0 items-baseline gap-2 border-l-4 px-2 py-1 text-left hover:bg-hover ${current ? "bg-now" : ""} ${open ? "outline-2 -outline-offset-2 outline-ink" : ""} ${past ? "" : "opacity-45"}`}
                style={{ borderColor: AGENT_COLORS[entry.agent] }}
              >
                <span className="w-9 shrink-0 tabular-nums text-ink-soft">{clockLabel(entry.at)}</span>
                <span className="w-16 shrink-0 truncate font-pixel text-[11px] font-bold" style={{ color: entry.agent === "orchestrator" ? "var(--color-ink-soft)" : undefined }}>
                  <span aria-hidden className="mr-1 inline-block h-2 w-2" style={{ background: AGENT_COLORS[entry.agent] }} />
                  {ROLE[entry.agent] ?? entry.agent}
                </span>
                <span className={`min-w-0 flex-1 break-words ${TONE[entry.tone]}`}>{entry.text}</span>
                <span aria-hidden className={`shrink-0 font-pixel text-ink-soft ${open ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"}`}>›</span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
