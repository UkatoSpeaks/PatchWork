import { describe, expect, it } from "vitest";

import { diffSnapshots, snapshotAt } from "./snapshots";
import type { AgentName, EventType, RunEvent } from "./types";

let seq = 0;
const ev = (agent: AgentName, type: EventType, payload: Record<string, unknown> = {}): RunEvent => ({
  run_id: "r", seq: ++seq, timestamp: "2026-10-26T10:00:00+00:00", agent, type, payload,
});

const T = "diff --git a/tests/test_m.py b/tests/test_m.py\n+test\n";
const C = "diff --git a/m.py b/m.py\n+code\n";
const M = T + C;
const R = M + "+fix\n";

const run: RunEvent[] = [
  ev("orchestrator", "run_started"),
  ev("tester", "agent_finished", { label: "tester", diff: T, branch: "patchwork/r/tester" }),
  ev("coder", "agent_finished", { label: "coder", diff: C, branch: "patchwork/r/coder" }),
  ev("orchestrator", "merge", { diff: C }),
  ev("orchestrator", "merge", { diff: M }),
  ev("orchestrator", "tests_run", { passed: false }),
  ev("coder", "agent_finished", { label: "coder (retry 1: tests)", attempt: 1, reason: "tests", diff: R, change: "+fix\n" }),
  ev("orchestrator", "run_finished", { result: { diff: R } }),
];

describe("diffSnapshots", () => {
  it("lists every version: tester, coder, merged, each retry; the last one is final", () => {
    const snaps = diffSnapshots(run, { diff: R, result_branch: "patchwork/r/result" });
    expect(snaps.map((s) => [s.label, s.index, s.agent])).toEqual([
      ["Tester's tests", 1, "tester"],
      ["Coder, first try", 2, "coder"],
      ["Merged", 4, "orchestrator"],
      ["Retry 1", 6, "coder"],
    ]);
    expect(snaps[0].detail).toBe("on patchwork/r/tester");
    expect(snaps[3]).toMatchObject({ detail: "after failing tests", change: "+fix\n", final: true });
  });

  it("adds the final result when it differs from the last logged version", () => {
    const snaps = diffSnapshots(run.slice(0, 5), { diff: R, result_branch: "patchwork/r/result" });
    expect(snaps.at(-1)).toMatchObject({ id: "final", label: "Final result", diff: R, final: true, detail: "on patchwork/r/result" });
  });

  it("works for old logs (only the final diff) and for runs with nothing", () => {
    const old = [ev("orchestrator", "run_started"), ev("orchestrator", "run_finished", { result: {} })];
    expect(diffSnapshots(old, { diff: C }).map((s) => [s.label, s.index])).toEqual([["Final result", 1]]);
    expect(diffSnapshots(old, { diff: "" })).toEqual([]);
    expect(diffSnapshots(old, null)).toEqual([]);
  });

  it("notes a cut diff", () => {
    const cut = [ev("tester", "agent_finished", { diff: T, diff_chars: 250_000 })];
    expect(diffSnapshots(cut, null)[0].diffChars).toBe(250_000);
  });
});

describe("snapshotAt", () => {
  const snaps = diffSnapshots(run, { diff: R });
  it("is the newest version the replay has reached", () => {
    expect(snapshotAt(snaps, 1)).toBeNull();
    expect(snapshotAt(snaps, 2)?.label).toBe("Tester's tests");
    expect(snapshotAt(snaps, 5)?.label).toBe("Merged");
    expect(snapshotAt(snaps, run.length)?.label).toBe("Retry 1");
  });
});
