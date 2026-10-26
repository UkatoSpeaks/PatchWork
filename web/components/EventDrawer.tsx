"use client";

import { useEffect, useMemo, useRef } from "react";

import { eventDetail } from "@/lib/eventDetail";
import { clockLabel } from "@/lib/log";
import { AGENT_COLORS } from "@/lib/office/sprites";
import type { RunEvent } from "@/lib/types";

import { ROLE } from "./AgentCard";
import CopyButton from "./CopyButton";
import DetailBlocks, { TONE_PILL } from "./DetailBlocks";

interface Props {
  events: RunEvent[];
  index: number;
  prev: number | null;
  next: number | null;
  onOpen: (index: number) => void;
  onClose: () => void;
}

/**
 * A side panel with everything one event carries, laid out for its type.
 * It doesn't block the page: the replay and the log stay usable next to it.
 */
export default function EventDrawer({ events, index, prev, next, onOpen, onClose }: Props) {
  const event = events[index];
  const detail = useMemo(() => eventDetail(events, index), [events, index]);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const opened = useRef(false);

  // Focus the title when the drawer opens (not on every step), and start each event at the top.
  useEffect(() => {
    if (!opened.current) {
      opened.current = true;
      titleRef.current?.focus({ preventScroll: true });
    }
    bodyRef.current?.scrollTo({ top: 0 });
  }, [index]);

  if (!event) return null;
  const at = Math.max(0, (Date.parse(event.timestamp) - Date.parse(events[0].timestamp)) / 1000) || 0;
  const color = AGENT_COLORS[event.agent];

  return (
    <aside
      aria-labelledby="event-drawer-title"
      className="event-drawer fixed inset-y-0 right-0 z-40 flex w-full flex-col bg-paper sm:w-[32rem] sm:max-w-[calc(100vw-2rem)]"
    >
      <div className="h-1.5 shrink-0" style={{ background: color }} aria-hidden />
      <header className="flex shrink-0 flex-col gap-3 border-b-4 border-ink px-5 pb-4 pt-4">
        <div className="flex items-center gap-2">
          <span className="flex min-w-0 items-center gap-2 font-pixel text-sm font-bold">
            <span aria-hidden className="inline-block h-3 w-3 shrink-0" style={{ background: color }} />
            {ROLE[event.agent] ?? event.agent}
          </span>
          <span className="font-mono text-xs text-ink-soft">
            {clockLabel(at)} · #{event.seq}
          </span>
          <nav className="ml-auto flex items-center gap-2" aria-label="Step through events">
            <button type="button" className="pixel-btn px-2 py-0.5 text-sm" disabled={prev === null} onClick={() => prev !== null && onOpen(prev)} title="Previous event (←)" aria-label="Previous event">
              ‹
            </button>
            <button type="button" className="pixel-btn px-2 py-0.5 text-sm" disabled={next === null} onClick={() => next !== null && onOpen(next)} title="Next event (→)" aria-label="Next event">
              ›
            </button>
            <button type="button" className="pixel-btn ml-1 px-2 py-0.5 text-sm" onClick={onClose} title="Close (Esc)" aria-label="Close event details">
              ✕
            </button>
          </nav>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="event-drawer-title" ref={titleRef} tabIndex={-1} className="min-w-0 flex-1 font-pixel text-xl font-bold leading-tight outline-none first-letter:uppercase">
            {detail.title}
          </h2>
          {detail.status && (
            <span className={`pixel-box-sm shrink-0 px-2 py-0.5 font-pixel text-xs font-bold uppercase tracking-wider ${TONE_PILL[detail.status.tone]}`}>
              {detail.status.label}
            </span>
          )}
        </div>
      </header>

      <div ref={bodyRef} className="pixel-scroll flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-5">
        <DetailBlocks blocks={detail.blocks} />
        {detail.related && (
          <button type="button" className="pixel-btn self-start px-3 py-1 text-xs" onClick={() => onOpen(detail.related!.index)}>
            {detail.related.label} →
          </button>
        )}
        <details className="group mt-auto pt-2">
          <summary className="flex cursor-pointer items-center gap-2 font-pixel text-xs text-ink-soft hover:text-ink">
            <span aria-hidden className="inline-block transition-transform group-open:rotate-90">▸</span>
            Raw event
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            <div className="flex justify-end">
              <CopyButton text={JSON.stringify(event, null, 2)} label="copy JSON" />
            </div>
            <pre className="pixel-scroll max-h-80 overflow-auto bg-cream/70 p-3 font-mono text-[11px] leading-[1.5]">{JSON.stringify(event, null, 2)}</pre>
          </div>
        </details>
      </div>

      <footer className="shrink-0 border-t-2 border-dashed border-ink/20 px-5 py-2 font-pixel text-[11px] text-ink-soft">
        ← → step · Esc close · the office shows the moment right after this event
      </footer>
    </aside>
  );
}
