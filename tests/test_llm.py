"""LLM wrapper tests: retry-after handling, backoff, token tracking, parsing."""

import asyncio
from types import SimpleNamespace

import pytest

from patchwork.llm import (
    BadRequest,
    DailyLimitReached,
    LLMClient,
    RateLimitExhausted,
    limit_period,
    parse_limit_message,
    retry_after_seconds,
)
from patchwork.usage import UsageStore


class FakeRateLimit(Exception):
    status_code = 429

    def __init__(self, message="rate limited", headers=None):
        super().__init__(message)
        self.response = SimpleNamespace(headers=headers or {})


def fake_response(content=None, tool_calls=(), prompt=10, completion=5):
    calls = [
        SimpleNamespace(id=f"c{i}", function=SimpleNamespace(name=name, arguments=args))
        for i, (name, args) in enumerate(tool_calls)
    ]
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=content, tool_calls=calls), finish_reason="stop")],
        usage=SimpleNamespace(prompt_tokens=prompt, completion_tokens=completion),
    )


def make_client(outcomes, **kwargs):
    """A client over scripted outcomes; sleeping advances a fake clock instantly."""
    outcomes = list(outcomes)
    sleeps: list[float] = []
    now = [1000.0]

    async def completion_fn(**kw):
        item = outcomes.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    async def sleep(seconds):
        sleeps.append(seconds)
        now[0] += seconds

    kwargs.setdefault("clock", lambda: now[0])
    return LLMClient(completion_fn=completion_fn, sleep=sleep, **kwargs), sleeps


def groq_429(kind="TPM", wait="7.5s", limit=8000, used=7000, requested=1500):
    names = {"TPM": "tokens per minute", "RPM": "requests per minute", "TPD": "tokens per day", "RPD": "requests per day"}
    exc = FakeRateLimit(
        'litellm.RateLimitError: GroqException - {"error":{"message":"Rate limit reached for model '
        "`openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` on "
        f"{names[kind]} ({kind}): Limit {limit}, Used {used}, Requested {requested}. Please try again in {wait}. "
        'Need more tokens? Upgrade to Dev Tier today","type":"tokens","code":"rate_limit_exceeded"}}'
    )
    return exc


def groq_400(code, failed_generation=None):
    body = {"message": "Parsing failed.", "type": "invalid_request_error", "code": code}
    if failed_generation is not None:
        body["failed_generation"] = failed_generation
    import json

    exc = Exception(f"litellm.BadRequestError: GroqException - {json.dumps({'error': body})}\n")
    exc.status_code = 400
    return exc


def with_headers(response, **headers):
    response._hidden_params = {"additional_headers": {k.replace("_", "-"): v for k, v in headers.items()}}
    return response


def test_retry_after_header_seconds():
    assert retry_after_seconds(FakeRateLimit(headers={"Retry-After": "7"})) == 7.0


def test_retry_after_ms_header():
    assert retry_after_seconds(FakeRateLimit(headers={"retry-after-ms": "1500"})) == 1.5


def test_retry_after_http_date():
    exc = FakeRateLimit(headers={"retry-after": "Wed, 21 Oct 2015 07:28:10 GMT"})
    assert retry_after_seconds(exc, now=1445412480.0) == pytest.approx(10.0)


@pytest.mark.parametrize(
    "message,expected",
    [
        ("Rate limit reached ... Please try again in 7.66s. Need more tokens?", 7.66),
        ("Please try again in 1m23.5s.", 83.5),
        ("Please try again in 250ms.", 0.25),
        ("no hint here", None),
    ],
)
def test_retry_after_from_groq_message(message, expected):
    got = retry_after_seconds(FakeRateLimit(message))
    assert got == (pytest.approx(expected) if expected is not None else None)


def test_retries_respect_retry_after():
    client, sleeps = make_client([FakeRateLimit(headers={"retry-after": "3"}), fake_response("hi")])
    response = asyncio.run(client.complete("m", [{"role": "user", "content": "x"}]))
    assert response.content == "hi"
    assert sleeps == [3.5]  # hint + 0.5s pad
    assert client.calls[0].retries == 1


def test_falls_back_to_exponential_backoff():
    client, sleeps = make_client(
        [FakeRateLimit(), FakeRateLimit(), FakeRateLimit(), fake_response("ok")],
        base_backoff=1.0,
    )
    asyncio.run(client.complete("m", []))
    assert len(sleeps) == 3
    for attempt, delay in enumerate(sleeps):
        assert 2**attempt <= delay <= 2**attempt * 1.25


def test_non_rate_limit_errors_are_not_retried():
    client, sleeps = make_client([ValueError("bad request")])
    with pytest.raises(ValueError):
        asyncio.run(client.complete("m", []))
    assert sleeps == []


# --- 400s ------------------------------------------------------------------------------

@pytest.mark.parametrize("code", ["tool_use_failed", "output_parse_failed", "something_new"])
def test_400_with_failed_generation_carries_the_text(code):
    client, sleeps = make_client([groq_400(code, "We need to inspect stats core first.")])
    with pytest.raises(BadRequest) as info:
        asyncio.run(client.complete("m", []))
    assert (info.value.code, info.value.failed_generation) == (code, "We need to inspect stats core first.")
    assert sleeps == []


