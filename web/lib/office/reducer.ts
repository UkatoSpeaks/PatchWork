// officeReducer(state, event) turns a run's event log into scene state. It is
// pure, so a replay, a seek (reduce over events[0..n]) and later a live run all
// share it. Movement is not modelled here: agents have a `place`, and the
// canvas walks them there tile by tile. Speech is chosen here too (seeded by
// run id + event seq, see phrases.ts); how long a bubble stays up is the
// overlay's business (bubbles.ts).
//
// Where agents are: an ACTIVE agent (from its agent_started to its
// agent_finished) sits at its own work spot for the whole task, even while it
// waits for the provider; its status tag (status.ts) says what it is doing.
// Speech bubbles are only for moments: a result, a handoff, a model switch,
// finishing. IDLE agents are free for office life (idle.ts).

import type { CrewAgent, RunEvent } from "../types";
import { toolName } from "./labels";
import * as say from "./phrases";
import { actionPhrase, taskLine, THINKING, type PlannedTask, type Wait } from "./status";

export const CREW: CrewAgent[] = ["lead", "tester", "coder", "reviewer"];

export type Place = "lounge" | "desk" | "whiteboard" | "coffee" | "merge" | "coderDesk" | "celebrate";
export type Activity = "idle" | "thinking" | "typing" | "testing" | "waiting" | "done" | "failed" | "cancelled";

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
}

/** One run of an agent (e.g. the coder's first attempt, or retry 2) and the models it used. */
export interface Attempt {
  // "attempt 1", "retry 1", "round 2", ...
  label: string;
  // In order; more than one after a model switch.
  models: string[];
  outcome: "running" | "passed" | "failed" | "cancelled";
}

export interface AgentState {
  name: CrewAgent;
  inRun: boolean;
  model: string | null;
  label: string | null;
  place: Place;
  // Has a task in the current phase: between its agent_started and agent_finished.
  active: boolean;
  // Status tag line 1 (the task, "Task: add slugify()") and line 2 (the current
  // action, "Reading core.py"); a provider wait replaces line 2 while it lasts.
  task: string | null;
  action: string | null;
  wait: Wait | null;
  // A there-and-back errand (e.g. the reviewer visiting the coder); a new key means a new trip.
  // `at`: the scene's event count when it was set (a deep link landing just after still plays it).
  trip: { to: Place; key: number; say?: string; at?: number } | null;
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
  attempts: Attempt[];
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
  // Lines of the submitted plan on the whiteboard (0 until the lead submits it).
  whiteboardLines: number;
  subtasks: PlannedTask[];
  // The latest retry_started: its reason and the feedback the coder got.
  retry: { reason: string; feedback: string } | null;
  events: number;
  tripCounter: number;
}

function initialAgent(name: CrewAgent): AgentState {
  return {
    name, inRun: true, model: null, label: null, place: "lounge", active: false, task: null, action: null, wait: null,
    trip: null, activity: "idle", bubble: null, said: null,
    verdict: null, steps: 0, tokens: 0, totalTokens: 0, runs: 0, attempts: [],
  };
}

export function initialScene(): SceneState {
  return {
    runId: null, issue: "", mode: "crew", sequential: false, maxSteps: 25, maxTokens: 60_000, maxRetries: 3,
    phase: null, phaseLabel: "waiting", startedAt: null, lastAt: null, totalTokens: 0,
    agents: Object.fromEntries(CREW.map((name) => [name, initialAgent(name)])) as Record<CrewAgent, AgentState>,
    monitor: { status: "idle", passed: null, failed: null, summary: "" },
    merges: [], reviewRound: 0, retries: 0, outcome: null, failedAgent: null, whiteboardLines: 0, subtasks: [], retry: null,
    events: 0, tripCounter: 0,
  };
}

export const isCrew = (agent: unknown): agent is CrewAgent => (CREW as unknown[]).includes(agent);
const num = (value: unknown, fallback = 0): number => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
};
export const FINISHED: Activity[] = ["done", "failed", "cancelled"];

/** Where an agent works while active: its own desk (the lead's is in its cabin). */
export const WORK_PLACE: Place = "desk";

export const parseTestCounts = say.testCounts;

function phaseLabel(phase: string, payload: Record<string, any>): string {
  if (phase === "review" && payload.round != null) return `review r${payload.round}`;
  if (phase === "retry" && payload.attempt != null) return `retry ${payload.attempt}${payload.reason ? ` (${payload.reason})` : ""}`;
  if (phase === "implement" && payload.parallel != null) return payload.parallel ? "implement" : "implement (seq)";
  return phase;
}

function attemptLabel(agent: string, payload: Record<string, any>, run: number): string {
  const label = String(payload.label ?? "");
  const retry = num(payload.retry) || Number(label.match(/retry (\d+)/)?.[1] ?? 0);
  if (retry > 0) return `retry ${retry}`;
  const round = Number(label.match(/round (\d+)/)?.[1] ?? 0);
  if (round > 0) return `round ${round}`;
  if (run > 1) return `run ${run}`;
  return agent === "reviewer" ? "round 1" : "attempt 1";
}

// Attempt bookkeeping shared with the stats tab (lib/stats.ts). Each returns a new list.

/** agent_started: a new attempt on its starting model. */
export function startAttempt(attempts: Attempt[], agent: string, payload: Record<string, any>): Attempt[] {
  const models = payload.model ? [String(payload.model)] : [];
  return [...attempts, { label: attemptLabel(agent, payload, attempts.length + 1), models, outcome: "running" }];
}

