// Everything an event carries, laid out for the event drawer: a title, a
// status, and blocks (fields, code, text, lists) chosen per event type.
// Tool calls are paired with their results, so either one shows both.

import { formatDuration, shortModel } from "./api";
import { argsOf, toolName } from "./office/labels";
import type { RunEvent } from "./types";

export type Tone = "neutral" | "good" | "bad" | "wait";

export interface Field {
  label: string;
  value: string;
  mono?: boolean;
  tone?: Tone;
}

export type Block =
  | { kind: "fields"; title?: string; items: Field[] }
  // flavor colours the block: removed text, added text, or test output
  | { kind: "code"; title: string; text: string; flavor?: "del" | "add" | "plain"; startLine?: number }
  | { kind: "text"; title?: string; text: string; tone?: Tone }
  | { kind: "list"; title: string; items: { text: string; badge?: string; tone?: Tone; mono?: string }[] }
  | { kind: "chips"; title: string; items: string[] };

export interface EventDetail {
  title: string;
  status?: { label: string; tone: Tone };
  blocks: Block[];
  // The other half of a tool call / result pair.
  related?: { index: number; label: string };
}

const TOOL_TITLES: Record<string, string> = {
  read_file: "Read a file",
  list_dir: "List a folder",
  search_code: "Search the code",
  write_file: "Write a whole file",
  edit_file: "Edit a file",
  replace_lines: "Replace lines",
  insert_lines: "Insert lines",
  run_tests: "Run the tests",
  submit_plan: "Submit the plan",
  submit_review: "Submit the review",
  finish: "Finish",
};

const NOTE_TITLES: Record<string, string> = {
  finish: "Finished its task",
  stuck: "Stuck",
  model_switch: "Switched models",
  coder_failed: "The coder failed",
  retry_limit: "Retry limit reached",
  retry_unchanged: "Retry changed nothing",
  merge_skipped: "Merge skipped",
  stopped: "Run stopped",
  cancelled: "Cancelled",
};

const STOP_REASONS: Record<string, string> = {
  finished: "finished",
  stuck: "got stuck going in circles",
  max_steps: "ran out of steps",
  max_tokens: "ran out of tokens",
  cancelled: "was cancelled",
  error: "hit an error",
  invalid_output: "gave invalid output",
  daily_limit: "hit the daily limit on every model",
};

export const humanize = (key: string) => key.replace(/_/g, " ");
export const stopReason = (reason: unknown) => STOP_REASONS[String(reason)] ?? humanize(String(reason ?? "unknown"));

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US") : String(value ?? "-"));
const secs = (value: unknown) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return n < 10 ? `${n.toFixed(1).replace(/\.0$/, "")}s` : formatDuration(n);
};
const isText = (value: unknown): value is string => typeof value === "string";
const present = (value: unknown) => value !== undefined && value !== null && value !== "";
const stringList = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
const json = (value: unknown) => JSON.stringify(value, null, 2);

/** Index of the tool_result for the call at `index` (same agent, step and tool), or -1. */
export function findToolResult(events: RunEvent[], index: number): number {
  const call = events[index];
  for (let i = index + 1; i < events.length; i++) {
    const e = events[i];
    if (e.agent !== call.agent) continue;
    if (e.type === "tool_result" && e.payload?.step === call.payload?.step && toolName(e.payload?.tool) === toolName(call.payload?.tool)) return i;
    if (e.type === "tool_called" || e.type === "agent_finished") return -1;
  }
  return -1;
}

/** Index of the tool_called for the result at `index`, or -1. */
export function findToolCall(events: RunEvent[], index: number): number {
  const result = events[index];
  for (let i = index - 1; i >= 0; i--) {
    const e = events[i];
    if (e.agent !== result.agent) continue;
    if (e.type === "tool_called" && e.payload?.step === result.payload?.step && toolName(e.payload?.tool) === toolName(result.payload?.tool)) return i;
    if (e.type === "tool_result" || e.type === "agent_started") return -1;
  }
  return -1;
}