def test_400_without_failed_generation():
    client, _ = make_client([groq_400("tool_use_failed")])
    with pytest.raises(BadRequest) as info:
        asyncio.run(client.complete("m", []))
    assert (info.value.code, info.value.failed_generation) == ("tool_use_failed", None)


# --- per-minute vs per-day 429s ---------------------------------------------------------------

def test_limit_kind_is_read_from_groq_message():
    assert limit_period(groq_429("TPM")) == limit_period(groq_429("RPM")) == "minute"
    assert limit_period(groq_429("TPD")) == limit_period(groq_429("RPD")) == "day"
    assert limit_period(FakeRateLimit("rate limited")) == "minute"
    assert parse_limit_message(str(groq_429("TPD", limit=200000, used=197532, requested=2952))) == {
        "name": "tokens per day (TPD)", "kind": "TPD", "limit": 200000, "used": 197532, "requested": 2952,
    }


def test_per_minute_retries_until_total_wait_not_a_fixed_count():
    """Ten short waits (more than the old cap of 6 retries) are fine: only the total counts."""
    client, sleeps = make_client([groq_429(wait="269.999999ms")] * 10 + [fake_response("ok")], max_wait=180)
    assert asyncio.run(client.complete("m", [])).content == "ok"
    assert len(sleeps) == 10 and sleeps[0] == pytest.approx(0.77)
    assert client.calls[0].retries == 10


def test_per_minute_gives_up_once_the_total_wait_would_pass_the_limit():
    client, sleeps = make_client([groq_429(wait="50s")] * 5, max_wait=180)
    with pytest.raises(RateLimitExhausted, match="after waiting 152s in total"):
        asyncio.run(client.complete("m", []))
    assert sleeps == [50.5] * 3  # a 4th wait would make 202s > 180s


def test_per_minute_retry_after_is_honoured_even_above_max_backoff():
    client, sleeps = make_client([groq_429(wait="1m40s"), fake_response("ok")], max_backoff=90)
    asyncio.run(client.complete("m", []))
    assert sleeps == [100.5]


def test_per_day_limit_is_not_retried_and_marks_the_model_exhausted(tmp_path):
    usage = UsageStore(tmp_path / "usage.json")
    calls = []

    async def completion_fn(**kw):
        calls.append(kw["model"])
        if kw["model"] == "m":
            raise groq_429("TPD", wait="3m29.088s", limit=200000, used=197532)
        return fake_response("ok")

    sleeps = []

    async def sleep(seconds):
        sleeps.append(seconds)

    async def main():
        client = LLMClient(completion_fn=completion_fn, sleep=sleep, usage=usage)
        with pytest.raises(DailyLimitReached) as first:
            await client.complete("m", [])
        # Later calls on that model fail at once, without a request; other models are fine.
        with pytest.raises(DailyLimitReached):
            await client.complete("m", [])
        assert (await client.complete("other", [])).content == "ok"
        return first.value

    limit = asyncio.run(main())
    assert sleeps == [] and calls == ["m", "other"]
    assert limit.model == "m" and limit.retry_after == pytest.approx(209.088)
    assert limit.describe().startswith("m (tokens per day (TPD), resets in 3m29s, around ")
    # The per-day limit and Groq's own count are remembered.
    today = usage.day()
    assert today["m"]["tokens_per_day"] == 200000 and today["m"]["tokens"] == 197532


# --- proactive throttling from x-ratelimit headers ------------------------------------------------

def test_throttles_when_headers_show_too_little_token_budget():
    throttled = []
    first = with_headers(fake_response("one"), x_ratelimit_limit_tokens="8000",
                         x_ratelimit_remaining_tokens="300", x_ratelimit_reset_tokens="7.5s",
                         x_ratelimit_limit_requests="1000", x_ratelimit_remaining_requests="990",
                         x_ratelimit_reset_requests="2m59.56s")
    client, sleeps = make_client([first, fake_response("two")],
                                 on_throttle=lambda *args: throttled.append(args))
    messages = [{"role": "user", "content": "x" * 2000}]  # ~500 tokens + max_tokens

    async def main():
        await client.complete("m", messages, max_tokens=100)
        await client.complete("m", messages, max_tokens=100)

    asyncio.run(main())
    assert sleeps == [pytest.approx(7.5)]
    [(model, delay, needed, remaining)] = throttled
    assert model == "m" and delay == pytest.approx(7.5) and remaining == 300 and needed > 300


def test_no_throttle_when_the_budget_suffices_or_headers_are_missing():
    roomy = with_headers(fake_response("one"), x_ratelimit_limit_tokens="8000",
                         x_ratelimit_remaining_tokens="7000", x_ratelimit_reset_tokens="7.5s")
    client, sleeps = make_client([roomy, fake_response("two"), fake_response("three")])

    async def main():
        for _ in range(3):
            await client.complete("m", [{"role": "user", "content": "hi"}], max_tokens=100)

    asyncio.run(main())
    assert sleeps == []