/** A model_switch note: the current attempt moved on to `to`. */
export function switchAttempt(attempts: Attempt[], to: unknown): Attempt[] {
  const last = attempts[attempts.length - 1];
  if (!last || !to || last.models[last.models.length - 1] === to) return attempts;
  return [...attempts.slice(0, -1), { ...last, models: [...last.models, String(to)] }];
}

/** agent_finished: the outcome, and every model it used (models_used) when given. */
export function finishAttempt(attempts: Attempt[], payload: Record<string, any>): Attempt[] {
  const last = attempts[attempts.length - 1];
  if (!last) return attempts;
  const outcome: Attempt["outcome"] = payload.stop_reason === "cancelled" ? "cancelled" : payload.success === true ? "passed" : "failed";
  const used = Array.isArray(payload.models_used) && payload.models_used.length ? payload.models_used.map(String) : last.models;
  return [...attempts.slice(0, -1), { ...last, models: used, outcome }];
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
  const active = (name: CrewAgent) => agents[name].active;
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
      const opening = p.escalated === true ? say.escalatedRetryPhrase(seed) : say.startPhrase(actor, label, next.phase, seed);
      const task = taskLine(actor, label, num(p.retry), next.reviewRound, {
        mode: next.mode, issue: next.issue, subtasks: next.subtasks, retry: next.retry,
      });
      update(actor, {
        inRun: true,
        model: p.model ?? agents[actor].model,
        label,
        place: WORK_PLACE,
        active: true,
        task,
        action: THINKING,
        wait: null,
        trip: null,
        activity: "thinking",
        bubble: speech(opening, { ttl: 2.5 }),
        attempts: startAttempt(agents[actor].attempts, actor, p),
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
      update(actor, {
        steps: Math.max(a.steps, num(p.step)),
        tokens,
        totalTokens: a.totalTokens + added,
        activity: active(actor) ? "thinking" : a.activity,
        // The model replied, so any wait is over.
        wait: null,
      });
      next.totalTokens = state.totalTokens + added;
      break;
    }
    case "tool_called": {
      if (!actor) break;
      const tool = toolName(p.tool);
      update(actor, {
        steps: Math.max(agents[actor].steps, num(p.step)),
        activity: tool === "run_tests" ? "testing" : "typing",
        action: actionPhrase(tool, p.arguments),
        wait: null,
      });
      break;
    }
    case "tool_result": {
      if (!actor) break;
      const a = agents[actor];
      // Back to waiting for the model. Only news gets a bubble: a test result,
      // or dead code left behind.
      let bubble = a.bubble;
      const summary = String(p.summary ?? "");
      if (toolName(p.tool) === "run_tests") {
        bubble = speech(say.testResultPhrase(actor, summary, /^PASSED/i.test(summary.trim()), seed), { ttl: 3 });
      } else if (/WARNING: unreachable code/.test(summary)) {
        bubble = speech(say.deadCodePhrase(seed), { ttl: 3 });
      }
      update(actor, { activity: active(actor) ? "thinking" : a.activity, action: active(actor) ? THINKING : null, bubble });
      break;
    }
    case "rate_limited":
    case "throttled": {
      const delay = num(p.delay_s);
      if (!actor || !active(actor) || delay <= 0) break;
      // Stays at its desk with a mug; the status tag counts the wait down.
      update(actor, { activity: "waiting", wait: { seconds: delay, model: p.model ?? agents[actor].model, seq: event.seq } });
      break;
    }
    case "note": {
      if (p.kind === "coder_failed" && agents.coder.inRun) {
        // The implement-phase coder failed; the run goes on to a retry.
        update("coder", { bubble: speech(say.helpPhrase(seed), { ttl: 4 }) });
        break;
      }
      if (actor && p.kind === "model_switch") {
        const to = p.to_model ?? null;
        update(actor, {
          model: to ?? agents[actor].model,
          attempts: switchAttempt(agents[actor].attempts, to),
          bubble: speech(say.modelSwitchPhrase(to, seed), { ttl: 3 }),
        });
        break;
      }
      if (!actor || !active(actor)) break;
      if (p.kind === "stuck") update(actor, { action: "Going in circles…", wait: null });
      else if (p.kind === "finish" && toolName(p.tool ?? "finish") !== "auto-finish") update(actor, { action: actionPhrase("finish", null), wait: null });
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
      else if (p.stop_reason === "stuck") bubble = speech(say.stuckPhrase(seed), { ttl: 4 });
      else bubble = speech(say.finishPhrase(activity, seed), activity === "failed" ? {} : { ttl: 3 });
      if (actor === "lead" && subtasks) {
        // The plan goes up on the meeting-room whiteboard; the lead stays in its cabin.
        next.subtasks = subtasks.map((s: Record<string, unknown>) => ({ role: String(s.role ?? ""), description: String(s.description ?? "") }));
        next.whiteboardLines = Math.min(8, 1 + subtasks.length * 2);
      }
      update(actor, {
        place: WORK_PLACE,
        active: false,
        task: null,
        action: null,
        wait: null,
        activity,
        bubble,
        attempts: finishAttempt(a.attempts, p),
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
        if (!agents[name].inRun || agents[name].active) continue;
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
      next.retry = { reason: String(p.reason ?? ""), feedback: String(p.feedback ?? "") };
      next.tripCounter = state.tripCounter + 1;
      // After a rejection, the idle reviewer walks over to hand over its notes; it never leaves a task to do so.
      if (p.reason === "review" && agents.reviewer.inRun && !agents.reviewer.active) update("reviewer", { trip: { to: "coderDesk", key: next.tripCounter, say: say.retryAskPhrase(seed), at: next.events } });
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
