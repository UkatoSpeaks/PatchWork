// officeReducer(state, event) turns a run's event log into scene state. It is
// pure, so a replay, a seek (reduce over events[0..n]) and later a live run all
// share it. Movement is not modelled here: agents have a `place`, and the
// canvas walks them there tile by tile. Speech is chosen here too (seeded by
// run id + event seq, see phrases.ts); how long a bubble stays up is the
// overlay's business (bubbles.ts).

import type { CrewAgent, RunEvent } from "../types";
import { toolName } from "./labels";
import * as say from "./phrases";

export const CREW: CrewAgent[] = ["lead", "tester", "coder", "reviewer"];

export type Place = "lounge" | "desk" | "whiteboard" | "coffee" | "merge" | "coderDesk" | "celebrate";
export type Activity = "idle" | "thinking" | "typing" | "testing" | "waiting" | "done" | "failed" | "cancelled";

// Rate-limit waits shorter than this don't send the agent to the coffee machine.
export const COFFEE_MIN_WAIT_S = 2;

export interface Bubble {
  text: string;
  // A speech bubble for actions, a thought cloud while waiting.
  style: "speech" | "thought";
  // The event that set it: identifies the bubble and seeds its wording.
  seq: number;
  // Seconds (at 1x) it stays up while still current; omitted: until replaced.
  ttl?: number;
  // When it was said (ms since the epoch, the event's timestamp).
  at?: number;
  // A coffee break of this many seconds: the bubble counts it down.
  wait?: number;
}

export interface AgentState {
  name: CrewAgent;
  inRun: boolean;
  model: string | null;
  label: string | null;
  place: Place;
  // A there-and-back errand (e.g. the reviewer visiting the coder); a new key means a new trip.
  trip: { to: Place; key: number; say?: string } | null;
  activity: Activity;
  bubble: Bubble | null;
  // The last speech bubble, kept after `bubble` clears, so a line set and
  // cleared between two frames (fast replays) still gets shown.
  said: Bubble | null;
  // The reviewer's last verdict.
  verdict: "approved" | "rejected" | null;
  steps: number;
  // Tokens of the current agent run (the budget is per run) and over all its runs.
  tokens: number;
  totalTokens: number;
  runs: number;
}

export interface MonitorState {
  status: "idle" | "pass" | "fail";
  passed: number | null;
  failed: number | null;
  summary: string;
}

export interface SceneState {
  runId: string | null;
  issue: string;
  mode: "crew" | "solo";
  sequential: boolean;
  maxSteps: number;
  maxTokens: number;
  maxRetries: number;
  phase: string | null;
  phaseLabel: string;
  startedAt: string | null;
  lastAt: string | null;
  totalTokens: number;
  agents: Record<CrewAgent, AgentState>;
  monitor: MonitorState;
  merges: { branch: string; ok: boolean }[];
  reviewRound: number;
  retries: number;
  outcome: "success" | "failure" | null;
  failedAgent: CrewAgent | null;
  // Plan-phase lead steps, drawn as lines on the whiteboard.
  whiteboardLines: number;
  events: number;
  tripCounter: number;
}

function initialAgent(name: CrewAgent): AgentState {
  return {
    name, inRun: true, model: null, label: null, place: "lounge", trip: null, activity: "idle", bubble: null, said: null,
    verdict: null, steps: 0, tokens: 0, totalTokens: 0, runs: 0,
  };
}

export function initialScene(): SceneState {
  return {
    runId: null, issue: "", mode: "crew", sequential: false, maxSteps: 25, maxTokens: 60_000, maxRetries: 3,
    phase: null, phaseLabel: "waiting", startedAt: null, lastAt: null, totalTokens: 0,
    agents: Object.fromEntries(CREW.map((name) => [name, initialAgent(name)])) as Record<CrewAgent, AgentState>,
    monitor: { status: "idle", passed: null, failed: null, summary: "" },
    merges: [], reviewRound: 0, retries: 0, outcome: null, failedAgent: null, whiteboardLines: 0, events: 0, tripCounter: 0,
  };
}

export const isCrew = (agent: unknown): agent is CrewAgent => (CREW as unknown[]).includes(agent);
const num = (value: unknown, fallback = 0): number => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
};
export const FINISHED: Activity[] = ["done", "failed", "cancelled"];

/** Where an agent works while active: the lead plans at the whiteboard. */
function workPlace(state: SceneState, agent: CrewAgent): Place {
  return agent === "lead" && state.phase === "plan" ? "whiteboard" : "desk";
}

export const parseTestCounts = say.testCounts;

function phaseLabel(phase: string, payload: Record<string, any>): string {
  if (phase === "review" && payload.round != null) return `review r${payload.round}`;
  if (phase === "retry" && payload.attempt != null) return `retry ${payload.attempt}${payload.reason ? ` (${payload.reason})` : ""}`;
  if (phase === "implement" && payload.parallel != null) return payload.parallel ? "implement" : "implement (seq)";
  return phase;
}

