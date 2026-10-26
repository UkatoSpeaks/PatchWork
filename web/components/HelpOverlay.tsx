"use client";

import { useEffect, useRef } from "react";

const SECTIONS: { title: string; rows: [keys: string[], what: string][] }[] = [
  {
    title: "Playback",
    rows: [
      [["Space"], "Play / pause"],
      [["←", "→"], "Step one event back / forward"],
      [["1", "2", "3", "4"], "Speed 1x, 2x, 4x, 8x"],
      [["L"], "Go live (a run that's still going)"],
    ],
  },
  {
    title: "Events",
    rows: [
      [["click a log line"], "Open the event's details, and show the office right after it"],
      [["click the current event"], "The text under the scrubber: open the event you're on"],
      [["←", "→"], "With the details open: the previous / next event"],
      [["Esc"], "Close the details (or this help)"],
    ],
  },
  {
    title: "The office",
    rows: [
      [["click a character"], "Follow that agent in the log (click again for everyone)"],
      [["click the whiteboard"], "Open the lead's plan"],
      [["click a phase"], "In the coloured bar under the scrubber: jump to that phase"],
    ],
  },
  {
    title: "Links",
    rows: [
      [["?at=N"], "Open the run paused after N events"],
      [["?event=N"], "Open event N's details (the address bar keeps it in step)"],
      [["?tab=diff"], "Open a tab: plan, diff or stats"],
    ],
  },
];

/** Keys and clickable things on a run's page. */
export default function HelpOverlay({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const previous = useRef<Element | null>(null);

  useEffect(() => {
    previous.current = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (previous.current instanceof HTMLElement) previous.current.focus();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/45 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        className="help-panel pixel-box pixel-scroll flex max-h-[calc(100dvh-2rem)] w-full max-w-2xl flex-col gap-5 overflow-y-auto bg-paper p-6"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          // Keep Tab inside the panel: its only control is the close button.
          if (event.key === "Tab") {
            event.preventDefault();
            closeRef.current?.focus();
          }
        }}
      >
        <div className="flex items-center justify-between gap-4">
          <h2 id="help-title" className="font-pixel text-xl font-bold">Keys and clicks</h2>
          <button ref={closeRef} type="button" className="pixel-btn px-2 py-0.5 text-sm" onClick={onClose} aria-label="Close help">
            ✕
          </button>
        </div>
        <div className="grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2">
          {SECTIONS.map((section) => (
            <section key={section.title} className="flex flex-col gap-2.5">
              <h3 className="font-pixel text-[11px] uppercase tracking-wider text-ink-soft">{section.title}</h3>
              <dl className="flex flex-col gap-2">
                {section.rows.map(([keys, what]) => (
                  <div key={what} className="flex flex-col gap-1">
                    <dt className="flex flex-wrap gap-1">
                      {keys.map((key) =>
                        key.length <= 6 ? (
                          <kbd key={key} className="pixel-key">{key}</kbd>
                        ) : (
                          <span key={key} className="font-pixel text-xs font-bold">{key}</span>
                        ),
                      )}
                    </dt>
                    <dd className="text-xs leading-snug text-ink-soft">{what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <p className="border-t-2 border-dashed border-ink/20 pt-3 font-pixel text-[11px] text-ink-soft">Press ? any time to open this again.</p>
      </div>
    </div>
  );
}
