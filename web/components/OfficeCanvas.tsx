"use client";

import { useEffect, useRef } from "react";

import { Actors } from "@/lib/office/animator";
import { HEIGHT, WIDTH } from "@/lib/office/layout";
import type { SceneState } from "@/lib/office/reducer";
import { drawScene } from "@/lib/office/renderer";
import type { CrewAgent } from "@/lib/types";

interface Props {
  scene: SceneState;
  // Changes on every seek: characters jump to their places instead of walking.
  snapKey: number;
  speed: number;
  onWalkingChange?: (walking: CrewAgent[]) => void;
}

export default function OfficeCanvas({ scene, snapKey, speed, onWalkingChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef(scene);
  const speedRef = useRef(speed);
  const actorsRef = useRef<Actors | null>(null);
  const snapRef = useRef(snapKey);
  const outcomeAt = useRef<number | null>(null);
  const walkingRef = useRef("");
  const onWalkingRef = useRef(onWalkingChange);
  onWalkingRef.current = onWalkingChange;
  speedRef.current = speed;

  useEffect(() => {
    sceneRef.current = scene;
    if (!actorsRef.current) actorsRef.current = new Actors(scene);
    const snap = snapRef.current !== snapKey;
    snapRef.current = snapKey;
    actorsRef.current.sync(scene, snap);
    if (!scene.outcome) outcomeAt.current = null;
    else if (outcomeAt.current === null || snap) outcomeAt.current = performance.now();
  }, [scene, snapKey]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let frame = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const actors = actorsRef.current;
      if (actors) {
        // Walk faster at higher replay speeds so trips fit in the (capped) gaps.
        actors.update(dt, 5 + Math.min(speedRef.current, 8) * 1.2);
        const outcome = outcomeAt.current === null ? null : (now - outcomeAt.current) / 1000;
        drawScene(ctx, sceneRef.current, actors, now, outcome);
        const walking = actors.walkingAgents();
        const key = walking.join(",");
        if (key !== walkingRef.current) {
          walkingRef.current = key;
          onWalkingRef.current?.(walking);
        }
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="w-full min-w-0 bg-charcoal p-2 sm:p-3" style={{ boxShadow: "0 0 0 4px #2b2523, 8px 8px 0 4px rgba(43,37,35,0.22)" }}>
      <canvas
        ref={canvasRef}
        width={WIDTH}
        height={HEIGHT}
        className="pixelated block h-auto w-full max-w-full"
        style={{ aspectRatio: `${WIDTH} / ${HEIGHT}` }}
        role="img"
        aria-label={`Office scene: phase ${scene.phaseLabel}`}
      />
    </div>
  );
}
