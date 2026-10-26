// The runs list: search, status filter, sort, the summary numbers, and the
// address-bar query that keeps them (?q=&status=&sort=).

import type { RunSummary } from "./types";

export type RunState = "pass" | "fail" | "live" | "stopped";
export type StatusFilter = "all" | RunState;
export type SortKey = "newest" | "oldest" | "longest" | "tokens";

export interface ListQuery {
  q: string;
  status: StatusFilter;
  sort: SortKey;
}

export const DEFAULT_QUERY: ListQuery = { q: "", status: "all", sort: "newest" };
export const STATES: RunState[] = ["pass", "fail", "live", "stopped"];
export const SORTS: { key: SortKey; label: string }[] = [
  { key: "newest", label: "Newest first" },
  { key: "oldest", label: "Oldest first" },
  { key: "longest", label: "Longest first" },
  { key: "tokens", label: "Most tokens" },
];

export function stateOf(run: RunSummary): RunState {
  if (run.status === "running") return "live";
  if (run.status === "stopped") return "stopped";
  if (run.success === true) return "pass";
  if (run.success === false) return "fail";
  return "stopped";
}

/** "/Users/me/code/app" or "C:\\code\\app" -> "app" */
export function repoName(path: string | null | undefined): string {
  const clean = String(path ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  return clean.split("/").pop() ?? "";
}

/** The words of a search, lower-cased. */
export const searchTerms = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);

/** Every word of the search appears in the issue, the repo, the run id or the mode. */
export function matches(run: RunSummary, q: string): boolean {
  const terms = searchTerms(q);
  if (!terms.length) return true;
  const haystack = [run.issue, run.repo, run.run_id, run.mode, run.sequential ? "sequential" : "parallel"].join(" ").toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

/** How many runs of each state match the search (for the filter chips). */
export function stateCounts(runs: RunSummary[], q: string): Record<StatusFilter, number> {
  const counts: Record<StatusFilter, number> = { all: 0, pass: 0, fail: 0, live: 0, stopped: 0 };
  for (const run of runs) {
    if (!matches(run, q)) continue;
    counts.all += 1;
    counts[stateOf(run)] += 1;
  }
  return counts;
}

export function applyQuery(runs: RunSummary[], query: ListQuery): RunSummary[] {
  const shown = runs.filter((run) => matches(run, query.q) && (query.status === "all" || stateOf(run) === query.status));
  const started = (r: RunSummary) => r.started_at ?? "";
  const by: Record<SortKey, (a: RunSummary, b: RunSummary) => number> = {
    newest: (a, b) => started(b).localeCompare(started(a)) || b.run_id.localeCompare(a.run_id),
    oldest: (a, b) => started(a).localeCompare(started(b)) || a.run_id.localeCompare(b.run_id),
    longest: (a, b) => (b.duration_s ?? -1) - (a.duration_s ?? -1),
    tokens: (a, b) => b.total_tokens - a.total_tokens,
  };
  return [...shown].sort(by[query.sort]);
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface ListStats {
  total: number;
  today: number;
  finished: number;
  passed: number;
  // passed / finished, 0..1; null before any run finished
  passRate: number | null;
  // medians over finished runs: robust to the odd very long run
  typicalSeconds: number | null;
  typicalTokens: number | null;
  live: RunSummary | null;
}

export function listStats(runs: RunSummary[], now: Date = new Date()): ListStats {
  const finished = runs.filter((r) => stateOf(r) === "pass" || stateOf(r) === "fail");
  const passed = finished.filter((r) => r.success === true).length;
  const sameDay = (iso: string | null) => {
    if (!iso) return false;
    const d = new Date(iso);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  };
  return {
    total: runs.length,
    today: runs.filter((r) => sameDay(r.started_at)).length,
    finished: finished.length,
    passed,
    passRate: finished.length ? passed / finished.length : null,
    typicalSeconds: median(finished.map((r) => r.duration_s).filter((s): s is number => s != null)),
    typicalTokens: median(finished.map((r) => r.total_tokens)),
    live: runs.find((r) => r.status === "running") ?? null,
  };
}

export function readQuery(params: URLSearchParams): ListQuery {
  const status = params.get("status");
  const sort = params.get("sort");
  return {
    q: params.get("q") ?? "",
    status: status === "all" || STATES.includes(status as RunState) ? (status as StatusFilter) : "all",
    sort: SORTS.some((s) => s.key === sort) ? (sort as SortKey) : "newest",
  };
}

/** The query string for a list query, leaving out the defaults ("" when everything is default). */
export function writeQuery(query: ListQuery): string {
  const params = new URLSearchParams();
  if (query.q.trim()) params.set("q", query.q.trim());
  if (query.status !== "all") params.set("status", query.status);
  if (query.sort !== "newest") params.set("sort", query.sort);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** Split text into parts, marking the ones that match a search word (for highlighting). */
export function highlight(text: string, q: string): { text: string; hit: boolean }[] {
  const terms = searchTerms(q).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!terms.length || !text) return [{ text, hit: false }];
  const pattern = new RegExp(`(${terms.join("|")})`, "gi");
  return text
    .split(pattern)
    .filter((part) => part !== "")
    .map((part) => ({ text: part, hit: terms.some((t) => new RegExp(`^${t}$`, "i").test(part)) }));
}
