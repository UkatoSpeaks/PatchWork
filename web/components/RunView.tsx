"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { API_URL, ApiError, fetchEvents, fetchLaunch, fetchRun, streamEvents } from "@/lib/api";
import { fileRoles } from "@/lib/diff";
import { filterLog as filterEntries, logEntries, type LogFilter } from "@/lib/log";
import { CREW, initialScene, isCrew, officeReducer, reduceEvents, type SceneState } from "@/lib/office/reducer";
import { runOutcome } from "@/lib/outcome";
import { agentStats, phaseDurations, phaseSegments } from "@/lib/stats";
import type { CrewAgent, LaunchStatus, Plan, RunDetail, RunEvent, RunStatus } from "@/lib/types";

import ActivityLog from "./ActivityLog";
import AgentCard from "./AgentCard";
import EventDrawer from "./EventDrawer";
import InfoPanels, { type InfoTab } from "./InfoPanels";
import LaunchWaiting from "./LaunchWaiting";
import OfficeCanvas, { type AgentLines } from "./OfficeCanvas";
import ReplayControls, { SPEEDS } from "./ReplayControls";
import ResultBanner from "./ResultBanner";
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
 * events[0..n] from the log fetched once (/events). For a run that is still
 * going, the stream turns live once it has caught up: new events are appended
 * to the log as the run writes them. A running run opens live.
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
  const [status, setStatus] = useState<Partial<Record<CrewAgent, AgentLines>>>({});
  const [selected, setSelected] = useState<CrewAgent | null>(null);
  const [logFilter, setLogFilter] = useState<LogFilter>("all");
  const [tab, setTab] = useState<InfoTab>("plan");
  const [live, setLive] = useState(false);
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  // The event open in the drawer, if any.
  const [inspect, setInspect] = useState<number | null>(null);
  // A run started from the dashboard that hasn't written its first event yet.
  const [launch, setLaunch] = useState<LaunchStatus | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const indexRef = useRef(0);
  const closeRef = useRef<(() => void) | null>(null);
  const panelsRef = useRef<HTMLElement>(null);

  const stop = useCallback(() => {
    closeRef.current?.();
    closeRef.current = null;
    setLive(false);
  }, []);

  /** Re-read the run detail (status, result with the diff), e.g. once a live run ends. */
  const refreshDetail = useCallback(
    (retry = true) => {
      fetchRun(id).then(
        (d) => {
          setDetail(d);
          setRunStatus(d.summary.status);
          // result.json is written just after the run_finished line; try once more if we beat it.
          if (retry && d.summary.status === "finished" && !d.result) setTimeout(() => refreshDetail(false), 1500);
        },
        () => undefined,
      );
    },
    [id],
  );

  const start = useCallback(
    (from: number, atSpeed: number) => {
      stop();
      closeRef.current = streamEvents(id, { speed: atSpeed, start: from }, {
        onEvent: (event, i) => {
          // Ignore anything that doesn't follow on from where we are (e.g. after a seek).
          if (i !== indexRef.current) return;
          // Events past the end of the log we loaded are new: the run wrote them just now.
          setEvents((prev) => (prev && i === prev.length ? [...prev, event] : prev));
          indexRef.current = i + 1;
          setIndex(i + 1);
          setScene((s) => officeReducer(s, event));
        },
        onLive: () => {
          setLive(true);
          setRunStatus("running");
        },
        onEnd: () => {
          closeRef.current = null;
          setLive(false);
          setPlaying(false);
          refreshDetail();
        },
        onError: () => {
          closeRef.current = null;
          setLive(false);
          setPlaying(false);
          setError(`lost the event stream from ${API_URL}`);
        },
      });
      setError(null);
      setPlaying(true);
    },
    [id, stop, refreshDetail],
  );

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // The detail (plan, result with the diff, status) is optional: the scene works without it.
    const detailLoaded = fetchRun(id).catch(() => null);
    fetchEvents(id).then(
      async (loaded) => {
        const d = await detailLoaded;
        if (cancelled) return;
        setLaunch(null);
        setEvents(loaded);
        setDetail(d);
        setRunStatus(d?.summary.status ?? null);
        // ?tab=plan|diff|stats opens that panel.
        const tabParam = new URLSearchParams(window.location.search).get("tab");
        if (tabParam === "plan" || tabParam === "diff" || tabParam === "stats") setTab(tabParam);
        // ?event=N opens event N's details, paused right after it; ?at=N opens the run paused after N events.
        const eventParam = new URLSearchParams(window.location.search).get("event");
        const opened = eventParam === null ? NaN : Number(eventParam);
        const at = Number.isInteger(opened) && opened >= 0 && opened < loaded.length ? opened + 1 : Number(new URLSearchParams(window.location.search).get("at"));
        if (Number.isInteger(opened) && opened >= 0 && opened < loaded.length) setInspect(opened);
        if (Number.isInteger(at) && at > 0) {
          const target = Math.min(at, loaded.length);
          indexRef.current = target;
          setIndex(target);
          setScene(reduceEvents(loaded, target));
          setSnapKey((k) => k + 1);
        } else if (d?.summary.status === "running") {
          // Still going: show where it is now and follow it.
          indexRef.current = loaded.length;
          setIndex(loaded.length);
          setScene(reduceEvents(loaded, loaded.length));
          setSnapKey((k) => k + 1);
          start(loaded.length, 0);
        } else {
          start(0, 4);
        }
      },
      (e: Error) => {
        if (cancelled) return;
        if (!(e instanceof ApiError && e.status === 404)) {
          setError(e.message);
          return;
        }
        // No events yet: if this server just started the run, wait for its first event.
        fetchLaunch(id).then(
          (status) => {
            if (cancelled) return;
            setLaunch(status);
            if (status.state !== "exited" || status.has_events) retry = setTimeout(() => setReloadKey((k) => k + 1), 700);
          },
          () => !cancelled && setError(e.message),
        );
      },
    );
    return () => {
      cancelled = true;
      clearTimeout(retry);
      stop();
    };
  }, [id, start, stop, reloadKey]);

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

  /** Jump to the newest event and follow the run from there. */
  const goLive = () => {
    if (!events) return;
    stop();
    const n = events.length;
    indexRef.current = n;
    setIndex(n);
    setScene(reduceEvents(events, n));
    setSnapKey((k) => k + 1);
    // Speed 0: anything written since we loaded the log arrives at once.
    start(n, 0);
  };

  const playPause = () => {
    if (!events) return;
    if (playing) {
      stop();
      setPlaying(false);
    } else if (indexRef.current >= events.length && runStatus === "running") {
      goLive();
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

  /** Open an event in the drawer and show the office right after it. */
  const openEvent = (i: number) => {
    seek(i + 1, false);
    setInspect(i);
  };

  // Keep ?event=N in the address bar in step with the drawer, so the link can be shared.
  useEffect(() => {
    if (!events) return;
    const url = new URL(window.location.href);
    if (inspect === null) url.searchParams.delete("event");
    else url.searchParams.set("event", String(inspect));
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
  }, [inspect, events]);

  const showDiff = () => {
    setTab("diff");
    panelsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const openPlan = () => {
    setTab("plan");
    panelsRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  const entries = useMemo(() => logEntries(events ?? []), [events]);
  // Drawer neighbours: the previous / next event in the log as it's filtered now.
  const neighbours = useMemo(() => {
    if (inspect === null) return { prev: null, next: null };
    const visible = filterEntries(entries, logFilter).map((e) => e.index);
    return {
      prev: visible.findLast((i) => i < inspect) ?? null,
      next: visible.find((i) => i > inspect) ?? null,
    };
  }, [entries, logFilter, inspect]);

  // Keyboard: space plays / pauses, left / right step one event (or through the drawer
  // when it's open), 1-4 pick the speed, L goes live, Esc closes the drawer.
  const keyState = { playPause, seek, changeSpeed, goLive, openEvent, index, inspect, neighbours, canGoLive: runStatus === "running" && !live };
  const keys = useRef(keyState);
  keys.current = keyState;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || typing(event.target)) return;
      const k = keys.current;
      if (event.key === " " && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault();
        k.playPause();
      } else if (event.key === "Escape" && k.inspect !== null) {
        setInspect(null);
      } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && k.inspect !== null) {
        event.preventDefault();
        const to = event.key === "ArrowLeft" ? k.neighbours.prev : k.neighbours.next;
        if (to !== null) k.openEvent(to);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        k.seek(k.index + (event.key === "ArrowLeft" ? -1 : 1), false);
      } else if (/^[1-4]$/.test(event.key)) {
        k.changeSpeed(SPEEDS[Number(event.key) - 1]);
      } else if ((event.key === "l" || event.key === "L") && k.canGoLive) {
        k.goLive();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const phases = useMemo(() => phaseSegments(events ?? []), [events]);
  const stats = useMemo(() => agentStats(events ?? []), [events]);
  const durations = useMemo(() => phaseDurations(events ?? [], detail?.result ?? null), [events, detail]);
  const roleOf = useMemo(() => fileRoles(events ?? [], detail?.result ?? null), [events, detail]);
  const plan = planFrom(detail, events);
  // The result: result.json, else the run_finished event (e.g. before result.json is read).
  const finishedResult = useMemo(() => events?.findLast((e) => e.type === "run_finished")?.payload?.result ?? null, [events]);
  const outcome = useMemo(
    () => runOutcome(detail?.result ?? finishedResult, events ?? [], runStatus),
    [detail, finishedResult, events, runStatus],
  );
  // Show it once the replay reaches the end of the run.
  const showOutcome = outcome && (outcome.verdict === "stopped" ? index >= (events?.length ?? 0) : scene.outcome !== null);

  if (launch && !events) return <LaunchWaiting launch={launch} />;

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
      <TopBar runId={id} scene={scene} issue={detail?.result?.issue ?? ""} live={live} status={runStatus} />
      <OfficeCanvas
        scene={scene}
        snapKey={snapKey}
        speed={speed}
        playing={playing}
        selected={selected}
        onSelect={select}
        onWhiteboard={openPlan}
        onWalkingChange={setWalking}
        onStatusChange={setStatus}
      />
      <ReplayControls
        playing={playing}
        speed={speed}
        index={index}
        total={events?.length ?? 0}
        current={events ? describe(events[index - 1]) : "loading events…"}
        phases={phases}
        live={live}
        canGoLive={runStatus === "running" && !live}
        onGoLive={goLive}
        onPlayPause={playPause}
        onRestart={() => seek(0, true)}
        onSpeed={changeSpeed}
        onSeek={(n) => seek(n)}
        onInspect={index > 0 ? () => openEvent(index - 1) : undefined}
      />
      {error && (
        <p className="flex flex-wrap items-center gap-3 font-pixel text-sm text-terracotta" role="alert">
          {error}
          <button type="button" className="pixel-btn px-2 py-0.5 text-xs text-ink" onClick={() => start(indexRef.current, speed)}>
            ↻ reconnect
          </button>
        </p>
      )}
      {showOutcome && <ResultBanner runId={id} outcome={outcome} onOpenEvent={openEvent} onShowDiff={showDiff} />}
      <section aria-label="Agents" className="flex flex-wrap gap-8">
        {shown.map((name) => (
          <AgentCard
            key={name}
            agent={scene.agents[name]}
            walking={walking.includes(name)}
            maxSteps={scene.maxSteps}
            maxTokens={scene.maxTokens}
            task={status[name]?.task ?? null}
            now={status[name]?.now ?? null}
            selected={selected === name}
            onSelect={() => select(selected === name ? null : name)}
          />
        ))}
      </section>
      <div className="grid min-w-0 grid-cols-1 gap-8 lg:grid-cols-2 [&>*]:min-w-0">
        <ActivityLog entries={entries} index={index} inspected={inspect} filter={logFilter} onFilter={filterLog} onOpen={openEvent} />
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
      {inspect !== null && events?.[inspect] && (
        <EventDrawer
          events={events}
          index={inspect}
          prev={neighbours.prev}
          next={neighbours.next}
          onOpen={openEvent}
          onClose={() => setInspect(null)}
        />
      )}
    </div>
  );
}
