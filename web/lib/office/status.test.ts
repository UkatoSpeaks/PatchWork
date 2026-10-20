import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { CrewAgent, RunEvent } from "../types";
import { Actors } from "./animator";
import { MIN_HOLD_S } from "./bubbles";
import { spotFor } from "./layout";
import { CREW, initialScene, officeReducer, reduceEvents, type SceneState } from "./reducer";
import { actionPhrase, MAX_TAG_CHARS, retryTask, StatusDirector, statusLines, subjectOf, taskLine, THINKING } from "./status";

const FIXTURE = new URL("../../../tests/fixtures/runs/20261019-120000-f1x7/events.jsonl", import.meta.url);
const fixture: RunEvent[] = readFileSync(fileURLToPath(FIXTURE), "utf-8")
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

// A text_utils run like the real one: the coder fails, a retry fixes the import,
// the reviewer rejects dead code, and retry 2 deletes it while being throttled.
const RUN = "20261020-162934-dae3";
const GROQ_20B = "groq/openai/gpt-oss-20b";
const GROQ_120B = "groq/openai/gpt-oss-120b";
const DEAD_CODE = "The reviewer found problems that must be fixed:\n- [blocker] text_utils/core.py: Unreachable dead code left after slugify's return (lines 35-36). Remove them.";
const IMPORT_FAILS = "The full test suite fails in the merged result:\nFAILED (exit 2): 1 error\nreason: ImportError: cannot import name 'slugify' from 'text_utils'";

