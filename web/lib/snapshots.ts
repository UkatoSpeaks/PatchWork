// Versions of the code over a run, for the Diff tab: each commit logs its diff
// (the tester's branch, the coder's first try, the merged result, each retry),
// and result.json has the final one. Older logs only have the final diff.

import type { AgentName, RunEvent } from "./types";

export interface Snapshot {
  id: string;
  // The event it was recorded at: it exists from there on in the replay.
  index: number;
  label: string;
  detail: string;
  agent: AgentName;
  // Against the run's base commit.
  diff: string;
  // The full length when the logged diff was cut.
  diffChars?: number;
  // A retry: what that one retry changed.
  change?: string;
  final?: boolean;
}

const REASONS: Record<string, string> = { review: "after the review", tests: "after failing tests", coder_failed: "after the first try failed" };

/** Every version of the code in the run, in order. */
export function diffSnapshots(events: RunEvent[], result: Record<string, any> | null): Snapshot[] {
  const snapshots: Snapshot[] = [];
  events.forEach((event, index) => {
    const p = event.payload ?? {};
    if (typeof p.diff !== "string") return;
    const cut = typeof p.diff_chars === "number" ? { diffChars: p.diff_chars } : {};
    if (event.type === "agent_finished" && event.agent === "tester") {
      snapshots.push({ id: `tester-${index}`, index, label: "Tester's tests", detail: p.branch ? `on ${p.branch}` : "the tester's branch", agent: "tester", diff: p.diff, ...cut });
    } else if (event.type === "agent_finished" && event.agent === "coder" && p.attempt == null) {
      snapshots.push({ id: `coder-${index}`, index, label: "Coder, first try", detail: p.branch ? `on ${p.branch}` : "the coder's branch", agent: "coder", diff: p.diff, ...cut });
    } else if (event.type === "merge") {
      // Only the last of a row of merges: the merged result.
      if (events[index + 1]?.type === "merge") return;
      snapshots.push({ id: `merge-${index}`, index, label: "Merged", detail: "the tester's and the coder's work together", agent: "orchestrator", diff: p.diff, ...cut });
    } else if (event.type === "agent_finished" && event.agent === "coder") {
      snapshots.push({
        id: `retry-${index}`,
        index,
        label: `Retry ${p.attempt}`,
        detail: REASONS[String(p.reason)] ?? (p.reason ? `after ${p.reason}` : "a coder retry"),
        agent: "coder",
        diff: p.diff,
        ...cut,
        ...(typeof p.change === "string" ? { change: p.change } : {}),
      });
    }
  });

  const finalDiff = typeof result?.diff === "string" ? result.diff : "";
  if (finalDiff) {
    const last = snapshots.at(-1);
    if (last && last.diff === finalDiff) {
      last.final = true;
    } else {
      const end = events.findLastIndex((e) => e.type === "run_finished");
      snapshots.push({ id: "final", index: end >= 0 ? end : Math.max(0, events.length - 1), label: "Final result", detail: result?.result_branch ? `on ${result.result_branch}` : "the run's result", agent: "orchestrator", diff: finalDiff, final: true });
    }
  }
  return snapshots;
}

/** The newest version that exists after `applied` events of the replay, or null. */
export function snapshotAt(snapshots: Snapshot[], applied: number): Snapshot | null {
  return snapshots.findLast((s) => s.index < applied) ?? null;
}
