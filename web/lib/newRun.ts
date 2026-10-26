// The "New run" form's state, what must be true before a run can start (shown
// as a checklist), and the request it sends.

import type { LaunchConfig, LaunchRequest, RepoCheck, RunEvent } from "./types";

export interface Draft {
  source: "toy" | "repo";
  toy: string | null;
  repo: string;
  issue: string;
  initGit: boolean;
  sequential: boolean;
  // null: the .env default
  maxRetries: number | null;
  maxSteps: number | null;
  testCmd: string;
}

export const emptyDraft = (): Draft => ({
  source: "toy",
  toy: null,
  repo: "",
  issue: "",
  initGit: false,
  sequential: false,
  maxRetries: null,
  maxSteps: null,
  testCmd: "",
});

export interface CheckItem {
  key: "api" | "free" | "repo" | "issue";
  label: string;
  // null: still finding out
  ok: boolean | null;
  text: string;
}

/** What must be true to start, item by item. The run can start when every item is ok. */
export function checklist(draft: Draft, config: LaunchConfig | null, repoCheck: RepoCheck | null, checking: boolean): CheckItem[] {
  const items: CheckItem[] = [];
  if (!config) {
    items.push({ key: "api", label: "Settings", ok: null, text: "Reading .env…" });
  } else {
    const keyOk = !config.needs_api_key || config.api_key_set;
    items.push({ key: "api", label: "API key", ok: keyOk, text: keyOk ? "GROQ_API_KEY is set" : "Add GROQ_API_KEY to .env, then reload" });
    items.push({
      key: "free",
      label: "Crew",
      ok: !config.busy,
      text: config.busy ? `Busy with run ${config.busy}` : "Free: no other run going",
    });
  }

  if (draft.source === "toy") {
    items.push({
      key: "repo",
      label: "Repo",
      ok: draft.toy !== null,
      text: draft.toy ? `Toy repo ${draft.toy}, on a fresh copy` : "Pick a toy repo",
    });
  } else if (!draft.repo.trim()) {
    items.push({ key: "repo", label: "Repo", ok: false, text: "Enter the path of a repo folder" });
  } else if (checking || !repoCheck) {
    items.push({ key: "repo", label: "Repo", ok: null, text: "Checking the folder…" });
  } else if (repoCheck.state === "ready") {
    items.push({ key: "repo", label: "Repo", ok: true, text: repoCheck.message });
  } else if (repoCheck.state === "needs_init") {
    items.push({
      key: "repo",
      label: "Repo",
      ok: draft.initGit,
      text: draft.initGit ? "Not a git repo yet: Patchwork will run git init and commit everything" : "Not a git repo: tick “Initialize git”",
    });
  } else {
    items.push({ key: "repo", label: "Repo", ok: false, text: repoCheck.message });
  }

  const chars = draft.issue.trim().length;
  items.push({ key: "issue", label: "Issue", ok: chars > 0, text: chars ? `${chars.toLocaleString("en-US")} characters` : "Describe what to fix or add" });
  return items;
}

export const canStart = (items: CheckItem[]) => items.every((item) => item.ok === true);

/** The request for a draft: only the options that differ from the defaults. */
export function toRequest(draft: Draft): LaunchRequest {
  const request: LaunchRequest = { issue: draft.issue.trim() };
  if (draft.source === "toy" && draft.toy) request.toy = draft.toy;
  else {
    request.repo = draft.repo.trim();
    if (draft.initGit) request.init_git = true;
  }
  if (draft.sequential) request.sequential = true;
  if (draft.maxRetries !== null) request.max_retries = draft.maxRetries;
  if (draft.maxSteps !== null) request.max_steps = draft.maxSteps;
  if (draft.testCmd.trim()) request.test_cmd = draft.testCmd.trim();
  return request;
}

/** Toy runs work on a copy in a temp folder named patchwork-toy-…/<toy>. */
export function toyFromPath(path: string): string | null {
  const match = path.replace(/\\/g, "/").match(/\/patchwork-toy-[^/]+\/([^/]+)\/?$/);
  return match ? match[1] : null;
}

/**
 * A draft from the page's query: ?from=<run id> (that run's events, to run it
 * again), ?toy=<name> or ?repo=<path>. Null when there's nothing to apply.
 */
export function draftFromQuery(query: URLSearchParams, base: Draft, fromEvents: RunEvent[] | null): Draft | null {
  const started = fromEvents?.find((e) => e.type === "run_started")?.payload;
  if (started) {
    const repo = String(started.repo ?? "");
    const toy = toyFromPath(repo);
    return {
      ...base,
      source: toy ? "toy" : "repo",
      toy: toy ?? base.toy,
      repo: toy ? base.repo : repo,
      initGit: false,
      issue: String(started.issue ?? ""),
      sequential: started.sequential === true,
      maxRetries: typeof started.max_retries === "number" ? started.max_retries : null,
    };
  }
  const toy = query.get("toy");
  if (toy) return { ...base, source: "toy", toy, issue: "" };
  const repo = query.get("repo");
  if (repo) return { ...base, source: "repo", repo };
  return null;
}
