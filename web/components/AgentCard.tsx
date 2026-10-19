"use client";

import { useEffect, useRef } from "react";

import { formatTokens, shortModel } from "@/lib/api";
import type { AgentState } from "@/lib/office/reducer";
import { drawPortrait } from "@/lib/office/sprites";

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

const ROLE: Record<string, string> = { lead: "Lead", tester: "Tester", coder: "Coder", reviewer: "Reviewer" };

export function agentStatus(agent: AgentState, walking: boolean): Status {
  return walking && agent.activity !== "cancelled" ? "walking" : agent.activity;
}

function Portrait({ agent, animate, grey }: { agent: AgentState["name"]; animate: boolean; grey: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current!.getContext("2d")!;
    let frame = 0;
    drawPortrait(ctx, agent, 0, grey);
    if (!animate) return;
    const timer = setInterval(() => drawPortrait(ctx, agent, ++frame % 2, grey), 600);
    return () => clearInterval(timer);
  }, [agent, animate, grey]);
  return <canvas ref={ref} width={16} height={16} className="pixelated h-14 w-14 shrink-0 bg-cream-dark" aria-hidden />;
}

export default function AgentCard({ agent, walking, maxSteps, maxTokens }: {
  agent: AgentState;
  walking: boolean;
  maxSteps: number;
  maxTokens: number;
}) {
  const status = agentStatus(agent, walking);
  const share = Math.min(1, agent.tokens / Math.max(1, maxTokens));
  const grey = status === "cancelled";
  const segments = 12;
  const filled = Math.round(share * segments);
  return (
    <article className={`pixel-box flex min-w-0 flex-1 basis-[15rem] flex-col gap-2 bg-paper p-3 ${grey ? "opacity-70" : ""}`}>
      <div className="flex items-center gap-3">
        <Portrait agent={agent.name} animate={status === "typing" || status === "thinking" || status === "testing"} grey={grey} />
        <div className="min-w-0 flex-1">
          <h3 className="font-pixel text-base font-bold leading-tight">{ROLE[agent.name]}</h3>
          <p className="truncate font-mono text-[11px] text-ink-soft" title={agent.model ?? undefined}>{shortModel(agent.model)}</p>
          <span className={`pixel-box-sm mt-1 inline-block px-1.5 py-px font-pixel text-[11px] uppercase tracking-wider ${STATUS_STYLE[status]}`}>
            {status}
          </span>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-2 font-pixel text-xs">
        <dt className="text-ink-soft">steps</dt>
        <dd className="text-right tabular-nums">{agent.steps} / {maxSteps}</dd>
        <dt className="text-ink-soft">tokens</dt>
        <dd className="text-right tabular-nums">
          {formatTokens(agent.tokens)} / {formatTokens(maxTokens)}
        </dd>
      </dl>
      <div
        className="flex h-3 gap-[2px] bg-ink p-[2px]"
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
    </article>
  );
}