def test_llm_provider_prefixed_headers_are_read():
    from patchwork.llm import TokenBudget, _response_headers

    raw = SimpleNamespace(_hidden_params={"additional_headers": {
        "llm_provider-x-ratelimit-remaining-tokens": "120", "llm_provider-x-ratelimit-limit-tokens": "8000",
        "llm_provider-x-ratelimit-reset-tokens": "1m2s",
    }})
    budget = TokenBudget()
    budget.update(_response_headers(raw), now=10.0)
    assert (budget.remaining_tokens, budget.limit_tokens, budget.tokens_reset_at) == (120, 8000, 72.0)


# --- daily usage ------------------------------------------------------------------------------------

def test_usage_is_recorded_after_every_call(tmp_path):
    usage = UsageStore(tmp_path / "usage.json")
    response = with_headers(fake_response("a", prompt=100, completion=20), x_ratelimit_limit_requests="1000",
                            x_ratelimit_remaining_requests="999", x_ratelimit_reset_requests="1m26.4s")
    client, _ = make_client([response, fake_response("b", prompt=50, completion=5)], usage=usage)

    async def main():
        await client.complete("m", [])
        await client.complete("m", [])

    asyncio.run(main())
    assert usage.day() == {"m": {"tokens": 175, "requests": 2, "tokens_per_day": None, "requests_per_day": 1000}}
    assert (tmp_path / "usage.json").is_file()


def test_parses_tool_calls_and_tracks_tokens():
    client, _ = make_client([
        fake_response(tool_calls=[("read_file", '{"path": "a.py"}'), ("x", "not json")], prompt=100, completion=20),
        fake_response("done", prompt=50, completion=5),
    ])
    first = asyncio.run(client.complete("m", []))
    asyncio.run(client.complete("m", []))

    assert first.tool_calls[0].name == "read_file"
    assert first.tool_calls[0].arguments == {"path": "a.py"}
    assert first.tool_calls[1].parse_error is not None
    assert (first.usage.prompt_tokens, first.usage.completion_tokens) == (100, 20)
    assert client.total_usage.total_tokens == 175
    assert first.to_message()["tool_calls"][0]["function"] == {"name": "read_file", "arguments": '{"path": "a.py"}'}


def test_semaphore_caps_concurrency():
    in_flight = 0
    peak = 0

    async def completion_fn(**kw):
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        await asyncio.sleep(0.01)
        in_flight -= 1
        return fake_response("ok")

    async def main():
        client = LLMClient(completion_fn=completion_fn, max_concurrency=2)
        await asyncio.gather(*(client.complete("m", []) for _ in range(6)))

    asyncio.run(main())
    assert peak == 2


def test_rate_limit_cooldown_is_shared_per_model():
    """A 429 on one call makes concurrent calls on the same model wait too;
    other models are unaffected."""
    calls: list[str] = []
    sleeps: list[tuple[str, float]] = []
    cooldowns: list[tuple[str, float]] = []
    first = {"m": True}

    async def completion_fn(**kw):
        tag = kw["messages"][0]["content"]
        calls.append(tag)
        if tag == "A" and first["m"]:
            first["m"] = False
            raise FakeRateLimit(headers={"retry-after": "5"})
        return fake_response("ok")

    def client(name):
        async def sleep(seconds):
            sleeps.append((name, seconds))
            await asyncio.sleep(0)
        return LLMClient(completion_fn=completion_fn, sleep=sleep, clock=lambda: 100.0,
                         on_cooldown=lambda model, delay: cooldowns.append((model, delay)))

    async def main():
        a, b, c = client("A"), client("B"), client("C")
        await asyncio.gather(
            a.complete("m", [{"role": "user", "content": "A"}]),
            b.complete("m", [{"role": "user", "content": "B"}]),
            c.complete("other", [{"role": "user", "content": "C"}]),
        )

    asyncio.run(main())
    # A hit the 429 and backed off; B (same model, different client) waited out the
    # same cooldown instead of calling; C (other model) never waited.
    assert ("A", 5.5) in sleeps and ("B", 5.5) in sleeps
    assert not any(name == "C" for name, _ in sleeps)
    assert cooldowns == [("m", 5.5)]
    assert calls.index("C") < calls.index("B")


def test_rate_limit_events_name_the_waiting_agent(tmp_path):
    from patchwork.config import Settings
    from patchwork.events import EventBus
    from patchwork.llm import llm_caller
    from patchwork.orchestrator import Orchestrator

    events = []
    bus = EventBus()
    bus.subscribe(events.append)
    llm, _ = make_client([])
    Orchestrator(repo=tmp_path, settings=Settings(_env_file=None), llm=llm, bus=bus)
    token = llm_caller.set("tester")
    try:
        llm.on_retry("m", 1, 2.0, FakeRateLimit())
        llm.on_cooldown("m", 1.5)
    finally:
        llm_caller.reset(token)
    assert [(e.agent, e.type, e.payload["shared"]) for e in events] == [
        ("tester", "rate_limited", False), ("tester", "rate_limited", True),
    ]
