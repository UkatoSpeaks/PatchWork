"use client";

import type { Outcome } from "@/lib/outcome";

import CopyButton from "./CopyButton";
import { TONE_PILL } from "./DetailBlocks";

const LOOK: Record<Outcome["verdict"], { edge: string; badge: string; mark: string }> = {
  success: { edge: "bg-moss", badge: "bg-moss text-paper", mark: "✓" },
  failure: { edge: "bg-terracotta", badge: "bg-terracotta text-paper", mark: "✗" },
  stopped: { edge: "bg-[#9a948c]", badge: "bg-[#9a948c] text-paper", mark: "■" },
};

const ATTEMPT_MARK = {
  passed: { mark: "✓", className: "text-moss" },
  failed: { mark: "✗", className: "text-terracotta" },
  cancelled: { mark: "–", className: "text-ink-soft" },
} as const;

interface Props {
  outcome: Outcome;
  onOpenEvent: (index: number) => void;
  onShowDiff: () => void;
}

/** How the run ended: verdict, why, checks, the coder's attempts, and what to do next. */
export default function ResultBanner({ outcome, onOpenEvent, onShowDiff }: Props) {
  const look = LOOK[outcome.verdict];
  const commands = outcome.next?.lines.join("\n") ?? "";
  return (
    <section aria-label="Run result" className="result-banner pixel-box flex min-w-0 bg-paper">
      <div aria-hidden className={`w-2 shrink-0 ${look.edge}`} />
      <div className="flex min-w-0 flex-1 flex-col gap-5 p-5">
        {/* Verdict and why */}
        <div className="flex flex-wrap items-start gap-4">
          <span aria-hidden className={`pixel-box-sm grid h-12 w-12 shrink-0 place-items-center font-pixel text-2xl font-bold ${look.badge}`}>
            {look.mark}
          </span>
          <div className="min-w-0 flex-1 basis-[16rem]">
            <h2 className="font-pixel text-2xl font-bold leading-tight">{outcome.headline}</h2>
            <p className="mt-1 break-words text-sm leading-relaxed">{outcome.reason}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            {outcome.changes && (
              <button type="button" className="pixel-btn px-3 py-1.5 text-sm" onClick={onShowDiff}>
                View diff
              </button>
            )}
            {outcome.keyEvent && (
              <button type="button" className="pixel-btn px-3 py-1.5 text-sm" onClick={() => onOpenEvent(outcome.keyEvent!.index)} title={outcome.keyEvent.label}>
                {outcome.verdict === "stopped" ? "See the last event" : outcome.keyEvent.label} →
              </button>
            )}
          </div>
        </div>

        {/* Checks and size of the change */}
        {(outcome.checks.length > 0 || outcome.changes) && (
          <dl className="flex flex-wrap gap-x-6 gap-y-3">
            {outcome.checks.map((check) => (
              <div key={check.label} className="flex items-center gap-2">
                <dt className="font-pixel text-xs uppercase tracking-wider text-ink-soft">{check.label}</dt>
                <dd className={`px-1.5 font-pixel text-xs font-bold uppercase ${TONE_PILL[check.tone]}`}>{check.value}</dd>
              </div>
            ))}
            {outcome.changes && (
              <div className="flex items-center gap-2">
                <dt className="font-pixel text-xs uppercase tracking-wider text-ink-soft">Changed</dt>
                <dd className="font-pixel text-sm tabular-nums">
                  {outcome.changes.files} file{outcome.changes.files === 1 ? "" : "s"} <span className="text-moss">+{outcome.changes.additions}</span>{" "}
                  <span className="text-terracotta">−{outcome.changes.deletions}</span>
                </dd>
              </div>
            )}
          </dl>
        )}

        {/* The coder's path: first try, then each retry */}
        {outcome.attempts.length > 0 && (
          <div className="flex flex-col gap-2">
            <h3 className="font-pixel text-[11px] uppercase tracking-wider text-ink-soft">Coder attempts</h3>
            <ol className="flex flex-wrap items-center gap-2">
              {outcome.attempts.map((a, i) => (
                <li key={i} className="flex items-center gap-2">
                  {i > 0 && <span aria-hidden className="font-pixel text-ink-soft">→</span>}
                  <span className="pixel-box-sm flex items-baseline gap-2 bg-cream/60 px-2 py-1 text-xs" title={`${a.label}: ${a.models}, ${a.detail}`}>
                    <span className="font-pixel font-bold">{a.label}</span>
                    <span className="font-mono text-[11px] text-ink-soft">{a.models}</span>
                    <span className={`font-pixel font-bold ${ATTEMPT_MARK[a.outcome].className}`} aria-label={a.outcome}>
                      {ATTEMPT_MARK[a.outcome].mark}
                    </span>
                    {a.outcome !== "passed" && <span className="text-[11px] text-ink-soft">{a.detail}</span>}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* What's still wrong */}
        {outcome.blockers.length > 0 && (
          <div className="flex flex-col gap-2">
            <h3 className="font-pixel text-[11px] uppercase tracking-wider text-ink-soft">Open blockers</h3>
            <ul className="flex flex-col gap-1.5">
              {outcome.blockers.map((b, i) => (
                <li key={i} className="border-l-4 border-terracotta bg-cream/50 py-1 pl-3 pr-2 text-sm">
                  {b.file && <span className="mr-2 font-mono text-xs text-ink-soft">{b.file}</span>}
                  {b.description}
                </li>
              ))}
            </ul>
          </div>
        )}
        {outcome.failingTests.length > 0 && (
          <div className="flex flex-col gap-2">
            <h3 className="font-pixel text-[11px] uppercase tracking-wider text-ink-soft">Still failing</h3>
            <ul className="flex flex-col gap-1.5">
              {outcome.failingTests.map((t, i) => (
                <li key={i} className="break-words border-l-4 border-terracotta bg-cream/50 py-1 pl-3 pr-2 font-mono text-xs">{t}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Next steps in git */}
        {outcome.next && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-pixel text-[11px] uppercase tracking-wider text-ink-soft">{outcome.next.title}</h3>
              {commands && <CopyButton text={commands} label="copy commands" />}
            </div>
            {outcome.next.note && <p className="text-sm text-ink-soft">{outcome.next.note}</p>}
            {commands && (
              <pre className="pixel-scroll overflow-x-auto bg-charcoal px-4 py-3 font-mono text-xs leading-[1.7] text-cream">
                {outcome.next.lines.map((line, i) => {
                  const [cmd, comment] = line.split(/(?=\s+#)/);
                  return (
                    <div key={i}>
                      <span aria-hidden className="select-none text-mustard">$ </span>
                      {cmd}
                      {comment && <span className="text-cream/45">{comment}</span>}
                    </div>
                  );
                })}
              </pre>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
