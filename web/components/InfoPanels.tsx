"use client";

import { forwardRef } from "react";

import type { FileRole } from "@/lib/diff";
import type { AgentStats } from "@/lib/stats";
import type { Plan } from "@/lib/types";

import DiffViewer from "./DiffViewer";
import PlanPanel from "./PlanPanel";
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
  diff: string;
  roleOf: (path: string) => FileRole;
  agents: AgentStats[];
  phases: { phase: string; seconds: number }[];
}

/** The plan, the final diff and the stats, as tabs. */
const InfoPanels = forwardRef<HTMLElement, Props>(function InfoPanels({ tab, onTab, plan, diff, roleOf, agents, phases }, ref) {
  return (
    <section ref={ref} aria-label="Run details" className="pixel-box flex min-w-0 flex-col gap-4 bg-paper p-4">
      <div className="flex gap-3" role="tablist" aria-label="Run details">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            className="pixel-btn px-3 py-1 text-sm"
            aria-pressed={tab === t.id}
            onClick={() => onTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="pixel-scroll max-h-[34rem] min-w-0 overflow-y-auto pr-1">
        {tab === "plan" && <PlanPanel plan={plan} />}
        {tab === "diff" && <DiffViewer diff={diff} roleOf={roleOf} />}
        {tab === "stats" && <StatsPanel agents={agents} phases={phases} />}
      </div>
    </section>
  );
});

export default InfoPanels;
