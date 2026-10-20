"use client";

import { useEffect, useRef } from "react";

import { formatTokens, shortModel } from "@/lib/api";
import { drawPortrait } from "@/lib/office/characters";
import type { AgentState } from "@/lib/office/reducer";

import AttemptList, { showAttempts } from "./AttemptList";

export type Status = "idle" | "walking" | "thinking" | "typing" | "testing" | "waiting" | "done" | "failed" | "cancelled";

const STATUS_STYLE: Record<Status, string> = {
  idle: "bg-cream-dark text-ink",
  walking: "bg-sage text-ink",
  thinking: "bg-slate text-paper",
  typing: "bg-mustard text-ink",
  testing: "bg-plum text-paper",
  waiting: "bg-[#8b6f55] text-paper",
  done: "bg-moss text-paper",
  failed: "bg-terracotta text-paper",
  cancelled: "bg-[#9a948c] text-paper",
};

export const ROLE: Record<string, string> = { lead: "Lead", tester: "Tester", coder: "Coder", reviewer: "Reviewer", orchestrator: "System" };

export function agentStatus(agent: AgentState, walking: boolean): Status {
  return walking && agent.activity !== "cancelled" ? "walking" : agent.activity;
}

function Portrait({ agent, animate, grey }: { agent: AgentState["name"]; animate: boolean; grey: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current!.getContext("2d")!;
    drawPortrait(ctx, agent, 0, grey);
    if (!animate) return;
    const started = performance.now();
    const timer = setInterval(() => drawPortrait(ctx, agent, performance.now() - started, grey), 150);
    return () => clearInterval(timer);
  }, [agent, animate, grey]);
  return <canvas ref={ref} width={20} height={20} className="pixelated h-14 w-14 shrink-0 bg-cream-dark" aria-hidden />;
}

export default function AgentCard({ agent, walking, maxSteps, maxTokens, task, now, selected, onSelect }: {
  agent: AgentState;
  walking: boolean;
  maxSteps: number;
  maxTokens: number;
  // the status tag's two lines (task, current action); idle agents: no task, and what they say
  task: string | null;
  now: string | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const status = agentStatus(agent, walking);
  const share = Math.min(1, agent.tokens / Math.max(1, maxTokens));
  const grey = status === "cancelled";
  const segments = 12;
  const filled = Math.round(share * segments);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      title={selected ? "Show every agent in the log" : `Follow the ${ROLE[agent.name]} in the log`}
      className={`pixel-box flex min-w-0 flex-1 basis-[15rem] cursor-pointer flex-col gap-2 p-3 text-left transition-transform hover:-translate-y-0.5 ${selected ? "bg-[#fff6dc] outline-3 outline-dashed outline-offset-4 outline-mustard" : "bg-paper"} ${grey ? "opacity-70" : ""}`}
    >
      <div className="flex w-full items-center gap-3">
        <Portrait agent={agent.name} animate={status !== "done" && status !== "cancelled"} grey={grey} />
        <div className="min-w-0 flex-1">
          <h3 className="font-pixel text-base font-bold leading-tight">{ROLE[agent.name]}</h3>
          <p className="truncate font-mono text-[11px] text-ink-soft" title={agent.model ?? undefined}>{shortModel(agent.model)}</p>
          <span className={`pixel-box-sm mt-1 inline-block px-1.5 py-px font-pixel text-[11px] uppercase tracking-wider ${STATUS_STYLE[status]}`}>
            {status}
          </span>
        </div>
      </div>
      <div className="w-full font-pixel text-xs">
        <p className="truncate" title={task ?? undefined}>
          <span className="text-ink-soft">task: </span>
          {task ? task.replace(/^Task: /, "") : <span className="text-ink-soft">none right now</span>}
        </p>
        <p className="truncate" title={now ?? undefined}>
          <span className="text-ink-soft">now: </span>
          {now ?? <span className="text-ink-soft">{agent.active ? "…" : "free"}</span>}
        </p>
      </div>
      <dl className="grid w-full grid-cols-2 gap-x-2 font-pixel text-xs">
        <dt className="text-ink-soft">steps</dt>
        <dd className="text-right tabular-nums">{agent.steps} / {maxSteps}</dd>
        <dt className="text-ink-soft">tokens</dt>
        <dd className="text-right tabular-nums">
          {formatTokens(agent.tokens)} / {formatTokens(maxTokens)}
        </dd>
      </dl>
      <div
        className="flex h-3 w-full gap-[2px] bg-ink p-[2px]"
        role="meter"
        aria-label={`${ROLE[agent.name]} tokens this run`}
        aria-valuemin={0}
        aria-valuemax={maxTokens}
        aria-valuenow={agent.tokens}
      >
        {Array.from({ length: segments }, (_, i) => (
          <span key={i} className={`flex-1 ${i < filled ? (share > 0.8 ? "bg-terracotta" : "bg-mustard") : "bg-cream-dark"}`} />
        ))}
      </div>
      {agent.runs > 1 && (
        <p className="font-pixel text-[11px] text-ink-soft">
          {agent.runs} runs · {formatTokens(agent.totalTokens)} total
        </p>
      )}
      {showAttempts(agent.attempts) && <AttemptList attempts={agent.attempts} />}
    </button>
  );
}