function textUtilsRun(): RunEvent[] {
  let seq = 0;
  let clock = Date.parse("2026-10-20T16:29:34Z");
  const ev = (agent: RunEvent["agent"], type: RunEvent["type"], payload: Record<string, unknown> = {}, gap = 2): RunEvent => {
    clock += gap * 1000;
    return { run_id: RUN, seq: ++seq, timestamp: new Date(clock).toISOString(), agent, type, payload };
  };
  const step = (agent: CrewAgent, n: number, tool: string, args: Record<string, unknown>, summary = "ok", isError = false) => [
    ev(agent, "llm_call", { step: n, tokens_used: n * 1000 }),
    ev(agent, "tool_called", { step: n, tool, arguments: args }, 0.2),
    ev(agent, "tool_result", { step: n, tool, summary, is_error: isError }, 0.3),
  ];
  return [
    ev("orchestrator", "run_started", { models: { lead: GROQ_120B, tester: GROQ_120B, coder: GROQ_20B, reviewer: GROQ_120B }, max_retries: 3 }),
    ev("orchestrator", "phase_started", { phase: "plan" }),
    ev("lead", "agent_started", { label: "lead", model: GROQ_120B }),
    ev("lead", "throttled", { model: GROQ_120B, delay_s: 12 }),
    ...step("lead", 1, "read_file", { path: "text_utils/core.py" }),
    ev("lead", "agent_finished", {
      label: "lead", success: true, stop_reason: "finished", steps: 2, tokens: 3000,
      output: { issue_summary: "add slugify", subtasks: [
        { id: "t1", role: "tester", description: "Create tests for slugify covering lower-casing and accent stripping." },
        { id: "c1", role: "coder", description: "Implement slugify in text_utils/core.py and export it." },
      ] },
    }),
    ev("orchestrator", "phase_finished", { phase: "plan" }),
    ev("orchestrator", "phase_started", { phase: "implement", parallel: true }),
    ev("tester", "agent_started", { label: "tester", model: GROQ_120B }),
    ev("coder", "agent_started", { label: "coder", model: GROQ_20B, attempt: 1 }),
    ...step("tester", 1, "write_file", { path: "tests/test_slugify.py", content: "..." }),
    ev("coder", "rate_limited", { model: GROQ_20B, delay_s: 8.5, attempt: 1 }),
    ...step("coder", 1, "read_file", { path: "text_utils/core.py" }),
    ...step("tester", 2, "run_tests", { path: "tests/test_slugify.py" }, "FAILED (exit 2): 1 error in 0.2s", true),
    ev("tester", "agent_finished", { label: "tester", success: true, stop_reason: "finished", steps: 2, tokens: 2000 }),
    ...step("coder", 2, "edit_file", { path: "text_utils/core.py", old: "x", new: "y" }, "edited text_utils/core.py at line 30 (WARNING: unreachable code)"),
    ev("coder", "agent_finished", { label: "coder", success: false, stop_reason: "max_steps", steps: 25, tokens: 9000 }),
    ev("orchestrator", "note", { kind: "coder_failed", text: "coder failed (max_steps: ...); continuing with a retry" }),
    ev("orchestrator", "phase_finished", { phase: "implement" }),
    ev("orchestrator", "phase_started", { phase: "integrate" }),
    ev("orchestrator", "merge", { branch: `patchwork/${RUN}/coder`, ok: true }),
    ev("orchestrator", "merge", { branch: `patchwork/${RUN}/tester`, ok: true }),
    ev("orchestrator", "phase_finished", { phase: "integrate" }),
    ev("orchestrator", "tests_run", { passed: false, summary: "FAILED (exit 2): 1 error in 0.28s" }),
    ev("orchestrator", "retry_started", { attempt: 1, max_retries: 3, reason: "tests", feedback: IMPORT_FAILS }),
    ev("orchestrator", "phase_started", { phase: "retry", attempt: 1, reason: "tests" }),
    ev("coder", "agent_started", { label: "coder (retry 1: tests)", model: GROQ_120B, attempt: 2, retry: 1, escalated: true }),
    ev("coder", "throttled", { model: GROQ_120B, delay_s: 20 }),
    ...step("coder", 1, "edit_file", { path: "text_utils/__init__.py", old: "a", new: "b" }),
    ...step("coder", 2, "run_tests", {}, "PASSED: 10 passed in 0.05s"),
    ev("coder", "agent_finished", { label: "coder (retry 1: tests)", success: true, stop_reason: "finished", steps: 3, tokens: 6000 }),
    ev("orchestrator", "tests_run", { passed: true, summary: "PASSED: 10 passed in 0.05s" }),
    ev("orchestrator", "phase_started", { phase: "review", round: 1 }),
    ev("reviewer", "agent_started", { label: "reviewer", model: GROQ_120B }),
    ...step("reviewer", 1, "read_file", { path: "text_utils/core.py" }),
    ev("reviewer", "review_verdict", { round: 1, approved: false, issues: [{ severity: "blocker" }], summary: "dead code" }),
    ev("reviewer", "agent_finished", { label: "reviewer", success: true, stop_reason: "finished", steps: 2, tokens: 3000 }),
    ev("orchestrator", "retry_started", { attempt: 2, max_retries: 3, reason: "review", feedback: DEAD_CODE }),
    ev("coder", "agent_started", { label: "coder (retry 2: review)", model: GROQ_120B, attempt: 3, retry: 2, escalated: true }, 0.5),
    ev("coder", "throttled", { model: GROQ_120B, delay_s: 12 }),
    ...step("coder", 1, "replace_lines", { path: "text_utils/core.py", start_line: 35, end_line: 36, text: "" }, "deleted lines 35-36 of text_utils/core.py"),
    ev("coder", "note", { step: 2, kind: "stuck", text: "stuck: blocked 3 times by the repeated-call guard (last: read_file)", is_error: true }),
    ev("coder", "agent_finished", { label: "coder (retry 2: review)", success: false, stop_reason: "stuck", steps: 2, tokens: 4000 }),
    ev("orchestrator", "run_finished", { result: { success: false } }),
  ];
}

const events = textUtilsRun();
const afterEvent = (predicate: (e: RunEvent) => boolean, list = events) => reduceEvents(list, list.findIndex(predicate) + 1);
const tag = (scene: SceneState, agent: CrewAgent) => statusLines(scene.agents[agent], null);

