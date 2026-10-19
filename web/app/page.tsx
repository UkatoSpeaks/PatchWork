"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { API_URL, fetchRuns, formatDuration, formatTokens, modeLabel } from "@/lib/api";
import type { RunSummary } from "@/lib/types";

function OutcomeBadge({ run }: { run: RunSummary }) {
  const [label, color] =
    run.success === true ? ["PASS", "bg-moss text-paper"]
    : run.success === false ? ["FAIL", "bg-terracotta text-paper"]
    : ["UNFINISHED", "bg-cream-dark text-ink"];
  return <span className={`pixel-box-sm px-2 py-0.5 font-pixel text-xs font-bold tracking-wider ${color}`}>{label}</span>;
}

function formatStart(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function RunCard({ run }: { run: RunSummary }) {
  return (
    <Link
      href={`/runs/${encodeURIComponent(run.run_id)}`}
      className="pixel-box pixel-link group flex flex-col gap-3 bg-paper p-4 transition-transform hover:-translate-y-1"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-pixel text-xs text-ink-soft">{formatStart(run.started_at)}</span>
        <OutcomeBadge run={run} />
      </div>
      <p className="line-clamp-3 min-h-[3.75rem] text-sm leading-5" title={run.issue}>
        {run.issue || "(no issue text)"}
      </p>
      <dl className="mt-auto grid grid-cols-3 gap-2 border-t-2 border-dashed border-ink/20 pt-3 font-pixel text-sm">
        <div>
          <dt className="text-[11px] text-ink-soft">mode</dt>
          <dd>{modeLabel(run)}</dd>
        </div>
        <div>
          <dt className="text-[11px] text-ink-soft">tokens</dt>
          <dd className="tabular-nums">{formatTokens(run.total_tokens)}</dd>
        </div>
        <div>
          <dt className="text-[11px] text-ink-soft">time</dt>
          <dd className="tabular-nums">{formatDuration(run.duration_s)}</dd>
        </div>
      </dl>
      <span className="font-mono text-[11px] text-ink-soft group-hover:text-terracotta">{run.run_id} →</span>
    </Link>
  );
}

export default function RunsPage() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchRuns().then(setRuns, (e: Error) => setError(e.message));
  }, []);

  return (
    <section className="pt-4">
      <h1 className="mb-1 font-pixel text-xl font-bold">Runs</h1>
      <p className="mb-8 text-sm text-ink-soft">Pick a run to watch the crew replay it in the office.</p>
      {error && (
        <div className="pixel-box bg-paper p-5 text-sm">
          <p className="font-pixel text-base font-bold text-terracotta">Can&apos;t reach the API</p>
          <p className="mt-2">
            Tried <code>{API_URL}/api/runs</code> ({error}). Start it from the repo root with{" "}
            <code className="bg-cream-dark px-1">uv run patchwork serve</code>.
          </p>
        </div>
      )}
      {!error && runs === null && <p className="font-pixel text-ink-soft">Loading runs…</p>}
      {runs && runs.length === 0 && (
        <p className="pixel-box bg-paper p-5 text-sm">
          No runs yet. Run <code className="bg-cream-dark px-1">uv run patchwork run --repo …</code> first.
        </p>
      )}
      {runs && runs.length > 0 && (
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {runs.map((run) => (
            <RunCard key={run.run_id} run={run} />
          ))}
        </div>
      )}
    </section>
  );
}
