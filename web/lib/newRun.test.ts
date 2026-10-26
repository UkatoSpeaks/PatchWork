import { describe, expect, it } from "vitest";

import { canStart, checklist, draftFromQuery, emptyDraft, toRequest, toyFromPath, type Draft } from "./newRun";
import type { LaunchConfig, RepoCheck, RunEvent } from "./types";

const config: LaunchConfig = {
  models: { lead: "groq/openai/gpt-oss-120b", tester: "groq/openai/gpt-oss-120b", coder: "groq/openai/gpt-oss-120b", reviewer: "groq/qwen/qwen3.8-27b" },
  coder_retry_model: "groq/openai/gpt-oss-120b",
  api_key_set: true,
  needs_api_key: true,
  max_retries: 3,
  max_steps: 25,
  test_command: "python -m pytest -q",
  busy: null,
};

const draft = (changes: Partial<Draft> = {}): Draft => ({ ...emptyDraft(), ...changes });
const ready: RepoCheck = { state: "ready", path: "/r", message: "Clean git repo on main at abc123." };
const item = (d: Draft, key: string, c: LaunchConfig | null = config, check: RepoCheck | null = null, checking = false) =>
  checklist(d, c, check, checking).find((i) => i.key === key)!;

describe("checklist", () => {
  it("is ready with a toy and an issue", () => {
    const items = checklist(draft({ toy: "stats_feature", issue: "Add median()" }), config, null, false);
    expect(items.map((i) => [i.key, i.ok])).toEqual([["api", true], ["free", true], ["repo", true], ["issue", true]]);
    expect(canStart(items)).toBe(true);
  });

  it("waits for the settings and for the repo check", () => {
    expect(item(draft(), "api", null).ok).toBeNull();
    const typing = draft({ source: "repo", repo: "/r", issue: "x" });
    expect(item(typing, "repo", config, null, true)).toMatchObject({ ok: null, text: "Checking the folder…" });
    expect(canStart(checklist(typing, config, ready, true))).toBe(false);
    expect(canStart(checklist(typing, config, ready, false))).toBe(true);
  });

  it("asks for the API key and for the crew to be free", () => {
    expect(item(draft(), "api", { ...config, api_key_set: false })).toMatchObject({ ok: false, text: "Add GROQ_API_KEY to .env, then reload" });
    expect(item(draft(), "api", { ...config, api_key_set: false, needs_api_key: false }).ok).toBe(true);
    expect(item(draft(), "free", { ...config, busy: "20261026-1-ab" })).toMatchObject({ ok: false, text: "Busy with run 20261026-1-ab" });
  });

  it("needs a git repo, or the init-git tick for a plain folder", () => {
    const plain: RepoCheck = { state: "needs_init", path: "/p", message: "Not a git repository yet" };
    expect(item(draft({ source: "repo", repo: "/p" }), "repo", config, plain).ok).toBe(false);
    expect(item(draft({ source: "repo", repo: "/p", initGit: true }), "repo", config, plain).ok).toBe(true);
    const dirty: RepoCheck = { state: "dirty", path: "/d", message: "2 uncommitted changes: commit or stash first." };
    expect(item(draft({ source: "repo", repo: "/d" }), "repo", config, dirty)).toMatchObject({ ok: false, text: dirty.message });
    expect(item(draft({ source: "repo", repo: "  " }), "repo").text).toBe("Enter the path of a repo folder");
  });

  it("needs an issue that isn't just spaces", () => {
    expect(item(draft({ issue: "   " }), "issue").ok).toBe(false);
    expect(item(draft({ issue: "Fix it" }), "issue").text).toBe("6 characters");
  });
});

describe("toRequest", () => {
  it("sends a toy run with only what differs from the defaults", () => {
    expect(toRequest(draft({ toy: "text_utils", issue: "  Add slugify()  ", repo: "/ignored", initGit: true }))).toEqual({ toy: "text_utils", issue: "Add slugify()" });
  });

  it("sends a repo run with its options", () => {
    const request = toRequest(draft({ source: "repo", repo: " /code/app ", issue: "x", initGit: true, sequential: true, maxRetries: 0, maxSteps: 40, testCmd: " pytest -x " }));
    expect(request).toEqual({ repo: "/code/app", issue: "x", init_git: true, sequential: true, max_retries: 0, max_steps: 40, test_cmd: "pytest -x" });
  });
});

describe("draftFromQuery", () => {
  const started = (payload: Record<string, unknown>): RunEvent[] => [
    { run_id: "r", seq: 1, timestamp: "2026-10-26T10:00:00+00:00", agent: "orchestrator", type: "run_started", payload },
  ];

  it("recognises a toy repo's temp copy", () => {
    expect(toyFromPath("/var/folders/x/T/patchwork-toy-ab12/text_utils")).toBe("text_utils");
    expect(toyFromPath("C:\\Users\\me\\AppData\\Local\\Temp\\patchwork-toy-x1\\stats_feature")).toBe("stats_feature");
    expect(toyFromPath("/code/text_utils")).toBeNull();
  });

  it("runs a past run again: same repo, issue and options", () => {
    const events = started({ repo: "/code/app", issue: "Fix it", sequential: true, max_retries: 1 });
    expect(draftFromQuery(new URLSearchParams("from=r"), emptyDraft(), events)).toMatchObject({
      source: "repo", repo: "/code/app", issue: "Fix it", sequential: true, maxRetries: 1,
    });
    const toy = started({ repo: "/tmp/patchwork-toy-1/text_utils", issue: "Add slugify()" });
    expect(draftFromQuery(new URLSearchParams("from=r"), emptyDraft(), toy)).toMatchObject({ source: "toy", toy: "text_utils", issue: "Add slugify()" });
  });

  it("picks a toy or a repo from the query, else changes nothing", () => {
    expect(draftFromQuery(new URLSearchParams("toy=calculator"), emptyDraft(), null)).toMatchObject({ source: "toy", toy: "calculator" });
    expect(draftFromQuery(new URLSearchParams("repo=/code/app"), emptyDraft(), null)).toMatchObject({ source: "repo", repo: "/code/app" });
    expect(draftFromQuery(new URLSearchParams(""), emptyDraft(), null)).toBeNull();
  });
});
