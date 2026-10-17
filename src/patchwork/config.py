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
    lead_model: str = "groq/llama-3.3-70b-versatile"
    coder_model: str = "groq/llama-3.3-70b-versatile"
    tester_model: str = "groq/llama-3.1-8b-instant"
    reviewer_model: str = "groq/llama-3.3-70b-versatile"

    # Agent budgets
    max_steps_per_agent: int = Field(default=25, ge=1)
    max_tokens_per_run: int = Field(default=60_000, ge=1)
    max_output_tokens: int = Field(default=1024, ge=1)

    # Test runner
    test_command: str = "python -m pytest -q --tb=short -p no:cacheprovider"
    test_timeout_seconds: float = Field(default=120.0, gt=0)

    # LLM client
    max_concurrent_requests: int = Field(default=2, ge=1)
    llm_max_retries: int = Field(default=6, ge=0)

    def model_for(self, role: Role) -> str:
        return getattr(self, f"{role}_model")

    def api_key(self) -> str | None:
        return self.groq_api_key.get_secret_value() if self.groq_api_key else None
