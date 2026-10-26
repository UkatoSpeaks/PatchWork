// Shapes served by `patchwork serve` (src/patchwork/server.py), mirroring
// src/patchwork/events.py and src/patchwork/schemas.py.

export type AgentName = "lead" | "tester" | "coder" | "reviewer" | "orchestrator";
export type CrewAgent = Exclude<AgentName, "orchestrator">;

export type EventType =
  | "run_started"
  | "phase_started"
  | "phase_finished"
  | "agent_started"
  | "llm_call"
  | "tool_called"
  | "tool_result"
  | "rate_limited"
  | "throttled"
  | "note"
  | "agent_finished"
  | "tests_run"
  | "merge"
  | "retry_started"
  | "review_verdict"
  | "run_finished";

export interface RunEvent {
  run_id: string;
  seq: number;
  timestamp: string;
  agent: AgentName;
  type: EventType;
  // Payload fields depend on the type; see officeReducer for the ones used.
  payload: Record<string, any>;
}

export type RunStatus = "finished" | "running" | "stopped";

export interface RunSummary {
  run_id: string;
  started_at: string | null;
  mode: "crew" | "solo";
  sequential: boolean;
  issue: string;
  success: boolean | null;
  finished: boolean;
  // finished: has a result; running: its process is alive; stopped: it crashed or was killed
  status: RunStatus;
  total_tokens: number;
  duration_s: number | null;
  events: number;
}

export interface Subtask {
  id: string;
  role: "tester" | "coder";
  description: string;
  files_hint: string[];
  acceptance_criteria: string[];
}

export interface Plan {
  issue_summary: string;
  subtasks: Subtask[];
  risks: string[];
}

export interface RunDetail {
  summary: RunSummary;
  result: Record<string, any> | null;
  plan: Plan | null;
}

// Starting runs (the "New run" page).

export interface LaunchConfig {
  models: Record<CrewAgent, string>;
  coder_retry_model: string;
  api_key_set: boolean;
  needs_api_key: boolean;
  max_retries: number;
  max_steps: number;
  test_command: string;
  // the run going right now, if any
  busy: string | null;
}

export interface ToyRepo {
  name: string;
  about: string;
  issue: string | null;
}

export type RepoState = "ready" | "needs_init" | "dirty" | "no_commits" | "inside_repo" | "missing";

export interface RepoCheck {
  state: RepoState;
  path: string;
  message: string;
  branch?: string;
  head?: string;
  dirty_files?: string[];
  dirty_count?: number;
  issue_files?: string[];
  issue?: string | null;
}

export interface LaunchRequest {
  repo?: string;
  toy?: string;
  issue: string;
  init_git?: boolean;
  sequential?: boolean;
  max_retries?: number;
  max_steps?: number;
  test_cmd?: string;
}

export interface LaunchStatus {
  run_id: string;
  state: "starting" | "running" | "exited";
  exit_code: number | null;
  has_events: boolean;
  repo: string;
  seconds: number;
  log: string;
}