/** The arguments of a tool call, laid out for the tools we know; anything else generically. */
export function toolCallBlocks(tool: string, rawArgs: unknown): Block[] {
  const args = argsOf(rawArgs);
  const field = (label: string, key: string, mono = true): Field[] => (present(args[key]) ? [{ label, value: String(args[key]), mono }] : []);
  const path = field("file", "path");
  switch (tool) {
    case "read_file":
      return [{ kind: "fields", items: [...path, ...field("from line", "offset"), ...field("lines", "limit")] }];
    case "list_dir":
      return [{ kind: "fields", items: path.length ? [{ ...path[0], label: "folder" }] : [{ label: "folder", value: "(repo root)" }] }];
    case "search_code":
      return [{ kind: "fields", items: [...field("pattern", "pattern"), ...field("in", "path"), ...field("files", "glob")] }];
    case "run_tests":
      return [{ kind: "fields", items: field("only", "path").length ? field("only", "path") : [{ label: "scope", value: "the whole suite" }] }];
    case "edit_file":
      return [
        { kind: "fields", items: [...path, ...field("near line", "near_line")] },
        ...(isText(args.old) ? [{ kind: "code" as const, title: "Replace this", text: args.old, flavor: "del" as const }] : []),
        ...(isText(args.new) ? [{ kind: "code" as const, title: "With this", text: args.new, flavor: "add" as const }] : []),
      ];
    case "replace_lines": {
      const range = present(args.start_line) ? `${args.start_line}–${args.end_line ?? args.start_line}` : "?";
      const text = isText(args.text) ? args.text : "";
      return [
        { kind: "fields", items: [...path, { label: "lines", value: range, mono: true }] },
        text
          ? { kind: "code", title: "New text", text, flavor: "add", startLine: Number(args.start_line) || undefined }
          : { kind: "text", text: "Deletes these lines.", tone: "bad" },
      ];
    }
    case "insert_lines": {
      const after = Number(args.after_line);
      const where = after === 0 ? "at the top" : after === -1 ? "at the end" : `after line ${args.after_line}`;
      return [
        { kind: "fields", items: [...path, { label: "where", value: where }] },
        ...(isText(args.text) ? [{ kind: "code" as const, title: "Inserted text", text: args.text, flavor: "add" as const }] : []),
      ];
    }
    case "write_file":
      return [
        { kind: "fields", items: path },
        ...(isText(args.content) ? [{ kind: "code" as const, title: "Content", text: args.content, flavor: "add" as const, startLine: 1 }] : []),
      ];
    default:
      return genericBlocks(args);
  }
}

/** Short values as fields, long or multi-line strings and objects as code. */
function genericBlocks(values: Record<string, unknown>, skip: string[] = []): Block[] {
  const fields: Field[] = [];
  const code: Block[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (skip.includes(key) || !present(value)) continue;
    if (isText(value) && (value.length > 80 || value.includes("\n"))) code.push({ kind: "code", title: humanize(key), text: value });
    else if (typeof value === "object") code.push({ kind: "code", title: humanize(key), text: json(value) });
    else fields.push({ label: humanize(key), value: String(value), mono: isText(value) });
  }
  return [...(fields.length ? [{ kind: "fields" as const, items: fields }] : []), ...code];
}

function toolDetail(events: RunEvent[], index: number): EventDetail {
  const event = events[index];
  const isCall = event.type === "tool_called";
  const callIndex = isCall ? index : findToolCall(events, index);
  const resultIndex = isCall ? findToolResult(events, index) : index;
  const call = callIndex >= 0 ? events[callIndex] : null;
  const result = resultIndex >= 0 ? events[resultIndex] : null;
  const tool = toolName(event.payload?.tool);
  const blocks: Block[] = call ? toolCallBlocks(tool, call.payload?.arguments) : [];
  if (result) {
    blocks.push({ kind: "text", title: "Result", text: String(result.payload?.summary ?? "done"), tone: result.payload?.is_error ? "bad" : "neutral" });
  } else if (isCall) {
    blocks.push({ kind: "text", title: "Result", text: "No result yet.", tone: "wait" });
  }
  const status = result ? (result.payload?.is_error ? { label: "error", tone: "bad" as const } : { label: "ok", tone: "good" as const }) : undefined;
  const step = event.payload?.step;
  const otherIndex = isCall ? resultIndex : callIndex;
  return {
    title: `${TOOL_TITLES[tool] ?? humanize(tool)}${step != null ? ` · step ${step}` : ""}`,
    status,
    blocks,
    related: otherIndex >= 0 ? { index: otherIndex, label: isCall ? "Go to its result" : "Go to the call" } : undefined,
  };
}

