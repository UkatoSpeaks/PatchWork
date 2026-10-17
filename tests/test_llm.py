"""LLM wrapper tests: retry-after handling, backoff, token tracking, parsing."""

import asyncio
from types import SimpleNamespace

import pytest

from patchwork.llm import (
    LLMClient,
    MalformedToolCall,
    RateLimitExhausted,
    retry_after_seconds,
)


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
    outcomes = list(outcomes)
    sleeps: list[float] = []

    async def completion_fn(**kw):
        item = outcomes.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    async def sleep(seconds):
        sleeps.append(seconds)

    return LLMClient(completion_fn=completion_fn, sleep=sleep, **kwargs), sleeps


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


def test_gives_up_after_max_retries():
    client, sleeps = make_client([FakeRateLimit()] * 3, max_retries=2)
    with pytest.raises(RateLimitExhausted):
        asyncio.run(client.complete("m", []))
    assert len(sleeps) == 2


def test_non_rate_limit_errors_are_not_retried():
    client, sleeps = make_client([ValueError("bad request")])
    with pytest.raises(ValueError):
        asyncio.run(client.complete("m", []))
    assert sleeps == []


def test_groq_tool_use_failed_becomes_malformed_tool_call():
    exc = Exception("GroqException - {'code': 'tool_use_failed'}")
    exc.status_code = 400
    client, _ = make_client([exc])
    with pytest.raises(MalformedToolCall):
        asyncio.run(client.complete("m", []))


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
