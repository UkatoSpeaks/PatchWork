import { shortModel } from "@/lib/api";
import type { Attempt } from "@/lib/office/reducer";

const OUTCOME: Record<Attempt["outcome"], { mark: string; className: string; label: string }> = {
  running: { mark: "…", className: "text-ink-soft", label: "running" },
  passed: { mark: "✓", className: "text-moss", label: "passed" },
  failed: { mark: "✗", className: "text-terracotta", label: "failed" },
  cancelled: { mark: "–", className: "text-ink-soft", label: "cancelled" },
};

/** Whether the attempts are worth listing: more than one, or a model switch within one. */
export const showAttempts = (attempts: Attempt[]) => attempts.length > 1 || attempts.some((a) => a.models.length > 1);

/** Each run of an agent with the model(s) it used: "attempt 1  gpt-oss-20b ✗", "retry 1  gpt-oss-120b ✓". */
export default function AttemptList({ attempts, className = "" }: { attempts: Attempt[]; className?: string }) {
  return (
    <ol className={`flex w-full flex-col gap-0.5 font-pixel text-[11px] ${className}`}>
      {attempts.map((a, i) => {
        const outcome = OUTCOME[a.outcome];
        const models = a.models.map(shortModel).join(" → ") || "-";
        return (
          <li key={i} className="flex min-w-0 items-baseline gap-2" title={`${a.label}: ${a.models.join(" → ")} (${outcome.label})`}>
            <span className="shrink-0 text-ink-soft">{a.label}</span>
            <span className="min-w-0 flex-1 truncate text-right font-mono">{models}</span>
            <span className={`shrink-0 ${outcome.className}`} aria-label={outcome.label}>{outcome.mark}</span>
          </li>
        );
      })}
    </ol>
  );
}
