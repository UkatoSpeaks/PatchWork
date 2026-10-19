"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { API_URL, fetchEvents, streamEvents } from "@/lib/api";
import { CREW, initialScene, officeReducer, reduceEvents, type SceneState } from "@/lib/office/reducer";
import type { CrewAgent, RunEvent } from "@/lib/types";

import AgentCard from "./AgentCard";
import OfficeCanvas from "./OfficeCanvas";
import ReplayControls from "./ReplayControls";
import TopBar from "./TopBar";

function describe(event: RunEvent | undefined): string {
  if (!event) return "start";
  return `#${event.seq} ${event.agent} · ${event.type}`;
}

/**
 * Replays a run. Normal playback streams events over SSE (/stream) and feeds
 * them to the reducer one by one; seeking rebuilds the scene by reducing
 * events[0..n] from the full log fetched once (/events).
 */
export default function RunView({ id }: { id: string }) {
  const [events, setEvents] = useState<RunEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scene, setScene] = useState<SceneState>(initialScene);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [snapKey, setSnapKey] = useState(0);
  const [walking, setWalking] = useState<CrewAgent[]>([]);
  const indexRef = useRef(0);
  const closeRef = useRef<(() => void) | null>(null);

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
      <TopBar runId={id} scene={scene} />
      <OfficeCanvas scene={scene} snapKey={snapKey} speed={speed} onWalkingChange={setWalking} />
      <ReplayControls
        playing={playing}
        speed={speed}
        index={index}
        total={events?.length ?? 0}
        current={events ? describe(events[index - 1]) : "loading events…"}
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
          />
        ))}
      </section>
    </div>
  );
}
