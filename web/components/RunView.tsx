"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { API_URL, fetchEvents, fetchRun, streamEvents } from "@/lib/api";
import { fileRoles } from "@/lib/diff";
import { logEntries, type LogFilter } from "@/lib/log";
import { CREW, initialScene, isCrew, officeReducer, reduceEvents, type SceneState } from "@/lib/office/reducer";
import { agentStats, phaseDurations, phaseSegments } from "@/lib/stats";
import type { CrewAgent, Plan, RunDetail, RunEvent } from "@/lib/types";

import ActivityLog from "./ActivityLog";
import AgentCard from "./AgentCard";
import InfoPanels, { type InfoTab } from "./InfoPanels";
import OfficeCanvas from "./OfficeCanvas";
import ReplayControls, { SPEEDS } from "./ReplayControls";
import TopBar from "./TopBar";

function describe(event: RunEvent | undefined): string {
  if (!event) return "start";
  return `#${event.seq} ${event.agent} · ${event.type}`;
}

/** The plan from the run detail, else from the lead's finished run in the log. */
function planFrom(detail: RunDetail | null, events: RunEvent[] | null): Plan | null {
  if (detail?.plan) return detail.plan;
  const finished = events?.findLast((e) => e.agent === "lead" && e.type === "agent_finished" && e.payload?.output?.subtasks);
  return (finished?.payload.output as Plan | undefined) ?? null;
}

/** Keys typed into these don't drive the replay. */
const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/**
 * Replays a run. Normal playback streams events over SSE (/stream) and feeds
 * them to the reducer one by one; seeking rebuilds the scene by reducing
 * events[0..n] from the full log fetched once (/events).
 */
