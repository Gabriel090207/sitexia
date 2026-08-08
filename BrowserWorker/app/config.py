from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    chrome_debug_url: str = "http://127.0.0.1:9222"


settings = Settings()