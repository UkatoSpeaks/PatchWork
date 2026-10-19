// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import ActivityLog from "@/components/ActivityLog";

import { describeEvent, filterLog, logEntries, seekTargetFor } from "./log";
import type { RunEvent } from "./types";

// jsdom's import.meta.url isn't a file URL: resolve from web/ (vitest's cwd).
const FIXTURE = resolve(process.cwd(), "../tests/fixtures/runs/20261019-120000-f1x7/events.jsonl");
const events: RunEvent[] = readFileSync(FIXTURE, "utf-8")
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("log entries", () => {
  const entries = logEntries(events);

  it("turns every event into a readable line", () => {
    expect(entries).toHaveLength(events.length);
    expect(entries[0]).toMatchObject({ index: 0, agent: "orchestrator", at: 0 });
    expect(entries[0].text).toContain("Add a median() function.");
    const throttled = entries.find((e) => events[e.index].type === "throttled")!;
    expect(throttled.text).toBe("Throttling to stay under the token limit: waiting 12s");
    expect(throttled.tone).toBe("wait");
    expect(describeEvent(events.find((e) => e.type === "review_verdict")!).text).toBe("Review round 1: changes requested, 1 note");
  });

  it("filters by agent", () => {
    const coder = filterLog(entries, "coder");
    expect(coder.length).toBeGreaterThan(0);
    expect(coder.every((e) => e.agent === "coder")).toBe(true);
    expect(filterLog(entries, "all")).toHaveLength(entries.length);
    expect(filterLog(entries, "orchestrator").every((e) => e.agent === "orchestrator")).toBe(true);
  });

  it("seeks to just after the clicked event", () => {
    expect(seekTargetFor(entries[10])).toBe(11);
  });
});

describe("ActivityLog", () => {
  let container: HTMLDivElement;
  afterEach(() => container?.remove());

  function render(props: Partial<Parameters<typeof ActivityLog>[0]> = {}) {
    container = document.createElement("div");
    document.body.appendChild(container);
    const onSeek = vi.fn();
    const onFilter = vi.fn();
    const root = createRoot(container);
    act(() => root.render(createElement(ActivityLog, { entries: logEntries(events), index: 20, filter: "all", onFilter, onSeek, ...props })));
    return { onSeek, onFilter, root };
  }

  it("seeks the replay when a line is clicked", () => {
    const { onSeek } = render();
    const line = container.querySelector<HTMLButtonElement>('[data-index="30"] button')!;
    act(() => line.click());
    expect(onSeek).toHaveBeenCalledWith(31);
  });

  it("shows only the chosen agent's lines and reports chip clicks", () => {
    const { onFilter } = render({ filter: "tester" });
    const rows = [...container.querySelectorAll("[data-index]")].map((li) => events[Number((li as HTMLElement).dataset.index)].agent);
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows)).toEqual(new Set(["tester"]));
    const chip = [...container.querySelectorAll("button")].find((b) => b.textContent === "Coder")!;
    act(() => chip.click());
    expect(onFilter).toHaveBeenCalledWith("coder");
  });

  it("marks the current event and dims the ones still to come", () => {
    render({ index: 5 });
    expect(container.querySelector('[data-index="4"] button')!.getAttribute("aria-current")).toBe("step");
    expect(container.querySelector('[data-index="10"] button')!.className).toContain("opacity-45");
  });
});
