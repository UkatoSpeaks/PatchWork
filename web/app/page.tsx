"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { API_URL, fetchRuns, formatDuration, formatTokens, modeLabel } from "@/lib/api";
import {
  applyQuery,
  DEFAULT_QUERY,
  highlight,
  listStats,
  readQuery,
  repoName,
  SORTS,
  stateCounts,
  writeQuery,
  type ListQuery,
  type ListStats,
  type SortKey,
  type StatusFilter,
} from "@/lib/runList";
import type { RunSummary } from "@/lib/types";

import Skeleton from "@/components/Skeleton";

// How often the list is re-read: quickly while a run is going, slowly otherwise.
const REFRESH_RUNNING_MS = 3000;
const REFRESH_IDLE_MS = 10000;

const FILTERS: { key: StatusFilter; label: string; dot?: string }[] = [
  { key: "all", label: "All" },
  { key: "pass", label: "Pass", dot: "bg-moss" },
  { key: "fail", label: "Fail", dot: "bg-terracotta" },
  { key: "live", label: "Live", dot: "bg-mustard" },
  { key: "stopped", label: "Stopped", dot: "bg-[#9a948c]" },
];

function OutcomeBadge({ run }: { run: RunSummary }) {
  if (run.status === "running") {
    return (
      <span className="pixel-box-sm inline-flex items-center gap-1.5 bg-terracotta px-2 py-0.5 font-pixel text-xs font-bold tracking-wider text-paper">
        <span aria-hidden className="live-dot" /> LIVE
      </span>
    );
  }
  const [label, color, title] =
    run.success === true ? ["PASS", "bg-moss text-paper", "Tests pass and the reviewer approved"]
    : run.success === false ? ["FAIL", "bg-terracotta text-paper", "The run finished without a fix"]
    : ["STOPPED", "bg-[#9a948c] text-paper", "The run ended without a result: it crashed or was stopped"];
  return <span title={title} className={`pixel-box-sm px-2 py-0.5 font-pixel text-xs font-bold tracking-wider ${color}`}>{label}</span>;
}

