# Patchwork

A multi-agent coding system for fixing GitHub issues. A lead agent plans the fix and coder, tester and reviewer agents carry it out.

**Status: milestone 3.** The crew works on git branches in separate worktrees, runs the tester and coder in parallel, retries on failing tests or review blockers, and reports everything as structured events.

## How a crew run works

1. **plan**: the **lead** explores the target repo read-only and submits a `Plan` (issue summary, tester/coder subtasks with files and acceptance criteria, risks) through a `submit_plan` tool. Invalid plans are sent back with the validation error (up to 2 retries). A tester subtask that names an existing test file is invalid: tests go in a new file.
2. **implement**: the **tester** and the **coder** run **concurrently**, each in its own git worktree on its own branch (`patchwork/<run_id>/tester`, `patchwork/<run_id>/coder`), created from the current HEAD.
   - The tester writes tests in a *new* file that encode the issue's expected behaviour. It can only create test files (under `tests/` or named `test_*.py`). Its tests must **fail** against the unmodified code in its worktree (an ImportError for the missing feature counts; a syntax error doesn't). It is ended automatically as soon as a `run_tests` on its new files shows that.
   - The coder gets the plan's coder subtasks, but not the tester's tests, which are written in another worktree; its task says so plainly, so it implements from the issue and the acceptance criteria instead of searching for them. Its own check is that the existing suite passes in its worktree.
   - Both commit to their branch when done. `--sequential` runs them one after the other instead, for comparison.
   - If the **tester** fails, the run stops. Sequentially, the coder is never started. In parallel, the coder is cancelled (asyncio task cancellation); it is recorded with stop reason `cancelled` and its work so far is committed to its branch.
   - If the **coder** fails (error, max steps, invalid output) and the tester succeeds, that is a failed attempt, not the end of the run: the tester finishes, the run logs "coder failed (reason); continuing with a retry", and goes on to integrate and the retry loop. The failed attempt counts toward the retry cap.
3. **integrate**: a result worktree/branch (`patchwork/<run_id>/result`) is created from HEAD, and the coder branch (if it has commits) and then the tester branch are merged into it. A conflict should be impossible; if one happens, the run stops and names the files.
4. **verify**: the full suite runs in the result worktree. If it fails, a **coder retry** starts in the result worktree with the failing output and the plan. The retry may not edit the tester's files.
5. **review**: the **reviewer** reads the diff (result branch vs HEAD) with read-only tools and submits a `ReviewVerdict`. `approved` is true exactly when there is no blocker. A blocker starts a coder retry with the review issues, then verify and review run again.

At most `--max-retries` (default 3) coder retries happen per run, across both kinds, counting a failed implement-phase coder as one. Each retry is a fresh agent that gets only the plan, the current diff and the feedback, and its changes are committed to the result branch. Retries run on `CODER_RETRY_MODEL` (e.g. a bigger model) when it is set. Every coder attempt and its models are in `RunResult.attempts` and in the final table: `coder: gpt-oss-20b (attempt 1, failed) -> retry 1: gpt-oss-120b (passed)`.

**Success** = the full suite passes in the result worktree **and** the reviewer approved. The diff and changed files come from git (result branch vs the base commit), never from what a model says. If an agent other than the implement-phase coder fails, the run stops and reports which one.

**Your working tree is never modified.** Worktrees live in a temp dir and are always removed at the end, even after a failure. After a successful run only the result branch is kept (the tester and coder branches are merged into it and deleted). After a failed run, every tester/coder/result branch **that has commits** is kept; empty ones are deleted. Patchwork prints each kept branch with `git log --oneline <base>..<branch>` / `git diff <base> <branch>`, and a `git branch -D ...` line to remove them. After a success it prints:

```bash
git diff HEAD patchwork/<run_id>/result     # inspect
git merge patchwork/<run_id>/result         # apply
```

Patchwork commits on its own branches with `--no-verify`, so the target repo's commit hooks don't block agents mid-run. It uses your git identity if one is configured, and `Patchwork <patchwork@localhost>` otherwise.

Write restrictions are enforced in the tool layer (`agents/toolkit.py`), not just in prompts.

