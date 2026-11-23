"""Small routing checks; no settings files, services or model requests."""
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

APP_ROOT = Path(__file__).resolve().parents[1]
os.environ['DAFEIYU_PC_ROOT'] = str(APP_ROOT)
sys.path.insert(0, str(APP_ROOT / 'desktop_bridge'))
from native_chat_controller import NativeChatController
from live_chat import AstrBotChatWindow


class RouteTests(unittest.TestCase):
    def test_controller_keeps_one_window_and_shared_settings_entry(self):
        calls = []
        window = SimpleNamespace(showNormal=lambda: None, raise_=lambda: None,
                                 activateWindow=lambda: None)
        created = []
        def factory():
            created.append(window)
            return window
        controller = NativeChatController(factory, settings_opener=lambda: calls.append('settings'))
        controller.open_chat()
        controller.open_chat()
        controller.window.settings_opener()
        self.assertEqual(len(created), 1)
        self.assertEqual(calls, ['settings'])

    def test_local_chat_settings_deeplink_does_not_open_duplicate_form(self):
        calls = []
        def unexpected(*_args):
            self.fail('The legacy model popup must not be opened')
        window = SimpleNamespace(busy=False, _loading=False, local_backend=True,
                                 settings_opener=lambda: calls.append('unified'), _submit=unexpected)
        AstrBotChatWindow.open_backend_settings(window)
        self.assertEqual(calls, ['unified'])


if __name__ == '__main__':
    unittest.main()
