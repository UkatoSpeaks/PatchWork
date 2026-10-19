# Patchwork

A multi-agent coding system for fixing GitHub issues. A lead agent plans the fix and coder, tester and reviewer agents carry it out.

**Status: milestone 3.** The crew works on git branches in separate worktrees, runs the tester and coder in parallel, retries on failing tests or review blockers, and reports everything as structured events.

## How a crew run works

1. **plan**: the **lead** explores the target repo read-only and submits a `Plan` (issue summary, tester/coder subtasks with files and acceptance criteria, risks) through a `submit_plan` tool. Invalid plans are sent back with the validation error (up to 2 retries). A tester subtask that names an existing test file is invalid: tests go in a new file.
2. **implement**: the **tester** and the **coder** run **concurrently**, each in its own git worktree on its own branch (`patchwork/<run_id>/tester`, `patchwork/<run_id>/coder`), created from the current HEAD.
   - The tester writes tests in a *new* file that encode the issue's expected behaviour. It can only create test files (under `tests/` or named `test_*.py`). Its tests must **fail** against the unmodified code in its worktree (an ImportError for the missing feature counts; a syntax error doesn't). It is ended automatically as soon as a `run_tests` on its new files shows that.
   - The coder gets the plan's coder subtasks, but not the tester's tests, which don't exist yet. Its own check is that the existing suite passes in its worktree.
   - Both commit to their branch when done. `--sequential` runs them one after the other instead, for comparison.
   - If one fails, the run stops. Sequentially, a failed tester means the coder is never started. In parallel, the other agent is cancelled (asyncio task cancellation); it is recorded with stop reason `cancelled` and its work so far is committed to its branch.
3. **integrate**: a result worktree/branch (`patchwork/<run_id>/result`) is created from HEAD, and the coder branch and then the tester branch are merged into it. A conflict should be impossible; if one happens, the run stops and names the files.
4. **verify**: the full suite runs in the result worktree. If it fails, a **coder retry** starts in the result worktree with the failing output and the plan. The retry may not edit the tester's files.
5. **review**: the **reviewer** reads the diff (result branch vs HEAD) with read-only tools and submits a `ReviewVerdict`. `approved` is true exactly when there is no blocker. A blocker starts a coder retry with the review issues, then verify and review run again.

At most `--max-retries` (default 3) coder retries happen per run, across both kinds. Each retry is a fresh agent that gets only the plan, the current diff and the feedback, and its changes are committed to the result branch.

**Success** = the full suite passes in the result worktree **and** the reviewer approved. The diff and changed files come from git (result branch vs the base commit), never from what a model says. If an agent fails, the run stops and reports which one.

**Your working tree is never modified.** Worktrees live in a temp dir and are always removed at the end, even after a failure. After a successful run only the result branch is kept (the tester and coder branches are merged into it and deleted). After a failed run, every tester/coder/result branch **that has commits** is kept; empty ones are deleted. Patchwork prints each kept branch with `git log --oneline <base>..<branch>` / `git diff <base> <branch>`, and a `git branch -D ...` line to remove them. After a success it prints:

```bash
git diff HEAD patchwork/<run_id>/result     # inspect
git merge patchwork/<run_id>/result         # apply
```

Patchwork commits on its own branches with `--no-verify`, so the target repo's commit hooks don't block agents mid-run. It uses your git identity if one is configured, and `Patchwork <patchwork@localhost>` otherwise.

Write restrictions are enforced in the tool layer (`agents/toolkit.py`), not just in prompts.

### Tool behaviour

These help every agent recover without wasted steps:

- `edit_file` matches regardless of CRLF vs LF and keeps the file's line endings. It also accepts text copied with read_file's `N| ` prefixes. When the text isn't found, the error shows the closest matching lines, numbered.
- `insert_lines(path, after_line, text)` (coder and tester) inserts after a line number: 0 = top, -1 = end of file. It's the safe way to add a new function without hunting for a unique `edit_file` anchor.
- Successful `edit_file` / `insert_lines` / `write_file` results show the changed region with 5 lines of context, so there is no need to re-read the file.
- Writes to `.py` files are refused, and the file is left unchanged, if the result doesn't parse (`ast.parse`). The error gives the line number. A write that leaves a top-level function or class defined twice goes through, with a warning in the result ("WARNING: median is now defined twice (lines 28 and 42); remove one").
- `read_file` on a directory returns its listing. A missing path suggests close matches ("did you mean tests/test_core.py?").
- A tool call written as JSON text (`{"name": ..., "arguments": ...}`) is executed like a normal tool call, and never counts as a plain-text final answer. Parsing tries strict JSON (raw newlines in strings allowed), then `json-repair`, then the outermost `{...}` block. If the text looks like a tool call but can't be parsed, or the reply was cut off at the output-token limit, the model gets an error asking it to call the tool natively; the call is never dropped silently.
- gpt-oss's built-in tool names are mapped to ours: `repo_browser.print_tree` → `list_dir`, `repo_browser.open_file` → `read_file` (`line_start` → `offset`), `repo_browser.search` → `search_code` (`query` → `pattern`), and any `repo_browser.<tool>` where `<tool>` is one of ours (e.g. `repo_browser.list_dir`) → `<tool>`. Any other unknown tool name gets an error listing the tools that exist, and the run continues.
- Groq 400s that carry a `failed_generation` (`output_parse_failed`, `tool_use_failed`, or any other code) are treated as the model's reply with that text: a JSON tool call in it is run, prose follows the plain-text rules. A 400 without `failed_generation` is logged as a note and retried up to 2 times in a row; the third fails the agent.
- The coder may not give up before it has edited a file or run the tests: the first such give-up is refused with a note to explore and attempt a fix; a second one is accepted. It is nudged when 5 steps have passed since its first edit after the last test run.
- Failed `run_tests` results start with the failure reason (the pytest `E ...` lines), then the last 30 lines of output.

