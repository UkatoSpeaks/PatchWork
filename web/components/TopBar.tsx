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

export default function TopBar({ runId, scene, issue }: { runId: string; scene: SceneState; issue: string }) {
  const phaseColor =
    scene.outcome === "success" ? "bg-moss text-paper" : scene.outcome === "failure" ? "bg-terracotta text-paper" : "bg-mustard text-ink";
  const text = (issue || scene.issue).trim();
  const oneLine = text.replace(/\s+/g, " ");
  return (
    <div className="pixel-box flex flex-col gap-3 bg-paper p-4">
      <div className="flex min-w-0 items-center gap-4">
        <Link href="/" className="pixel-link shrink-0 font-pixel text-sm text-ink-soft hover:text-terracotta">← all runs</Link>
        {oneLine && (
          <p className="min-w-0 flex-1 truncate text-sm" title={text}>
            <span className="font-pixel text-ink-soft">issue: </span>
            {oneLine}
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
