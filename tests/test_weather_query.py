"""Weather helper checks with saved temporary settings and a fake weather client."""
from dataclasses import fields
from datetime import datetime, timedelta
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "desktop_bridge"))
from weather_query import MAX_INPUT_BYTES, TOTAL_BUDGET_SECONDS, query_weather
from pet.weather import WeatherError, WeatherReading


class FakeClient:
    def __init__(self, reading=None, error=None):
        self.calls = []
        self.reading = reading or WeatherReading(
            city="苏家屯", condition="晴", temperature="0.5℃", wind="北风 2级",
            humidity="25%", source="中国天气网", observed_at="09:30", detail="2026-11-06")
        self.error = error

    def fetch(self, city, **kwargs):
        self.calls.append((city, kwargs))
        if self.error:
            raise self.error
        return self.reading


class WeatherQueryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / "temp")
        self.path = Path(self.temp.name) / "config.json"
        self.config = {"weather_enabled": True, "weather_city": "苏家屯",
                       "weather_city_list": ["沈阳", "苏家屯"],
                       "weather_city_codes": {"苏家屯": "101070104", "沈阳": "101070101"},
                       "private": "secret-setting-must-not-be-returned"}
        self.save()

    def tearDown(self):
        self.temp.cleanup()

    def save(self):
        self.path.write_text(json.dumps(self.config, ensure_ascii=False), encoding="utf-8")

    def test_current_city_code_fields_timestamp_and_read_only(self):
        before = self.path.read_bytes()
        fake = FakeClient()
        response = query_weather(self.path, {}, client=fake, clock=lambda: 100.0)
        self.assertTrue(response["ok"])
        self.assertEqual(fake.calls, [("苏家屯", {"code": "101070104", "deadline": 100.0 + TOTAL_BUDGET_SECONDS})])
        result = response["result"]
        for field in fields(WeatherReading):
            self.assertEqual(result[field.name], getattr(fake.reading, field.name))
        self.assertEqual(result["requested_city"], "苏家屯")
        self.assertEqual(result["scope"], "current")
        self.assertEqual(datetime.fromisoformat(result["fetched_at"]).utcoffset(), timedelta(0))
        self.assertEqual(self.path.read_bytes(), before)
        self.assertNotIn("secret-setting", json.dumps(response))

    def test_explicit_saved_city_uses_its_code_without_changing_selection(self):
        before = self.path.read_bytes()
        fake = FakeClient()
        self.assertTrue(query_weather(self.path, {"city": "沈阳"}, client=fake)["ok"])
        self.assertEqual(fake.calls[0][0], "沈阳")
        self.assertEqual(fake.calls[0][1]["code"], "101070101")
        self.assertEqual(self.path.read_bytes(), before)

    def test_explicit_new_city_can_query_without_configured_default(self):
        self.config.update(weather_city="", weather_city_list=[])
        self.save()
        fake = FakeClient()
        self.assertTrue(query_weather(self.path, {"city": "北京"}, client=fake)["ok"])
        self.assertEqual(fake.calls[0][0], "北京")
        self.assertEqual(fake.calls[0][1]["code"], "")

    def test_list_fallback_and_subsequent_saved_selection(self):
        self.config["weather_city"] = ""
        self.save()
        fake = FakeClient()
        query_weather(self.path, {}, client=fake)
        self.config["weather_city"] = "苏家屯"
        self.save()
        query_weather(self.path, {}, client=fake)
        self.assertEqual([item[0] for item in fake.calls], ["沈阳", "苏家屯"])

    def test_saved_same_name_city_keeps_regional_code(self):
        self.config.update(weather_city="朝阳 · 辽宁", weather_city_codes={"朝阳 · 辽宁": "101071201"})
        self.save()
        fake = FakeClient()
        query_weather(self.path, {}, client=fake)
        self.assertEqual(fake.calls[0][0], "朝阳 · 辽宁")
        self.assertEqual(fake.calls[0][1]["code"], "101071201")

    def test_disabled_and_no_city_do_not_query(self):
        fake = FakeClient()
        self.config["weather_enabled"] = False
        self.save()
        self.assertEqual(query_weather(self.path, {"city": "北京"}, client=fake)["error"]["code"], "weather_disabled")
        self.config.update(weather_enabled=True, weather_city="", weather_city_list=[])
        self.save()
        self.assertEqual(query_weather(self.path, {}, client=fake)["error"]["code"], "weather_city_required")
        self.assertEqual(fake.calls, [])

    def test_missing_malformed_and_nonobject_config_are_safe(self):
        fake = FakeClient()
        for content in (None, "{broken", "[]", "null", "\ufffd"):
            with self.subTest(content=content):
                if content is None:
                    self.path.unlink(missing_ok=True)
                else:
                    self.path.write_text(content, encoding="utf-8")
                response = query_weather(self.path, {}, client=fake)
                self.assertEqual(response["error"]["code"], "weather_config_unavailable")
                self.assertNotIn(str(self.path), json.dumps(response))
        self.assertEqual(fake.calls, [])

    def test_arguments_reject_unknown_fields_and_invalid_city(self):
        fake = FakeClient()
        for args in (None, [], "北京", {"extra": True}, {"city": None}, {"city": 1},
                     {"city": ""}, {"city": " "}, {"city": "城" * 25}):
            with self.subTest(args=args):
                self.assertEqual(query_weather(self.path, args, client=fake)["error"]["code"], "weather_invalid_arguments")
        self.assertEqual(fake.calls, [])

    def test_network_errors_and_expired_results_are_sanitized(self):
        for error in (WeatherError("proxy-secret and private URL"), RuntimeError("secret credentials")):
            with self.subTest(error=type(error).__name__):
                response = query_weather(self.path, {}, client=FakeClient(error=error))
                self.assertEqual(response["error"]["code"], "weather_query_failed")
                self.assertNotIn("secret", json.dumps(response))
        times = iter([100.0, 100.0 + TOTAL_BUDGET_SECONDS])
        response = query_weather(self.path, {}, client=FakeClient(), clock=lambda: next(times))
        self.assertEqual(response["error"]["code"], "weather_query_failed")

    def test_cli_protocol_utf8_bounded_input_and_no_settings_mutation(self):
        self.config["weather_enabled"] = False  # All subprocess fixtures avoid network.
        self.save()
        before = self.path.read_bytes()
        for payload, code in ((b"{}", "weather_disabled"), (b"[", "weather_invalid_arguments"),
                              (b" " * (MAX_INPUT_BYTES + 1), "weather_invalid_arguments")):
            with self.subTest(code=code, size=len(payload)):
                run = subprocess.run([sys.executable, "-B", str(ROOT / "desktop_bridge" / "weather_query.py"), str(self.path)],
                                     input=payload, capture_output=True, timeout=5, check=True)
                self.assertEqual(run.stderr, b"")
                self.assertEqual(json.loads(run.stdout.decode("utf-8"))["error"]["code"], code)
                self.assertEqual(len(run.stdout.splitlines()), 1)
        self.assertEqual(self.path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
