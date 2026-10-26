// How a run ended, for the result banner: the verdict, why, the checks, the
// coder's attempts, the moment that decided it and what to do next in git.

import { parseDiff } from "./diff";
import { stopReason, type Tone } from "./eventDetail";
import { describeEvent } from "./log";
import { shortModel } from "./api";
import type { RunEvent, RunStatus } from "./types";

export interface OutcomeAttempt {
  label: string;
  models: string;
  outcome: "passed" | "failed" | "cancelled";
  detail: string;
}

export interface Outcome {
  verdict: "success" | "failure" | "stopped";
  headline: string;
  reason: string;
  checks: { label: string; value: string; tone: Tone }[];
  attempts: OutcomeAttempt[];
  // Review blockers still open, and why the tests fail, when that's why it failed.
  blockers: { file: string; description: string }[];
  failingTests: string[];
  // The event that decided the run, to open in the drawer.
  keyEvent: { index: number; label: string } | null;
  // Git commands for what's next; `note` when there's nothing to run.
  next: { title: string; lines: string[]; note?: string } | null;
  changes: { files: number; additions: number; deletions: number } | null;
}

const retries = (n: number) => (n === 1 ? "1 retry" : `${n} retries`);

function lastIndex(events: RunEvent[], predicate: (e: RunEvent) => boolean): number {
  for (let i = events.length - 1; i >= 0; i--) if (predicate(events[i])) return i;
  return -1;
}

/** "cd" into a path, quoted when it has spaces. */
const cd = (path: string) => `cd ${/\s/.test(path) ? `"${path}"` : path}`;

function attemptsOf(result: Record<string, any>): OutcomeAttempt[] {
  const attempts = Array.isArray(result.attempts) ? result.attempts : [];
  if (attempts.length) {
    return attempts.map((a: Record<string, any>) => ({
      label: a.retry ? `Retry ${a.retry}${a.reason ? ` · ${a.reason}` : ""}` : "First try",
      models: (Array.isArray(a.models) ? a.models : []).map(shortModel).join(" → ") || "-",
      outcome: a.outcome === "passed" || a.outcome === "cancelled" ? a.outcome : "failed",
      detail: a.outcome === "passed" ? "finished" : stopReason(a.stop_reason),
    }));
  }
  // Solo runs (and old logs) have no attempts: use the coder's agent runs.
  const runs = Array.isArray(result.runs) ? result.runs.filter((r: Record<string, any>) => r.agent === "coder") : [];
  return runs.map((r: Record<string, any>, i: number) => ({
    label: i ? `Run ${i + 1}` : "First try",
    models: ((r.result?.models_used?.length ? r.result.models_used : [r.model]) as string[]).map(shortModel).join(" → "),
    outcome: r.result?.stop_reason === "cancelled" ? "cancelled" : r.result?.success ? "passed" : "failed",
    detail: r.result?.success ? "finished" : stopReason(r.result?.stop_reason),
  }));
}

function nextSteps(result: Record<string, any>, repo: string): Outcome["next"] {
  const where = repo ? [cd(repo)] : [];
  const branch = result.result_branch as string | null;
  if (result.mode === "solo") {
    return result.success
      ? { title: "Next", lines: [], note: "Solo mode edits the repo in place, so the fix is already there." }
      : { title: "Next", lines: [], note: "Solo mode edited the repo in place; check it for partial changes." };
  }
  if (result.success && branch) {
    return { title: "Apply the fix", lines: [...where, `git diff HEAD ${branch}   # inspect`, `git merge ${branch}   # apply`] };
  }
  const kept: string[] = Array.isArray(result.kept_branches) ? result.kept_branches : [];
  if (!kept.length) return { title: "Next", lines: [], note: "No branches were kept: nothing was committed." };
  const base = result.base_commit ? String(result.base_commit).slice(0, 10) : "HEAD";
  return {
    title: "Look at what was tried",
    lines: [...where, ...kept.map((b) => `git log --oneline ${base}..${b}`), `git diff ${base} ${kept[kept.length - 1]}`, `git branch -D ${kept.join(" ")}   # clean up`],
  };
}

/**
 * The outcome of a run from its RunResult (result.json, or the run_finished
 * payload) and its events. Null while the run is still going.
 */
