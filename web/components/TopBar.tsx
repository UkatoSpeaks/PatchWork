import Link from "next/link";

import { formatDuration, formatTokens, modeLabel } from "@/lib/api";
import { elapsedSeconds, type SceneState } from "@/lib/office/reducer";

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="font-pixel text-[11px] uppercase tracking-wider text-ink-soft">{label}</dt>
      <dd className="truncate font-pixel text-base tabular-nums">{children}</dd>
    </div>
  );
}

export default function TopBar({ runId, scene }: { runId: string; scene: SceneState }) {
  const phaseColor =
    scene.outcome === "success" ? "bg-moss text-paper" : scene.outcome === "failure" ? "bg-terracotta text-paper" : "bg-mustard text-ink";
  return (
    <div className="pixel-box flex flex-col gap-3 bg-paper p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href="/" className="pixel-link font-pixel text-sm text-ink-soft hover:text-terracotta">← all runs</Link>
        {scene.issue && (
          <p className="min-w-0 flex-1 truncate text-right text-xs text-ink-soft sm:text-sm" title={scene.issue}>
            {scene.issue.split("\n")[0]}
          </p>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-5">
        <Stat label="run">{runId}</Stat>
        <Stat label="mode">{modeLabel(scene)}</Stat>
        <Stat label="phase">
          <span className={`pixel-box-sm inline-block px-1.5 text-sm ${phaseColor}`}>{scene.phaseLabel}</span>
        </Stat>
        <Stat label="elapsed">{formatDuration(elapsedSeconds(scene))}</Stat>
        <Stat label="tokens">{formatTokens(scene.totalTokens)}</Stat>
      </dl>
    </div>
  );
}
