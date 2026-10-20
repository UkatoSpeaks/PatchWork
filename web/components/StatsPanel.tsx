import { formatDuration, formatTokens } from "@/lib/api";
import { PHASE_COLORS, WORK_COLORS, type AgentStats } from "@/lib/stats";

import { ROLE } from "./AgentCard";
import AttemptList from "./AttemptList";

const secs = (s: number) => (s < 10 ? `${s.toFixed(1)}s` : formatDuration(s));

function Swatch({ color }: { color: string }) {
  return <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0" style={{ background: color }} />;
}

/** Per-agent numbers, phase durations, and time spent waiting on rate limits vs working. */
export default function StatsPanel({ agents, phases }: { agents: AgentStats[]; phases: { phase: string; seconds: number }[] }) {
  const phaseTotal = phases.reduce((n, p) => n + p.seconds, 0);
  const longest = Math.max(1, ...agents.map((a) => a.seconds));
  return (
    <div className="flex flex-col gap-6 text-sm">
      <div className="pixel-scroll overflow-x-auto">
        <table className="w-full min-w-[30rem] border-collapse text-left font-pixel text-xs">
          <caption className="sr-only">Per-agent totals</caption>
          <thead className="text-ink-soft">
            <tr>
              {["agent", "runs", "steps", "tokens", "time", "waiting", "working"].map((h, i) => (
                <th key={h} scope="col" className={`border-b-2 border-ink/20 px-2 py-1 font-normal uppercase tracking-wider ${i ? "text-right" : ""}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {agents.map((a) => (
              <tr key={a.agent} className="border-b border-ink/10">
                <th scope="row" className="px-2 py-1.5 font-bold">{ROLE[a.agent]}</th>
                <td className="px-2 text-right">{a.runs}</td>
                <td className="px-2 text-right">{a.steps}</td>
                <td className="px-2 text-right">{formatTokens(a.tokens)}</td>
                <td className="px-2 text-right">{secs(a.seconds)}</td>
                <td className="px-2 text-right">{secs(a.waiting)}</td>
                <td className="px-2 text-right">{secs(a.working)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {agents.some((a) => a.attempts.length > 0) && (
        <section aria-label="Model per attempt" className="flex flex-col gap-2">
          <h3 className="font-pixel text-sm font-bold">Model per attempt</h3>
          <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2 gap-y-2 sm:max-w-[32rem]">
            {agents.filter((a) => a.attempts.length > 0).map((a) => (
              <div key={a.agent} className="contents">
                <span className="font-pixel text-xs font-bold">{ROLE[a.agent]}</span>
                <AttemptList attempts={a.attempts} className="text-xs" />
              </div>
            ))}
          </div>
        </section>
      )}

      {phases.length > 0 && (
        <section aria-label="Phase durations" className="flex flex-col gap-2">
          <h3 className="font-pixel text-sm font-bold">Phase durations <span className="font-normal text-ink-soft">({secs(phaseTotal)} in total)</span></h3>
          <div className="flex h-5 gap-[2px]" role="img" aria-label={phases.map((p) => `${p.phase} ${secs(p.seconds)}`).join(", ")}>
            {phases.map((p) => (
              <div
                key={p.phase}
                title={`${p.phase}: ${secs(p.seconds)} (${Math.round((p.seconds / Math.max(phaseTotal, 0.001)) * 100)}%)`}
                className="min-w-[3px] hover:brightness-110"
                style={{ flexGrow: p.seconds, flexBasis: 0, background: PHASE_COLORS[p.phase] ?? "#cbbf9f" }}
              />
            ))}
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 font-pixel text-xs">
            {phases.map((p) => (
              <li key={p.phase} className="flex items-center gap-1.5">
                <Swatch color={PHASE_COLORS[p.phase] ?? "#cbbf9f"} />
                {p.phase} <span className="tabular-nums text-ink-soft">{secs(p.seconds)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {agents.length > 0 && (
        <section aria-label="Working versus waiting on rate limits" className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-pixel text-sm font-bold">Working vs waiting on rate limits</h3>
            <ul className="flex gap-3 font-pixel text-xs">
              <li className="flex items-center gap-1.5"><Swatch color={WORK_COLORS.working} />working</li>
              <li className="flex items-center gap-1.5"><Swatch color={WORK_COLORS.waiting} />waiting</li>
            </ul>
          </div>
          <div className="flex flex-col gap-2">
            {agents.map((a) => {
              const share = a.seconds ? Math.round((a.waiting / a.seconds) * 100) : 0;
              return (
                <div key={a.agent} className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 font-pixel text-xs sm:grid-cols-[4.5rem_minmax(0,1fr)_9rem]">
                  <span className="font-bold">{ROLE[a.agent]}</span>
                  <div className="flex h-4 gap-[2px]" style={{ width: `${(a.seconds / longest) * 100}%` }}>
                    {a.working > 0 && (
                      <div title={`${ROLE[a.agent]} working: ${secs(a.working)}`} style={{ flexGrow: a.working, flexBasis: 0, background: WORK_COLORS.working }} />
                    )}
                    {a.waiting > 0 && (
                      <div title={`${ROLE[a.agent]} waiting: ${secs(a.waiting)}`} style={{ flexGrow: a.waiting, flexBasis: 0, background: WORK_COLORS.waiting }} />
                    )}
                  </div>
                  <span className="col-start-2 tabular-nums text-ink-soft sm:col-start-auto">
                    {secs(a.seconds)} · {share}% waiting
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