/** The full detail of events[index]. */
export function eventDetail(events: RunEvent[], index: number): EventDetail {
  const event = events[index];
  const p = event.payload ?? {};
  switch (event.type) {
    case "tool_called":
    case "tool_result":
      return toolDetail(events, index);

    case "run_started": {
      const models = p.models && typeof p.models === "object" ? (p.models as Record<string, string>) : {};
      return {
        title: "Run started",
        blocks: [
          { kind: "text", title: "Issue", text: String(p.issue ?? "") },
          {
            kind: "fields",
            items: [
              { label: "repo", value: String(p.repo ?? "-"), mono: true },
              { label: "mode", value: p.mode === "solo" ? "solo" : p.sequential ? "crew, one at a time" : "crew, in parallel" },
              ...(present(p.max_retries) ? [{ label: "max retries", value: String(p.max_retries) }] : []),
              { label: "per agent", value: `${num(p.max_steps)} steps, ${num(p.max_tokens)} tokens` },
            ],
          },
          {
            kind: "fields",
            title: "Models",
            items: [
              ...Object.entries(models).map(([role, model]) => ({ label: role, value: shortModel(model), mono: true })),
              ...(present(p.coder_retry_model) ? [{ label: "coder retries", value: shortModel(p.coder_retry_model), mono: true }] : []),
            ],
          },
        ],
      };
    }

    case "phase_started":
    case "phase_finished": {
      const extra = genericBlocks(p, ["phase", "duration_s"]);
      return {
        title: `Phase ${event.type === "phase_started" ? "started" : "finished"}: ${p.phase ?? "?"}`,
        blocks: [
          ...(event.type === "phase_finished" ? [{ kind: "fields" as const, items: [{ label: "took", value: secs(p.duration_s) }] }] : []),
          ...extra,
        ],
      };
    }

    case "agent_started":
      return {
        title: `${p.label ?? event.agent} started`,
        blocks: [{ kind: "fields", items: [{ label: "model", value: String(p.model ?? "-"), mono: true }] }, ...genericBlocks(p, ["label", "model"])],
      };

    case "llm_call":
      return {
        title: `Model call · step ${p.step ?? "?"}`,
        blocks: [
          {
            kind: "fields",
            items: [
              { label: "prompt", value: `${num(p.prompt_tokens)} tokens` },
              { label: "reply", value: `${num(p.completion_tokens)} tokens` },
              { label: "this agent so far", value: `${num(p.tokens_used)} tokens` },
            ],
          },
        ],
      };

    case "rate_limited":
    case "throttled":
      return {
        title: event.type === "rate_limited" ? "Rate limited by the provider" : "Throttling to stay under the limit",
        status: { label: `waiting ${secs(p.delay_s)}`, tone: "wait" },
        blocks: [
          {
            kind: "fields",
            items: [
              { label: "model", value: shortModel(p.model), mono: true },
              ...(event.type === "throttled"
                ? [
                    { label: "needs", value: `~${num(p.needed_tokens)} tokens` },
                    { label: "left this minute", value: `${num(p.remaining_tokens)} of ${num(p.limit_tokens)}` },
                    { label: "mode", value: String(p.mode ?? "-") },
                  ]
                : [
                    { label: "attempt", value: String(p.attempt ?? "-") },
                    { label: "shared cooldown", value: p.shared ? "yes, other agents wait too" : "no" },
                  ]),
            ],
          },
        ],
      };

    case "note": {
      const kind = String(p.kind ?? "");
      return {
        title: NOTE_TITLES[kind] ?? (kind ? humanize(kind) : "Note"),
        status: p.is_error ? { label: "problem", tone: "bad" } : undefined,
        blocks: [{ kind: "text", text: String(p.text ?? "") }, ...genericBlocks(p, ["kind", "text", "is_error"])],
      };
    }

    case "agent_finished": {
      const ok = p.success === true;
      const cancelled = p.stop_reason === "cancelled";
      const files = [...stringList(p.files), ...stringList(p.tests_written)];
      const blocks: Block[] = [
        { kind: "text", title: "Summary", text: String(p.summary ?? ""), tone: ok ? "neutral" : cancelled ? "neutral" : "bad" },
        {
          kind: "fields",
          items: [
            { label: "outcome", value: stopReason(p.stop_reason), tone: ok ? "good" : cancelled ? "neutral" : "bad" },
            { label: "steps", value: num(p.steps) },
            { label: "tokens", value: `${num(p.tokens)} (${num(p.prompt_tokens)} in, ${num(p.completion_tokens)} out)` },
            { label: "time", value: secs(p.duration_s) },
            { label: "models", value: (stringList(p.models_used).length ? stringList(p.models_used) : [String(p.model ?? "-")]).map(shortModel).join(" → "), mono: true },
            ...(present(p.branch) ? [{ label: "branch", value: String(p.branch), mono: true }] : []),
            ...(present(p.committed) ? [{ label: "committed", value: p.committed ? "yes" : "nothing to commit" }] : []),
          ],
        },
      ];
      if (files.length) blocks.push({ kind: "chips", title: "Files", items: files });
      if (p.output && typeof p.output === "object") blocks.push({ kind: "code", title: "Output", text: json(p.output) });
      return {
        title: `${p.label ?? event.agent} ${ok ? "finished" : cancelled ? "was cancelled" : "failed"}`,
        status: { label: ok ? "done" : cancelled ? "cancelled" : "failed", tone: ok ? "good" : cancelled ? "neutral" : "bad" },
        blocks,
      };
    }

    case "tests_run": {
      const reasons = stringList(p.reasons);
      return {
        title: "Full test suite",
        status: { label: p.passed ? "passed" : "failed", tone: p.passed ? "good" : "bad" },
        blocks: [
          { kind: "text", text: String(p.summary ?? ""), tone: p.passed ? "good" : "bad" },
          ...(reasons.length ? [{ kind: "list" as const, title: "Why it failed", items: reasons.map((r) => ({ text: r, tone: "bad" as const })) }] : []),
          ...(isText(p.output) && p.output.trim() && p.output.trim() !== String(p.summary ?? "").trim()
            ? [{ kind: "code" as const, title: "Output", text: p.output, flavor: "plain" as const }]
            : []),
        ],
      };
    }

    case "merge": {
      const conflicts = stringList(p.conflicts);
      return {
        title: `Merge ${String(p.branch ?? "").split("/").pop()} into result`,
        status: p.ok === false ? { label: "conflict", tone: "bad" } : { label: "merged", tone: "good" },
        blocks: [
          {
            kind: "fields",
            items: [
              { label: "from", value: String(p.branch ?? "-"), mono: true },
              { label: "into", value: String(p.into ?? "-"), mono: true },
            ],
          },
          ...(stringList(p.files).length ? [{ kind: "chips" as const, title: "Files", items: stringList(p.files) }] : []),
          ...(conflicts.length ? [{ kind: "list" as const, title: "Conflicts", items: conflicts.map((f) => ({ text: f, tone: "bad" as const })) }] : []),
        ],
      };
    }

    case "retry_started":
      return {
        title: `Coder retry ${p.attempt ?? "?"} of ${p.max_retries ?? "?"}`,
        status: { label: p.reason === "review" ? "review feedback" : p.reason === "tests" ? "failing tests" : String(p.reason ?? "retry"), tone: "wait" },
        blocks: [{ kind: "code", title: "Feedback given to the coder", text: String(p.feedback ?? ""), flavor: "plain" }],
      };

    case "review_verdict": {
      const issues = Array.isArray(p.issues) ? (p.issues as { severity?: string; file?: string; description?: string }[]) : [];
      const blockers = issues.filter((i) => i.severity === "blocker").length;
      return {
        title: `Review · round ${p.round ?? "?"}`,
        status: p.approved ? { label: "approved", tone: "good" } : { label: `${blockers} blocker${blockers === 1 ? "" : "s"}`, tone: "bad" },
        blocks: [
          { kind: "text", text: String(p.summary ?? "") },
          ...(issues.length
            ? [{
                kind: "list" as const,
                title: "Issues",
                items: issues.map((i) => ({
                  text: String(i.description ?? ""),
                  badge: String(i.severity ?? "note"),
                  tone: i.severity === "blocker" ? ("bad" as const) : ("neutral" as const),
                  mono: i.file ? String(i.file) : undefined,
                })),
              }]
            : [{ kind: "text" as const, text: "No issues raised.", tone: "good" as const }]),
        ],
      };
    }

    case "run_finished": {
      const r = (p.result ?? {}) as Record<string, any>;
      return {
        title: "Run finished",
        status: r.success ? { label: "success", tone: "good" } : { label: "failed", tone: "bad" },
        blocks: [
          {
            kind: "fields",
            items: [
              { label: "tests", value: r.tests_passed === true ? "pass" : r.tests_passed === false ? "fail" : "not run" },
              { label: "review", value: r.verdict ? (r.verdict.approved ? "approved" : "changes requested") : "not reached" },
              { label: "retries", value: String(r.retries ?? 0) },
              ...(present(r.failed_agent) ? [{ label: "failed agent", value: String(r.failed_agent), tone: "bad" as const }] : []),
              ...(present(r.error) ? [{ label: "error", value: String(r.error), tone: "bad" as const }] : []),
            ],
          },
          { kind: "text", text: "The result banner above the agents has the full outcome." },
        ],
      };
    }

    default:
      return { title: humanize(event.type), blocks: genericBlocks(p) };
  }
}