### Tool behaviour

These help every agent recover without wasted steps:

- `edit_file` matches regardless of CRLF vs LF and keeps the file's line endings. It also accepts text copied with read_file's `N| ` prefixes. When the text isn't found, the error shows the closest matching lines, numbered. When it occurs more than once, an optional `near_line` picks the occurrence closest to that line; without it the error lists the lines and suggests both ways out: "old text occurs 2 times in text_utils/core.py (at lines 8, 35). Pass near_line to pick one (e.g. near_line=35), or use replace_lines(text_utils/core.py, 35, 36, '') to delete lines 35-36 ...".
- `replace_lines(path, start_line, end_line, text)` (coder and tester) replaces an inclusive line range; `text=""` deletes it. The coder's prompt tells it to prefer this when it knows the line numbers, especially for deleting code. Same path guards, write restrictions, line-ending handling and syntax guard as `edit_file`.
- `insert_lines(path, after_line, text)` (coder and tester) inserts after a line number: 0 = top, -1 = end of file. It's the safe way to add a new function without hunting for a unique `edit_file` anchor.
- Successful `edit_file` / `replace_lines` / `insert_lines` / `write_file` results show the changed region with 5 lines of context, so there is no need to re-read the file.
- Writes to `.py` files are refused, and the file is left unchanged, if the result doesn't parse (`ast.parse`). The error gives the line number. Two problems are written anyway, with a warning in the result: a top-level function or class defined twice ("WARNING: median is now defined twice (lines 28 and 42); remove one"), and statements after a `return` / `raise` / `continue` / `break` in the same block ("WARNING: lines 35-36 are unreachable (after the return on line 33)").
- `read_file` on a directory returns its listing. A missing path suggests close matches ("did you mean tests/test_core.py?").
- A tool call written as JSON text (`{"name": ..., "arguments": ...}`) is executed like a normal tool call, and never counts as a plain-text final answer. Parsing tries strict JSON (raw newlines in strings allowed), then `json-repair`, then the outermost `{...}` block. If the text looks like a tool call but can't be parsed, or the reply was cut off at the output-token limit, the model gets an error asking it to call the tool natively; the call is never dropped silently.
- gpt-oss's built-in tool names are mapped to ours: `repo_browser.print_tree` → `list_dir`, `repo_browser.open_file` → `read_file` (`line_start` → `offset`), `repo_browser.search` → `search_code` (`query` → `pattern`), and any `repo_browser.<tool>` where `<tool>` is one of ours (e.g. `repo_browser.list_dir`) → `<tool>`. Any other unknown tool name gets an error listing the tools that exist, and the run continues.
- Groq 400s that carry a `failed_generation` (`output_parse_failed`, `tool_use_failed`, or any other code) are treated as the model's reply with that text: a JSON tool call in it is run, prose follows the plain-text rules. A 400 without `failed_generation` is logged as a note and retried. After 3 consecutive 400s on one model (with or without `failed_generation`), the agent switches to the next model in its role's `*_FALLBACKS` list, keeping the conversation, and logs "model kept failing on X, switching to Y". The agent fails only when every model in its list has hit this or a daily limit; with no model left to switch to, a third 400 in a row without `failed_generation` fails it.
- An exact tool call (same name and arguments) made a 3rd time with no file changed since, after two identical results, is not run. The agent gets "You've made this exact call 3 times and the result hasn't changed. Do something different: ..." with a tool-specific hint (a crew coder looking for tests is told the tester writes them in a separate workspace). The guard never starves an agent of a file: a repeated `read_file` whose earlier full result has been trimmed from the history just runs, and one that is blocked gets the requested lines again after the warning.
- An attempt that goes in circles ends early as failed with stop reason `stuck` ("stuck: <details>") instead of running to `MAX_STEPS_PER_AGENT`: after 3 repeated-call blocks, or 3 errors in a row from the same tool with the same error type (numbers ignored; a file change resets the count). A stuck coder retry counts toward the retry cap; if it changed nothing, the next retry starts straight away with the same feedback (no re-run of the suite or the reviewer), and the run ends once the cap is reached.
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
| `LEAD_FALLBACKS` / `CODER_FALLBACKS` / `TESTER_FALLBACKS` | `groq/qwen/qwen3.8-27b,groq/openai/gpt-oss-20b` | Comma-separated models to switch to, in order, when the role's model hits a per-day limit or keeps getting 400s |
| `REVIEWER_FALLBACKS` | `groq/openai/gpt-oss-120b,groq/openai/gpt-oss-20b` | Same, for the reviewer |
| `CODER_RETRY_MODEL` | empty (= `CODER_MODEL`) | Model for crew coder retries, e.g. a bigger one than the first attempt's |
| `CODER_RETRY_FALLBACKS` | empty (= `CODER_FALLBACKS`) | Fallbacks for coder retries |
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
  - `THROTTLE_MODE=proportional` (default) assumes the budget refills gradually at limit/60s, so it waits `(needed - remaining) / (limit / 60s) + 1s`, capped at the reset time from the headers. Each per-minute 429 on a call sent on assumed refill adds 2s to that model's margin; after the third, the model switches to full waits for the rest of the run, and the run says so once: "proportional throttling not accepted on <model>; using full reset waits".
  - `THROTTLE_MODE=full` waits for the reset time from the headers.
