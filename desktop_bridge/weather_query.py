"""Read the pet's saved weather settings and query its existing weather client.

The backend invokes this fixed helper with one configuration path argument and
one small JSON object on stdin.  It never constructs Config or writes settings.
"""
from __future__ import annotations

from dataclasses import fields
from datetime import datetime, timezone
import json
import logging
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "desktop"))

from pet.weather import (  # noqa: E402
    MAX_CITY_NAME,
    TOTAL_BUDGET_SECONDS,
    WeatherClient,
    WeatherReading,
    city_code_for,
    current_city,
    normalize_city_name,
)

MAX_INPUT_BYTES = 512
MAX_CONFIG_BYTES = 4 * 1024 * 1024


def _failure(code: str, message: str) -> dict:
    return {"ok": False, "error": {"code": code, "message": message}}


def query_weather(config_path, args, client=None, clock=time.monotonic) -> dict:
    """Query current conditions using the same city and provider logic as the menu."""
    if not isinstance(args, dict) or set(args) - {"city"}:
        return _failure("weather_invalid_arguments", "天气查询参数无效")
    explicit_city = args.get("city")
    if "city" in args and (not isinstance(explicit_city, str)
                           or not explicit_city.strip()
                           or len(explicit_city) > MAX_CITY_NAME):
        return _failure("weather_invalid_arguments", "城市名须为不超过24字的非空文字")
    try:
        with Path(config_path).open("rb") as handle:
            raw = handle.read(MAX_CONFIG_BYTES + 1)
        if len(raw) > MAX_CONFIG_BYTES:
            raise ValueError("configuration too large")
        config = json.loads(raw.decode("utf-8-sig"))
        if not isinstance(config, dict):
            raise ValueError("configuration is not an object")
    except (OSError, UnicodeError, ValueError, TypeError):
        return _failure("weather_config_unavailable", "无法读取桌宠天气设置，请检查桌宠设置后重试")

    if not bool(config.get("weather_enabled", True)):
        return _failure("weather_disabled", "桌宠天气功能已关闭，请在桌宠设置中开启")
    city = normalize_city_name(explicit_city) if explicit_city is not None else current_city(config)
    if not city:
        return _failure("weather_city_required", "尚未设置天气城市，请告诉我城市，或在右键天气城市菜单中添加")
    code = city_code_for(config, city)
    deadline = clock() + TOTAL_BUDGET_SECONDS
    try:
        reading = (client or WeatherClient(clock=clock)).fetch(city, code=code, deadline=deadline)
        if clock() >= deadline or not isinstance(reading, WeatherReading):
            raise ValueError("weather result unavailable")
        # Bound source strings as well as stdin; external provider text stays data.
        result = {field.name: str(getattr(reading, field.name))[:256]
                  for field in fields(WeatherReading)}
    except Exception:
        return _failure("weather_query_failed", "天气查询失败或超时，请检查城市和网络后重试")
    result.update(requested_city=city, scope="current",
                  fetched_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
    return {"ok": True, "result": result}


def main() -> None:
    # Provider exception details may contain URLs or proxy information.  Only
    # the small, sanitized JSON result is part of this subprocess protocol.
    logging.disable(logging.CRITICAL)
    if len(sys.argv) != 2:
        result = _failure("weather_invalid_arguments", "天气查询参数无效")
    else:
        try:
            raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
            if len(raw) > MAX_INPUT_BYTES:
                raise ValueError("input too large")
            args = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeError):
            result = _failure("weather_invalid_arguments", "天气查询参数无效")
        else:
            result = query_weather(sys.argv[1], args)
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode("utf-8") + b"\n")
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