export function officeReducer(state: SceneState, event: RunEvent): SceneState {
  const p = event.payload ?? {};
  const next: SceneState = {
    ...state,
    events: state.events + 1,
    lastAt: event.timestamp ?? state.lastAt,
    startedAt: state.startedAt ?? event.timestamp ?? null,
  };
  const agents = { ...state.agents };
  next.agents = agents;
  const update = (name: CrewAgent, patch: Partial<AgentState>) => {
    agents[name] = { ...agents[name], ...patch };
  };
  const actor = isCrew(event.agent) ? event.agent : null;
  // An agent that does something while at the coffee machine has stopped waiting.
  const backToWork = (name: CrewAgent): Partial<AgentState> =>
    agents[name].place === "coffee" ? { place: workPlace(next, name) } : {};
  const active = (name: CrewAgent) => !FINISHED.includes(agents[name].activity);
  const seed = say.seedOf(state.runId ?? event.run_id, event.seq, event.agent);
  const said = Date.parse(event.timestamp);
  const speech = (text: string, extra: Partial<Bubble> = {}): Bubble => ({
    text, style: "speech", seq: event.seq, ...(Number.isFinite(said) ? { at: said } : {}), ...extra,
  });

  switch (event.type) {
    case "run_started": {
      const models: Record<string, string> = p.models ?? {};
      next.runId = event.run_id;
      next.issue = String(p.issue ?? "");
      next.mode = p.mode === "solo" ? "solo" : "crew";
      next.sequential = Boolean(p.sequential);
      next.maxSteps = num(p.max_steps, state.maxSteps);
      next.maxTokens = num(p.max_tokens, state.maxTokens);
      next.maxRetries = num(p.max_retries, state.maxRetries);
      next.phaseLabel = "starting";
      for (const name of CREW) {
        const inRun = Object.keys(models).length === 0 || name in models;
        update(name, { inRun, model: models[name] ?? null });
      }
      break;
    }
    case "phase_started": {
      next.phase = String(p.phase);
      next.phaseLabel = phaseLabel(next.phase, p);
      if (next.phase === "review" && p.round != null) next.reviewRound = num(p.round);
      break;
    }
    case "phase_finished": {
      if (p.phase === "integrate") {
        for (const name of ["tester", "coder"] as const) if (agents[name].place === "merge") update(name, { place: "desk" });
      }
      break;
    }
    case "agent_started": {
      if (!actor) break;
      const label = String(p.label ?? actor);
      update(actor, {
        inRun: true,
        model: p.model ?? agents[actor].model,
        label,
        place: workPlace(next, actor),
        activity: "thinking",
        bubble: speech(say.startPhrase(actor, label, next.phase, seed), { ttl: 2 }),
        verdict: actor === "reviewer" ? null : agents[actor].verdict,
        steps: 0,
        tokens: 0,
        runs: agents[actor].runs + 1,
      });
      break;
    }
    case "llm_call": {
      if (!actor) break;
      const a = agents[actor];
      // tokens_used is the agent run's running total (usage.total_tokens).
      const tokens = Math.max(a.tokens, num(p.tokens_used));
      const added = tokens - a.tokens;
      const waiting = a.activity === "waiting";
      update(actor, {
        ...backToWork(actor),
        steps: Math.max(a.steps, num(p.step)),
        tokens,
        totalTokens: a.totalTokens + added,
        activity: active(actor) ? "thinking" : a.activity,
        bubble: waiting ? null : a.bubble,
      });
      next.totalTokens = state.totalTokens + added;
      if (actor === "lead" && next.phase === "plan") next.whiteboardLines = state.whiteboardLines + 1;
      break;
    }
    case "tool_called": {
      if (!actor) break;
      const tool = toolName(p.tool);
      update(actor, {
        ...backToWork(actor),
        steps: Math.max(agents[actor].steps, num(p.step)),
        activity: tool === "run_tests" ? "testing" : "typing",
        bubble: speech(say.toolPhrase(tool, p.arguments, seed)),
      });
      break;
    }
    case "tool_result": {
      if (!actor) break;
      const a = agents[actor];
      // Back to waiting for the model (a thought cloud), unless there's news.
      let bubble: Bubble | null = null;
      if (toolName(p.tool) === "run_tests") {
        const summary = String(p.summary ?? "");
        bubble = speech(say.testResultPhrase(actor, summary, /^PASSED/i.test(summary.trim()), seed), { ttl: 3 });
      } else if (p.is_error === true) {
        bubble = speech(say.toolErrorPhrase(seed), { ttl: 2.5 });
      }
      update(actor, { activity: active(actor) ? "thinking" : a.activity, bubble });
      break;
    }
    case "rate_limited":
    case "throttled": {
      const delay = num(p.delay_s);
      if (!actor || !active(actor) || delay <= 0) break;
      const coffee = delay >= COFFEE_MIN_WAIT_S;
      update(actor, {
        activity: "waiting",
        bubble: coffee
          ? speech(say.coffeePhrase(event.type, p.model ?? agents[actor].model, seed), { wait: delay })
          : { text: say.shortWaitPhrase(seed), style: "thought", seq: event.seq },
        place: coffee ? "coffee" : agents[actor].place,
      });
      break;
    }
    case "note": {
      if (!actor || p.kind !== "finish") break;
      const tool = toolName(p.tool ?? "finish");
      if (tool === "auto-finish") break;
      update(actor, { ...backToWork(actor), bubble: speech(say.toolPhrase(tool, null, seed)) });
      break;
    }
    case "agent_finished": {
      if (!actor) break;
      const a = agents[actor];
      const tokens = num(p.tokens, a.tokens);
      const activity: Activity = p.stop_reason === "cancelled" ? "cancelled" : p.success === true ? "done" : "failed";
      const subtasks = p.output && Array.isArray(p.output.subtasks) ? p.output.subtasks : null;
      let bubble: Bubble;
      if (activity === "done" && actor === "lead" && state.phase === "plan" && subtasks) bubble = speech(say.planPhrase(subtasks, seed), { ttl: 3 });
      else if (activity === "done" && actor === "reviewer" && a.verdict && a.bubble) bubble = a.bubble; // keep the verdict up
      else bubble = speech(say.finishPhrase(activity, seed), activity === "failed" ? {} : { ttl: 3 });
      update(actor, {
        place: "desk",
        activity,
        bubble,
        steps: num(p.steps, a.steps),
        tokens,
        totalTokens: a.totalTokens + (tokens - a.tokens),
      });
      next.totalTokens = state.totalTokens + (tokens - a.tokens);
      break;
    }
    case "tests_run": {
      const summary = String(p.summary ?? "");
      next.monitor = { status: p.passed === true ? "pass" : "fail", ...parseTestCounts(summary), summary };
      break;
    }
    case "merge": {
      const ok = p.ok !== false;
      next.merges = [...state.merges, { branch: String(p.branch ?? ""), ok }];
      const owner = String(p.branch ?? "").split("/").pop();
      for (const name of ["tester", "coder"] as const) {
        if (!agents[name].inRun) continue;
        update(name, { place: "merge", ...(owner === name ? { bubble: speech(say.mergePhrase(name, ok, seed), { ttl: 2.5 }) } : {}) });
      }
      break;
    }
    case "review_verdict": {
      const issues = Array.isArray(p.issues) ? p.issues.length : 0;
      update("reviewer", {
        verdict: p.approved === true ? "approved" : "rejected",
        bubble: speech(say.verdictPhrase(p.approved === true, issues, seed), { ttl: 4 }),
      });
      if (p.round != null) next.reviewRound = num(p.round);
      break;
    }
    case "retry_started": {
      next.retries = num(p.attempt, state.retries + 1);
      next.tripCounter = state.tripCounter + 1;
      if (agents.reviewer.inRun) update("reviewer", { trip: { to: "coderDesk", key: next.tripCounter, say: say.retryAskPhrase(seed) } });
      break;
    }
    case "run_finished": {
      const result = p.result ?? {};
      next.outcome = result.success === true ? "success" : "failure";
      next.failedAgent = isCrew(result.failed_agent) ? result.failed_agent : null;
      if (typeof result.total_tokens === "number") next.totalTokens = result.total_tokens;
      next.phaseLabel = next.outcome === "success" ? "done" : "failed";
      next.phase = "finished";
      if (next.outcome === "success") {
        // Everyone gathers at the merge table to celebrate.
        for (const name of CREW) if (agents[name].inRun) update(name, { place: "celebrate", bubble: null });
        if (agents.lead.inRun) update("lead", { bubble: speech(say.celebratePhrase(seed), { ttl: 5 }) });
      }
      break;
    }
  }
  for (const name of CREW) {
    const bubble = agents[name].bubble;
    if (bubble && bubble !== state.agents[name].bubble && bubble.style === "speech") update(name, { said: bubble });
  }
  return next;
}

export function reduceEvents(events: RunEvent[], count = events.length): SceneState {
  let state = initialScene();
  for (let i = 0; i < Math.min(count, events.length); i++) state = officeReducer(state, events[i]);
  return state;
}

/** Seconds from the first event to the latest one applied. */
export function elapsedSeconds(state: SceneState): number {
  if (!state.startedAt || !state.lastAt) return 0;
  return Math.max(0, (Date.parse(state.lastAt) - Date.parse(state.startedAt)) / 1000);
}
