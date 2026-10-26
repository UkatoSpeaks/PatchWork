"use client";

import { useEffect, useRef } from "react";

import { Actors } from "@/lib/office/animator";
import { BubbleDirector, bubbleAnchor, layoutOverlay, type OverlayItem, type ShownBubble } from "@/lib/office/bubbles";
import { HEIGHT, WIDTH } from "@/lib/office/layout";
import { CREW, type SceneState } from "@/lib/office/reducer";
import { drawScene, hitTest } from "@/lib/office/renderer";
import { AGENT_COLORS } from "@/lib/office/sprites";
import { StatusDirector, type StatusLines } from "@/lib/office/status";
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
  // each agent's status tag lines right now, or what it is saying (for the agent cards)
  onStatusChange?: (lines: Partial<Record<CrewAgent, AgentLines>>) => void;
}

/** For the agent cards: the tag's task line, and its action line (or what an idle agent says). */
export interface AgentLines {
  task: string | null;
  now: string | null;
}

const ROLE: Record<CrewAgent, string> = { lead: "Lead", tester: "Tester", coder: "Coder", reviewer: "Reviewer" };

export default function OfficeCanvas({ scene, snapKey, speed, playing, selected, onSelect, onWhiteboard, onWalkingChange, onStatusChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const bubbleRefs = useRef<Partial<Record<CrewAgent, HTMLDivElement | null>>>({});
  const tagRefs = useRef<Partial<Record<CrewAgent, HTMLDivElement | null>>>({});
  const statusRef = useRef(new StatusDirector());
  const sceneRef = useRef(scene);
  const speedRef = useRef(speed);
  const playingRef = useRef(playing);
  const selectedRef = useRef(selected);
  const actorsRef = useRef<Actors | null>(null);
  const directorRef = useRef(new BubbleDirector());
  const snapRef = useRef(snapKey);
  const outcomeAt = useRef<number | null>(null);
  const walkingRef = useRef("");
  const callbacks = useRef({ onWalkingChange, onStatusChange });
  callbacks.current = { onWalkingChange, onStatusChange };
  speedRef.current = speed;
  playingRef.current = playing;
  // Reduced motion: characters jump to where they're going instead of walking.
  const reducedRef = useRef(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      reducedRef.current = query.matches;
    };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
  selectedRef.current = selected;

  useEffect(() => {
    sceneRef.current = scene;
    if (!actorsRef.current) actorsRef.current = new Actors(scene);
    const snap = snapRef.current !== snapKey;
    snapRef.current = snapKey;
    actorsRef.current.sync(scene, snap);
    if (snap) {
      directorRef.current.reset();
      statusRef.current.reset();
    }
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
    const tagShown: Partial<Record<CrewAgent, string>> = {};
    const tagSizes: Partial<Record<CrewAgent, { w: number; h: number }>> = {};
    let reported = "";

    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (playingRef.current) play += dt;
      const actors = actorsRef.current;
      if (actors) {
        // Walk faster at higher replay speeds so trips fit in the (capped) gaps.
        actors.update(dt, reducedRef.current ? 10_000 : 5 + Math.min(speedRef.current, 8) * 1.2);
        const outcome = outcomeAt.current === null ? null : (now - outcomeAt.current) / 1000;
        drawScene(ctx, { scene: sceneRef.current, actors, t: now, outcomeSeconds: outcome, selected: selectedRef.current });

        const walking = actors.walkingAgents();
        const key = walking.join(",");
        if (key !== walkingRef.current) {
          walkingRef.current = key;
          callbacks.current.onWalkingChange?.(walking);
        }

        // Status tags and speech bubbles: an HTML overlay positioned from the characters.
        const width = canvas.clientWidth;
        overlayRef.current?.style.setProperty("--office-scale", String(width / WIDTH));
        const texts: Partial<Record<CrewAgent, AgentLines>> = {};
        const sceneTime = sceneRef.current.lastAt ? Date.parse(sceneRef.current.lastAt) : null;
        const items: OverlayItem[] = [];
        for (const agent of CREW) {
          const el = bubbleRefs.current[agent];
          const tagEl = tagRefs.current[agent];
          if (!el || !tagEl) continue;
          const state = sceneRef.current.agents[agent];
          const actor = actors.actors[agent];
          const view = actors.view(agent);
          const lines = statusRef.current.next(agent, state, now / 1000, play, speedRef.current);
          const tagText = lines ? `${lines.task}\n${lines.action}` : "";
          if (tagText !== tagShown[agent]) {
            tagShown[agent] = tagText;
            renderTag(tagEl, lines);
            tagSizes[agent] = lines ? { w: tagEl.offsetWidth, h: tagEl.offsetHeight } : undefined;
          }
          const bubble = directorRef.current.next(
            agent,
            { bubble: state.bubble, said: state.said, say: view.say, trip: actor.mode === "trip", sceneTime },
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
          texts[agent] = { task: lines?.task ?? null, now: lines?.action ?? bubble?.text ?? null };
          if (!lines && !bubble) continue;
          items.push({
            agent,
            anchor: bubbleAnchor(actor.px, actor.py, view.pose, width),
            tag: lines ? (tagSizes[agent] ?? { w: tagEl.offsetWidth, h: tagEl.offsetHeight }) : null,
            bubble: bubble ? (sizes[agent] ?? { w: el.offsetWidth, h: el.offsetHeight }) : null,
          });
        }
        // Neighbours (e.g. the reviewer visiting the coder) mustn't cover each other.
        const placed = layoutOverlay(items, width);
        for (const item of items) {
          const where = placed[item.agent]!;
          const tagEl = tagRefs.current[item.agent]!;
          const el = bubbleRefs.current[item.agent]!;
          if (where.tag) {
            tagEl.style.transform = `translate(${Math.round(where.tag.left)}px, ${Math.round(where.tag.top)}px)`;
            tagEl.style.setProperty("--stem", `${Math.max(0, Math.round(where.tag.stem))}px`);
            tagEl.style.setProperty("--stem-x", `${Math.round(item.anchor.x - where.tag.left)}px`);
          }
          if (where.bubble) {
            el.style.transform = `translate(${Math.round(where.bubble.left)}px, ${Math.round(where.bubble.top)}px)`;
            el.style.setProperty("--tail", `${Math.round(where.bubble.tail)}px`);
          }
        }
        const textKey = JSON.stringify(texts);
        if (textKey !== reported) {
          reported = textKey;
          callbacks.current.onStatusChange?.(texts);
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
    <div className="w-full min-w-0 bg-charcoal p-2 sm:p-3" style={{ boxShadow: "0 0 0 4px var(--ink), 8px 8px 0 4px var(--shade)" }}>
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
        <div ref={overlayRef} className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
          {CREW.map((agent) => (
            <div
              key={`tag-${agent}`}
              ref={(el) => {
                tagRefs.current[agent] = el;
              }}
              className="office-tag"
              data-agent={agent}
              style={{ "--agent": AGENT_COLORS[agent] } as React.CSSProperties}
              hidden
              aria-label={`${ROLE[agent]} is working`}
            />
          ))}
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

/** Fill a status tag: the task on line 1, the current action on line 2. */
function renderTag(el: HTMLDivElement, lines: StatusLines | null): void {
  if (!lines) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const task = document.createElement("span");
  task.className = "office-tag-task";
  task.textContent = lines.task;
  const action = document.createElement("span");
  action.className = "office-tag-action";
  action.textContent = lines.action;
  el.replaceChildren(task, action);
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
