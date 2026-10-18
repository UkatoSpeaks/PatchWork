# Patchwork

A multi-agent coding system for fixing GitHub issues. A lead agent plans the fix and coder, tester and reviewer agents carry it out.

**Status: milestone 2.** Four agents run one after another, in a fixed order:

1. **lead**: explores the repo read-only and submits a `Plan` (issue summary, tester/coder subtasks with files and acceptance criteria, risks) through a `submit_plan` tool. Invalid plans are sent back with the validation error (up to 2 retries). A tester subtask that names an existing test file is invalid: tests go in a new file.
2. **tester**: writes tests in a *new* file that encode the issue's expected behaviour. It can only create test files (under a `tests/` directory or named `test_*.py`); existing test files can't be changed. Its success counts only if those tests **fail** before the fix (an ImportError for the missing feature counts; a syntax error doesn't). As soon as a `run_tests` on its new files shows that, the tester is ended automatically.
3. **coder**: the milestone 1 agent, now given the plan's coder subtasks and the tester's test paths. It cannot edit any file the tester created or modified, and succeeds only if the full suite passes after its last edit. It is nudged if it edits files and then goes 5 steps without running tests.
4. **reviewer**: reads the run's diff (read-only tools) and submits a `ReviewVerdict` through `submit_review`. In milestone 2 the verdict is only reported; there is no retry loop yet.

Each agent gets only what it needs from earlier agents, not their history. The repo is copied to a temp dir before the run, and the diff and changed files are computed from that copy with `difflib`, never taken from what a model says. A run succeeds when the coder succeeds **and** the reviewer approves. If an agent fails, the run stops and reports which one.

Write restrictions are enforced in the tool layer (`agents/toolkit.py`), not just in prompts.

Tool behaviour that helps every agent recover without wasted steps:

- `edit_file` matches regardless of CRLF vs LF and keeps the file's line endings. It also accepts text copied with read_file's `N| ` prefixes. When the text isn't found, the error shows the closest matching lines, numbered.
- Successful `edit_file` / `write_file` results show the changed region with 5 lines of context, so there is no need to re-read the file.
- Writes to `.py` files are refused, and the file is left unchanged, if the result doesn't parse (`ast.parse`). The error gives the line number.
- `read_file` on a directory returns its listing. A missing path suggests close matches ("did you mean tests/test_core.py?").
- A tool call written as JSON text (`{"name": ..., "arguments": ...}`) is executed like a normal tool call.
- Failed `run_tests` results start with the failure reason (the pytest `E ...` lines), then the last 30 lines of output.

## Setup

Requires [uv](https://docs.astral.sh/uv/). uv downloads Python 3.12 if you don't have it.

```bash
uv sync                    # creates .venv and installs runtime + dev dependencies
cp .env.example .env       # then set GROQ_API_KEY (https://console.groq.com/keys)
```

All settings are read from `.env` (or real environment variables). See `.env.example`:

| Variable | Default | Purpose |
|---|---|---|
| `GROQ_API_KEY` | none | Required for `groq/` models |
| `LEAD_MODEL` / `CODER_MODEL` / `TESTER_MODEL` / `REVIEWER_MODEL` | `groq/openai/gpt-oss-120b` (reviewer: `groq/qwen/qwen3.8-27b`, to spread load across Groq's per-model rate limits) | Model for each role, as LiteLLM model strings. `--solo` uses only `CODER_MODEL`. |
| `MAX_STEPS_PER_AGENT` | 25 | LLM turns before an agent gives up (per agent) |
| `MAX_TOKENS_PER_RUN` | 60000 | Prompt + completion token budget per agent |
| `MAX_OUTPUT_TOKENS` | 1024 | `max_tokens` for each LLM call |
| `TEST_COMMAND` | `python -m pytest -q --tb=short -p no:cacheprovider` | Run in the repo root. A leading `python` means the interpreter running Patchwork. |
| `TEST_TIMEOUT_SECONDS` | 120 | Timeout for the test command |
| `MAX_CONCURRENT_REQUESTS` | 2 | Semaphore cap on in-flight LLM requests |
| `LLM_MAX_RETRIES` | 6 | Retries on HTTP 429 |

## Usage

```bash
uv run patchwork run --repo PATH --issue "TEXT" [--solo] [--test-cmd "..."] [--max-steps N]
```

Without `--solo` the crew runs (lead -> tester -> coder -> reviewer). The CLI prints a section per agent (plan, tests written, coder steps, review verdict), then the diff computed from the snapshot, then a token table per agent. `--solo` runs only the coder, as in milestone 1, and prints the same diff and token table (useful for single-vs-crew comparisons).

Agents edit files in `PATH` **in place**, so run on a copy or on a clean git checkout.

### Try it on the toy repos

- `toy_repos/calculator`: 3 planted bugs; 3 of its 8 tests fail.
- `toy_repos/stats_feature`: a working stats package (6 passing tests) and a feature request in `ISSUE.md`: add `median()`. This exercises the tester writing tests first.

Always copy a toy repo before running on it; Patchwork's own tests check the originals are untouched.

`toy_repos/calculator` has 3 planted bugs. Out of the box, 3 of its 8 tests fail. Copy it first so the original stays broken, because `tests/test_toy_repo.py` checks that the bugs are still there:

```powershell
# PowerShell
Copy-Item -Recurse toy_repos\calculator $env:TEMP\calc
uv run patchwork run --repo $env:TEMP\calc --issue "The calculator test suite fails. subtract(), divide() and mean() return wrong results. Fix the bugs."
```

```bash
# bash
cp -r toy_repos/calculator /tmp/calc
uv run patchwork run --repo /tmp/calc --issue "The calculator test suite fails. subtract(), divide() and mean() return wrong results. Fix the bugs."
```

```powershell
# PowerShell: the crew on the feature request
Copy-Item -Recurse toy_repos\stats_feature $env:TEMP\stats
uv run patchwork run --repo $env:TEMP\stats --issue "Add a median() function that handles even and odd length lists and raises ValueError on an empty list."
```

The exit code is 0 if the run succeeds and 1 otherwise.

## Tests

```bash
uv run pytest
```

The unit tests cover the path guard, read_file paging, the shell runner, LLM retry handling, the agent loop, plan/verdict validation and retries, the tester's write restriction and must-fail check, the coder's protection of tester files, the snapshot diff, the orchestrator stopping on failure, and a full scripted crew run on `stats_feature`. The LLM is mocked, so no API key or network is needed. Symlink tests are skipped on Windows unless Developer Mode is enabled.

## Layout

```
src/patchwork/
  config.py         Settings from .env (pydantic-settings)
  llm.py            Async LiteLLM wrapper: tool calls, token tracking, 429 retries, semaphore
  tools/fs.py       read_file / write_file / edit_file / list_dir / search_code, confined to the repo root
  tools/shell.py    run_tests: subprocess with timeout, output tail-truncated
  schemas.py        Plan, Subtask, ReviewVerdict, RunResult
  snapshot.py       Copy the repo before a run; diff it afterwards with difflib
  orchestrator.py   Runs lead -> tester -> coder -> reviewer (or the coder alone)
  agents/base.py    Generic Agent loop, Tool / AgentResult, SubmitSpec for structured outputs
  agents/toolkit.py Shared tool bindings and write guards (tests-only, protected files)
  agents/lead.py    Lead role: read-only tools + submit_plan
  agents/tester.py  Tester role: test-file writes only + must-fail gate
  agents/coder.py   Coder role: system prompt + tool bindings
  agents/reviewer.py Reviewer role: read-only tools + diff + submit_review
  cli.py            Typer CLI
toy_repos/calculator/     Bug-planted package
toy_repos/stats_feature/  Working package + a feature request (median)
tests/
```

Each role is a module that builds an `Agent` with its own prompt, tools and `settings.model_for("<role>")`. The loop, budgets and logging are shared. Roles that return structured data pass a `SubmitSpec` (tool name + pydantic model); roles whose success must be checked independently pass `verify_finish`.

## Staying within Groq's free tier

The free tier allows roughly 30 requests and 6k tokens per minute per model, and the full history is resent on every turn. To stay within that, Patchwork:

- caps `read_file` at 200 lines and 8k characters per call, and clips very long lines;
- adds `edit_file` (exact find/replace), so a fix doesn't have to rewrite the whole file;
- keeps only the last end of test output (3k chars per stream);
- elides old tool results and old tool-call arguments, keeping the 3 most recent in full, plus the latest read of each recently read file (older reads of the same file become a one-line stub);
- answers a repeated read or search whose result hasn't changed with a short pointer to the earlier result instead of the full content again;
- strips `title` keys from tool JSON schemas and keeps tool descriptions short;
- forces tool calls (`tool_choice="required"`) so turns aren't spent on prose;
- tells every agent not to re-read a file it has just written or edited, since the tool result confirms the change;
- hands each crew agent only what it needs (plan subtasks, test paths, the diff capped at 8k chars), not earlier agents' histories.

On a 429, the client waits for as long as the provider asks: the `retry-after` / `retry-after-ms` headers, or Groq's "try again in 7.5s" message. If no hint is given, it falls back to exponential backoff with jitter. Expect runs to pause on rate limits now and then; that is normal.