- **Daily usage.** Tokens and requests per model per day (local date) are added to `runs/usage.json` after every call. The final table shows today's totals, with the per-day limit when known. Groq sends the requests-per-day limit in its headers; the tokens-per-day limit only appears in a TPD 429 message, so it is remembered from there. A TPD message's "Used N" also raises today's total to Groq's count, which includes usage outside Patchwork. `patchwork usage` prints today's totals, and `patchwork usage --days 7` shows the last 7 days with usage.

## Usage

```bash
uv run patchwork run --repo PATH --issue "TEXT" [--init-git] [--sequential] [--max-retries N] [--test-cmd "..."] [--max-steps N]
uv run patchwork run --repo PATH --issue-file ISSUE.md [...]
uv run patchwork run --repo PATH --issue "TEXT" --solo
uv run patchwork replay runs/<run_id>/events.jsonl
uv run patchwork usage [--days N]
uv run patchwork serve [--port 8000] [--runs-dir runs]
uv run patchwork stop [RUN_ID]
```

- `--runs-dir DIR` (run) writes the run, the run lock and `usage.json` under DIR instead of `runs/`. The dashboard also passes a hidden `--run-id` so it can open the run straight away.
- `--issue-file` reads the issue from a UTF-8 file (a BOM is fine) instead of `--issue`; pass exactly one of them. Prefer it for issue text with non-ASCII characters: in Windows PowerShell 5, `--issue (Get-Content -Raw ISSUE.md)` decodes UTF-8 with the wrong encoding ('é' arrives as 'Ã©').
- `PATH` must be the root of a git repo with a commit and no uncommitted changes (commit or stash first). `--init-git` turns a plain directory into one: `git init` plus an initial commit of everything in it.
- `--sequential` runs the tester and coder one after the other instead of concurrently. The final table shows wall-clock time per agent and per phase, so the two modes can be compared.
- **Stopping a run.** `patchwork stop` (or **■ STOP** in the dashboard, or Ctrl+C / SIGTERM on the run's process) stops the run that is going. The agent at work is cancelled at once (an LLM call or rate-limit wait ends; a tool already running, like the tests, finishes in the background), its work so far is committed and recorded with stop reason `stopped`, and the run ends the usual way: worktrees removed, branches with commits kept, `run_finished` written with `stopped: true` and `error` saying why. A second Ctrl+C interrupts at once. The request is a file, `runs/<run_id>/stop.json`, which the run checks twice a second, so it works for runs started anywhere and on Windows.
- `--solo` runs only the coder, editing `PATH` **in place** as in milestone 1 (no git needed; the diff comes from a temp-dir snapshot). It's kept for single-vs-crew evals.

The CLI shows each phase as it happens. Lines from agents are prefixed with the agent name, so parallel output stays readable. At the end it prints the diff, a table of tokens and time per agent run (retries included), the phase durations, and the outcome. The exit code is 0 if the run succeeds and 1 otherwise.

### Events

Everything the CLI prints is rendered from structured events (`events.py`). Agents and the orchestrator publish to an `EventBus`; nothing else prints. Each `Event` has `run_id`, `seq`, `timestamp`, `agent` (lead/tester/coder/reviewer/orchestrator), `type` and `payload`. The types are:

`run_started`, `phase_started`, `phase_finished`, `agent_started`, `llm_call`, `tool_called`, `tool_result`, `rate_limited`, `throttled`, `note`, `agent_finished`, `tests_run`, `merge`, `retry_started`, `review_verdict`, `run_finished`.

For the dashboard, `tool_result` events carry the tool's `output` as the agent saw it (cut to 4,000 characters, with `output_chars` giving the full length), and every commit carries its `diff` against the base commit: the tester's and the coder's `agent_finished`, each `merge` (the result branch after it) and each retry's `agent_finished`, which also has `change` (just that retry's commit). Diffs are cut to 100k characters (`diff_chars`).

Every run writes `runs/<run_id>/events.jsonl` (one event per line, as it happens) and `runs/<run_id>/result.json` (the final `RunResult`). `patchwork replay` re-renders a past run from its log; the output is identical. A frontend can subscribe with `EventBus.subscribe`, or consume `async for event in bus.stream()`.

### Web dashboard

`web/` is a Next.js app that replays a run as a pixel-art office. The rule for who is where: an **active** agent (from its `agent_started` to its `agent_finished`) works at its own spot for the whole task (the lead at the desk in its cabin, the tester, coder and reviewer at their named desks; a retry coder at the coder's desk), with a soft glow under it and its monitor on. Waiting on a rate limit or throttling, it stays seated with a mug. Above it, a **status tag** in its colour shows its task ("Task: add slugify()", from the plan or the retry reason) and what it is doing now ("Reading core.py", "Deleting lines 35-36", "Running tests…", "⏳ waiting for Groq · 12s" counting down); the agent cards show the same two lines. **Idle** agents have no tag, their monitors are off, and they live office life: water cooler, coffee machine, sofa, window, chats. Speech bubbles are only for moments: a test result ("All green! ✅"), a handoff (the idle reviewer walks to the coder's desk with "Can you fix this?"; "On it"), a model switch, dead code ("Oops, dead code"), and finishing, failing or getting stuck ("I'm going in circles…"). Wording is chosen per run id + event seq, so replays and deep links read the same. The whiteboard shows the plan once the lead submits it, the wall TV shows test results, and on success everyone gathers at the merge table. All art is drawn in code. When the replay reaches the end, a **result banner** says whether the issue was fixed and why (tests, review, the coder's attempts and models, the open blockers or failing tests), links to the event that decided it, and gives the git commands to apply the fix or inspect the kept branches. Below the scene: an activity log (click a character to filter it), the lead's plan (also via the whiteboard), the code and per-agent stats. The **Diff** tab lists every version of the code in the run (the tester's tests, the coder's first try, the merged result, each retry, marked FINAL at the end); it follows the replay, showing the newest version at the current moment, until you pick one. For a retry, "this retry only" shows just what that retry changed. Runs that stopped before merging still show the tester's and coder's branches. Clicking a log line (or the current event under the scrubber) opens the **event drawer**: everything that event carries, laid out per type: a tool call with its arguments (an edit's old and new text, written file content), its result and what the agent got back (the file lines read, the search matches, ...), full test output and failure reasons, every review issue, retry feedback, rate-limit details, plus the raw JSON. `?event=N` links to an open event. Keys: space play/pause, ←/→ step one event (through the drawer when it's open), Esc close the drawer, 1-4 speed, L go live, ? keys and clicks (also the ? button; first-time visitors get a one-time tip). On wide screens (≥1280px) the office is sized to fit the screen's height with the activity log beside it at full height; the replay controls stay pinned to the bottom of the screen on every size. It reads the run logs through a small read-only API (`server.py`).

```bash
# terminal 1, repo root: the API on http://localhost:8000
uv run patchwork serve [--port 8000] [--runs-dir runs]

# terminal 2: the dashboard on http://localhost:3000
cd web && npm install && npm run dev
```

The API base URL comes from `NEXT_PUBLIC_API_URL` (default `http://localhost:8000`; see `web/.env.example`). Endpoints:

- `GET /api/runs`: run summaries (issue, mode, success, status, tokens, duration), newest first. `status` is `finished`, `running` (the run lock in `runs/` names the run and its process is alive) or `stopped` (stopped on request, or no result and no live process: it crashed or was killed).
- `GET /api/runs/{run_id}`: the summary, `result.json` (null while unfinished) and the plan.
- `GET /api/runs/{run_id}/events`: every event.
- `POST /api/runs/{run_id}/stop`: ask a running run to stop (202, `{"state": "stopping"}`); 409 if it isn't running. Until it ends, its summary has `stop_requested: true`; afterwards its `status` is `stopped`. Same origin and JSON rules as starting a run.
- `GET /api/runs/{run_id}/stream?speed=4&start=0`: server-sent events replaying the log at its original pace divided by `speed` (0 = no delays), each gap capped at 2s, then an `end` event. For a running run, once the replay catches up it sends a `live` event and then each new event as soon as it is written to `events.jsonl`, until `run_finished` or the run's process exits.

The replay uses `/stream` for playback and `/events` for seeking: the scene is a pure reducer over events (`web/lib/office/reducer.ts`), so jumping to event N means reducing `events[0..N]`. `/runs/<run_id>?at=N` opens a run paused at event N.

**Themes and phones.** The dashboard follows the system's light or dark setting; the button in the header cycles system → light → dark and the browser remembers the choice (applied before the first paint, so there's no flash). Colours are CSS variables in `web/app/globals.css` (one block per theme); the office art keeps its colours in both. On phones the agent cards are a row to swipe through, and the pinned replay controls shrink to one line (play, restart, speed, scrubber, ?), without the phase bar and the current-event text.

**Loading and accessibility.** While data loads, pages show pixel placeholders shaped like what's coming (run cards and the summary, the run's top bar, log and tabs, the toy repos and the crew), marked `aria-busy`. The run's tabs are real tabs (arrow keys, Home, End) and the toy picker is a radio group (arrow keys). Speech bubbles and status tags are hidden from screen readers (the agent cards carry the same text); a polite live region announces only the phase and the result. With reduced motion turned on in the OS, characters move straight to where they're going instead of walking, and the decorative animations stop. The help panel keeps focus inside it; the scrubber reads "Event 12 of 76: …"; a "Skip to content" link comes first on every page.

**Runs list.** A summary strip on top (runs and how many today, pass rate over finished runs, typical time and tokens as medians, and a link to the live run if one is going), then search (issue, repo, run id, mode; matches are highlighted), filter chips with counts (All, Pass, Fail, Live, Stopped) and a sort (newest, oldest, longest, most tokens). They are kept in the address bar (`/?q=median&status=fail&sort=tokens`), so a filtered view can be shared. `/` focuses the search, Esc clears it. Each card shows the repo's folder name and the number of retries; `GET /api/runs` includes `repo` and `retries`.

**New run.** `+ New run` on the runs list (or `/runs/new`) starts a crew run from the browser. Pick a toy repo (copied to a temp folder and git-initialised for each run, so the original is untouched) or type the path of your own repo: it is checked as you type (clean git repo, uncommitted changes listed, or "not a git repo yet" with an **Initialize git** option), and its `ISSUE.md` can fill the issue. Options: tester and coder together or one at a time, coder retries, and (advanced) steps per agent and the test command. A checklist beside the form shows what still blocks the start (API key, another run going, the repo, the issue); Ctrl/⌘+Enter starts. The page then shows "Getting the crew ready…" until the first event and switches to the live office; if `patchwork run` exits before writing any events, the page shows its console output instead. The draft is kept for the tab's session. `/runs/new?toy=text_utils`, `?repo=PATH` and `?from=<run_id>` (the result banner's **Run again**: the same repo, issue and options) prefill the form. Solo mode stays CLI-only, since it edits the repo in place.

