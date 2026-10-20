// The status tag above an ACTIVE agent (one between its agent_started and
// agent_finished): line 1 is the task it is working on, line 2 what it is
// doing right now. Both come from events only (see officeReducer), so a
// replay, a seek and a deep link show the same words. The agent cards show the
// same two lines.

import type { CrewAgent } from "../types";
import { countdown, MIN_HOLD_S } from "./bubbles";
import { argsOf, basename, clip, toolName } from "./labels";
import { providerName } from "./phrases";

export const MAX_TAG_CHARS = 32;
export const THINKING = "Thinking…";

const fit = (text: string) => clip(text, MAX_TAG_CHARS);
const file = (path: string) => clip(basename(path), 20);

export interface PlannedTask {
  role: string;
  description: string;
}

export interface TaskContext {
  mode: "crew" | "solo";
  issue: string;
  // The lead's plan, once submitted.
  subtasks: PlannedTask[];
  // The latest retry_started: why the coder is retrying, and the feedback it got.
  retry: { reason: string; feedback: string } | null;
}

const NOT_NAMES = new Set(["a", "an", "the", "new", "function", "tests", "test", "code", "it", "support", "for", "in", "to"]);

/** The function a piece of plan text is about: `slugify(`, a `backticked` name, "tests for X", "implement X". */
export function subjectOf(text: string): string | null {
  const patterns = [
    /\b([A-Za-z_]\w*)\s*\(/g,
    /`([A-Za-z_]\w*)/g,
    /\b(?:tests?|cases?)\s+(?:for|of|covering)\s+([A-Za-z_]\w*)/gi,
    /\b(?:implement|add|create|write|fix|define|update)\s+(?:(?:a|an|the|new|function|method|helper)\s+)*([A-Za-z_]\w*)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      if (!NOT_NAMES.has(name.toLowerCase()) && !/^(if|for|while|print|len|str|int|list|dict|isinstance)$/.test(name)) return name;
    }
  }
  return null;
}

/** Line 1 of the status tag: what the agent is working on, in plain words. */
export function taskLine(agent: CrewAgent, label: string, retry: number, round: number, ctx: TaskContext): string {
  switch (agent) {
    case "lead":
      return "Task: plan the fix";
    case "reviewer":
      return round > 1 ? "Task: re-review the fixes" : "Task: review the diff";
    case "tester": {
      const name = ctx.subtasks.filter((s) => s.role === "tester").map((s) => subjectOf(s.description)).find(Boolean);
      return fit(name ? `Task: tests for ${name}()` : "Task: write failing tests");
    }
    case "coder": {
      if (retry > 0 || /retry/i.test(label)) {
        const reason = label.match(/retry \d+: (\w+)/)?.[1] ?? ctx.retry?.reason ?? "";
        return retryTask(reason, ctx.retry?.feedback ?? "");
      }
      const planned = ctx.subtasks.filter((s) => s.role === "coder");
      const text = planned.length ? planned.map((s) => s.description).join("\n") : ctx.issue;
      const name = subjectOf(text);
      const verb = /^\s*(fix|correct|repair|handle)\b/i.test(text) ? "fix" : "add";
      if (name) return fit(`Task: ${verb} ${name}()`);
      if (planned.length) return fit(`Task: ${planned[0].description.charAt(0).toLowerCase()}${planned[0].description.slice(1)}`);
      return "Task: fix the issue";
    }
  }
}

/** A coder retry's task, from the retry reason and the feedback it was given. */
export function retryTask(reason: string, feedback: string): string {
  if (reason === "tests") {
    if (/ImportError|ModuleNotFoundError|cannot import/i.test(feedback)) return "Task: fix failing import";
    if (/SyntaxError|IndentationError/.test(feedback)) return "Task: fix a syntax error";
    return "Task: fix failing tests";
  }
  if (reason === "review") {
    if (/unreachable|dead code/i.test(feedback)) return "Task: remove dead code";
    if (/\bunused\b/i.test(feedback)) return "Task: remove unused code";
    if (/\bexport|__all__|__init__/i.test(feedback)) return "Task: fix the exports";
    return "Task: fix review notes";
  }
  return "Task: fix the problems";
}

const lineSpan = (start: unknown, end: unknown) => {
  const a = Number(start), b = Number(end);
  if (!Number.isFinite(a)) return "lines";
  return !Number.isFinite(b) || b === a ? `line ${a}` : `lines ${a}-${b}`;
};

/** Line 2 while a tool runs: "Reading core.py", "Deleting lines 35-36", ... */
export function actionPhrase(tool: unknown, rawArgs: unknown): string {
  const args = argsOf(rawArgs);
  const path = typeof args.path === "string" ? args.path : "";
  const f = path ? file(path) : "";
  const name = toolName(tool);
  switch (name) {
    case "read_file": {
      const offset = Number(args.offset ?? args.line_start ?? 1);
      return fit(`Reading ${f || "a file"}${offset > 1 ? ` from line ${offset}` : ""}`);
    }
    case "list_dir":
    case "print_tree":
      return fit(path && path !== "." ? `Looking in ${file(path.replace(/\/+$/, ""))}/` : "Looking around the repo");
    case "search_code":
    case "search": {
      const pattern = clip(String(args.pattern ?? args.query ?? "").trim(), 16);
      return fit(pattern ? `Searching for '${pattern}'` : "Searching the code");
    }
    case "edit_file":
      if (args.new === "") return fit(`Deleting code in ${f || "a file"}`);
      return fit(args.near_line != null ? `Editing ${f} near line ${args.near_line}` : `Editing ${f || "the code"}`);
    case "replace_lines": {
      const span = lineSpan(args.start_line, args.end_line);
      return fit(args.text === "" ? `Deleting ${span}` : `Rewriting ${span}`);
    }
    case "insert_lines":
      return fit(`Adding code to ${f || "a file"}`);
    case "write_file":
      return fit(`Writing ${f || "a file"}`);
    case "run_tests":
      return "Running tests…";
    case "submit_plan":
      return "Writing up the plan";
    case "submit_review":
      return "Writing the verdict";
    case "finish":
      return "Wrapping up";
    default:
      return fit(name ? `${name.replace(/_/g, " ")}…` : "Working…");
  }
}

export const waitingText = (model: unknown, seconds: number) =>
  `⏳ waiting for ${providerName(model)} · ${Math.max(0, Math.ceil(seconds))}s`;

/** A rate-limit or throttling wait of an active agent, counted down on the tag. */
export interface Wait {
  seconds: number;
  model: string | null;
  // the event that started it
  seq: number;
}

export interface StatusLines {
  task: string;
  action: string;
}

/**
 * The two lines for an agent, or null when it has no task right now.
 * `waitLeft` is the countdown's remaining seconds for the current wait.
 */
export function statusLines(
  agent: { active: boolean; task: string | null; action: string | null; wait: Wait | null },
  waitLeft: number | null,
): StatusLines | null {
  if (!agent.active) return null;
  let action = agent.action ?? THINKING;
  if (agent.wait) action = waitLeft != null && waitLeft <= 0 ? THINKING : waitingText(agent.wait.model, waitLeft ?? agent.wait.seconds);
  return { task: fit(agent.task ?? "Task: working on it"), action: fit(action) };
}

interface Slot {
  // the wait being counted down, and when (playback seconds) it was first seen
  waitSeq: number | null;
  waitStart: number;
  action: string;
  since: number; // real seconds
}

/**
 * Turns agent state into the tag shown this frame: counts provider waits
 * down, and keeps an action up for at least MIN_HOLD_S (scaled by speed)
 * before "Thinking…" replaces it, so quick tool calls are still readable.
 */
export class StatusDirector {
  private slots = new Map<CrewAgent, Slot>();

  /** Forget everything (after a seek). */
  reset(): void {
    this.slots.clear();
  }

  next(
    agent: CrewAgent,
    state: { active: boolean; task: string | null; action: string | null; wait: Wait | null },
    now: number,
    play: number,
    speed: number,
  ): StatusLines | null {
    if (!state.active) {
      this.slots.delete(agent);
      return null;
    }
    let slot = this.slots.get(agent);
    if (!slot) {
      slot = { waitSeq: null, waitStart: play, action: "", since: -Infinity };
      this.slots.set(agent, slot);
    }
    let left: number | null = null;
    if (state.wait) {
      if (slot.waitSeq !== state.wait.seq) {
        slot.waitSeq = state.wait.seq;
        slot.waitStart = play;
      }
      left = countdown(state.wait.seconds, play - slot.waitStart, speed);
    }
    const lines = statusLines(state, left)!;
    const hold = MIN_HOLD_S / Math.max(1, speed);
    const holding = lines.action === THINKING && slot.action && slot.action !== THINKING && !slot.action.startsWith("⏳") && now - slot.since < hold;
    if (holding) return { ...lines, action: slot.action };
    if (lines.action !== slot.action) {
      slot.action = lines.action;
      slot.since = now;
    }
    return lines;
  }
}
