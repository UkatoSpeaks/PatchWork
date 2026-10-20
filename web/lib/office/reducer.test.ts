import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { RunEvent } from "../types";
import { agentStats } from "../stats";
import { allSpots, findPath, walkable } from "./layout";
import { CREW, elapsedSeconds, initialScene, officeReducer, parseTestCounts, reduceEvents } from "./reducer";

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

  it("plans at the lead's cabin desk; the whiteboard shows the plan once it is submitted", () => {
    const planning = after((e) => e.type === "agent_started" && e.agent === "lead");
    expect(planning.phase).toBe("plan");
    expect(planning.agents.lead).toMatchObject({ place: "desk", active: true, activity: "thinking", task: "Task: plan the fix" });
    const beforeSubmit = reduceEvents(events, events.findIndex((e) => e.type === "agent_finished" && e.agent === "lead"));
    expect(beforeSubmit.whiteboardLines).toBe(0);
    expect(beforeSubmit.agents.lead.place).toBe("desk");
    const planned = after((e) => e.type === "agent_finished" && e.agent === "lead");
    expect(planned.agents.lead).toMatchObject({ place: "desk", active: false, activity: "done", task: null });
    expect(planned.whiteboardLines).toBeGreaterThan(0);
    expect(planned.subtasks.map((s) => s.role)).toContain("coder");
  });

  it("shows tool calls on the status tag, not in speech bubbles", () => {
    const before = reduceEvents(events, events.findIndex((e) => e.type === "tool_called" && e.agent === "coder" && e.payload.tool === "edit_file"));
    const state = after((e) => e.type === "tool_called" && e.agent === "coder" && e.payload.tool === "edit_file");
    expect(state.agents.coder.activity).toBe("typing");
    expect(state.agents.coder.action).toMatch(/^Editing .*\.py/);
    expect(state.agents.coder.bubble).toEqual(before.agents.coder.bubble); // no new bubble
    expect(state.agents.coder.steps).toBe(2);
    const testing = after((e) => e.type === "tool_called" && e.payload.tool === "run_tests");
    expect(testing.agents.tester.activity).toBe("testing");
    expect(testing.agents.tester.action).toBe("Running tests…");
  });

  it("reports test results in words, and goes back to thinking after a tool", () => {
    const result = after((e) => e.type === "tool_result" && e.payload.tool === "run_tests");
    expect(result.agents.tester.bubble?.text).toMatch(/fail|red/i); // the tester's tests fail first, as planned
    const read = after((e) => e.type === "tool_result" && e.agent === "coder");
    expect(read.agents.coder.activity).toBe("thinking");
    expect(read.agents.coder.action).toBe("Thinking…");
  });

  it("keeps rate-limited agents at their desk, counting the wait down on the tag", () => {
    const throttled = after((e) => e.type === "throttled");
    expect(throttled.agents.lead.place).toBe("desk");
    expect(throttled.agents.lead.activity).toBe("waiting");
    expect(throttled.agents.lead.wait).toMatchObject({ seconds: 12, model: expect.stringMatching(/^groq\//) });
    const limited = after((e) => e.type === "rate_limited");
    expect(limited.agents.coder.place).toBe("desk");
    expect(limited.agents.coder.wait?.seconds).toBe(8.5);
    // No coffee-break bubble: waits are not moments.
    const before = reduceEvents(events, events.findIndex((e) => e.type === "rate_limited"));
    expect(limited.agents.coder.bubble).toEqual(before.agents.coder.bubble);
    // The next LLM call ends the wait.
    const index = events.findIndex((e) => e.type === "rate_limited");
    const resumed = reduceEvents(events, index + 2);
    expect(resumed.agents.coder.place).toBe("desk");
    expect(resumed.agents.coder.activity).toBe("thinking");
    expect(resumed.agents.coder.wait).toBeNull();
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
    expect(retry.agents.reviewer.trip).toMatchObject({ to: "coderDesk", key: 1 });
    expect(retry.agents.reviewer.trip?.say).toBeTruthy();
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
    // everyone gathers at the merge table to celebrate
    expect(CREW.map((name) => final.agents[name].place)).toEqual(["celebrate", "celebrate", "celebrate", "celebrate"]);
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

describe("layout", () => {
  it("can reach every spot from every other", () => {
    for (const agent of CREW) {
      const spots = allSpots(agent);
      for (const spot of spots) expect(walkable(spot.x, spot.y) || spot.seat === "sofa", `${agent} ${JSON.stringify(spot)}`).toBe(true);
      for (const a of spots) for (const b of spots) {
        if (a.x !== b.x || a.y !== b.y) expect(findPath(a, b).length, `${agent} ${a.x},${a.y} -> ${b.x},${b.y}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("model switches, coder failures and escalated retries", () => {
  const base = reduceEvents(events, 1);
  let seq = 1000;
  const ev = (agent: RunEvent["agent"], type: RunEvent["type"], payload: Record<string, unknown>): RunEvent =>
    ({ ...events[0], seq: seq++, agent, type, payload });
  const run = (...list: RunEvent[]) => list.reduce(officeReducer, base);

  const coderStart = ev("coder", "agent_started", { label: "coder", model: "groq/openai/gpt-oss-20b", attempt: 1 });
  const coderSwitch = ev("coder", "note", {
    step: 4, kind: "model_switch", is_error: true, from_model: "groq/openai/gpt-oss-20b", to_model: "groq/qwen/qwen3.8-27b",
    reason: "bad_requests", text: "model kept failing on groq/openai/gpt-oss-20b (…), switching to groq/qwen/qwen3.8-27b",
  });
  const coderFailed = ev("coder", "agent_finished", {
    label: "coder", success: false, stop_reason: "error", steps: 9, tokens: 5000,
    models_used: ["groq/openai/gpt-oss-20b", "groq/qwen/qwen3.8-27b"],
  });
  const stuck = ev("orchestrator", "note", { kind: "coder_failed", text: "coder failed (error: …); continuing with a retry" });
  const retryStart = ev("coder", "agent_started", {
    label: "coder (retry 1: tests)", model: "groq/openai/gpt-oss-120b", attempt: 2, retry: 1, escalated: true,
  });
  const retryDone = ev("coder", "agent_finished", {
    label: "coder (retry 1: tests)", success: true, stop_reason: "finished", steps: 5, tokens: 3000,
    models_used: ["groq/openai/gpt-oss-120b"],
  });

  it("says it is switching models and shows the new model", () => {
    const state = run(coderStart, coderSwitch);
    const coder = state.agents.coder;
    expect(coder.model).toBe("groq/qwen/qwen3.8-27b");
    expect(["Switching to qwen3.8-27b 🧠", "Let me try a different brain", "New brain, same plan 🧠"]).toContain(coder.bubble?.text);
    expect(coder.attempts).toEqual([{ label: "attempt 1", models: ["groq/openai/gpt-oss-20b", "groq/qwen/qwen3.8-27b"], outcome: "running" }]);
  });

  it("asks for help when the implement-phase coder fails before a retry", () => {
    const coder = run(coderStart, coderFailed, stuck).agents.coder;
    expect(coder.activity).toBe("failed");
    expect(["I'm stuck… can someone help?", "Stuck. A second pair of eyes?", "I need a hand here…"]).toContain(coder.bubble?.text);
  });

  it("announces an escalated retry and records the model per attempt", () => {
    const started = run(coderStart, coderSwitch, coderFailed, stuck, retryStart).agents.coder;
    expect(["Bigger model, second try", "Bigger brain, let's go 🧠", "Second try, bigger model"]).toContain(started.bubble?.text);
    expect(started.model).toBe("groq/openai/gpt-oss-120b");
    const coder = officeReducer(run(coderStart, coderSwitch, coderFailed, stuck, retryStart), retryDone).agents.coder;
    expect(coder.attempts).toEqual([
      { label: "attempt 1", models: ["groq/openai/gpt-oss-20b", "groq/qwen/qwen3.8-27b"], outcome: "failed" },
      { label: "retry 1", models: ["groq/openai/gpt-oss-120b"], outcome: "passed" },
    ]);
  });

  it("starts a retry on the same model with the usual words", () => {
    const sameModel = { ...retryStart, payload: { ...retryStart.payload, escalated: false } };
    const coder = run(coderStart, coderFailed, sameModel).agents.coder;
    expect(["On it", "Sure, fixing it now", "On it, one sec"]).toContain(coder.bubble?.text);
  });

  it("gives the stats tab the same attempts", () => {
    const [coder] = agentStats([events[0], coderStart, coderSwitch, coderFailed, stuck, retryStart, retryDone]);
    expect(coder.attempts.map((a) => [a.label, a.models.length, a.outcome])).toEqual([["attempt 1", 2, "failed"], ["retry 1", 1, "passed"]]);
  });

  it("lists one attempt per agent run in the fixture", () => {
    const final = reduceEvents(events);
    for (const name of CREW) expect(final.agents[name].attempts).toHaveLength(final.agents[name].runs);
  });
});