function formatStart(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Text with the search words marked. */
function Marked({ text, q }: { text: string; q: string }) {
  return (
    <>
      {highlight(text, q).map((part, i) =>
        part.hit ? (
          <mark key={i} className="bg-mustard/60 text-ink">{part.text}</mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

function RunCard({ run, q }: { run: RunSummary; q: string }) {
  const repo = repoName(run.repo);
  return (
    <Link
      href={`/runs/${encodeURIComponent(run.run_id)}`}
      className="pixel-box pixel-link group flex flex-col gap-3 bg-paper p-4 transition-transform hover:-translate-y-1"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-pixel text-xs text-ink-soft">{formatStart(run.started_at)}</span>
        <OutcomeBadge run={run} />
      </div>
      {repo && (
        <span className="flex min-w-0 items-center gap-1.5 self-start bg-cream-dark px-1.5 py-0.5 font-mono text-[11px]" title={run.repo}>
          <span aria-hidden className="text-ink-soft">▤</span>
          <span className="truncate"><Marked text={repo} q={q} /></span>
        </span>
      )}
      <p className="line-clamp-3 min-h-[3.75rem] text-sm leading-5" title={run.issue}>
        {run.issue ? <Marked text={run.issue} q={q} /> : "(no issue text)"}
      </p>
      <dl className="mt-auto grid grid-cols-4 gap-2 border-t-2 border-dashed border-ink/20 pt-3 font-pixel text-sm">
        <div className="min-w-0">
          <dt className="text-[11px] text-ink-soft">mode</dt>
          <dd className="truncate">{modeLabel(run)}</dd>
        </div>
        <div>
          <dt className="text-[11px] text-ink-soft">retries</dt>
          <dd className="tabular-nums">{run.retries ?? "-"}</dd>
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
      <span className="truncate font-mono text-[11px] text-ink-soft group-hover:text-terracotta">
        <Marked text={run.run_id} q={q} /> →
      </span>
    </Link>
  );
}

function StatTile({ label, children, hint }: { label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="font-pixel text-[11px] uppercase tracking-wider text-ink-soft">{label}</dt>
      <dd className="font-pixel text-2xl font-bold leading-none tabular-nums">{children}</dd>
      {hint && <dd className="truncate text-xs text-ink-soft">{hint}</dd>}
    </div>
  );
}

/** The numbers over every run: how many, how often they pass, how long and how many tokens a run usually takes. */
function Summary({ stats }: { stats: ListStats }) {
  const rate = stats.passRate === null ? null : Math.round(stats.passRate * 100);
  return (
    <dl className="pixel-box grid grid-cols-2 gap-x-6 gap-y-5 bg-paper p-5 sm:grid-cols-3 lg:grid-cols-5">
      <StatTile label="Runs" hint={stats.today ? `${stats.today} today` : "none today"}>
        {stats.total}
      </StatTile>
      <StatTile
        label="Pass rate"
        hint={
          stats.finished ? (
            <span className="flex items-center gap-2">
              <span aria-hidden className="flex h-2 w-16 bg-terracotta">
                <span className="h-full bg-moss" style={{ width: `${rate}%` }} />
              </span>
              {stats.passed} of {stats.finished} finished
            </span>
          ) : (
            "no finished runs yet"
          )
        }
      >
        {rate === null ? "-" : `${rate}%`}
      </StatTile>
      <StatTile label="Typical time" hint="median of finished runs">
        {formatDuration(stats.typicalSeconds)}
      </StatTile>
      <StatTile label="Typical tokens" hint="median of finished runs">
        {stats.typicalTokens === null ? "-" : formatTokens(Math.round(stats.typicalTokens))}
      </StatTile>
      <div className="flex min-w-0 flex-col gap-1">
        <dt className="font-pixel text-[11px] uppercase tracking-wider text-ink-soft">Live now</dt>
        <dd>
          {stats.live ? (
            <Link href={`/runs/${encodeURIComponent(stats.live.run_id)}`} className="pixel-btn inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-terracotta">
              <span aria-hidden className="live-dot" /> watch {repoName(stats.live.repo) || stats.live.run_id}
            </Link>
          ) : (
            <span className="font-pixel text-2xl font-bold leading-none text-ink-soft">-</span>
          )}
        </dd>
      </div>
    </dl>
  );
}

/** The page's shape while the first list loads: the summary strip and a few cards. */
function ListSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-6">
      <span className="sr-only">Loading runs…</span>
      <div className="pixel-box grid grid-cols-2 gap-x-6 gap-y-5 bg-paper p-5 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="h-2.5 w-16" />
            <Skeleton className="h-6 w-20" />
            <Skeleton className="h-2.5 w-28" />
          </div>
        ))}
      </div>
      <Skeleton className="h-10 w-full" />
      <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="pixel-box flex flex-col gap-3 bg-paper p-4">
            <div className="flex items-center justify-between">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-5 w-12" />
            </div>
            <Skeleton className="h-4 w-28" />
            <div className="flex min-h-[3.75rem] flex-col gap-2">
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-4/5" />
            </div>
            <div className="grid grid-cols-4 gap-2 border-t-2 border-dashed border-ink/20 pt-3">
              {Array.from({ length: 4 }, (_, j) => (
                <Skeleton key={j} className="h-6 w-full" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function RunsPage() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [query, setQuery] = useState<ListQuery>(DEFAULT_QUERY);
  const [queryLoaded, setQueryLoaded] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Load the list, then keep it fresh so new and live runs show up without a reload.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let loadedOnce = false;
    const load = () => {
      fetchRuns().then(
        (loaded) => {
          if (cancelled) return;
          loadedOnce = true;
          setRuns(loaded);
          setError(null);
          setStale(false);
          timer = setTimeout(load, loaded.some((r) => r.status === "running") ? REFRESH_RUNNING_MS : REFRESH_IDLE_MS);
        },
        (e: Error) => {
          if (cancelled) return;
          // Keep showing the list we have; only a first load failure replaces it.
          if (loadedOnce) setStale(true);
          else setError(e.message);
          timer = setTimeout(load, REFRESH_IDLE_MS);
        },
      );
    };
    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  // The search, filter and sort live in the address bar: ?q=&status=&sort=.
  useEffect(() => {
    setQuery(readQuery(new URLSearchParams(window.location.search)));
    setQueryLoaded(true);
  }, []);
  useEffect(() => {
    if (!queryLoaded) return;
    const url = `${window.location.pathname}${writeQuery(query)}`;
    if (url !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(window.history.state, "", url);
  }, [query, queryLoaded]);

  // "/" jumps to the search box.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const update = (changes: Partial<ListQuery>) => setQuery((q) => ({ ...q, ...changes }));
  const stats = useMemo(() => listStats(runs ?? []), [runs]);
  const counts = useMemo(() => stateCounts(runs ?? [], query.q), [runs, query.q]);
  const shown = useMemo(() => applyQuery(runs ?? [], query), [runs, query]);
  const filtered = query.q.trim() !== "" || query.status !== "all";

  return (
    <section className="flex flex-col gap-6 pt-4">
      <div>
        <div className="mb-1 flex flex-wrap items-center justify-between gap-4">
          <h1 className="font-pixel text-xl font-bold">Runs</h1>
          <Link href="/runs/new" className="pixel-btn start-btn px-4 py-1.5 text-sm font-bold">
            + New run
          </Link>
        </div>
        <p className="text-sm text-ink-soft">
          Pick a run to watch the crew replay it in the office.
          {stats.live && " A LIVE run opens at the present moment and follows along."}
          {stale && <span className="ml-2 font-pixel text-terracotta">(lost the API, retrying…)</span>}
        </p>
      </div>

      {error && !runs && (
        <div className="pixel-box bg-paper p-5 text-sm">
          <p className="font-pixel text-base font-bold text-terracotta">Can&apos;t reach the API</p>
          <p className="mt-2">
            Tried <code>{API_URL}/api/runs</code> ({error}). Start it from the repo root with{" "}
            <code className="bg-cream-dark px-1">uv run patchwork serve</code>.
          </p>
        </div>
      )}
      {!error && runs === null && <ListSkeleton />}
      {runs && runs.length === 0 && (
        <div className="pixel-box flex flex-col items-start gap-3 bg-paper p-5 text-sm">
          <p className="font-pixel text-base font-bold">No runs yet</p>
          <p>Start one here, or from a terminal with <code className="bg-cream-dark px-1">uv run patchwork run --repo …</code>.</p>
          <Link href="/runs/new" className="pixel-btn start-btn px-4 py-1.5 text-sm font-bold">
            + New run
          </Link>
        </div>
      )}

      {runs && runs.length > 0 && (
        <>
          <Summary stats={stats} />

          <div className="flex flex-col gap-4" role="search" aria-label="Find runs">
            <div className="flex flex-wrap items-center gap-4">
              <label className="relative min-w-0 flex-1 basis-[16rem]">
                <span className="sr-only">Search runs</span>
                <input
                  ref={searchRef}
                  type="search"
                  value={query.q}
                  onChange={(e) => update({ q: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      update({ q: "" });
                      e.currentTarget.blur();
                    }
                  }}
                  placeholder="Search issues, repos, run ids…"
                  spellCheck={false}
                  className="pixel-input pr-10 text-sm"
                />
                {!query.q && <kbd aria-hidden className="pixel-key pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">/</kbd>}
              </label>
              <label className="flex items-center gap-2">
                <span className="font-pixel text-xs uppercase tracking-wider text-ink-soft">Sort</span>
                <select value={query.sort} onChange={(e) => update({ sort: e.target.value as SortKey })} className="pixel-input w-auto py-1.5 text-sm">
                  {SORTS.map((s) => (
                    <option key={s.key} value={s.key}>{s.label}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-3" role="group" aria-label="Filter by result">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className="pixel-btn inline-flex items-center gap-1.5 px-2.5 py-1 text-xs"
                  aria-pressed={query.status === f.key}
                  disabled={f.key !== "all" && counts[f.key] === 0 && query.status !== f.key}
                  onClick={() => update({ status: f.key })}
                >
                  {f.dot && <span aria-hidden className={`inline-block h-2 w-2 ${f.dot}`} />}
                  {f.label}
                  <span className="tabular-nums text-ink-soft">{counts[f.key]}</span>
                </button>
              ))}
              {filtered && (
                <button type="button" className="pixel-link ml-auto font-pixel text-xs text-ink-soft underline decoration-dotted underline-offset-4 hover:text-terracotta" onClick={() => setQuery(DEFAULT_QUERY)}>
                  clear filters
                </button>
              )}
            </div>
            <p className="font-pixel text-xs text-ink-soft" aria-live="polite">
              {filtered ? `Showing ${shown.length} of ${runs.length} runs` : `${runs.length} run${runs.length === 1 ? "" : "s"}`}
            </p>
          </div>

          {shown.length > 0 ? (
            <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
              {shown.map((run) => (
                <RunCard key={run.run_id} run={run} q={query.q} />
              ))}
            </div>
          ) : (
            <div className="pixel-box flex flex-col items-start gap-3 bg-paper p-5 text-sm">
              <p className="font-pixel text-base font-bold">No runs match</p>
              <p className="text-ink-soft">
                {query.q.trim() ? <>Nothing matches “{query.q.trim()}”</> : "Nothing here"}
                {query.status !== "all" && <> with the {FILTERS.find((f) => f.key === query.status)?.label.toLowerCase()} filter</>}.
              </p>
              <button type="button" className="pixel-btn px-3 py-1 text-xs" onClick={() => setQuery(DEFAULT_QUERY)}>
                Clear filters
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
