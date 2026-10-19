import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { RunEvent } from "../types";
import { toolLabel } from "./labels";
import { findPath, spotFor, walkable } from "./layout";
import { CREW, elapsedSeconds, initialScene, officeReducer, parseTestCounts, reduceEvents, type Place } from "./reducer";

// The same fixture run the Python server tests use.
const FIXTURE = new URL("../../../tests/fixtures/runs/20261019-120000-f1x7/events.jsonl", import.meta.url);
const events: RunEvent[] = readFileSync(fileURLToPath(FIXTURE), "utf-8")
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

/** State right after the first event matching `predicate`. */
function after(predicate: (e: RunEvent) => boolean) {
  const index = events.findIndex(predicate);
  if (index < 0) throw new Error("no such event in the fixture");
  return reduceEvents(events, index + 1);
}

describe("officeReducer", () => {
  it("is pure: it never mutates the previous state", () => {
    const before = initialScene();
    const snapshot = JSON.stringify(before);
    officeReducer(before, events[0]);
    events.reduce(officeReducer, before);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("reads the run settings from run_started", () => {
    const state = reduceEvents(events, 1);
    expect(state.runId).toBe("20261019-120000-f1x7");
    expect(state.maxSteps).toBe(25);
    expect(state.maxTokens).toBe(60000);
    expect(state.agents.reviewer.model).toBe("groq/qwen/qwen3.8-27b");
    expect(CREW.every((name) => state.agents[name].place === "lounge" && state.agents[name].activity === "idle")).toBe(true);
  });

  it("sends the lead to the whiteboard during planning, then back to the office", () => {
    const planning = after((e) => e.type === "agent_started" && e.agent === "lead");
    expect(planning.phase).toBe("plan");
    expect(planning.agents.lead.place).toBe("whiteboard");
    expect(planning.agents.lead.activity).toBe("thinking");
    const planned = after((e) => e.type === "agent_finished" && e.agent === "lead");
    expect(planned.agents.lead.place).toBe("desk");
    expect(planned.agents.lead.activity).toBe("done");
    expect(planned.whiteboardLines).toBe(2);
  });

  it("types with a labelled bubble on tool calls", () => {
    const state = after((e) => e.type === "tool_called" && e.agent === "coder" && e.payload.tool === "edit_file");
    expect(state.agents.coder.activity).toBe("typing");
    expect(state.agents.coder.bubble).toEqual({ text: "editing core.py" });
    expect(state.agents.coder.steps).toBe(2);
    const testing = after((e) => e.type === "tool_called" && e.payload.tool === "run_tests");
    expect(testing.agents.tester.activity).toBe("testing");
    expect(testing.agents.tester.bubble?.text).toBe("running tests");
  });

  it("sends rate-limited agents for coffee and back", () => {
    const throttled = after((e) => e.type === "throttled");
    expect(throttled.agents.lead.place).toBe("coffee");
    expect(throttled.agents.lead.activity).toBe("waiting");
    expect(throttled.agents.lead.bubble).toEqual({ text: "waiting 12s", icon: "coffee" });
    const limited = after((e) => e.type === "rate_limited");
    expect(limited.agents.coder.place).toBe("coffee");
    expect(limited.agents.coder.bubble?.text).toBe("waiting 8.5s");
    // The next LLM call ends the wait.
    const index = events.findIndex((e) => e.type === "rate_limited");
    const resumed = reduceEvents(events, index + 2);
    expect(resumed.agents.coder.place).toBe("desk");
    expect(resumed.agents.coder.activity).toBe("thinking");
    expect(resumed.agents.coder.bubble).toBeNull();
  });

  it("stays put for a short shared cooldown", () => {
    const state = reduceEvents(events, events.findIndex((e) => e.type === "rate_limited"));
    const cooled = officeReducer(state, { ...events[0], agent: "coder", type: "rate_limited", payload: { delay_s: 0.25, shared: true } });
    expect(cooled.agents.coder.place).toBe("desk");
    expect(cooled.agents.coder.activity).toBe("waiting");
  });

  it("counts tokens per agent run and in total", () => {
    const state = after((e) => e.type === "agent_finished" && e.agent === "tester");
    expect(state.agents.tester.tokens).toBe(1100);
    const final = reduceEvents(events);
    expect(final.agents.coder.tokens).toBe(2400); // the retry run
    expect(final.agents.coder.totalTokens).toBe(5000);
    expect(final.agents.coder.runs).toBe(2);
    expect(final.totalTokens).toBe(12990);
  });

  it("walks the tester and coder to the merge table, and back after integrating", () => {
    const merging = after((e) => e.type === "merge");
    expect(merging.agents.tester.place).toBe("merge");
    expect(merging.agents.coder.place).toBe("merge");
    expect(merging.merges).toHaveLength(1);
    const merged = after((e) => e.type === "phase_finished" && e.payload.phase === "integrate");
    expect(merged.agents.tester.place).toBe("desk");
    expect(merged.merges).toHaveLength(2);
  });

  it("shows test results on the wall monitor", () => {
    const state = after((e) => e.type === "tests_run");
    expect(state.monitor).toEqual({ status: "pass", passed: 9, failed: null, summary: "PASSED: 9 passed in 0.05s" });
    expect(parseTestCounts("FAILED (exit 1): 2 failed, 7 passed, 1 error in 0.3s")).toEqual({ passed: 7, failed: 3 });
  });

  it("shows the review verdict and sends the reviewer to the coder on a retry", () => {
    const rejected = after((e) => e.type === "review_verdict");
    expect(rejected.agents.reviewer.verdict).toBe("rejected");
    expect(rejected.reviewRound).toBe(1);
    const retry = after((e) => e.type === "retry_started");
    expect(retry.retries).toBe(1);
    expect(retry.agents.reviewer.trip).toEqual({ to: "coderDesk", key: 1 });
    expect(retry.agents.reviewer.place).toBe("desk");
    const coding = after((e) => e.type === "agent_started" && e.payload.label?.startsWith("coder (retry"));
    expect(coding.agents.coder.activity).toBe("thinking");
    expect(coding.agents.coder.tokens).toBe(0);
    expect(coding.phaseLabel).toBe("retry 1 (review)");
  });

  it("ends with every agent done and a successful outcome", () => {
    const final = reduceEvents(events);
    expect(final.outcome).toBe("success");
    expect(final.phaseLabel).toBe("done");
    expect(final.agents.reviewer.verdict).toBe("approved");
    expect(CREW.map((name) => final.agents[name].activity)).toEqual(["done", "done", "done", "done"]);
    expect(elapsedSeconds(final)).toBeCloseTo(32.2, 1);
    expect(final.events).toBe(events.length);
  });

  it("marks failed and cancelled agents", () => {
    const base = reduceEvents(events, events.findIndex((e) => e.type === "agent_finished" && e.agent === "tester"));
    const finished = (agent: "tester" | "coder", payload: Record<string, unknown>): RunEvent =>
      ({ ...events[0], agent, type: "agent_finished", payload });
    let state = officeReducer(base, finished("tester", { success: false, stop_reason: "error", tokens: 1100, steps: 2 }));
    state = officeReducer(state, finished("coder", { success: false, stop_reason: "cancelled", tokens: 2600, steps: 2 }));
    state = officeReducer(state, { ...events[0], type: "run_finished", payload: { result: { success: false, failed_agent: "tester" } } });
    expect(state.agents.tester.activity).toBe("failed");
    expect(state.agents.coder.activity).toBe("cancelled");
    expect(state.outcome).toBe("failure");
    expect(state.failedAgent).toBe("tester");
  });

  it("seeking (reducing a prefix) equals stepping event by event", () => {
    let state = initialScene();
    for (let i = 0; i < events.length; i++) {
      state = officeReducer(state, events[i]);
      if (i % 10 === 0) expect(reduceEvents(events, i + 1)).toEqual(state);
    }
  });
});

describe("toolLabel", () => {
  it.each([
    ["read_file", { path: "calc/ops.py" }, "reading ops.py"],
    ["edit_file", { path: "stats\\stats.py" }, "editing stats.py"],
    ["run_tests", { path: "" }, "running tests"],
    ["search_code", { path: "", pattern: "median" }, "searching 'median'"],
    ["list_dir", { path: "" }, "looking in repo"],
    ["repo_browser.list_dir", { path: "tests" }, "looking in tests/"],
    ["write_file", "{'path': 'tests/test_mean.py', 'content': 'x'}", "writing test_mean.py"],
    ["read_file", { path: "tests/test_median_values.py" }, "reading test_media.."],
    ["submit_plan", null, "posting the plan"],
  ])("%s %j -> %s", (tool, args, label) => {
    expect(toolLabel(tool, args)).toBe(label);
  });
});

describe("layout", () => {
  const places: Place[] = ["lounge", "desk", "coffee", "merge"];
  it("can reach every spot from every other", () => {
    for (const agent of CREW) {
      const spots = [...places.map((p) => spotFor(agent, p)), spotFor(agent, "whiteboard"), spotFor(agent, "coderDesk")];
      for (const spot of spots) expect(walkable(spot.x, spot.y), `${agent} ${JSON.stringify(spot)}`).toBe(true);
      for (const a of spots) for (const b of spots) {
        if (a !== b && (a.x !== b.x || a.y !== b.y)) expect(findPath(a, b).length, `${agent} ${a.x},${a.y} -> ${b.x},${b.y}`).toBeGreaterThan(0);
      }
    }
  });
});