## Setup

Requires [uv](https://docs.astral.sh/uv/) (it downloads Python 3.12 if you don't have it) and **git** on your PATH.

```bash
uv sync                    # creates .venv and installs runtime + dev dependencies
cp .env.example .env       # then set GROQ_API_KEY (https://console.groq.com/keys)
```

All settings are read from `.env` (or real environment variables). See `.env.example`:

| Variable | Default | Purpose |
|---|---|---|
| `GROQ_API_KEY` | none | Required for `groq/` models |
| `LEAD_MODEL` / `CODER_MODEL` / `TESTER_MODEL` / `REVIEWER_MODEL` | `groq/openai/gpt-oss-120b` (reviewer: `groq/qwen/qwen3.8-27b`, to spread load across Groq's per-model rate limits) | Model for each role, as LiteLLM model strings. `--solo` uses only `CODER_MODEL`. |
| `MAX_STEPS_PER_AGENT` | 25 | LLM turns before an agent gives up (per agent run) |
| `MAX_TOKENS_PER_RUN` | 60000 | Prompt + completion token budget per agent run |
| `MAX_OUTPUT_TOKENS` | 1024 | `max_tokens` for each LLM call |
| `MAX_RETRIES` | 3 | Coder retries per crew run (`--max-retries` overrides) |
| `TEST_COMMAND` | `python -m pytest -q --tb=short -p no:cacheprovider` | Run in the repo root. A leading `python` means the interpreter running Patchwork. |
| `TEST_TIMEOUT_SECONDS` | 120 | Timeout for the test command |
| `LEAD_FALLBACKS` / `CODER_FALLBACKS` / `TESTER_FALLBACKS` | `groq/qwen/qwen3.8-27b,groq/openai/gpt-oss-20b` | Comma-separated models to switch to, in order, when the role's model hits a per-day limit |
| `REVIEWER_FALLBACKS` | `groq/openai/gpt-oss-120b,groq/openai/gpt-oss-20b` | Same, for the reviewer |
| `MAX_CONCURRENT_REQUESTS` | 2 | In-flight LLM requests per model, shared by all agents |
| `LLM_MAX_WAIT_SECONDS` | 180 | Total seconds one LLM call may wait on per-minute rate limits before failing |
| `THROTTLE_MODE` | `proportional` | How long a call waits when the per-minute token budget is short: `proportional` (only for the missing tokens to refill) or `full` (until the window resets) |

`LLM_MAX_RETRIES` is gone; per-minute retries are bounded by total wait time instead (an old value in `.env` is ignored).

### Rate limits

Groq's free-tier limits are per account and model (gpt-oss-120b: 8,000 tokens per minute, 200,000 per day), so Patchwork works with them instead of against them:

- **One run at a time.** A run takes `runs/.patchwork.lock` (with its PID and run id). A second `patchwork run` stops with "another Patchwork run is in progress (run <id>, pid <pid>); Groq rate limits are shared, run one at a time". A lock left by a process that is no longer running is replaced. The lock is released when the run ends, even on errors.
- **Per-minute vs per-day.** A 429 is classified from Groq's message: TPM/RPM are per-minute, TPD/RPD per-day.
  - Per-minute: retried, always waiting at least Groq's retry-after, until the call has waited `LLM_MAX_WAIT_SECONDS` (180s) in total. There is no fixed retry count.
  - Per-day: never retried. The model is marked exhausted for the rest of the process, and the agent switches to the next model in its role's `*_FALLBACKS` list. It keeps the same conversation and logs "daily limit reached on X, switching to Y". If every model is exhausted, the agent fails with a message naming each model and its reset time from Groq's error. The models each agent actually used are in `RunResult` (`runs[].result.models_used`) and the final table.
- **Throttling.** After every call, Groq's `x-ratelimit-*` headers (remaining tokens/requests and reset times) are stored per model. Before a call, its cost is estimated (prompt characters / 4 + `max_tokens`). If the per-minute token budget left is too small, the call waits instead of being sent and getting a 429: "throttling: waiting Xs for the token budget on <model> (need ~N, M left, limit L/min, mode)".
  - `THROTTLE_MODE=proportional` (default) assumes the budget refills gradually at limit/60s, so it waits `(needed - remaining) / (limit / 60s) + 1s`, capped at the reset time from the headers. If a call sent on assumed refill still gets a per-minute 429, that model switches to full waits for the rest of the run: "proportional throttling not accepted on <model>; using full reset waits".
  - `THROTTLE_MODE=full` waits for the reset time from the headers.
- **Daily usage.** Tokens and requests per model per day (local date) are added to `runs/usage.json` after every call. The final table shows today's totals, with the per-day limit when known. Groq sends the requests-per-day limit in its headers; the tokens-per-day limit only appears in a TPD 429 message, so it is remembered from there. A TPD message's "Used N" also raises today's total to Groq's count, which includes usage outside Patchwork. `patchwork usage` prints today's totals, and `patchwork usage --days 7` shows the last 7 days with usage.

## Usage

```bash
uv run patchwork run --repo PATH --issue "TEXT" [--init-git] [--sequential] [--max-retries N] [--test-cmd "..."] [--max-steps N]
uv run patchwork run --repo PATH --issue "TEXT" --solo
uv run patchwork replay runs/<run_id>/events.jsonl
uv run patchwork usage [--days N]
```

- `PATH` must be the root of a git repo with a commit and no uncommitted changes (commit or stash first). `--init-git` turns a plain directory into one: `git init` plus an initial commit of everything in it.
- `--sequential` runs the tester and coder one after the other instead of concurrently. The final table shows wall-clock time per agent and per phase, so the two modes can be compared.
- `--solo` runs only the coder, editing `PATH` **in place** as in milestone 1 (no git needed; the diff comes from a temp-dir snapshot). It's kept for single-vs-crew evals.

The CLI shows each phase as it happens. Lines from agents are prefixed with the agent name, so parallel output stays readable. At the end it prints the diff, a table of tokens and time per agent run (retries included), the phase durations, and the outcome. The exit code is 0 if the run succeeds and 1 otherwise.

### Events

Everything the CLI prints is rendered from structured events (`events.py`). Agents and the orchestrator publish to an `EventBus`; nothing else prints. Each `Event` has `run_id`, `seq`, `timestamp`, `agent` (lead/tester/coder/reviewer/orchestrator), `type` and `payload`. The types are:

`run_started`, `phase_started`, `phase_finished`, `agent_started`, `llm_call`, `tool_called`, `tool_result`, `rate_limited`, `throttled`, `note`, `agent_finished`, `tests_run`, `merge`, `retry_started`, `review_verdict`, `run_finished`.

Every run writes `runs/<run_id>/events.jsonl` (one event per line, as it happens) and `runs/<run_id>/result.json` (the final `RunResult`). `patchwork replay` re-renders a past run from its log; the output is identical. A frontend can subscribe with `EventBus.subscribe`, or consume `async for event in bus.stream()`.

### Try it on the toy repos

- `toy_repos/calculator`: 3 planted bugs; 3 of its 8 tests fail.
- `toy_repos/stats_feature`: a working stats package (6 passing tests) and a feature request in `ISSUE.md`: add `median()`. This exercises the tester writing tests first.
- `toy_repos/text_utils`: a working text-helpers package (6 passing tests, none for `slugify`) and an `ISSUE.md` asking for `slugify()` with several precise rules (accents, separator runs, edge hyphens, empty result, `TypeError`). A coder working without the tester's tests is likely to miss one, which exercises the verify/review retry loop.

Always run on a copy; Patchwork's own tests check the originals are untouched. The copies aren't git repos, so pass `--init-git`:

```powershell
# PowerShell
Remove-Item -Recurse -Force $env:TEMP\stats -ErrorAction SilentlyContinue
Copy-Item -Recurse toy_repos\stats_feature $env:TEMP\stats
uv run patchwork run --repo $env:TEMP\stats --init-git --issue "Add a median() function that handles even and odd length lists and raises ValueError on an empty list."
```

```bash
# bash
rm -rf /tmp/calc && cp -r toy_repos/calculator /tmp/calc
uv run patchwork run --repo /tmp/calc --init-git --issue "The calculator test suite fails. subtract(), divide() and mean() return wrong results. Fix the bugs."
```

## Tests

```bash
uv run pytest
```

The LLM is mocked (scripted), so no API key or network is needed. Crew tests use real git in temp dirs, with an isolated git config. Covered:

- **Tools:** path guard, read_file paging, edit/insert/write feedback and syntax guard, the shell runner.
- **LLM client:** 400s with and without `failed_generation`; per-minute 429s retried by total wait time; per-day 429s marking the model exhausted; throttling from `x-ratelimit-*` headers; the cooldown shared per model; usage recording.
- **Agent loop:** structured submits, text tool calls, aliases (including `repo_browser.<tool>`), parse failures handled as replies, 400 retries, daily-limit fallback with the conversation intact, and the error when every fallback is exhausted.
- **Role rules:** the tester's restrictions and fail-first gate, the coder's protection of tester files.
- **Crew flow:** worktrees and cleanup, concurrency, merges, retries on test failure and review blockers, the retry cap, the user's tree staying untouched, sequential stopping after a tester failure, parallel cancelling the sibling, branches kept after a failed run, models used and today's usage in the final table.
- **One run at a time and usage:** the lock refusing a second run and clearing a stale one, `runs/usage.json`, `patchwork usage`.
- **Events:** the full event sequence, replay output and `--sequential` producing the same result.

Symlink tests are skipped on Windows unless Developer Mode is enabled.

## Layout

```
src/patchwork/
  config.py          Settings from .env (pydantic-settings)
  llm.py             Async LiteLLM wrapper: tool calls, tokens, 400/429 handling, throttling, per-model state shared by all agents
  usage.py           Daily token usage per model (runs/usage.json)
  runlock.py         One run at a time (runs/.patchwork.lock)
  events.py          Event model, EventBus, JSONL writer, run ids
  render.py          Terminal renderer for events (live and replay)
  workspace.py       git checks, per-run branches/worktrees, commits, merges, cleanup
  orchestrator.py    The crew flow (plan, implement, integrate, verify/review/retry) and solo mode
  schemas.py         Plan, Subtask, ReviewVerdict, AgentRun, RunResult
  snapshot.py        Temp-dir snapshot + difflib diff (solo mode)
  tools/fs.py        read/write/edit/insert/list/search, confined to the repo root
  tools/shell.py     run_tests: subprocess with timeout, failure reason first
  agents/base.py     Generic Agent loop, Tool / AgentResult, SubmitSpec for structured outputs
  agents/toolkit.py  Shared tool bindings, write guards, gpt-oss tool aliases
  agents/lead.py     Lead role: read-only tools + submit_plan
  agents/tester.py   Tester role: new test files only + fail-first gate + auto-finish
  agents/coder.py    Coder role: prompt, tools, test gate and nudge; initial and retry tasks
  agents/reviewer.py Reviewer role: read-only tools + diff + submit_review
  cli.py             Typer CLI: run, replay, usage
toy_repos/calculator/     Bug-planted package
toy_repos/stats_feature/  Working package + a feature request (median)
tests/
runs/                     Event logs and results (git-ignored)
```

Each role is a module that builds an `Agent` with its own prompt, tools and `settings.model_for("<role>")`. The loop, budgets and logging are shared. Roles that return structured data pass a `SubmitSpec` (tool name + pydantic model); roles whose success must be checked independently pass `verify_finish`.

## Staying within Groq's free tier

The free tier allows roughly 30 requests and 6k tokens per minute per model, and the full history is resent on every turn. To stay within that, Patchwork:

- caps `read_file` at 200 lines and 8k characters per call, and clips very long lines;
- adds `edit_file` (exact find/replace) and `insert_lines`, so a fix doesn't have to rewrite the whole file;
- keeps only the end of test output, failure reason first;
- elides old tool results and old tool-call arguments, keeping the 3 most recent in full, plus the latest read of each recently read file (older reads of the same file become a one-line stub);
- answers a repeated read or search whose result hasn't changed with a short pointer to the earlier result instead of the full content again. This includes reads of an unchanged file at another offset, if an earlier read still in context covers those lines. The log marks these as `(unchanged, short note)`;
- strips `title` keys from tool JSON schemas and keeps tool descriptions short;
- tells every agent not to re-read a file it has just written or edited, since the tool result confirms the change;
- hands each crew agent only what it needs (plan subtasks, the diff capped at 8k chars, feedback), not earlier agents' histories.

On a 429, the client waits for as long as the provider asks: the `retry-after` / `retry-after-ms` headers, or Groq's "try again in 7.5s" message. If no hint is given, it falls back to exponential backoff with jitter. The concurrency cap and the backoff are shared **per model** across all agents in the process: when one agent is rate limited, the other agents on that model wait out the same cooldown instead of hitting the API too. The tester and coder run in parallel, so spreading roles across models (as the default reviewer model does) helps. Expect runs to pause on rate limits now and then; that is normal.
