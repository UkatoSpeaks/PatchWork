"use client";

import { forwardRef } from "react";

import type { FileRole } from "@/lib/diff";
import type { Snapshot } from "@/lib/snapshots";
import type { AgentStats } from "@/lib/stats";
import type { Plan } from "@/lib/types";

import DiffPanel from "./DiffPanel";
import PlanPanel from "./PlanPanel";
import Skeleton from "./Skeleton";
import StatsPanel from "./StatsPanel";

export type InfoTab = "plan" | "diff" | "stats";

const TABS: { id: InfoTab; label: string }[] = [
  { id: "plan", label: "Plan" },
  { id: "diff", label: "Diff" },
  { id: "stats", label: "Stats" },
];

interface Props {
  tab: InfoTab;
  onTab: (tab: InfoTab) => void;
  plan: Plan | null;
  snapshots: Snapshot[];
  // events applied in the replay so far
  index: number;
  roleOf: (path: string) => FileRole;
  agents: AgentStats[];
  phases: { phase: string; seconds: number }[];
  // the run's events are still loading
  loading?: boolean;
}

/** The plan, the code (each version of it) and the stats, as tabs. */
const InfoPanels = forwardRef<HTMLElement, Props>(function InfoPanels({ tab, onTab, plan, snapshots, index, roleOf, agents, phases, loading = false }, ref) {
  return (
    <section ref={ref} aria-label="Run details" className="pixel-box flex min-w-0 flex-col gap-4 bg-paper p-4">
      <div
        className="flex gap-3"
        role="tablist"
        aria-label="Run details"
        onKeyDown={(event) => {
          // Arrow keys, Home and End move between tabs (and select them).
          const at = TABS.findIndex((t) => t.id === tab);
          const to =
            event.key === "ArrowRight" ? (at + 1) % TABS.length
            : event.key === "ArrowLeft" ? (at - 1 + TABS.length) % TABS.length
            : event.key === "Home" ? 0
            : event.key === "End" ? TABS.length - 1
            : -1;
          if (to < 0) return;
          event.preventDefault();
          onTab(TABS[to].id);
          document.getElementById(`tab-${TABS[to].id}`)?.focus();
        }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            className="pixel-btn px-3 py-1 text-sm"
            onClick={() => onTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="pixel-scroll max-h-[34rem] min-w-0 overflow-y-auto pr-1">
        {loading && (
          <div aria-busy="true" className="flex flex-col gap-3 p-1">
            <span className="sr-only">Loading…</span>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}
        {!loading && tab === "plan" && <PlanPanel plan={plan} />}
        {!loading && tab === "diff" && <DiffPanel snapshots={snapshots} index={index} roleOf={roleOf} />}
        {!loading && tab === "stats" && <StatsPanel agents={agents} phases={phases} />}
      </div>
    </section>
  );
});

export default InfoPanels;