describe("status tag lines", () => {
  it("names each agent's task in plain words, from the plan or the retry reason", () => {
    expect(tag(afterEvent((e) => e.type === "agent_started" && e.agent === "lead"), "lead")?.task).toBe("Task: plan the fix");
    expect(tag(afterEvent((e) => e.type === "agent_started" && e.agent === "tester"), "tester")?.task).toBe("Task: tests for slugify()");
    expect(tag(afterEvent((e) => e.type === "agent_started" && e.agent === "coder"), "coder")?.task).toBe("Task: add slugify()");
    expect(tag(afterEvent((e) => e.type === "agent_started" && e.payload.retry === 1), "coder")?.task).toBe("Task: fix failing import");
    expect(tag(afterEvent((e) => e.type === "agent_started" && e.agent === "reviewer"), "reviewer")?.task).toBe("Task: review the diff");
    expect(tag(afterEvent((e) => e.type === "agent_started" && e.payload.retry === 2), "coder")?.task).toBe("Task: remove dead code");
  });

  it("says what the agent is doing right now", () => {
    expect(tag(afterEvent((e) => e.type === "agent_started" && e.agent === "lead"), "lead")?.action).toBe(THINKING);
    expect(tag(afterEvent((e) => e.type === "tool_called" && e.agent === "lead"), "lead")?.action).toBe("Reading core.py");
    expect(tag(afterEvent((e) => e.type === "tool_result" && e.agent === "lead"), "lead")?.action).toBe(THINKING);
    expect(tag(afterEvent((e) => e.type === "tool_called" && e.payload.tool === "run_tests"), "tester")?.action).toBe("Running tests…");
    expect(tag(afterEvent((e) => e.type === "tool_called" && e.payload.tool === "replace_lines"), "coder")?.action).toBe("Deleting lines 35-36");
    expect(tag(afterEvent((e) => e.type === "note" && e.payload.kind === "stuck"), "coder")?.action).toBe("Going in circles…");
  });

  it("counts a provider wait down on line 2, until the model replies", () => {
    const waiting = afterEvent((e) => e.type === "throttled" && e.agent === "lead");
    expect(statusLines(waiting.agents.lead, null)?.action).toBe("⏳ waiting for Groq · 12s");
    expect(statusLines(waiting.agents.lead, 4.2)?.action).toBe("⏳ waiting for Groq · 5s");
    expect(statusLines(waiting.agents.lead, 0)?.action).toBe(THINKING);
    const replied = afterEvent((e) => e.type === "llm_call" && e.agent === "lead");
    expect(replied.agents.lead.wait).toBeNull();
  });

  it("shows no tag for idle agents", () => {
    const implementing = afterEvent((e) => e.type === "agent_started" && e.agent === "coder");
    expect(tag(implementing, "lead")).toBeNull(); // planned and done
    expect(tag(implementing, "reviewer")).toBeNull(); // nothing to do yet
    const final = reduceEvents(events);
    for (const agent of CREW) expect(tag(final, agent)).toBeNull();
    expect(new StatusDirector().next("reviewer", implementing.agents.reviewer, 0, 0, 1)).toBeNull();
  });

  it("keeps every line within the tag's width", () => {
    const longPath = "some/really/long/directory/averyveryverylongfilename_module.py";
    const lines = [
      actionPhrase("read_file", { path: longPath, offset: 120 }),
      actionPhrase("search_code", { pattern: "a_quite_long_identifier_name" }),
      actionPhrase("edit_file", { path: longPath, old: "a", new: "b", near_line: 1234 }),
      actionPhrase("replace_lines", { path: "x.py", start_line: 1035, end_line: 1036, text: "x" }),
      actionPhrase("write_file", { path: longPath }),
      taskLine("coder", "coder", 0, 0, { mode: "crew", issue: "", retry: null, subtasks: [{ role: "coder", description: "Implement normalize_unicode_whitespace_everywhere(text)" }] }),
    ];
    for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(MAX_TAG_CHARS);
    expect(actionPhrase("edit_file", { path: "a/core.py", old: "x", new: "" })).toBe("Deleting code in core.py");
    expect(actionPhrase("replace_lines", { path: "core.py", start_line: 7, end_line: 7, text: "" })).toBe("Deleting line 7");
    expect(actionPhrase("replace_lines", { path: "core.py", start_line: 7, end_line: 9, text: "x = 1" })).toBe("Rewriting lines 7-9");
  });

  it("finds the function a plan is about, and the kind of fix a retry needs", () => {
    expect(subjectOf("Implement slugify(text) in text_utils/core.py")).toBe("slugify");
    expect(subjectOf("Add a `median` helper")).toBe("median");
    expect(subjectOf("Create tests for slugify covering lower-casing")).toBe("slugify");
    expect(subjectOf("Implement the new function word_count in core.py")).toBe("word_count");
    expect(retryTask("tests", "SyntaxError: invalid syntax")).toBe("Task: fix a syntax error");
    expect(retryTask("tests", "assert 1 == 2")).toBe("Task: fix failing tests");
    expect(retryTask("review", "- [blocker] core.py: handles None wrong")).toBe("Task: fix review notes");
    expect(taskLine("reviewer", "reviewer (round 2)", 0, 2, { mode: "crew", issue: "", subtasks: [], retry: null })).toBe("Task: re-review the fixes");
  });
});

