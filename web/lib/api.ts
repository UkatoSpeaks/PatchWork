import type { LaunchConfig, LaunchRequest, LaunchStatus, RepoCheck, RunDetail, RunEvent, RunSummary, ToyRepo } from "./types";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/\/+$/, "");

/** An error from the API, with its status and the server's message (FastAPI's `detail`). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail: string | null = null,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, { cache: "no-store", ...init });
  if (!response.ok) {
    let detail: string | null = null;
    try {
      const body = await response.json();
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      // not JSON
    }
    throw new ApiError(detail ?? `${response.status} ${response.statusText} from ${path}`, response.status, detail);
  }
  return response.json() as Promise<T>;
}

const getJson = <T,>(path: string) => request<T>(path);

export const fetchRuns = () => getJson<RunSummary[]>("/api/runs");
export const fetchRun = (id: string) => getJson<RunDetail>(`/api/runs/${encodeURIComponent(id)}`);
export const fetchEvents = (id: string) => getJson<RunEvent[]>(`/api/runs/${encodeURIComponent(id)}/events`);

export const fetchConfig = () => getJson<LaunchConfig>("/api/config");
export const fetchToyRepos = () => getJson<ToyRepo[]>("/api/toy-repos");
export const checkRepo = (path: string) => getJson<RepoCheck>(`/api/repo-check?path=${encodeURIComponent(path)}`);
export const fetchLaunch = (id: string) => getJson<LaunchStatus>(`/api/launches/${encodeURIComponent(id)}`);

/** Start a crew run; resolves to its run id. Errors carry the server's message. */
export const startRun = (body: LaunchRequest) =>
  request<{ run_id: string }>("/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.run_id);

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