export default function RunView({ id }: { id: string }) {
  const [events, setEvents] = useState<RunEvent[] | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scene, setScene] = useState<SceneState>(initialScene);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [snapKey, setSnapKey] = useState(0);
  const [walking, setWalking] = useState<CrewAgent[]>([]);
  const [saying, setSaying] = useState<Partial<Record<CrewAgent, string>>>({});
  const [selected, setSelected] = useState<CrewAgent | null>(null);
  const [logFilter, setLogFilter] = useState<LogFilter>("all");
  const [tab, setTab] = useState<InfoTab>("plan");
  const indexRef = useRef(0);
  const closeRef = useRef<(() => void) | null>(null);
  const panelsRef = useRef<HTMLElement>(null);

  const stop = useCallback(() => {
    closeRef.current?.();
    closeRef.current = null;
  }, []);

  const start = useCallback(
    (from: number, atSpeed: number) => {
      stop();
      closeRef.current = streamEvents(id, { speed: atSpeed, start: from }, {
        onEvent: (event, i) => {
          // Ignore anything that doesn't follow on from where we are (e.g. after a seek).
          if (i !== indexRef.current) return;
          indexRef.current = i + 1;
          setIndex(i + 1);
          setScene((s) => officeReducer(s, event));
        },
        onEnd: () => {
          closeRef.current = null;
          setPlaying(false);
        },
        onError: () => {
          closeRef.current = null;
          setPlaying(false);
          setError(`lost the event stream from ${API_URL}`);
        },
      });
      setPlaying(true);
    },
    [id, stop],
  );

  useEffect(() => {
    let cancelled = false;
    fetchEvents(id).then(
      (loaded) => {
        if (cancelled) return;
        setEvents(loaded);
        // ?tab=plan|diff|stats opens that panel.
        const tabParam = new URLSearchParams(window.location.search).get("tab");
        if (tabParam === "plan" || tabParam === "diff" || tabParam === "stats") setTab(tabParam);
        // ?at=N opens the run paused after N events.
        const at = Number(new URLSearchParams(window.location.search).get("at"));
        if (Number.isInteger(at) && at > 0) {
          const target = Math.min(at, loaded.length);
          indexRef.current = target;
          setIndex(target);
          setScene(reduceEvents(loaded, target));
          setSnapKey((k) => k + 1);
        } else {
          start(0, 4);
        }
      },
      (e: Error) => !cancelled && setError(e.message),
    );
    // The detail (plan, result with the diff) is optional: the scene works without it.
    fetchRun(id).then((d) => !cancelled && setDetail(d), () => undefined);
    return () => {
      cancelled = true;
      stop();
    };
  }, [id, start, stop]);

  const seek = useCallback(
    (n: number, resume = playing) => {
      if (!events) return;
      stop();
      const target = Math.max(0, Math.min(events.length, n));
      indexRef.current = target;
      setIndex(target);
      setScene(reduceEvents(events, target));
      setSnapKey((k) => k + 1);
      if (resume && target < events.length) start(target, speed);
      else setPlaying(false);
    },
    [events, playing, speed, start, stop],
  );

  const playPause = () => {
    if (!events) return;
    if (playing) {
      stop();
      setPlaying(false);
    } else if (indexRef.current >= events.length) {
      seek(0, true);
    } else {
      start(indexRef.current, speed);
    }
  };

  const changeSpeed = (s: number) => {
    setSpeed(s);
    if (playing) start(indexRef.current, s);
  };

  const select = (agent: CrewAgent | null) => {
    setSelected(agent);
    setLogFilter(agent ?? "all");
  };

  const filterLog = (filter: LogFilter) => {
    setLogFilter(filter);
    setSelected(isCrew(filter) ? filter : null);
  };

  const openPlan = () => {
    setTab("plan");
    panelsRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  // Keyboard: space plays / pauses, left / right step one event, 1-4 pick the speed.
  const keys = useRef({ playPause, seek, changeSpeed, index });
  keys.current = { playPause, seek, changeSpeed, index };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || typing(event.target)) return;
      const k = keys.current;
      if (event.key === " " && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault();
        k.playPause();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        k.seek(k.index + (event.key === "ArrowLeft" ? -1 : 1), false);
      } else if (/^[1-4]$/.test(event.key)) {
        k.changeSpeed(SPEEDS[Number(event.key) - 1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const entries = useMemo(() => logEntries(events ?? []), [events]);
  const phases = useMemo(() => phaseSegments(events ?? []), [events]);
  const stats = useMemo(() => agentStats(events ?? []), [events]);
  const durations = useMemo(() => phaseDurations(events ?? [], detail?.result ?? null), [events, detail]);
  const roleOf = useMemo(() => fileRoles(events ?? [], detail?.result ?? null), [events, detail]);
  const plan = planFrom(detail, events);

  if (error && !events) {
    return (
      <div className="pixel-box mt-6 bg-paper p-5 text-sm">
        <p className="font-pixel text-base font-bold text-terracotta">Couldn&apos;t load run {id}</p>
        <p className="mt-2">{error}. Is <code className="bg-cream-dark px-1">uv run patchwork serve</code> running?</p>
      </div>
    );
  }

  const shown = CREW.filter((name) => scene.agents[name].inRun);

  return (
    <div className="mt-4 flex min-w-0 flex-col gap-8 [&>*]:min-w-0">
      <TopBar runId={id} scene={scene} issue={detail?.result?.issue ?? ""} />
      <OfficeCanvas
        scene={scene}
        snapKey={snapKey}
        speed={speed}
        playing={playing}
        selected={selected}
        onSelect={select}
        onWhiteboard={openPlan}
        onWalkingChange={setWalking}
        onBubblesChange={setSaying}
      />
      <ReplayControls
        playing={playing}
        speed={speed}
        index={index}
        total={events?.length ?? 0}
        current={events ? describe(events[index - 1]) : "loading events…"}
        phases={phases}
        onPlayPause={playPause}
        onRestart={() => seek(0, true)}
        onSpeed={changeSpeed}
        onSeek={(n) => seek(n)}
      />
      {error && <p className="font-pixel text-sm text-terracotta">{error}</p>}
      <section aria-label="Agents" className="flex flex-wrap gap-8">
        {shown.map((name) => (
          <AgentCard
            key={name}
            agent={scene.agents[name]}
            walking={walking.includes(name)}
            maxSteps={scene.maxSteps}
            maxTokens={scene.maxTokens}
            now={saying[name] ?? null}
            selected={selected === name}
            onSelect={() => select(selected === name ? null : name)}
          />
        ))}
      </section>
      <div className="grid min-w-0 grid-cols-1 gap-8 lg:grid-cols-2 [&>*]:min-w-0">
        <ActivityLog entries={entries} index={index} filter={logFilter} onFilter={filterLog} onSeek={(n) => seek(n, false)} />
        <InfoPanels
          ref={panelsRef}
          tab={tab}
          onTab={setTab}
          plan={plan}
          diff={String(detail?.result?.diff ?? "")}
          roleOf={roleOf}
          agents={stats}
          phases={durations}
        />
      </div>
    </div>
  );
}