The server starts the run as `patchwork run` in its own process (`launcher.py`), from the server's working directory so it reads the same `.env`; stopping the server doesn't stop the run. Console output goes to `runs/.launch/<run_id>/console.log`. Starting runs is only allowed from the dashboard's origins (or from clients that send no Origin, like curl) and needs a JSON body, so other web pages can't start runs. Endpoints: `GET /api/config`, `GET /api/toy-repos`, `GET /api/repo-check?path=`, `POST /api/runs` (201 with the run id; 400 with a message for a bad request, 409 while another run is going) and `GET /api/launches/{run_id}`.

**Live runs.** Start `patchwork serve` and the dashboard, then `patchwork run` in a third terminal: the run appears in the list with a blinking LIVE badge (the list refreshes every 3s while a run is going, every 10s otherwise). Opening it jumps to the present and follows along; the top bar says LIVE. Scrubbing back or pausing leaves live mode; **go live** (or the L key) jumps back to now. When the run finishes, the diff and result load on their own. A run that died shows STOPPED. The office code lives in `web/lib/office/`: `reducer` (scene state and what agents say), `status` (status tag lines), `phrases`, `animator` + `idle` (movement and office life), `bubbles` (how long bubbles stay up, where tags and bubbles go), and the art in `characters`, `furniture`, `scenery`, `renderer`. Frontend tests: `cd web && npm test`.

