import Link from "next/link";

import { formatDuration, formatTokens, modeLabel } from "@/lib/api";
import { elapsedSeconds, type SceneState } from "@/lib/office/reducer";
import type { RunStatus } from "@/lib/types";

import Skeleton from "./Skeleton";

/** LIVE while following a running run; RUNNING when it runs but we're replaying the past; STOPPED when it died. */
function StatusBadge({ live, status }: { live: boolean; status: RunStatus | null }) {
  if (live) {
    return (
      <span className="pixel-box-sm inline-flex shrink-0 items-center gap-1.5 bg-terracotta px-2 py-0.5 font-pixel text-xs font-bold tracking-wider text-paper" title="Following the run as it happens">
        <span aria-hidden className="live-dot" /> LIVE
      </span>
    );
  }
  if (status === "running") {
    return (
      <span className="pixel-box-sm shrink-0 bg-mustard px-2 py-0.5 font-pixel text-xs font-bold tracking-wider text-ink" title="The run is still going; you're watching an earlier moment">
        RUNNING
      </span>
    );
  }
  if (status === "stopped") {
    return (
      <span className="pixel-box-sm shrink-0 bg-[#9a948c] px-2 py-0.5 font-pixel text-xs font-bold tracking-wider text-paper" title="The run ended without a result: it crashed or was stopped">
        STOPPED
      </span>
    );
  }
  return null;
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="font-pixel text-[11px] uppercase tracking-wider text-ink-soft">{label}</dt>
      <dd className="truncate font-pixel text-base tabular-nums">{children}</dd>
    </div>
  );
}

export default function TopBar({ runId, scene, issue, live, status, loading = false }: {
  runId: string;
  scene: SceneState;
  issue: string;
  live: boolean;
  status: RunStatus | null;
  // the events are still loading: the numbers aren't known yet
  loading?: boolean;
}) {
  const phaseColor =
    scene.outcome === "success" ? "bg-moss text-paper" : scene.outcome === "failure" ? "bg-terracotta text-paper" : "bg-mustard text-ink";
  const text = (issue || scene.issue).trim();
  const oneLine = text.replace(/\s+/g, " ");
  return (
    <div className="pixel-box flex flex-col gap-3 bg-paper p-4">
      <div className="flex min-w-0 items-center gap-4">
        <Link href="/" className="pixel-link shrink-0 font-pixel text-sm text-ink-soft hover:text-terracotta">← all runs</Link>
        {loading && !oneLine && <Skeleton className="h-3.5 min-w-0 flex-1" />}
        {oneLine && (
          <p className="min-w-0 flex-1 truncate text-sm" title={text}>
            <span className="font-pixel text-ink-soft">issue: </span>
            {oneLine}
          </p>
        )}
        <span className="ml-auto shrink-0">
          <StatusBadge live={live} status={status} />
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-5" aria-busy={loading || undefined}>
        <Stat label="run">{runId}</Stat>
        <Stat label="mode">{loading ? <Skeleton className="mt-1 h-4 w-20" /> : modeLabel(scene)}</Stat>
        <Stat label="phase">
          {loading ? (
            <Skeleton className="mt-1 h-4 w-16" />
          ) : (
            <span className={`pixel-box-sm inline-block px-1.5 text-sm ${phaseColor}`}>{scene.phaseLabel}</span>
          )}
        </Stat>
        <Stat label="elapsed">{loading ? <Skeleton className="mt-1 h-4 w-12" /> : formatDuration(elapsedSeconds(scene))}</Stat>
        <Stat label="tokens">{loading ? <Skeleton className="mt-1 h-4 w-14" /> : formatTokens(scene.totalTokens)}</Stat>
      </dl>
    </div>
  );
}
