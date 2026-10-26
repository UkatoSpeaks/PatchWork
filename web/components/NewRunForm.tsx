"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { API_URL, ApiError, checkRepo, fetchConfig, fetchEvents, fetchToyRepos, shortModel, startRun } from "@/lib/api";
import { canStart, checklist, draftFromQuery, emptyDraft, toRequest, type CheckItem, type Draft } from "@/lib/newRun";
import { AGENT_COLORS } from "@/lib/office/sprites";
import type { LaunchConfig, RepoCheck, RunEvent, ToyRepo } from "@/lib/types";

import { ROLE } from "./AgentCard";

const DRAFT_KEY = "patchwork:new-run";
const CHECK_DELAY_MS = 400;

function loadDraft(): Draft {
  try {
    const saved = sessionStorage.getItem(DRAFT_KEY);
    if (saved) return { ...emptyDraft(), ...JSON.parse(saved) };
  } catch {
    // no storage (private mode, blocked): start empty
  }
  return emptyDraft();
}

function saveDraft(draft: Draft): void {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // fine: the draft just won't survive a reload
  }
}

/** A numbered form section. */
function Step({ n, title, hint, children }: { n: number; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="pixel-box flex min-w-0 flex-col gap-4 bg-paper p-5" aria-labelledby={`step-${n}`}>
      <div className="flex items-baseline gap-3">
        <span aria-hidden className="grid h-7 w-7 shrink-0 place-items-center bg-ink font-pixel text-sm font-bold text-paper">{n}</span>
        <div className="min-w-0">
          <h2 id={`step-${n}`} className="font-pixel text-lg font-bold leading-tight">{title}</h2>
          {hint && <p className="mt-0.5 text-xs text-ink-soft">{hint}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

const MARK: Record<string, { mark: string; className: string }> = {
  true: { mark: "✓", className: "bg-moss text-paper" },
  false: { mark: "✗", className: "bg-terracotta text-paper" },
  null: { mark: "…", className: "bg-cream-dark text-ink" },
};

function Checklist({ items }: { items: CheckItem[] }) {
  return (
    <ul className="flex flex-col gap-2.5" aria-label="Ready to start?">
      {items.map((item) => {
        const look = MARK[String(item.ok)];
        return (
          <li key={item.key} className="flex items-start gap-2.5 text-xs">
            <span aria-hidden className={`grid h-5 w-5 shrink-0 place-items-center font-pixel text-xs font-bold ${look.className}`}>{look.mark}</span>
            <span className="min-w-0">
              <span className="block font-pixel text-[11px] uppercase tracking-wider text-ink-soft">{item.label}</span>
              <span className={`block break-words leading-snug ${item.ok === false ? "text-terracotta" : ""}`}>{item.text}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Where the repo check says the folder stands, under the path input. */
function RepoStatus({ check, checking }: { check: RepoCheck | null; checking: boolean }) {
  if (checking) return <p className="font-pixel text-xs text-ink-soft">Checking…</p>;
  if (!check) return null;
  const tone = check.state === "ready" ? "border-moss" : check.state === "needs_init" ? "border-mustard" : "border-terracotta";
  return (
    <div className={`flex flex-col gap-1.5 border-l-4 bg-cream/50 py-1.5 pl-3 pr-2 text-sm ${tone}`} role="status">
      <p className="break-words">{check.message}</p>
      {check.dirty_files && check.dirty_files.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {check.dirty_files.map((file) => (
            <li key={file} className="bg-cream-dark px-1.5 font-mono text-[11px]">{file}</li>
          ))}
          {(check.dirty_count ?? 0) > check.dirty_files.length && (
            <li className="font-pixel text-[11px] text-ink-soft">+{(check.dirty_count ?? 0) - check.dirty_files.length} more</li>
          )}
        </ul>
      )}
    </div>
  );
}

export default function NewRunForm() {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [loaded, setLoaded] = useState(false);
  const [config, setConfig] = useState<LaunchConfig | null>(null);
  const [toys, setToys] = useState<ToyRepo[] | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [repoCheck, setRepoCheck] = useState<RepoCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<{ message: string; busy: string | null } | null>(null);
  // The issue text came from a toy's ISSUE.md and hasn't been edited, so picking another toy may replace it.
  const issueFromToy = useRef(false);

  const update = (changes: Partial<Draft>) => setDraft((d) => ({ ...d, ...changes }));

  // Restore the draft from this tab's session (or fill it from ?from= / ?toy= / ?repo=), then keep saving it.
  useEffect(() => {
    let cancelled = false;
    const saved = loadDraft();
    const query = new URLSearchParams(window.location.search);
    const from = query.get("from");
    const apply = (events: RunEvent[] | null) => {
      if (cancelled) return;
      const filled = draftFromQuery(query, saved, events);
      if (filled?.source === "toy") issueFromToy.current = !filled.issue;
      setDraft(filled ?? saved);
      setLoaded(true);
      // Drop the query: from here on the draft is the source of truth.
      if (filled) window.history.replaceState(window.history.state, "", window.location.pathname);
    };
    if (from) fetchEvents(from).then(apply, () => apply(null));
    else apply(null);
    return () => {
      cancelled = true;
    };
  }, []);

  // A toy picked by the query starts with its ISSUE.md once the toys are known.
  useEffect(() => {
    if (!loaded || !toys || draft.source !== "toy" || !draft.toy || draft.issue.trim()) return;
    const toy = toys.find((t) => t.name === draft.toy);
    if (toy?.issue) {
      issueFromToy.current = true;
      update({ issue: toy.issue });
    }
  }, [loaded, toys, draft.source, draft.toy, draft.issue]);
  useEffect(() => {
    if (loaded) saveDraft(draft);
  }, [draft, loaded]);

  // Settings and toys; the settings are re-read so "busy" clears when a run ends.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      fetchConfig().then(
        (c) => {
          if (cancelled) return;
          setConfig(c);
          setApiError(null);
          timer = setTimeout(load, 5000);
        },
        (e: Error) => {
          if (cancelled) return;
          setApiError(e.message);
          timer = setTimeout(load, 5000);
        },
      );
    };
    load();
    fetchToyRepos().then((t) => !cancelled && setToys(t), () => !cancelled && setToys([]));
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  // Check the repo folder as it's typed (debounced; stale answers are dropped).
  useEffect(() => {
    const path = draft.repo.trim();
    if (draft.source !== "repo" || !path) {
      setRepoCheck(null);
      setChecking(false);
      return;
    }
    setChecking(true);
    let current = true;
    const timer = setTimeout(() => {
      checkRepo(path).then(
        (check) => {
          if (!current) return;
          setRepoCheck(check);
          setChecking(false);
        },
        (e: Error) => {
          if (!current) return;
          setRepoCheck({ state: "missing", path, message: `Couldn't check it: ${e.message}` });
          setChecking(false);
        },
      );
    }, CHECK_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [draft.repo, draft.source]);

  const items = useMemo(() => checklist(draft, config, repoCheck, checking), [draft, config, repoCheck, checking]);
  const ready = canStart(items) && !submitting;

  const pickToy = (toy: ToyRepo) => {
    const replace = !draft.issue.trim() || issueFromToy.current;
    issueFromToy.current = replace && !!toy.issue;
    update({ toy: toy.name, ...(replace ? { issue: toy.issue ?? "" } : {}) });
  };

  const submit = async () => {
    if (!ready) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // The draft stays saved, so "New run" again starts from the same settings.
      const runId = await startRun(toRequest(draft));
      router.push(`/runs/${encodeURIComponent(runId)}`);
    } catch (e) {
      const message = e instanceof ApiError ? e.message : `Couldn't reach the API at ${API_URL}`;
      const busy = e instanceof ApiError && e.status === 409 ? (message.match(/Run (\S+) is still going/)?.[1] ?? null) : null;
      setSubmitError({ message, busy });
      setSubmitting(false);
    }
  };

  // Ctrl/Cmd + Enter starts the run from anywhere on the page.
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        submitRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (apiError && !config) {
    return (
      <div className="pixel-box mt-6 bg-paper p-5 text-sm">
        <p className="font-pixel text-base font-bold text-terracotta">Can&apos;t reach the API</p>
        <p className="mt-2">
          Tried <code>{API_URL}</code> ({apiError}). Start it from the repo root with <code className="bg-cream-dark px-1">uv run patchwork serve</code>.
        </p>
      </div>
    );
  }

  const selectedToy = toys?.find((t) => t.name === draft.toy) ?? null;

  return (
    <form
      className="pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Link href="/" className="pixel-link font-pixel text-sm text-ink-soft hover:text-terracotta">← all runs</Link>
      <h1 className="mt-3 font-pixel text-2xl font-bold">New run</h1>
      <p className="mb-8 mt-1 max-w-2xl text-sm text-ink-soft">
        Point the crew at a repo and an issue. They work on their own git branches in temporary folders, so your files aren&apos;t touched; you
        merge the result when you&apos;re happy with it.
      </p>

      <div className="grid min-w-0 grid-cols-1 items-start gap-8 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="flex min-w-0 flex-col gap-8">
          {/* 1. Repo */}
          <Step n={1} title="Repo" hint="A toy repo to try things out, or one of yours.">
            <div className="flex gap-3" role="group" aria-label="Kind of repo">
              {(["toy", "repo"] as const).map((source) => (
                <button key={source} type="button" className="pixel-btn px-3 py-1 text-sm" aria-pressed={draft.source === source} onClick={() => update({ source })}>
                  {source === "toy" ? "Toy repo" : "My repo"}
                </button>
              ))}
            </div>

            {draft.source === "toy" ? (
              <div className="flex flex-col gap-3">
                {toys === null && <p className="font-pixel text-sm text-ink-soft">Loading toy repos…</p>}
                {toys?.length === 0 && <p className="text-sm text-ink-soft">No toy repos found (they live in toy_repos/ in a source checkout).</p>}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3" role="radiogroup" aria-label="Toy repos">
                  {toys?.map((toy) => {
                    const picked = draft.toy === toy.name;
                    return (
                      <button
                        key={toy.name}
                        type="button"
                        role="radio"
                        aria-checked={picked}
                        onClick={() => pickToy(toy)}
                        className={`pixel-box-sm flex min-w-0 flex-col gap-1.5 p-3 text-left transition-transform hover:-translate-y-0.5 ${picked ? "bg-[#fff6dc] outline-3 outline-dashed outline-offset-4 outline-mustard" : "bg-paper"}`}
                      >
                        <span className="font-mono text-sm font-bold">{toy.name}</span>
                        {toy.about && <span className="line-clamp-2 text-xs text-ink-soft">{toy.about}</span>}
                        <span className={`mt-auto self-start px-1.5 font-pixel text-[10px] uppercase tracking-wider ${toy.issue ? "bg-moss text-paper" : "bg-cream-dark text-ink"}`}>
                          {toy.issue ? "has ISSUE.md" : "write your own issue"}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs text-ink-soft">Each run gets a fresh copy in a temp folder, with git set up; the original stays as it is.</p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className="font-pixel text-xs uppercase tracking-wider text-ink-soft">Folder</span>
                  <input
                    type="text"
                    value={draft.repo}
                    onChange={(e) => update({ repo: e.target.value })}
                    placeholder="/Users/you/code/my-project"
                    spellCheck={false}
                    autoComplete="off"
                    className="pixel-input font-mono text-sm"
                    aria-describedby="repo-status"
                  />
                </label>
                <div id="repo-status">
                  <RepoStatus check={repoCheck} checking={checking} />
                </div>
                {repoCheck?.state === "needs_init" && (
                  <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                    <input type="checkbox" className="pixel-check mt-0.5" checked={draft.initGit} onChange={(e) => update({ initGit: e.target.checked })} />
                    <span>
                      <span className="font-pixel font-bold">Initialize git</span>
                      <span className="block text-xs text-ink-soft">Runs git init in this folder and commits everything in it.</span>
                    </span>
                  </label>
                )}
              </div>
            )}
          </Step>

          {/* 2. Issue */}
          <Step n={2} title="Issue" hint="What's broken or missing, as you'd write it in a GitHub issue. The clearer the expected behaviour, the better.">
            {draft.source === "repo" && repoCheck?.issue && repoCheck.issue.trim() !== draft.issue.trim() && (
              <button type="button" className="pixel-btn self-start px-3 py-1 text-xs" onClick={() => update({ issue: repoCheck.issue ?? "" })}>
                Use {repoCheck.issue_files?.[0] ?? "ISSUE.md"} from the repo
              </button>
            )}
            {draft.source === "toy" && selectedToy?.issue && selectedToy.issue.trim() !== draft.issue.trim() && (
              <button
                type="button"
                className="pixel-btn self-start px-3 py-1 text-xs"
                onClick={() => {
                  issueFromToy.current = true;
                  update({ issue: selectedToy.issue ?? "" });
                }}
              >
                Reset to {selectedToy.name}&apos;s ISSUE.md
              </button>
            )}
            <textarea
              value={draft.issue}
              onChange={(e) => {
                issueFromToy.current = false;
                update({ issue: e.target.value });
              }}
              rows={9}
              placeholder={"Add a median() function to stats/core.py.\nIt must handle an empty list by raising ValueError."}
              className="pixel-input min-h-40 resize-y font-mono text-sm leading-relaxed"
              aria-label="Issue"
            />
          </Step>

          {/* 3. Options */}
          <Step n={3} title="Options">
            <div className="flex flex-col gap-2">
              <span className="font-pixel text-xs uppercase tracking-wider text-ink-soft">Tester and coder</span>
              <div className="flex flex-wrap gap-3" role="group" aria-label="Tester and coder">
                <button type="button" className="pixel-btn px-3 py-1 text-sm" aria-pressed={!draft.sequential} onClick={() => update({ sequential: false })}>
                  Together
                </button>
                <button type="button" className="pixel-btn px-3 py-1 text-sm" aria-pressed={draft.sequential} onClick={() => update({ sequential: true })}>
                  One at a time
                </button>
              </div>
              <p className="text-xs text-ink-soft">
                {draft.sequential ? "The tester writes its tests first, then the coder starts: slower, fewer rate limits." : "The tester and the coder work in parallel: faster."}
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <span id="retries-label" className="font-pixel text-xs uppercase tracking-wider text-ink-soft">Coder retries</span>
              <div className="flex items-center gap-3" role="group" aria-labelledby="retries-label">
                {(() => {
                  const value = draft.maxRetries ?? config?.max_retries ?? 3;
                  return (
                    <>
                      <button type="button" className="pixel-btn h-8 w-8 text-sm" aria-label="Fewer retries" disabled={value <= 0} onClick={() => update({ maxRetries: Math.max(0, value - 1) })}>
                        −
                      </button>
                      <span className="w-6 text-center font-pixel text-lg tabular-nums" aria-live="polite">{value}</span>
                      <button type="button" className="pixel-btn h-8 w-8 text-sm" aria-label="More retries" disabled={value >= 10} onClick={() => update({ maxRetries: Math.min(10, value + 1) })}>
                        +
                      </button>
                    </>
                  );
                })()}
              </div>
              <p className="text-xs text-ink-soft">How many times the coder may try again when the tests fail or the reviewer finds a blocker.</p>
            </div>

            <details className="group">
              <summary className="flex cursor-pointer items-center gap-2 font-pixel text-sm text-ink-soft hover:text-ink">
                <span aria-hidden className="inline-block transition-transform group-open:rotate-90">▸</span>
                Advanced
              </summary>
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
                <label className="flex flex-col gap-1.5">
                  <span className="font-pixel text-xs uppercase tracking-wider text-ink-soft">Steps per agent</span>
                  <input
                    type="number"
                    min={1}
                    max={200}
                    value={draft.maxSteps ?? ""}
                    placeholder={String(config?.max_steps ?? 25)}
                    onChange={(e) => update({ maxSteps: e.target.value ? Math.max(1, Math.min(200, Number(e.target.value))) : null })}
                    className="pixel-input font-mono text-sm"
                  />
                </label>
                <label className="flex min-w-0 flex-col gap-1.5">
                  <span className="font-pixel text-xs uppercase tracking-wider text-ink-soft">Test command</span>
                  <input
                    type="text"
                    value={draft.testCmd}
                    placeholder={config?.test_command ?? "python -m pytest -q"}
                    onChange={(e) => update({ testCmd: e.target.value })}
                    spellCheck={false}
                    className="pixel-input font-mono text-sm"
                  />
                </label>
              </div>
              <p className="mt-2 text-xs text-ink-soft">Empty fields use the values from .env.</p>
            </details>
          </Step>
        </div>

        {/* Sidebar: the crew, the checklist and the start button */}
        <aside className="flex min-w-0 flex-col gap-6 lg:sticky lg:top-6" aria-label="Start">
          <section className="pixel-box flex flex-col gap-3 bg-paper p-4" aria-label="The crew">
            <h2 className="font-pixel text-sm font-bold">The crew</h2>
            {config ? (
              <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-xs">
                {(["lead", "tester", "coder", "reviewer"] as const).map((role) => (
                  <div key={role} className="contents">
                    <dt className="flex items-center gap-1.5 font-pixel">
                      <span aria-hidden className="inline-block h-2.5 w-2.5" style={{ background: AGENT_COLORS[role] }} />
                      {ROLE[role]}
                    </dt>
                    <dd className="truncate font-mono text-[11px]" title={config.models[role]}>{shortModel(config.models[role])}</dd>
                  </div>
                ))}
                {config.coder_retry_model !== config.models.coder && (
                  <div className="contents">
                    <dt className="font-pixel text-ink-soft">retries</dt>
                    <dd className="truncate font-mono text-[11px]" title={config.coder_retry_model}>{shortModel(config.coder_retry_model)}</dd>
                  </div>
                )}
              </dl>
            ) : (
              <p className="font-pixel text-xs text-ink-soft">Reading .env…</p>
            )}
            <p className="text-[11px] text-ink-soft">Models come from .env.</p>
          </section>

          <section className="pixel-box flex flex-col gap-4 bg-paper p-4" aria-label="Ready to start">
            <Checklist items={items} />
            {config?.busy && (
              <Link href={`/runs/${encodeURIComponent(config.busy)}`} className="pixel-btn inline-flex items-center gap-1.5 self-start px-3 py-1 text-xs text-terracotta">
                <span aria-hidden className="live-dot" /> watch run {config.busy}
              </Link>
            )}
            {submitError && (
              <div className="border-l-4 border-terracotta bg-cream/50 py-1.5 pl-3 pr-2 text-xs text-terracotta" role="alert">
                {submitError.message}
                {submitError.busy && (
                  <Link href={`/runs/${encodeURIComponent(submitError.busy)}`} className="mt-1 block underline">
                    Watch it →
                  </Link>
                )}
              </div>
            )}
            <button type="submit" disabled={!ready} className="pixel-btn start-btn w-full px-4 py-2.5 text-base font-bold">
              {submitting ? "Starting…" : "▶ Start the crew"}
            </button>
            <p className="text-center font-pixel text-[11px] text-ink-soft">or press Ctrl/⌘ + Enter</p>
          </section>
        </aside>
      </div>
    </form>
  );
}
