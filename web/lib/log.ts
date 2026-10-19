// The activity log: every event as one readable line, with who did it and
// when. Clicking a line seeks the replay to just after that event.

import { formatDuration, shortModel } from "./api";
import { argsOf, clip, toolName } from "./office/labels";
import type { AgentName, RunEvent } from "./types";

export type LogTone = "info" | "tool" | "wait" | "phase" | "good" | "bad";

export interface LogEntry {
  // position in the event list; seeking to index + 1 shows the scene right after it
  index: number;
  seq: number;
  agent: AgentName;
  // seconds since the first event
  at: number;
  text: string;
  tone: LogTone;
}

export type LogFilter = "all" | AgentName;

const secs = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? (n < 10 ? `${n.toFixed(1).replace(/\.0$/, "")}s` : formatDuration(n)) : "?";
};

/** One plain-language line for an event. */
export function describeEvent(event: RunEvent): { text: string; tone: LogTone } {
  const p = event.payload ?? {};
  switch (event.type) {
    case "run_started":
      return { text: `Run started: “${clip(String(p.issue ?? "").split("\n")[0], 70)}”`, tone: "phase" };
    case "phase_started": {
      const extra = p.round != null ? ` (round ${p.round})` : p.attempt != null ? ` ${p.attempt}${p.reason ? `, after ${p.reason}` : ""}` : p.parallel === false ? " (one at a time)" : "";
      return { text: `Phase: ${p.phase}${extra}`, tone: "phase" };
    }
    case "phase_finished":
      return { text: `${p.phase} finished in ${secs(p.duration_s)}`, tone: "phase" };
    case "agent_started":
      return { text: `${p.label ?? event.agent} started (${shortModel(p.model)})`, tone: "info" };
    case "llm_call":
      return { text: `Model replied, step ${p.step ?? "?"} (${Number(p.tokens_used ?? 0).toLocaleString("en-US")} tokens so far)`, tone: "info" };
    case "tool_called": {
      const args = argsOf(p.arguments);
      const name = toolName(p.tool);
      const target = typeof args.path === "string" && args.path ? ` ${args.path}` : typeof args.pattern === "string" ? ` “${clip(args.pattern, 30)}”` : "";
      return { text: `${name.replace(/_/g, " ")}${target}`, tone: "tool" };
    }
    case "tool_result":
      return { text: `→ ${clip(String(p.summary ?? "done"), 90)}`, tone: p.is_error ? "bad" : "info" };
    case "rate_limited":
      return { text: `Rate limited${p.shared ? " (shared cooldown)" : ""}: waiting ${secs(p.delay_s)}`, tone: "wait" };
    case "throttled":
      return { text: `Throttling to stay under the token limit: waiting ${secs(p.delay_s)}`, tone: "wait" };
    case "note":
      return { text: clip(String(p.text ?? p.kind ?? "note"), 100), tone: p.is_error ? "bad" : "info" };
    case "agent_finished": {
      const ok = p.success === true;
      const how = p.stop_reason === "cancelled" ? "cancelled" : ok ? "finished" : `failed (${p.stop_reason ?? "error"})`;
      return { text: `${p.label ?? event.agent} ${how}: ${p.steps ?? "?"} steps, ${Number(p.tokens ?? 0).toLocaleString("en-US")} tokens, ${secs(p.duration_s)}`, tone: ok ? "good" : p.stop_reason === "cancelled" ? "info" : "bad" };
    }
    case "tests_run":
      return { text: `Tests: ${clip(String(p.summary ?? ""), 80)}`, tone: p.passed ? "good" : "bad" };
    case "merge":
      return { text: `Merged ${String(p.branch ?? "").split("/").pop()} (${Array.isArray(p.files) ? p.files.length : 0} files)${p.ok === false ? " with conflicts" : ""}`, tone: p.ok === false ? "bad" : "info" };
    case "retry_started":
      return { text: `Retry ${p.attempt ?? "?"} of ${p.max_retries ?? "?"} (${p.reason ?? "?"}): ${clip(String(p.feedback ?? ""), 70)}`, tone: "wait" };
    case "review_verdict": {
      const issues = Array.isArray(p.issues) ? p.issues.length : 0;
      return { text: `Review round ${p.round ?? "?"}: ${p.approved ? "approved" : "changes requested"}${issues ? `, ${issues} note${issues === 1 ? "" : "s"}` : ""}`, tone: p.approved ? "good" : "bad" };
    }
    case "run_finished": {
      const r = p.result ?? {};
      return { text: r.success ? "Run finished: success" : `Run finished: failed${r.error ? ` (${clip(String(r.error), 60)})` : ""}`, tone: r.success ? "good" : "bad" };
    }
    default:
      return { text: event.type, tone: "info" };
  }
}

export function logEntries(events: RunEvent[]): LogEntry[] {
  const start = events.length ? Date.parse(events[0].timestamp) : 0;
  return events.map((event, index) => ({
    index,
    seq: event.seq,
    agent: event.agent,
    at: Math.max(0, (Date.parse(event.timestamp) - start) / 1000) || 0,
    ...describeEvent(event),
  }));
}

export function filterLog(entries: LogEntry[], filter: LogFilter): LogEntry[] {
  return filter === "all" ? entries : entries.filter((entry) => entry.agent === filter);
}

/** The replay position that shows the scene right after an entry's event. */
export const seekTargetFor = (entry: LogEntry) => entry.index + 1;

export function clockLabel(seconds: number): string {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
