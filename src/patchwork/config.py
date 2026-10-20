"""Settings loaded from the environment and a local .env file."""

from __future__ import annotations

from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

Role = Literal["lead", "coder", "tester", "reviewer"]


class Settings(BaseSettings):
    """All runtime configuration. Field names map to upper-case env vars."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    groq_api_key: SecretStr | None = None

    # One model per agent role, so models can be swapped without code changes.
    lead_model: str = "groq/openai/gpt-oss-120b"
    coder_model: str = "groq/openai/gpt-oss-120b"
    tester_model: str = "groq/openai/gpt-oss-120b"
    reviewer_model: str = "groq/qwen/qwen3.8-27b"

    # Comma-separated models to switch to, in order, when a role's model hits a
    # per-day limit. The agent keeps its conversation.
    lead_fallbacks: str = "groq/qwen/qwen3.8-27b,groq/openai/gpt-oss-20b"
    coder_fallbacks: str = "groq/qwen/qwen3.8-27b,groq/openai/gpt-oss-20b"
    tester_fallbacks: str = "groq/qwen/qwen3.8-27b,groq/openai/gpt-oss-20b"
    reviewer_fallbacks: str = "groq/openai/gpt-oss-120b,groq/openai/gpt-oss-20b"

    # Model for crew coder retries (escalation, e.g. a bigger model); empty means
    # CODER_MODEL. Its fallbacks; empty means CODER_FALLBACKS.
    coder_retry_model: str = ""
    coder_retry_fallbacks: str = ""

    # Agent budgets
    max_steps_per_agent: int = Field(default=25, ge=1)
    max_tokens_per_run: int = Field(default=60_000, ge=1)
    max_output_tokens: int = Field(default=1024, ge=1)

    # Test runner
    test_command: str = "python -m pytest -q --tb=short -p no:cacheprovider"
    test_timeout_seconds: float = Field(default=120.0, gt=0)

    # LLM client
    max_concurrent_requests: int = Field(default=2, ge=1)
    # Seconds one LLM call may spend waiting on per-minute rate limits in total.
    llm_max_wait_seconds: float = Field(default=180.0, ge=0)
    # How long to wait when the per-minute token budget is short: "proportional"
    # waits for just the missing tokens to refill, "full" for the window reset.
    throttle_mode: Literal["proportional", "full"] = "proportional"

    # Crew: coder retries (failing suite or review blockers) per run
    max_retries: int = Field(default=3, ge=0)

    def model_for(self, role: Role) -> str:
        return getattr(self, f"{role}_model")

    def fallbacks_for(self, role: Role) -> list[str]:
        """The role's fallback models in order, without its own model or duplicates."""
        return _model_list(getattr(self, f"{role}_fallbacks"), self.model_for(role))

    def coder_retry_model_or_default(self) -> str:
        """The model coder retries start on: CODER_RETRY_MODEL, else CODER_MODEL."""
        return self.coder_retry_model.strip() or self.coder_model

    def coder_retry_fallbacks_or_default(self) -> list[str]:
        """Fallbacks for coder retries: CODER_RETRY_FALLBACKS, else CODER_FALLBACKS."""
        if not self.coder_retry_model.strip():
            return self.fallbacks_for("coder")
        raw = self.coder_retry_fallbacks if self.coder_retry_fallbacks.strip() else self.coder_fallbacks
        return _model_list(raw, self.coder_retry_model_or_default())

    def api_key(self) -> str | None:
        return self.groq_api_key.get_secret_value() if self.groq_api_key else None


def _model_list(raw: str, primary: str) -> list[str]:
    """Comma-separated models in order, without ``primary`` or duplicates."""
    out: list[str] = []
    for model in raw.split(","):
        model = model.strip()
        if model and model != primary and model not in out:
            out.append(model)
    return out
