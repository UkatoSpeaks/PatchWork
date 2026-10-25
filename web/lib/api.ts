import type { RunDetail, RunEvent, RunSummary } from "./types";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/\/+$/, "");

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} from ${path}`);
  }
  return response.json() as Promise<T>;
}

export const fetchRuns = () => getJson<RunSummary[]>("/api/runs");
export const fetchRun = (id: string) => getJson<RunDetail>(`/api/runs/${encodeURIComponent(id)}`);
export const fetchEvents = (id: string) => getJson<RunEvent[]>(`/api/runs/${encodeURIComponent(id)}/events`);

/**
 * Replay events[start..] over SSE at `speed` (0: as fast as possible). For a run
 * that is still going, `onLive` fires once the replay has caught up; after that,
 * new events arrive as the run writes them. Returns a close function.
 */
export function streamEvents(
  id: string,
  { speed, start }: { speed: number; start: number },
  handlers: { onEvent: (event: RunEvent, index: number) => void; onLive?: () => void; onEnd: () => void; onError: () => void },
): () => void {
  const url = `${API_URL}/api/runs/${encodeURIComponent(id)}/stream?speed=${speed}&start=${start}`;
  const source = new EventSource(url);
  let closed = false;
  const close = () => {
    closed = true;
    source.close();
  };
  source.onmessage = (message) => {
    if (closed) return;
    handlers.onEvent(JSON.parse(message.data) as RunEvent, Number(message.lastEventId));
  };
  source.addEventListener("live", () => {
    if (!closed) handlers.onLive?.();
  });
  source.addEventListener("end", () => {
    close();
    handlers.onEnd();
  });
  source.onerror = () => {
    // EventSource would reconnect and replay from the start; stop instead.
    if (closed) return;
    close();
    handlers.onError();
  };
  return close;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "-";
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  if (m) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 10_000) return `${(tokens / 1000).toFixed(1)}k`;
  return tokens.toLocaleString("en-US");
}

/** "groq/openai/gpt-oss-120b" -> "gpt-oss-120b" */
export function shortModel(model: string | null | undefined): string {
  if (!model) return "-";
  return model.split("/").pop() || model;
}

export function modeLabel(summary: { mode: string; sequential: boolean }): string {
  if (summary.mode === "solo") return "solo";
  return summary.sequential ? "sequential" : "parallel";
}
