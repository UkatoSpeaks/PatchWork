import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { eventDetail, findToolCall, findToolResult, toolCallBlocks, type Block } from "./eventDetail";
import type { RunEvent } from "./types";

// The same fixture run the Python server tests use.
const FIXTURE = new URL("../../tests/fixtures/runs/20261019-120000-f1x7/events.jsonl", import.meta.url);
const events: RunEvent[] = readFileSync(fileURLToPath(FIXTURE), "utf-8")
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

const indexOf = (predicate: (e: RunEvent) => boolean) => events.findIndex(predicate);
const ofKind = <K extends Block["kind"]>(blocks: Block[], kind: K) => blocks.filter((b): b is Extract<Block, { kind: K }> => b.kind === kind);

describe("tool call pairing", () => {
  it("finds the result of a call and the call of a result, across interleaved agents", () => {
    // The coder's edit_file at step 2 has the tester's run_tests calls around it.
    const call = indexOf((e) => e.agent === "coder" && e.type === "tool_called" && e.payload.tool === "edit_file");
    const result = findToolResult(events, call);
    expect(events[result]).toMatchObject({ agent: "coder", type: "tool_result", payload: { tool: "edit_file", step: 2 } });
    expect(findToolCall(events, result)).toBe(call);
  });

  it("shows a call together with its result, and links the two", () => {
    const call = indexOf((e) => e.type === "tool_called" && e.payload.tool === "search_code");
    const detail = eventDetail(events, call);
    expect(detail.title).toBe("Search the code · step 1");
    expect(detail.status).toEqual({ label: "ok", tone: "good" });
    expect(ofKind(detail.blocks, "fields")[0].items).toContainEqual({ label: "pattern", value: "median", mono: true });
    expect(ofKind(detail.blocks, "text").find((b) => b.title === "Result")?.text).toBe("0 matches");
    expect(detail.related).toEqual({ index: call + 1, label: "Go to its result" });
    expect(eventDetail(events, call + 1).related).toEqual({ index: call, label: "Go to the call" });
  });

  it("shows what the agent got back, noting when it was cut", () => {
    const call = indexOf((e) => e.type === "tool_called" && e.payload.tool === "search_code");
    const withOutput = events.map((e, i) => (i === call + 1 ? { ...e, payload: { ...e.payload, output: "stats/core.py:3: def mean", output_chars: 9000 } } : e));
    const code = ofKind(eventDetail(withOutput, call).blocks, "code");
    expect(code).toEqual([{ kind: "code", title: "What the agent got back (first 25 of 9,000 characters)", text: "stats/core.py:3: def mean" }]);
    expect(ofKind(eventDetail(events, call).blocks, "code")).toEqual([]); // old logs: no output
  });
});

describe("toolCallBlocks", () => {
  it("shows an edit as the text replaced and the text put in", () => {
    const blocks = toolCallBlocks("edit_file", { path: "a.py", old: "x = 1", new: "x = 2", near_line: 4 });
    expect(ofKind(blocks, "fields")[0].items.map((f) => f.label)).toEqual(["file", "near line"]);
    expect(ofKind(blocks, "code").map((b) => [b.title, b.text, b.flavor])).toEqual([
      ["Replace this", "x = 1", "del"],
      ["With this", "x = 2", "add"],
    ]);
  });

  it("numbers replaced lines from their start, and says when lines are deleted", () => {
    expect(ofKind(toolCallBlocks("replace_lines", { path: "a.py", start_line: 35, end_line: 36, text: "pass\n" }), "code")[0].startLine).toBe(35);
    const deleting = toolCallBlocks("replace_lines", { path: "a.py", start_line: 35, end_line: 36, text: "" });
    expect(ofKind(deleting, "text")[0].text).toBe("Deletes these lines.");
    expect(ofKind(deleting, "fields")[0].items).toContainEqual({ label: "lines", value: "35–36", mono: true });
  });

  it("describes where insert_lines puts its text", () => {
    const where = (after: number) => ofKind(toolCallBlocks("insert_lines", { path: "a.py", after_line: after, text: "x" }), "fields")[0].items[1].value;
    expect([where(0), where(-1), where(12)]).toEqual(["at the top", "at the end", "after line 12"]);
  });

  it("lays out unknown tools generically: short values as fields, long ones as code", () => {
    const blocks = toolCallBlocks("mystery", { name: "x", body: "line 1\nline 2", nested: { a: 1 } });
    expect(ofKind(blocks, "fields")[0].items).toEqual([{ label: "name", value: "x", mono: true }]);
    expect(ofKind(blocks, "code").map((b) => b.title)).toEqual(["body", "nested"]);
  });

  it("tolerates arguments given as a JSON string", () => {
    expect(ofKind(toolCallBlocks("read_file", '{"path": "a.py", "offset": 10}'), "fields")[0].items.map((f) => f.value)).toEqual(["a.py", "10"]);
  });
});

describe("eventDetail", () => {
  it("lists every review issue with its severity", () => {
    const detail = eventDetail(events, indexOf((e) => e.type === "review_verdict" && !e.payload.approved));
    expect(detail.status).toEqual({ label: "1 blocker", tone: "bad" });
    expect(ofKind(detail.blocks, "list")[0].items[0]).toEqual({ text: "median mutates input", badge: "blocker", tone: "bad", mono: "stats/core.py" });
  });

  it("shows why tests failed and their full output", () => {
    const failing: RunEvent = {
      ...events[35],
      payload: { passed: false, summary: "FAILED: 1 failed", reasons: ["assert 2 == 3"], output: "FAILED: 1 failed\n...long output..." },
    };
    const detail = eventDetail([failing], 0);
    expect(detail.status).toEqual({ label: "failed", tone: "bad" });
    expect(ofKind(detail.blocks, "list")[0].items).toEqual([{ text: "assert 2 == 3", tone: "bad" }]);
    expect(ofKind(detail.blocks, "code")[0]).toMatchObject({ title: "Output", flavor: "plain" });
  });

  it("gives the full retry feedback", () => {
    const detail = eventDetail(events, indexOf((e) => e.type === "retry_started"));
    expect(detail.title).toBe("Coder retry 1 of 3");
    expect(ofKind(detail.blocks, "code")[0].text).toBe("median mutates input");
  });

  it("summarises a finished agent with its files", () => {
    const detail = eventDetail(events, indexOf((e) => e.agent === "tester" && e.type === "agent_finished"));
    expect(detail.status).toEqual({ label: "done", tone: "good" });
    expect(ofKind(detail.blocks, "chips")[0].items).toEqual(["tests/test_median.py"]);
  });

  it("has a detail for every event in the fixture", () => {
    events.forEach((_, i) => {
      const detail = eventDetail(events, i);
      expect(detail.title.length).toBeGreaterThan(0);
    });
  });
});
