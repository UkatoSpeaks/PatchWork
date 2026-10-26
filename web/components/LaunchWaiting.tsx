"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import type { LaunchStatus } from "@/lib/types";

import CopyButton from "./CopyButton";

/**
 * Shown on a run's page between starting it and its first event: the crew is
 * getting ready, or the process stopped before the run began (with its output).
 */
export default function LaunchWaiting({ launch }: { launch: LaunchStatus }) {
  // Count up between polls so the wait feels alive.
  const [shown, setShown] = useState(launch.seconds);
  useEffect(() => {
    setShown(launch.seconds);
    if (launch.state === "exited") return;
    const timer = setInterval(() => setShown((s) => s + 0.1), 100);
    return () => clearInterval(timer);
  }, [launch.seconds, launch.state]);

  if (launch.state === "exited" && !launch.has_events) {
    return (
      <section className="pixel-box mt-6 flex min-w-0 bg-paper" aria-label="The run didn't start">
        <div aria-hidden className="w-2 shrink-0 bg-terracotta" />
        <div className="flex min-w-0 flex-1 flex-col gap-4 p-5">
          <div>
            <h1 className="font-pixel text-2xl font-bold">The run stopped before it began</h1>
            <p className="mt-1 text-sm">
              <code className="bg-cream-dark px-1">patchwork run</code> exited with code {launch.exit_code} before writing any events. Its output is below.
            </p>
          </div>
          {launch.log && (
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-pixel text-[11px] uppercase tracking-wider text-ink-soft">Console output</h2>
                <CopyButton text={launch.log} />
              </div>
              <pre className="pixel-scroll max-h-96 overflow-auto bg-charcoal px-4 py-3 font-mono text-xs leading-[1.6] text-cream">{launch.log}</pre>
            </div>
          )}
          <div className="flex flex-wrap gap-3">
            <Link href="/runs/new" className="pixel-btn start-btn px-4 py-1.5 text-sm font-bold">
              ← Back to New run
            </Link>
            <Link href="/" className="pixel-btn px-4 py-1.5 text-sm">
              All runs
            </Link>
          </div>
        </div>
      </section>
    );
  }

  const steps = [
    { done: true, text: "Process started" },
    { done: launch.has_events, text: "The lead is reading the repo and the issue…" },
  ];
  return (
    <section className="pixel-box mt-6 flex flex-col items-center gap-6 bg-paper px-5 py-12 text-center" aria-live="polite" aria-label="Starting the run">
      <div aria-hidden className="launch-crew flex gap-2">
        {["#c0583f", "#5f9a57", "#4f7cac", "#8e6bb0"].map((color, i) => (
          <span key={color} className="h-6 w-6" style={{ background: color, animationDelay: `${i * 150}ms` }} />
        ))}
      </div>
      <div>
        <h1 className="font-pixel text-2xl font-bold">Getting the crew ready…</h1>
        <p className="mt-1 font-mono text-xs text-ink-soft">
          run {launch.run_id} · {shown.toFixed(0)}s
        </p>
      </div>
      <ol className="flex flex-col gap-2 text-left text-sm">
        {steps.map((step) => (
          <li key={step.text} className="flex items-center gap-2.5">
            <span aria-hidden className={`grid h-5 w-5 place-items-center font-pixel text-xs font-bold ${step.done ? "bg-moss text-paper" : "bg-cream-dark text-ink"}`}>
              {step.done ? "✓" : "…"}
            </span>
            {step.text}
          </li>
        ))}
      </ol>
      <p className="max-w-md break-all font-mono text-[11px] text-ink-soft">{launch.repo}</p>
    </section>
  );
}
