import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { RunEvent } from "../types";
import * as say from "./phrases";
import { CREW, reduceEvents } from "./reducer";

const FIXTURE = new URL("../../../tests/fixtures/runs/20261019-120000-f1x7/events.jsonl", import.meta.url);
const events: RunEvent[] = readFileSync(fileURLToPath(FIXTURE), "utf-8")
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

describe("phrases", () => {
  it("picks the same words for the same run id and event seq", () => {
    for (let seq = 0; seq < 50; seq++) {
      const seed = say.seedOf("run-1", seq, "coder");
      expect(say.toolPhrase("read_file", { path: "calc/ops.py" }, seed)).toBe(say.toolPhrase("read_file", { path: "calc/ops.py" }, say.seedOf("run-1", seq, "coder")));
    }
    // ...and varies across events, so it doesn't read like a robot
    const variants = new Set(Array.from({ length: 50 }, (_, seq) => say.toolPhrase("read_file", { path: "calc/ops.py" }, say.seedOf("run-1", seq, "coder"))));
    expect(variants.size).toBeGreaterThanOrEqual(3);
  });

  it("replays and deep links show the same bubbles", () => {
    for (let n = 1; n <= events.length; n += 3) {
      const a = reduceEvents(events, n), b = reduceEvents(events, n);
      for (const agent of CREW) expect(a.agents[agent].bubble).toEqual(b.agents[agent].bubble);
    }
  });

  it("speaks plainly, in sentence case, within 40 characters", () => {
    const seeds = Array.from({ length: 30 }, (_, i) => say.seedOf("r", i));
    const lines = seeds.flatMap((seed) => [
      say.toolPhrase("read_file", { path: "some/really/long/directory/name/averyveryverylongfilename_module.py" }, seed),
      say.toolPhrase("search_code", { pattern: "a_quite_long_identifier_name" }, seed),
      say.toolPhrase("edit_file", { path: "stats.py", old: "x", new: "def subtract(a, b): return a - b" }, seed),
      say.toolPhrase("write_file", { path: "tests/test_mean.py" }, seed),
      say.coffeePhrase("rate_limited", "groq/openai/gpt-oss-120b", seed),
      say.coffeePhrase("throttled", "groq/openai/gpt-oss-120b", seed),
      say.testResultPhrase("tester", "FAILED (exit 1): 3 failed, 2 passed", false, seed),
      say.testResultPhrase("coder", "FAILED (exit 1): 2 failed", false, seed),
      say.verdictPhrase(false, 2, seed),
      say.planPhrase([{ role: "tester" }, { role: "coder" }, { role: "coder" }], seed),
    ]);
    for (const line of lines) {
      expect(line.length, line).toBeLessThanOrEqual(say.MAX_BUBBLE_CHARS);
      expect(line[0], line).toBe(line[0].toUpperCase());
    }
  });

  it("covers the situations the crew talks about", () => {
    const seed = 7;
    expect(say.planPhrase([{ role: "tester" }, { role: "coder" }, { role: "coder" }], 0)).toBe("3 tasks: 1 for tests, 2 for code");
    expect(say.testResultPhrase("tester", "FAILED (exit 1): 3 failed", false, 2)).toBe("3 failing, as expected");
    expect(say.testResultPhrase("coder", "FAILED (exit 1): 2 failed", false, 2)).toBe("Still 2 failing, hmm");
    expect(say.testResultPhrase("coder", "PASSED: 9 passed", true, 0)).toBe("All green! ✅");
    expect(say.coffeePhrase("rate_limited", "groq/openai/gpt-oss-120b", 1)).toBe("Groq needs a break, so do I");
    expect(say.countdownText(11.2)).toBe("☕ 12s left");
    expect(say.verdictPhrase(true, 0, 0)).toBe("Looks good to me 👍");
    expect(say.verdictPhrase(true, 2, 0)).toBe("Approved, a couple of nits");
    expect(say.verdictPhrase(false, 1, 0)).toBe("Not yet, see my notes");
    expect(say.finishPhrase("done", 0)).toBe("Done ✓");
    expect(say.finishPhrase("failed", 0)).toBe("I'm stuck…");
    expect(say.finishPhrase("cancelled", 0)).toBe("Never mind");
    expect(say.startPhrase("coder", "coder (retry 1: review)", "retry", 0)).toBe("On it");
    expect(say.toolPhrase("search_code", { pattern: "median" }, 0)).toBe("Where is 'median' used?");
    expect(say.toolPhrase("edit_file", { path: "ops.py", old: "a - b", new: "a + b" }, seed)).toMatch(/ops\.py|One-line fix/);
  });
});

describe("phrases for model switches and retries", () => {
  it("names the new model, or asks for a different brain", () => {
    const lines = new Set(Array.from({ length: 30 }, (_, i) => say.modelSwitchPhrase("groq/openai/gpt-oss-120b", say.seedOf("r", i))));
    expect(lines).toEqual(new Set(["Switching to gpt-oss-120b 🧠", "Let me try a different brain", "New brain, same plan 🧠"]));
    expect(say.modelSwitchPhrase(null, 0)).toBe("Let me try a different brain");
  });

  it("asks for help after a failure and announces the bigger model", () => {
    expect(say.helpPhrase(0)).toBe("I'm stuck… can someone help?");
    expect(say.escalatedRetryPhrase(0)).toBe("Bigger model, second try");
  });

  it("stays within the bubble limit, in sentence case", () => {
    const seeds = Array.from({ length: 30 }, (_, i) => say.seedOf("r", i));
    const lines = seeds.flatMap((seed) => [
      say.modelSwitchPhrase("groq/meta-llama/a-really-long-model-name-for-testing-70b-versatile", seed),
      say.helpPhrase(seed),
      say.escalatedRetryPhrase(seed),
    ]);
    for (const line of lines) {
      expect(line.length, line).toBeLessThanOrEqual(say.MAX_BUBBLE_CHARS);
      expect(line[0], line).toBe(line[0].toUpperCase());
    }
  });
});
