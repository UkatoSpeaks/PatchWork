"use client";

import { useEffect, useState } from "react";

/** Copies `text` to the clipboard and says so for a moment. */
export default function CopyButton({ text, label = "copy", className = "" }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 1600);
    return () => clearTimeout(timer);
  }, [state]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      className={`pixel-btn shrink-0 px-2 py-0.5 text-[11px] ${state === "copied" ? "text-moss" : state === "failed" ? "text-terracotta" : ""} ${className}`}
      aria-live="polite"
    >
      {state === "copied" ? "copied ✓" : state === "failed" ? "can't copy" : label}
    </button>
  );
}
