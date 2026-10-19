import { AGENT_COLORS } from "@/lib/office/sprites";
import type { Plan, Subtask } from "@/lib/types";

const ROLE_TITLE: Record<Subtask["role"], string> = { tester: "Tester: tests", coder: "Coder: code" };

/** The lead's plan: subtasks per role with acceptance criteria, and the risks. */
export default function PlanPanel({ plan }: { plan: Plan | null }) {
  if (!plan) {
    return <p className="p-2 text-sm text-ink-soft">No plan yet: the lead hasn&apos;t finished planning in this run.</p>;
  }
  const roles = (["tester", "coder"] as const).filter((role) => plan.subtasks.some((s) => s.role === role));
  return (
    <div className="flex flex-col gap-5 text-sm">
      <p className="font-pixel text-base leading-snug">{plan.issue_summary}</p>
      {roles.map((role) => (
        <section key={role} aria-label={ROLE_TITLE[role]} className="flex flex-col gap-3">
          <h3 className="flex items-center gap-2 font-pixel text-sm font-bold">
            <span aria-hidden className="inline-block h-3 w-3" style={{ background: AGENT_COLORS[role] }} />
            {ROLE_TITLE[role]}
          </h3>
          {plan.subtasks.filter((s) => s.role === role).map((task) => (
            <article key={task.id} className="pixel-box-sm flex flex-col gap-2 bg-paper p-3">
              <p>
                <span className="mr-2 font-mono text-xs text-ink-soft">{task.id}</span>
                {task.description}
              </p>
              {task.files_hint.length > 0 && (
                <ul className="flex flex-wrap gap-1.5" aria-label="Files">
                  {task.files_hint.map((file) => (
                    <li key={file} className="bg-cream-dark px-1.5 font-mono text-[11px]">{file}</li>
                  ))}
                </ul>
              )}
              {task.acceptance_criteria.length > 0 && (
                <div>
                  <p className="font-pixel text-xs text-ink-soft">Done when</p>
                  <ul className="mt-1 flex flex-col gap-1">
                    {task.acceptance_criteria.map((c, i) => (
                      <li key={i} className="flex gap-2">
                        <span aria-hidden className="text-moss">✓</span>
                        <span>{c}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </article>
          ))}
        </section>
      ))}
      {plan.risks.length > 0 && (
        <section aria-label="Risks" className="flex flex-col gap-2">
          <h3 className="font-pixel text-sm font-bold">Risks</h3>
          <ul className="flex flex-col gap-1">
            {plan.risks.map((risk, i) => (
              <li key={i} className="flex gap-2">
                <span aria-hidden className="text-terracotta">!</span>
                <span>{risk}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