export function runOutcome(result: Record<string, any> | null, events: RunEvent[], status: RunStatus | null): Outcome | null {
  if (!result) {
    if (status !== "stopped" || !events.length) return null;
    const last = events.length - 1;
    return {
      verdict: "stopped",
      headline: "Run stopped",
      reason: "The run ended without a result: its process exited (crashed, was killed, or Ctrl+C) before it finished.",
      checks: [],
      attempts: [],
      blockers: [],
      failingTests: [],
      keyEvent: { index: last, label: `Last event: ${describeEvent(events[last]).text}` },
      next: null,
      changes: null,
    };
  }

  const started = events.find((e) => e.type === "run_started");
  const repo = String(started?.payload?.repo ?? "");
  const crew = result.mode !== "solo";
  const retryCount = Number(result.retries ?? 0);
  const verdict = result.verdict as { approved?: boolean; issues?: { severity?: string; file?: string; description?: string }[] } | null;
  const blockers = (verdict?.issues ?? []).filter((i) => i.severity === "blocker").map((i) => ({ file: String(i.file ?? ""), description: String(i.description ?? "") }));
  const testsIndex = lastIndex(events, (e) => e.type === "tests_run");
  const reviewIndex = lastIndex(events, (e) => e.type === "review_verdict");
  const files = parseDiff(String(result.diff ?? ""));
  const changes = files.length
    ? { files: files.length, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0) }
    : null;

  const checks: Outcome["checks"] = [];
  if (crew) {
    checks.push({
      label: "Tests",
      value: result.tests_passed === true ? "pass" : result.tests_passed === false ? "fail" : "not run",
      tone: result.tests_passed === true ? "good" : result.tests_passed === false ? "bad" : "neutral",
    });
    checks.push({
      label: "Review",
      value: verdict ? (verdict.approved ? "approved" : `${blockers.length} blocker${blockers.length === 1 ? "" : "s"}`) : "not reached",
      tone: verdict ? (verdict.approved ? "good" : "bad") : "neutral",
    });
    checks.push({ label: "Retries", value: String(retryCount), tone: retryCount ? "wait" : "neutral" });
  }

  let reason: string;
  let keyEvent: Outcome["keyEvent"] = null;
  let failingTests: string[] = [];
  let openBlockers: Outcome["blockers"] = [];

  if (result.success) {
    reason = crew
      ? `The full test suite passes and the reviewer approved, ${retryCount ? `after ${retries(retryCount)}` : "on the first try"}.`
      : "The coder finished and the tests pass.";
    const i = reviewIndex >= 0 ? reviewIndex : testsIndex;
    if (i >= 0) keyEvent = { index: i, label: reviewIndex >= 0 ? "See the approval" : "See the test run" };
  } else if (result.error) {
    reason = `The run hit an error: ${result.error}`;
    const i = lastIndex(events, (e) => e.type === "merge" && e.payload?.ok === false);
    keyEvent = { index: i >= 0 ? i : events.length - 1, label: i >= 0 ? "See the merge conflict" : "See the end of the run" };
  } else if (result.failed_agent && result.failed_agent !== "coder") {
    const agent = String(result.failed_agent);
    const i = lastIndex(events, (e) => e.agent === agent && e.type === "agent_finished" && e.payload?.success !== true);
    const p = i >= 0 ? events[i].payload : {};
    reason = `The ${agent} ${stopReason(p.stop_reason)}${p.summary ? `: ${p.summary}` : "."}`;
    if (i >= 0) keyEvent = { index: i, label: `See the ${agent} fail` };
  } else if (crew && result.tests_passed === false) {
    reason = `The tests still fail${retryCount ? ` after ${retries(retryCount)}` : ""}.`;
    if (testsIndex >= 0) {
      failingTests = Array.isArray(events[testsIndex].payload?.reasons) ? events[testsIndex].payload.reasons.map(String) : [];
      keyEvent = { index: testsIndex, label: "See the last test run" };
    }
  } else if (crew && verdict && !verdict.approved) {
    reason = `The reviewer still found ${blockers.length === 1 ? "a blocker" : `${blockers.length} blockers`}${retryCount ? ` after ${retries(retryCount)}` : ""}.`;
    openBlockers = blockers;
    if (reviewIndex >= 0) keyEvent = { index: reviewIndex, label: "See the last review" };
  } else {
    const i = lastIndex(events, (e) => e.agent === "coder" && e.type === "agent_finished" && e.payload?.success !== true);
    const p = i >= 0 ? events[i].payload : null;
    reason = p ? `The coder ${stopReason(p.stop_reason)}${p.summary ? `: ${p.summary}` : "."}` : "The run didn't produce a fix.";
    if (i >= 0) keyEvent = { index: i, label: "See the coder stop" };
  }

  return {
    verdict: result.success ? "success" : "failure",
    headline: result.success ? "Issue fixed" : "Not fixed",
    reason,
    checks,
    attempts: attemptsOf(result),
    blockers: openBlockers,
    failingTests,
    keyEvent,
    next: nextSteps(result, repo),
    changes,
  };
}