### Try it on the toy repos

- `toy_repos/calculator`: 3 planted bugs; 3 of its 8 tests fail.
- `toy_repos/stats_feature`: a working stats package (6 passing tests) and a feature request in `ISSUE.md`: add `median()`. This exercises the tester writing tests first.
- `toy_repos/text_utils`: a working text-helpers package (6 passing tests, none for `slugify`) and an `ISSUE.md` asking for `slugify()` with several precise rules (accents, separator runs, edge hyphens, empty result, `TypeError`). A coder working without the tester's tests is likely to miss one, which exercises the verify/review retry loop.

Always run on a copy; Patchwork's own tests check the originals are untouched. The copies aren't git repos, so pass `--init-git`:

```powershell
# PowerShell
Remove-Item -Recurse -Force $env:TEMP\stats -ErrorAction SilentlyContinue
Copy-Item -Recurse toy_repos\stats_feature $env:TEMP\stats
uv run patchwork run --repo $env:TEMP\stats --init-git --issue-file toy_repos\stats_feature\ISSUE.md

Remove-Item -Recurse -Force $env:TEMP\text_utils -ErrorAction SilentlyContinue
Copy-Item -Recurse toy_repos\text_utils $env:TEMP\text_utils
uv run patchwork run --repo $env:TEMP\text_utils --init-git --issue-file toy_repos\text_utils\ISSUE.md
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

- **Tools:** path guard, read_file paging, edit/replace/insert/write feedback and syntax guard, `near_line` and the ambiguity message, duplicate-definition and unreachable-code warnings, the shell runner.
- **LLM client:** 400s with and without `failed_generation`; per-minute 429s retried by total wait time; per-day 429s marking the model exhausted; throttling from `x-ratelimit-*` headers; the cooldown shared per model; usage recording.
- **Agent loop:** structured submits, text tool calls, aliases (including `repo_browser.<tool>`), parse failures handled as replies, 400 retries, switching models after repeated 400s or a daily limit with the conversation intact, the error when every model is used up, the repeated-call guard (re-running a trimmed read, showing the lines when it blocks one), stuck detection, and history trimming.
- **Role rules:** the tester's restrictions and fail-first gate, the coder's protection of tester files.
- **Crew flow:** worktrees and cleanup, concurrency, merges, retries on test failure and review blockers, the retry cap, the user's tree staying untouched, sequential stopping after a tester failure, parallel cancelling the coder, a coder failure leading to integrate and a retry on `CODER_RETRY_MODEL`, a stuck retry moving on to the next retry, branches kept after a failed run, models used and today's usage in the final table.
- **Stopping:** stopping during the plan, the parallel and sequential implement phase, the review and a solo run (work committed, branches kept, worktrees removed, `run_finished` written); a stop before the run starts; a cancellation from outside still cleaning up; the stop file; `patchwork stop`; the stop endpoint and the `stopped` status.
- **One run at a time and usage:** the lock refusing a second run and clearing a stale one, `runs/usage.json`, `patchwork usage`.
- **Events:** the full event sequence, replay output and `--sequential` producing the same result.
- **Dashboard API:** run list (skipping empty runs, newest first), detail and plan, events, SSE replay order and `end`, gap scaling and capping, CORS, run status, following a live log.
- **Starting runs:** the repo check's states, launching with the options (a fake `patchwork` script), toy repos copied with their issue and `--init-git`, a run that dies before its first event, refused requests (no repo, empty issue, dirty repo, plain folder without init, no API key, another run going), and other origins / non-JSON bodies being refused.

Symlink tests are skipped on Windows unless Developer Mode is enabled.

## Layout

```
src/patchwork/
  config.py          Settings from .env (pydantic-settings)
  llm.py             Async LiteLLM wrapper: tool calls, tokens, 400/429 handling, throttling, per-model state shared by all agents
  usage.py           Daily token usage per model (runs/usage.json)
  runlock.py         One run at a time (runs/.patchwork.lock), stop requests (runs/<run_id>/stop.json)
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
  server.py          FastAPI over runs/ for the web dashboard (list, detail, events, SSE replay and live follow, starting runs)
  launcher.py        Starts crew runs for the dashboard: request checks, toy repo copies, background `patchwork run`
  cli.py             Typer CLI: run, replay, usage, serve, stop
