"""Legacy enabled flags must not start an Agent monitor or capture a real screen."""
import json
import os
from pathlib import Path
import platform
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "desktop"))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QObject
from PySide6.QtWidgets import QApplication
from pet.app import AppShell
from pet.config import APP_DIR_NAME, Config
from pet.window_optional_services import WindowFeatureGateMixin


def old_settings():
    return {
        "agent_link": {
            "dsh": True, "claude": True, "cursor": True, "opencode": True,
            "demo": True,
            "custom_agents": [{"key": "demo", "name": "Demo", "path": "events/demo.jsonl"}],
        },
        "proactive_screen": {"enabled": True, "whitelist": ["demo.exe"]},
        "agent_cost_enabled": True, "harness_autostart": True, "harness_launch_target": "web",
        "edge_probe_enabled": True,
        "settings_process_isolation": False, "todo_reminder_enabled": False,
        "divination_enabled": False, "voice_chime_enabled": False,
        "self_talk_speak_enabled": False,
    }


class RetiredDesktopIntegrations(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        # Python may run the Windows "ver" command during a dependency import.
        # Resolve that platform query before guarding against application subprocesses.
        self.enterContext(patch("platform.win32_ver", return_value=platform.win32_ver()))
        for target in (
            "pet.agent_link.AgentLinkManager.__init__",
            "pet.proactive.ProactiveScreenWatcher.__init__",
            "pet.harness_launcher.launch_harness",
            "threading.Thread.start",
            "subprocess.Popen",
        ):
            guard = self.enterContext(patch(target, side_effect=AssertionError(target)))
            self.addCleanup(guard.assert_not_called)

    def test_old_enabled_config_through_shell_start_reload_and_shutdown(self):
        directory = Path(self.enterContext(tempfile.TemporaryDirectory(dir=ROOT / "temp")))
        self.enterContext(patch.dict(os.environ, {
            "APPDATA": str(directory), "PET_RENDER_TOPOLOGY": "overlay",
        }))
        path = directory / APP_DIR_NAME / "config.json"
        path.parent.mkdir()
        settings = old_settings()
        path.write_text(json.dumps(settings), encoding="utf-8")
        config = Config(base=directory, instance_id="")
        read_config = config.get
        retired = ("agent_link", "proactive_screen", "agent_cost_enabled",
                   "harness_autostart", "harness_launch_target")
        for key in retired:
            self.assertIsNone(read_config(key))
        # Even a host handing the runtime stale in-memory values cannot enable
        # the old subsystems. Config.reload below still exercises the real reader.
        def stale_runtime_value(key, default=None):
            return settings[key] if key in retired else read_config(key, default)

        self.enterContext(patch.object(config, "get", side_effect=stale_runtime_value))
        shell = AppShell(self.app, config, enable_chat=False)
        self.assertIsNone(getattr(shell._shared, "agent_link", None))
        self.assertIsNone(getattr(shell._shared, "proactive", None))

        # Build the real runtime owner. Substitute its visible surface, hotkeys,
        # and system integrations so the lifecycle runs without OS registration.
        overlay = QObject()
        for method in ("start", "refresh_settings", "on_screen_capture", "set_file_interpret_offer"):
            setattr(overlay, method, Mock())
        self.enterContext(patch("pet.overlay_shell.OverlayShell", return_value=overlay))
        for name in ("_sync_dynamic_island", "_install_session_watcher",
                     "_install_global_hotkeys", "_teardown_fps_capture"):
            self.enterContext(patch.object(shell, name))
        timers = self.enterContext(patch("pet.app.QTimer.singleShot"))
        stop_owned = self.enterContext(patch("pet.harness_launcher.stop_self_launched_harness",
                                            return_value=[]))
        self.enterContext(patch("pet.chat.session_store.close_all_writers", return_value=True))
        self.enterContext(patch("pet.webm_clip.set_session_ending"))
        shell.start()
        self.addCleanup(self.app.aboutToQuit.disconnect, shell._on_about_to_quit)
        self.assertFalse(any("harness" in call.args[-1].__name__.lower()
                             for call in timers.call_args_list))

        # Simulate another process saving the retired flags again beside a real,
        # unrelated change. The debounced config handler reads this file.
        settings["weather_city"] = "测试城"
        path.write_text(json.dumps(settings), encoding="utf-8")
        with self.assertNoLogs(level="ERROR"):
            shell._on_config_change_debounced()
        self.assertEqual(config.get("weather_city"), "测试城")
        saved = json.loads(path.read_text(encoding="utf-8"))
        for key in retired:
            self.assertIsNone(read_config(key))
            self.assertEqual(saved[key], settings[key])
        overlay.refresh_settings.assert_called_once()
        overlay.on_screen_capture.assert_not_called()
        shell._hotkey_screen_capture()
        overlay.on_screen_capture.assert_called_once()
        stop_owned.assert_not_called()

        with patch.object(shell._shared, "stop_all", wraps=shell._shared.stop_all) as stop:
            shell._on_about_to_quit()
            stop.assert_called_once()
        self.assertFalse(shell._shared.quiet.active())
        self.assertFalse((config.dir / "agent-events").exists())
        self.assertFalse(any(config.dir.glob("proactive_screen*.json")))

    def test_window_optional_sync_keeps_effects_and_music(self):
        window = WindowFeatureGateMixin()
        window.cfg = old_settings()
        window._edge_probe = Mock()
        window._install_effect_services = Mock()
        window.sync_music_lyric = Mock()
        window.sync_optional_services()
        window._edge_probe.set_enabled.assert_called_once_with(True)
        window.sync_music_lyric.assert_called_once()
        self.assertIsNone(getattr(window, "proactive_watcher", None))
        self.assertIsNone(getattr(window, "agent_link_manager", None))

    def test_pc_ignores_saved_legacy_schedule_and_screen_hotkey(self):
        from types import SimpleNamespace
        from pet.context_menus.registry import MENU_ACTIONS
        from pet.file_interpret import FileInterpretController
        from pet.hotkeys import ACTIONS

        self.enterContext(patch.dict(os.environ, {"DAFEIYU_PC_ROOT": str(ROOT)}))
        shell = SimpleNamespace(config={
            "todo_reminder_enabled": True, "festival_reminder_enabled": True,
            "voice_chime_enabled": True, "balance_refresh_minutes": 10,
            ACTIONS["look_screen"]: "Ctrl+F8", ACTIONS["screen_capture"]: "Ctrl+F9",
        }, _balance_timer=Mock(), _hotkeys=Mock(installed=True))
        self.assertFalse(AppShell._todo_wanted(shell))
        self.assertFalse(AppShell._festival_wanted(shell))
        for action in ("_festival_speak_wanted", "_todo_speak_wanted",
                       "_self_talk_speak_wanted", "_divination_speak_wanted"):
            setattr(shell, action, Mock(return_value=False))
        self.assertFalse(AppShell._chime_wanted(shell))
        shell._divination_speak_wanted.return_value = True
        self.assertTrue(AppShell._chime_wanted(shell))
        AppShell._apply_balance_timer(shell)
        shell._balance_timer.stop.assert_called_once()
        shell._balance_timer.start.assert_not_called()
        shell._hotkeys.apply.return_value = []
        for action in ("open_chat", "look_screen", "screen_capture"):
            setattr(shell, f"_hotkey_{action}", Mock())
        AppShell._apply_global_hotkeys(shell)
        self.assertNotIn("look_screen", shell._hotkeys.apply.call_args.args[0])
        self.assertEqual(shell._hotkeys.apply.call_args.args[0]["screen_capture"], "Ctrl+F9")
        pet = SimpleNamespace(cfg={}, on_screen_capture=Mock(), on_check_update=Mock())
        self.assertNotIn("autostart", MENU_ACTIONS.available_ids(pet))
        self.assertIn("screen_capture", MENU_ACTIONS.supported_ids)
        AppShell.check_update(shell)
        with patch("pet.file_interpret.collect_interpretable") as collect:
            FileInterpretController.offer(object(), ["example.txt"])
        collect.assert_not_called()


if __name__ == "__main__":
    unittest.main()
