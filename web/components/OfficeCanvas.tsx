"use client";

import { useEffect, useRef } from "react";

import { Actors } from "@/lib/office/animator";
import { BubbleDirector, bubbleAnchor, placeBubble, resolveOverlaps, type ShownBubble } from "@/lib/office/bubbles";
import { HEIGHT, WIDTH } from "@/lib/office/layout";
import { CREW, type SceneState } from "@/lib/office/reducer";
import { drawScene, hitTest } from "@/lib/office/renderer";
import type { CrewAgent } from "@/lib/types";

interface Props {
  scene: SceneState;
  // Changes on every seek: characters jump to their places instead of walking.
  snapKey: number;
  speed: number;
  playing: boolean;
  selected: CrewAgent | null;
  onSelect?: (agent: CrewAgent | null) => void;
  onWhiteboard?: () => void;
  onWalkingChange?: (walking: CrewAgent[]) => void;
  // what each agent is saying right now (for the agent cards)
  onBubblesChange?: (texts: Partial<Record<CrewAgent, string>>) => void;
}

const ROLE: Record<CrewAgent, string> = { lead: "Lead", tester: "Tester", coder: "Coder", reviewer: "Reviewer" };

export default function OfficeCanvas({ scene, snapKey, speed, playing, selected, onSelect, onWhiteboard, onWalkingChange, onBubblesChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const bubbleRefs = useRef<Partial<Record<CrewAgent, HTMLDivElement | null>>>({});
  const sceneRef = useRef(scene);
  const speedRef = useRef(speed);
  const playingRef = useRef(playing);
  const selectedRef = useRef(selected);
  const actorsRef = useRef<Actors | null>(null);
  const directorRef = useRef(new BubbleDirector());
  const snapRef = useRef(snapKey);
  const outcomeAt = useRef<number | null>(null);
  const walkingRef = useRef("");
  const callbacks = useRef({ onWalkingChange, onBubblesChange });
  callbacks.current = { onWalkingChange, onBubblesChange };
  speedRef.current = speed;
  playingRef.current = playing;
  selectedRef.current = selected;

  useEffect(() => {
    sceneRef.current = scene;
    if (!actorsRef.current) actorsRef.current = new Actors(scene);
    const snap = snapRef.current !== snapKey;
    snapRef.current = snapKey;
    actorsRef.current.sync(scene, snap);
    if (snap) directorRef.current.reset();
    if (!scene.outcome) outcomeAt.current = null;
    else if (outcomeAt.current === null || snap) outcomeAt.current = performance.now();
  }, [scene, snapKey]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let frame = 0;
    let last = performance.now();
    let play = 0; // playback seconds: frozen while paused
    const shown: Partial<Record<CrewAgent, ShownBubble | null>> = {};
    const sizes: Partial<Record<CrewAgent, { w: number; h: number }>> = {};
    let reported = "";

    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (playingRef.current) play += dt;
      const actors = actorsRef.current;
      if (actors) {
        // Walk faster at higher replay speeds so trips fit in the (capped) gaps.
        actors.update(dt, 5 + Math.min(speedRef.current, 8) * 1.2);
        const outcome = outcomeAt.current === null ? null : (now - outcomeAt.current) / 1000;
        drawScene(ctx, { scene: sceneRef.current, actors, t: now, outcomeSeconds: outcome, selected: selectedRef.current });

        const walking = actors.walkingAgents();
        const key = walking.join(",");
        if (key !== walkingRef.current) {
          walkingRef.current = key;
          callbacks.current.onWalkingChange?.(walking);
        }

        // Speech bubbles: an HTML overlay positioned from the characters.
        const width = canvas.clientWidth;
        overlayRef.current?.style.setProperty("--office-scale", String(width / WIDTH));
        const texts: Partial<Record<CrewAgent, string>> = {};
        const sceneTime = sceneRef.current.lastAt ? Date.parse(sceneRef.current.lastAt) : null;
        const boxes: { agent: CrewAgent; el: HTMLDivElement; left: number; top: number; w: number; h: number; tail: number }[] = [];
        for (const agent of CREW) {
          const el = bubbleRefs.current[agent];
          if (!el) continue;
          const state = sceneRef.current.agents[agent];
          const actor = actors.actors[agent];
          const view = actors.view(agent);
          const bubble = directorRef.current.next(
            agent,
            { bubble: state.bubble, said: state.said, thinking: state.activity === "thinking", say: view.say, trip: actor.mode === "trip", sceneTime },
            now / 1000,
            play,
            speedRef.current,
          );
          const before = shown[agent];
          if (bubble?.key !== before?.key || bubble?.text !== before?.text || bubble?.style !== before?.style) {
            shown[agent] = bubble;
            renderBubble(el, bubble, before?.key !== bubble?.key);
            sizes[agent] = bubble ? { w: el.offsetWidth, h: el.offsetHeight } : undefined;
          }
          if (bubble) {
            texts[agent] = bubble.style === "thought" ? "thinking…" : bubble.text;
            const size = sizes[agent] ?? { w: el.offsetWidth, h: el.offsetHeight };
            const anchor = bubbleAnchor(actor.px, actor.py, view.pose, width);
            // the thought cloud's trailing dots hang lower than a speech tail
            const lift = bubble.style === "thought" ? 9 : 0;
            const { left, top, tail } = placeBubble({ x: anchor.x, y: anchor.y - lift }, size.w, size.h, width);
            boxes.push({ agent, el, left, top, w: size.w, h: size.h + 8, tail });
          }
        }
        // Neighbours (two agents at the coffee machine) mustn't cover each other.
        const tops = resolveOverlaps(boxes);
        boxes.forEach((b, i) => {
          b.el.style.transform = `translate(${Math.round(b.left)}px, ${Math.round(tops[i])}px)`;
          b.el.style.setProperty("--tail", `${Math.round(b.tail)}px`);
        });
        const textKey = JSON.stringify(texts);
        if (textKey !== reported) {
          reported = textKey;
          callbacks.current.onBubblesChange?.(texts);
        }
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);

  const pick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const actors = actorsRef.current;
    if (!canvas || !actors) return null;
    const box = canvas.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * WIDTH;
    const y = ((event.clientY - box.top) / box.height) * HEIGHT;
    return hitTest(actors, x, y);
  };

  return (
    <div className="w-full min-w-0 bg-charcoal p-2 sm:p-3" style={{ boxShadow: "0 0 0 4px #2b2523, 8px 8px 0 4px rgba(43,37,35,0.22)" }}>
      <div className="relative">
        <canvas
          ref={canvasRef}
          width={WIDTH}
          height={HEIGHT}
          className="pixelated block h-auto w-full max-w-full"
          style={{ aspectRatio: `${WIDTH} / ${HEIGHT}` }}
          role="img"
          aria-label={`Office scene: phase ${scene.phaseLabel}. Click a character to follow it in the log, or the whiteboard for the plan.`}
          onClick={(event) => {
            const hit = pick(event);
            if (hit === "whiteboard") onWhiteboard?.();
            else onSelect?.(hit && hit === selected ? null : hit);
          }}
          onMouseMove={(event) => {
            event.currentTarget.style.cursor = pick(event) ? "pointer" : "default";
          }}
        />
        <div ref={overlayRef} className="pointer-events-none absolute inset-0 overflow-hidden" aria-live="polite">
          {CREW.map((agent) => (
            <div
              key={agent}
              ref={(el) => {
                bubbleRefs.current[agent] = el;
              }}
              className="office-bubble"
              data-agent={agent}
              hidden
              aria-label={`${ROLE[agent]} says`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Fill a bubble element (text or thinking dots); pop it in when it's a new bubble. */
function renderBubble(el: HTMLDivElement, bubble: ShownBubble | null, isNew: boolean): void {
  if (!bubble) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.dataset.style = bubble.style;
  el.replaceChildren();
  const body = document.createElement("span");
  body.className = "office-bubble-body";
  if (bubble.style === "thought") {
    body.setAttribute("aria-label", "thinking");
    for (let i = 0; i < 3; i++) body.appendChild(document.createElement("i"));
  } else {
    body.textContent = bubble.text;
  }
  el.appendChild(body);
  if (isNew && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    body.animate([{ transform: "scale(0.85)", opacity: 0.4 }, { transform: "scale(1)", opacity: 1 }], { duration: 140, easing: "steps(3)" });
  }
}
