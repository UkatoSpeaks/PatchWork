import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runOutcome } from "./outcome";
import type { RunEvent } from "./types";

const DIR = new URL("../../tests/fixtures/runs/20261019-120000-f1x7/", import.meta.url);
const events: RunEvent[] = readFileSync(fileURLToPath(new URL("events.jsonl", DIR)), "utf-8")
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));
const result: Record<string, any> = JSON.parse(readFileSync(fileURLToPath(new URL("result.json", DIR)), "utf-8"));

describe("runOutcome", () => {
  it("is null while a run is still going", () => {
    expect(runOutcome(null, events.slice(0, 20), "running")).toBeNull();
    expect(runOutcome(null, events.slice(0, 20), null)).toBeNull();
  });

  it("says a run was stopped on request, and points at where it stopped", () => {
    const note: RunEvent = { ...events[0], seq: 999, type: "note", agent: "orchestrator", payload: { kind: "stopping", text: "stopping: Ctrl+C" } };
    const stoppedEvents = [...events.slice(0, 10), note, ...events.slice(10, 12)];
    const stopped = { ...result, success: false, stopped: true, error: "stopped: Ctrl+C", verdict: null };
    const outcome = runOutcome(stopped, stoppedEvents, "stopped")!;
    expect(outcome.verdict).toBe("stopped");
    expect(outcome.headline).toBe("Run stopped");
    expect(outcome.reason).toBe("The run was stopped before it finished (Ctrl+C). Work that was committed is kept on its branches.");
    expect(outcome.keyEvent).toEqual({ index: 10, label: "See where it stopped" });
  });

  it("explains a success, points at the approval and gives the merge commands", () => {
    const outcome = runOutcome(result, events, "finished")!;
    expect(outcome.verdict).toBe("success");
    expect(outcome.reason).toBe("The full test suite passes and the reviewer approved, after 1 retry.");
    expect(outcome.checks).toEqual([
      { label: "Tests", value: "pass", tone: "good" },
      { label: "Review", value: "approved", tone: "good" },
      { label: "Retries", value: "1", tone: "wait" },
    ]);
    expect(events[outcome.keyEvent!.index].type).toBe("review_verdict");
    expect(outcome.next!.lines).toEqual([
      "cd C:/tmp/stats",
      "git diff HEAD patchwork/20261019-120000-f1x7/result   # inspect",
      "git merge patchwork/20261019-120000-f1x7/result   # apply",
    ]);
    expect(outcome.changes).toBeNull(); // the fixture's diff is empty
    const diff = "diff --git a/s.py b/s.py\n--- a/s.py\n+++ b/s.py\n@@ -1,2 +1,2 @@\n-x = 1\n+x = 2\n+y = 3\n";
    expect(runOutcome({ ...result, diff }, events, "finished")!.changes).toEqual({ files: 1, additions: 2, deletions: 1 });
  });

  it("lists the coder's attempts with their models", () => {
    const attempts = [
      { attempt: 1, retry: 0, reason: null, models: ["groq/openai/gpt-oss-20b"], outcome: "failed", stop_reason: "stuck" },
      { attempt: 2, retry: 1, reason: "tests", models: ["groq/openai/gpt-oss-120b"], outcome: "passed", stop_reason: "finished" },
    ];
    expect(runOutcome({ ...result, attempts }, events, "finished")!.attempts).toEqual([
      { label: "First try", models: "gpt-oss-20b", outcome: "failed", detail: "got stuck going in circles" },
      { label: "Retry 1 · tests", models: "gpt-oss-120b", outcome: "passed", detail: "finished" },
    ]);
  });

  it("says the reviewer's blockers are why a run failed, and lists them", () => {
    const failed = {
      ...result,
      success: false,
      retries: 3,
      kept_branches: ["patchwork/x/result", "patchwork/x/coder"],
      verdict: { approved: false, summary: "no", issues: [{ severity: "blocker", file: "a.py", description: "mutates input" }, { severity: "minor", file: "b.py", description: "naming" }] },
    };
    const outcome = runOutcome(failed, events, "finished")!;
    expect(outcome.headline).toBe("Not fixed");
    expect(outcome.reason).toBe("The reviewer still found a blocker after 3 retries.");
    expect(outcome.blockers).toEqual([{ file: "a.py", description: "mutates input" }]);
    expect(outcome.next!.title).toBe("Look at what was tried");
    expect(outcome.next!.lines).toContain("git log --oneline abc123..patchwork/x/coder");
    expect(outcome.next!.lines.at(-1)).toBe("git branch -D patchwork/x/result patchwork/x/coder   # clean up");
  });

  it("says failing tests are why a run failed", () => {
    const outcome = runOutcome({ ...result, success: false, tests_passed: false, retries: 2 }, events, "finished")!;
    expect(outcome.reason).toBe("The tests still fail after 2 retries.");
    expect(events[outcome.keyEvent!.index].type).toBe("tests_run");
  });

  it("names the agent that stopped the run", () => {
    const withFailure: RunEvent[] = [
      ...events.slice(0, 9),
      { ...events[9], payload: { ...events[9].payload, success: false, stop_reason: "max_steps", summary: "no plan" } },
    ];
    const outcome = runOutcome({ ...result, success: false, failed_agent: "lead" }, withFailure, "finished")!;
    expect(outcome.reason).toBe("The lead ran out of steps: no plan");
    expect(outcome.keyEvent).toEqual({ index: 9, label: "See the lead fail" });
  });

  it("reports a run that died without a result", () => {
    const outcome = runOutcome(null, events.slice(0, 20), "stopped")!;
    expect(outcome.verdict).toBe("stopped");
    expect(outcome.keyEvent!.index).toBe(19);
    expect(outcome.next).toBeNull();
  });

  it("tells a solo run the fix is already in place", () => {
    const outcome = runOutcome({ ...result, mode: "solo", attempts: [] }, events, "finished")!;
    expect(outcome.checks).toEqual([]);
    expect(outcome.next).toEqual({ title: "Next", lines: [], note: "Solo mode edits the repo in place, so the fix is already there." });
  });
});