toy_repos/calculator/     Bug-planted package
toy_repos/stats_feature/  Working package + a feature request (median)
tests/
tests/fixtures/runs/      A small recorded run shared by the server and reducer tests
web/                      Next.js dashboard: app/ pages, components/ (scene, replay controls, log, plan/diff/stats panels), lib/office/ (reducer, phrases, layout, animator, idle, bubbles, art)
runs/                     Event logs and results (git-ignored)
```

Each role is a module that builds an `Agent` with its own prompt, tools and `settings.model_for("<role>")`. The loop, budgets and logging are shared. Roles that return structured data pass a `SubmitSpec` (tool name + pydantic model); roles whose success must be checked independently pass `verify_finish`.

## Staying within Groq's free tier

The free tier allows roughly 30 requests and 6k tokens per minute per model, and the full history is resent on every turn. To stay within that, Patchwork:

- caps `read_file` at 200 lines and 8k characters per call, and clips very long lines;
- adds `edit_file` (exact find/replace), `replace_lines` and `insert_lines`, so a fix doesn't have to rewrite the whole file;
- keeps only the end of test output, failure reason first;
- keeps only the 2 most recent tool results in full; older ones, file reads included, become a one-line summary (`[trimmed: read_file: core.py: lines 1-40 of 40; ...]`), except the latest read of each file the agent has edited. Old tool-call arguments are shortened too. The final table shows the average prompt size per agent run (`avg prompt`), the number to watch against Groq's tokens-per-minute limit;
- answers a repeated read or search whose result hasn't changed with a short pointer to the earlier result instead of the full content again. This includes reads of an unchanged file at another offset, if an earlier read still in context covers those lines. The log marks these as `(unchanged, short note)`;
- strips `title` keys from tool JSON schemas and keeps tool descriptions short;
- tells every agent not to re-read a file it has just written or edited, since the tool result confirms the change;
- hands each crew agent only what it needs (plan subtasks, the diff capped at 8k chars, feedback), not earlier agents' histories.

On a 429, the client waits for as long as the provider asks: the `retry-after` / `retry-after-ms` headers, or Groq's "try again in 7.5s" message. If no hint is given, it falls back to exponential backoff with jitter. The concurrency cap and the backoff are shared **per model** across all agents in the process: when one agent is rate limited, the other agents on that model wait out the same cooldown instead of hitting the API too. The tester and coder run in parallel, so spreading roles across models (as the default reviewer model does) helps. Expect runs to pause on rate limits now and then; that is normal.
