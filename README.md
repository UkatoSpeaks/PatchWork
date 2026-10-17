# Patchwork

A multi-agent coding system for fixing GitHub issues. A lead agent plans the fix and coder, tester and reviewer agents carry it out.

**Status: milestone 1.** Only the **coder agent** exists so far. It fixes a bug in a local repository: it searches the code, reads what it needs, makes a minimal edit, runs the tests, and reports back.

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
| `LEAD_MODEL` / `CODER_MODEL` / `TESTER_MODEL` / `REVIEWER_MODEL` | `groq/openai/gpt-oss-120b` (tester: `groq/openai/gpt-oss-20b`) | Model for each role, as LiteLLM model strings. Only `CODER_MODEL` is used today. |
| `MAX_STEPS_PER_AGENT` | 25 | LLM turns before the agent gives up |
| `MAX_TOKENS_PER_RUN` | 60000 | Prompt + completion token budget for one agent run |
| `MAX_OUTPUT_TOKENS` | 1024 | `max_tokens` for each LLM call |
| `TEST_COMMAND` | `python -m pytest -q --tb=short -p no:cacheprovider` | Run in the repo root. A leading `python` means the interpreter running Patchwork. |
| `TEST_TIMEOUT_SECONDS` | 120 | Timeout for the test command |
| `MAX_CONCURRENT_REQUESTS` | 2 | Semaphore cap on in-flight LLM requests |
| `LLM_MAX_RETRIES` | 6 | Retries on HTTP 429 |

## Usage

```bash
uv run patchwork run --repo PATH --issue "TEXT" [--test-cmd "..."] [--max-steps N]
```

The agent edits files in `PATH` **in place**, so run it on a copy or on a clean git checkout.

### Try it on the toy repo

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

The exit code is 0 if the agent reports success and 1 otherwise.

## Tests

```bash
uv run pytest
```

The unit tests cover the path guard, read_file paging, the shell runner, LLM retry handling and the agent loop. The LLM is mocked, so no API key or network is needed. Symlink tests are skipped on Windows unless Developer Mode is enabled.

## Layout

```
src/patchwork/
  config.py         Settings from .env (pydantic-settings)
  llm.py            Async LiteLLM wrapper: tool calls, token tracking, 429 retries, semaphore
  tools/fs.py       read_file / write_file / edit_file / list_dir / search_code, confined to the repo root
  tools/shell.py    run_tests: subprocess with timeout, output tail-truncated
  agents/base.py    Generic Agent loop + Tool / AgentResult models
  agents/coder.py   Coder role: system prompt + tool bindings
  cli.py            Typer CLI
toy_repos/calculator/   Bug-planted package for testing the agent
tests/
```

To add a role (lead, tester, reviewer), write a module like `agents/coder.py` that builds an `Agent` with its own prompt, tools and `settings.model_for("<role>")`. The loop, budgets and logging are shared.

## Staying within Groq's free tier

The free tier allows roughly 30 requests and 6k tokens per minute per model, and the full history is resent on every turn. To stay within that, Patchwork:

- caps `read_file` at 200 lines and 8k characters per call, and clips very long lines;
- adds `edit_file` (exact find/replace), so a fix doesn't have to rewrite the whole file;
- keeps only the last end of test output (3k chars per stream);
- elides old tool results and old tool-call arguments, keeping the 3 most recent in full;
- strips `title` keys from tool JSON schemas and keeps tool descriptions short;
- forces tool calls (`tool_choice="required"`) so turns aren't spent on prose.

On a 429, the client waits for as long as the provider asks: the `retry-after` / `retry-after-ms` headers, or Groq's "try again in 7.5s" message. If no hint is given, it falls back to exponential backoff with jitter. Expect runs to pause on rate limits now and then; that is normal.
