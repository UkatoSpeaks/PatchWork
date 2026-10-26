import { describe, expect, it } from "vitest";

import { applyQuery, DEFAULT_QUERY, highlight, listStats, matches, readQuery, repoName, stateCounts, stateOf, writeQuery } from "./runList";
import type { RunSummary } from "./types";

const run = (id: string, changes: Partial<RunSummary> = {}): RunSummary => ({
  run_id: id,
  started_at: `2026-10-2${id}T10:00:00+00:00`,
  mode: "crew",
  sequential: false,
  issue: "Fix it",
  repo: "/code/app",
  retries: 0,
  success: true,
  finished: true,
  status: "finished",
  total_tokens: 1000,
  duration_s: 60,
  events: 10,
  ...changes,
});

const runs = [
  run("1", { issue: "Add median() to stats", repo: "/tmp/patchwork-toy-x/stats_feature", duration_s: 30, total_tokens: 9000 }),
  run("2", { success: false, retries: 3, issue: "Add slugify()", repo: "C:\\code\\text_utils", duration_s: 300 }),
  run("3", { success: null, finished: false, status: "stopped", retries: null, duration_s: 5 }),
  run("4", { success: null, finished: false, status: "running", retries: null, issue: "Fix the calculator", repo: "/code/calculator", sequential: true }),
];

describe("runs list", () => {
  it("knows each run's state and repo name", () => {
    expect(runs.map(stateOf)).toEqual(["pass", "fail", "stopped", "live"]);
    expect(runs.map((r) => repoName(r.repo))).toEqual(["stats_feature", "text_utils", "app", "calculator"]);
    expect(repoName("")).toBe("");
  });

  it("matches every search word against the issue, repo, run id and mode", () => {
    expect(matches(runs[0], "MEDIAN stats")).toBe(true);
    expect(matches(runs[0], "median slugify")).toBe(false);
    expect(matches(runs[1], "text_utils")).toBe(true);
    expect(matches(runs[3], "sequential")).toBe(true);
    expect(matches(runs[2], "  ")).toBe(true);
  });

  it("counts states among the runs that match the search", () => {
    expect(stateCounts(runs, "")).toEqual({ all: 4, pass: 1, fail: 1, live: 1, stopped: 1 });
    expect(stateCounts(runs, "add")).toEqual({ all: 2, pass: 1, fail: 1, live: 0, stopped: 0 });
  });

  it("filters and sorts", () => {
    const ids = (q: Partial<typeof DEFAULT_QUERY>) => applyQuery(runs, { ...DEFAULT_QUERY, ...q }).map((r) => r.run_id);
    expect(ids({})).toEqual(["4", "3", "2", "1"]);
    expect(ids({ sort: "oldest" })).toEqual(["1", "2", "3", "4"]);
    expect(ids({ sort: "longest" })).toEqual(["2", "4", "1", "3"]);
    expect(ids({ sort: "tokens" })[0]).toBe("1");
    expect(ids({ status: "fail" })).toEqual(["2"]);
    expect(ids({ q: "add", status: "pass" })).toEqual(["1"]);
  });

  it("sums up the runs: medians over finished ones, today's count, the live run", () => {
    const stats = listStats(runs, new Date("2026-10-24T18:00:00+00:00"));
    expect(stats).toMatchObject({ total: 4, today: 1, finished: 2, passed: 1, passRate: 0.5, typicalSeconds: 165, typicalTokens: 5000 });
    expect(stats.live?.run_id).toBe("4");
    expect(listStats([]).passRate).toBeNull();
  });

  it("keeps the query in the address bar, leaving out defaults and ignoring junk", () => {
    expect(writeQuery(DEFAULT_QUERY)).toBe("");
    expect(writeQuery({ q: " median ", status: "fail", sort: "tokens" })).toBe("?q=median&status=fail&sort=tokens");
    expect(readQuery(new URLSearchParams("q=median&status=fail&sort=tokens"))).toEqual({ q: "median", status: "fail", sort: "tokens" });
    expect(readQuery(new URLSearchParams("status=bogus&sort=nope"))).toEqual(DEFAULT_QUERY);
  });

  it("marks search words in text, safely", () => {
    expect(highlight("Add median() to stats", "median STATS")).toEqual([
      { text: "Add ", hit: false },
      { text: "median", hit: true },
      { text: "() to ", hit: false },
      { text: "stats", hit: true },
    ]);
    expect(highlight("a (b) c", "(b)")).toEqual([{ text: "a ", hit: false }, { text: "(b)", hit: true }, { text: " c", hit: false }]);
    expect(highlight("plain", "")).toEqual([{ text: "plain", hit: false }]);
  });
});
