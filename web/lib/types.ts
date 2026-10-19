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

export interface RunSummary {
  run_id: string;
  started_at: string | null;
  mode: "crew" | "solo";
  sequential: boolean;
  issue: string;
  success: boolean | null;
  finished: boolean;
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