describe("StatusDirector", () => {
  const coder = (action: string | null, wait: { seconds: number; seq: number } | null = null) =>
    ({ active: true, task: "Task: add slugify()", action, wait: wait && { ...wait, model: GROQ_120B } });

  it("keeps a quick action readable before going back to Thinking…", () => {
    const d = new StatusDirector();
    expect(d.next("coder", coder("Reading core.py"), 0, 0, 1)?.action).toBe("Reading core.py");
    expect(d.next("coder", coder(THINKING), MIN_HOLD_S * 0.5, 0.5, 1)?.action).toBe("Reading core.py");
    expect(d.next("coder", coder(THINKING), MIN_HOLD_S * 1.1, 1.6, 1)?.action).toBe(THINKING);
    // a new action replaces the old one at once
    expect(d.next("coder", coder("Running tests…"), MIN_HOLD_S * 1.2, 1.7, 1)?.action).toBe("Running tests…");
  });

  it("counts a wait down in playback time and restarts for a new wait", () => {
    const d = new StatusDirector();
    expect(d.next("coder", coder(THINKING, { seconds: 12, seq: 5 }), 0, 10, 1)?.action).toBe("⏳ waiting for Groq · 12s");
    expect(d.next("coder", coder(THINKING, { seconds: 12, seq: 5 }), 1, 11, 1)?.action).toBe("⏳ waiting for Groq · 6s");
    expect(d.next("coder", coder(THINKING, { seconds: 12, seq: 5 }), 3, 13, 1)?.action).toBe(THINKING);
    expect(d.next("coder", coder(THINKING, { seconds: 20, seq: 9 }), 4, 14, 1)?.action).toBe("⏳ waiting for Groq · 20s");
  });
});

