// Numbers for the stats tab and the phase timeline, computed from the events.

import { type Attempt, finishAttempt, isCrew, startAttempt, switchAttempt } from "./office/reducer";
import type { CrewAgent, RunEvent } from "./types";

export interface AgentStats {
  agent: CrewAgent;
  runs: number;
  steps: number;
  tokens: number;
  // wall-clock seconds the agent was running, and how much of it was spent
  // waiting on rate limits (rate_limited + throttled delays)
  seconds: number;
  waiting: number;
  working: number;
  // each run of the agent with the models it used
  attempts: Attempt[];
}

const num = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const ts = (event: RunEvent) => Date.parse(event.timestamp) / 1000;

export function agentStats(events: RunEvent[]): AgentStats[] {
  const stats = new Map<CrewAgent, AgentStats & { open: number | null; liveTokens: number; liveSteps: number }>();
  const get = (agent: CrewAgent) => {
    let s = stats.get(agent);
    if (!s) {
      s = { agent, runs: 0, steps: 0, tokens: 0, seconds: 0, waiting: 0, working: 0, attempts: [], open: null, liveTokens: 0, liveSteps: 0 };
      stats.set(agent, s);
    }
    return s;
  };
  for (const event of events) {
    if (!isCrew(event.agent)) continue;
    const s = get(event.agent);
    const p = event.payload ?? {};
    switch (event.type) {
      case "agent_started":
        s.runs++;
        s.open = ts(event);
        s.liveTokens = 0;
        s.liveSteps = 0;
        s.attempts = startAttempt(s.attempts, event.agent, p);
        break;
      case "note":
        if (p.kind === "model_switch") s.attempts = switchAttempt(s.attempts, p.to_model);
        break;
      case "llm_call":
        s.liveTokens = Math.max(s.liveTokens, num(p.tokens_used));
        s.liveSteps = Math.max(s.liveSteps, num(p.step));
        break;
      case "rate_limited":
      case "throttled":
        s.waiting += num(p.delay_s);
        break;
      case "agent_finished":
        s.steps += num(p.steps);
        s.tokens += num(p.tokens);
        s.seconds += p.duration_s != null ? num(p.duration_s) : s.open != null ? ts(event) - s.open : 0;
        s.open = null;
        s.attempts = finishAttempt(s.attempts, p);
        break;
    }
  }
  // A run still going at the end of the log counts up to the last event.
  const last = events.length ? ts(events[events.length - 1]) : 0;
  const order: CrewAgent[] = ["lead", "tester", "coder", "reviewer"];
  return order
    .filter((agent) => stats.has(agent))
    .map((agent) => {
      const s = stats.get(agent)!;
      const seconds = s.seconds + (s.open != null ? Math.max(0, last - s.open) : 0);
      const tokens = s.tokens + (s.open != null ? s.liveTokens : 0);
      const steps = s.steps + (s.open != null ? s.liveSteps : 0);
      const waiting = Math.min(s.waiting, seconds);
      return { agent, runs: s.runs, steps, tokens, seconds, waiting, working: Math.max(0, seconds - waiting), attempts: s.attempts };
    });
}

export const PHASE_ORDER = ["plan", "implement", "integrate", "verify", "review", "retry"] as const;

// Categorical slots in fixed phase order (validated for colour-blind separation).
export const PHASE_COLORS: Record<string, string> = {
  setup: "var(--color-track)",
  plan: "#2a78d6",
  implement: "#eb6834",
  integrate: "#1baf7a",
  verify: "#eda100",
  review: "#e87ba4",
  retry: "#008300",
};
export const WORK_COLORS = { working: "#2a78d6", waiting: "#eb6834" };

/** Total seconds per phase (repeated phases, like review rounds, are summed). */
export function phaseDurations(events: RunEvent[], result: Record<string, any> | null): { phase: string; seconds: number }[] {
  const totals = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "phase_finished") continue;
    const phase = String(event.payload?.phase ?? "");
    totals.set(phase, (totals.get(phase) ?? 0) + num(event.payload?.duration_s));
  }
  if (totals.size === 0 && result?.phases && typeof result.phases === "object") {
    for (const [phase, seconds] of Object.entries(result.phases)) totals.set(phase, num(seconds));
  }
  const known = PHASE_ORDER.filter((p) => totals.has(p)).map((phase) => ({ phase, seconds: totals.get(phase)! }));
  const other = [...totals.keys()].filter((p) => !(PHASE_ORDER as readonly string[]).includes(p)).map((phase) => ({ phase, seconds: totals.get(phase)! }));
  return [...known, ...other];
}

export interface PhaseSegment {
  phase: string;
  label: string;
  // event indexes: [start, end)
  start: number;
  end: number;
}

/** The run cut into phases by event index, for the timeline under the scrubber. */
export function phaseSegments(events: RunEvent[]): PhaseSegment[] {
  const segments: PhaseSegment[] = [];
  events.forEach((event, index) => {
    if (event.type !== "phase_started") return;
    const p = event.payload ?? {};
    const phase = String(p.phase ?? "");
    const label = p.round != null ? `${phase} ${p.round}` : p.attempt != null ? `${phase} ${p.attempt}` : phase;
    if (segments.length) segments[segments.length - 1].end = index;
    else if (index > 0) segments.push({ phase: "setup", label: "setup", start: 0, end: index });
    segments.push({ phase, label, start: index, end: events.length });
  });
  return segments;
}