describe("where active agents are", () => {
  /** Replays events through the reducer and animator, giving each event `dt` seconds. */
  function replay(list: RunEvent[], check: (scene: SceneState, actors: Actors, event: RunEvent) => void, dt = 1.5) {
    let scene = initialScene();
    const actors = new Actors(scene);
    for (const event of list) {
      scene = officeReducer(scene, event);
      actors.sync(scene, false);
      for (let t = 0; t < dt; t += 0.05) {
        actors.update(0.05, 8);
        check(scene, actors, event);
      }
    }
  }

  for (const [name, list] of [["the fixture run", fixture], ["a text_utils run with retries and waits", events]] as const) {
    it(`never leave their work spot between agent_started and agent_finished: ${name}`, () => {
      const arrived: Partial<Record<CrewAgent, boolean>> = {};
      let checks = 0;
      replay(list, (scene, actors) => {
        for (const agent of CREW) {
          const state = scene.agents[agent];
          if (!state.active) {
            arrived[agent] = false;
            continue;
          }
          expect(state.place, `${agent} place while active`).toBe("desk");
          const desk = spotFor(agent, "desk");
          const there = actors.actors[agent].tile.x === desk.x && actors.actors[agent].tile.y === desk.y && !actors.isWalking(agent);
          if (arrived[agent]) {
            expect(there, `${agent} left its desk while active (${state.activity})`).toBe(true);
            checks++;
          }
          arrived[agent] ||= there;
        }
      });
      expect(checks).toBeGreaterThan(100);
    });
  }

  it("waits at the desk with a mug instead of going for coffee", () => {
    let mugs = 0;
    replay(events, (scene, actors, event) => {
      if ((event.type === "throttled" || event.type === "rate_limited") && event.agent !== "orchestrator") {
        const agent = event.agent as CrewAgent;
        const view = actors.view(agent);
        if (!actors.isWalking(agent) && view.pose === "sit" && view.cup === "mug") mugs++;
        expect(scene.agents[agent].place).toBe("desk");
      }
    });
    expect(mugs).toBeGreaterThan(0);
  });

  it("lets the idle reviewer walk over with its notes while the retry coder stays put", () => {
    const visit = spotFor("reviewer", "coderDesk");
    let visited = false;
    replay(events.slice(0, events.findIndex((e) => e.type === "throttled" && e.payload.delay_s === 12 && e.agent === "coder") + 1), (scene, actors) => {
      if (actors.actors.reviewer.tile.x === visit.x && actors.actors.reviewer.tile.y === visit.y) visited = true;
    }, 3);
    expect(visited).toBe(true);
  });
});

describe("speech bubbles are only for moments", () => {
  const MOMENTS = new Set(["agent_started", "agent_finished", "review_verdict", "merge", "run_finished", "note", "tool_result"]);

  for (const [name, list] of [["the fixture run", fixture], ["a text_utils run", events]] as const) {
    it(`sets a bubble only on moment events: ${name}`, () => {
      let state = initialScene();
      let seen = 0;
      for (const event of list) {
        const next = officeReducer(state, event);
        for (const agent of CREW) {
          const bubble = next.agents[agent].bubble;
          if (!bubble || bubble === state.agents[agent].bubble) continue;
          seen++;
          expect(MOMENTS.has(event.type), `${event.type} set "${bubble.text}"`).toBe(true);
          if (event.type === "tool_result") expect(event.payload.tool === "run_tests" || /WARNING: unreachable/.test(event.payload.summary)).toBe(true);
          if (event.type === "note") expect(["model_switch", "coder_failed"]).toContain(event.payload.kind);
        }
        state = next;
      }
      expect(seen).toBeGreaterThan(3);
    });
  }

  it("speaks up for dead code, a stuck attempt and a handoff", () => {
    expect(afterEvent((e) => e.type === "tool_result" && /unreachable/.test(e.payload.summary)).agents.coder.bubble?.text).toMatch(/^Oops, dead code/);
    expect(afterEvent((e) => e.type === "agent_finished" && e.payload.stop_reason === "stuck").agents.coder.bubble?.text).toMatch(/^I'm going in circles…/);
    const handoff = afterEvent((e) => e.type === "retry_started" && e.payload.attempt === 2);
    expect(handoff.agents.reviewer.trip?.say).toBeTruthy();
    // no notes to hand over before a retry for failing tests
    expect(afterEvent((e) => e.type === "retry_started" && e.payload.attempt === 1).agents.reviewer.trip).toBeNull();
    expect(afterEvent((e) => e.type === "agent_started" && e.payload.retry === 2).agents.coder.bubble?.text).toBeTruthy();
    // tool calls and waits never put up a bubble
    const before = reduceEvents(events, events.findIndex((e) => e.type === "tool_called" && e.payload.tool === "replace_lines"));
    const during = afterEvent((e) => e.type === "tool_called" && e.payload.tool === "replace_lines");
    expect(during.agents.coder.bubble).toEqual(before.agents.coder.bubble);
  });
});
