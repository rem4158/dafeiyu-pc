"""Chat opens at the latest history after layout and delayed media settle."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_voice_messages_ui import Client, ROOT, SilentAudio, history, live_chat
from PySide6.QtCore import QCoreApplication, QEvent, QTimer
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication


class HistoryClient(Client):
    def restore_login(self):
        pass

    def remember_login(self):
        pass

    def sessions(self):
        return [{'session_id': 'main', 'display_name': '隔离历史', 'creator': 'local'}]


class ChatScrollUITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='chat-scroll-', dir=ROOT / 'temp')
        self.client = HistoryClient(Path(self.temp.name))
        (self.client.root / 'chat-state.json').write_text(json.dumps({'session_id': 'main'}), 'utf-8')
        messages = [('user' if index % 2 == 0 else 'assistant', [
            {'type': 'plain', 'text': f'历史消息{index}：' + '这是一条需要换行显示的历史消息。' * 7}])
            for index in range(24)]
        messages.append(('assistant', [{'type': 'plain', 'text': '最后一条：现在应该看到这里。'}]))
        self.client.saved_history = history(*messages)
        self.windows = []

    def tearDown(self):
        for window in self.windows:
            window._stop_voice_playback()
            window.hide()
            window.deleteLater()
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.app.processEvents()
        self.temp.cleanup()

    def window(self):
        with patch.object(live_chat, 'AudioQueue', SilentAudio):
            window = live_chat.AstrBotChatWindow(self.client, auto_connect=False)
        self.windows.append(window)
        return window

    def settle(self, milliseconds=220):
        QTest.qWait(milliseconds)
        self.app.processEvents()

    def assert_latest_visible(self, window):
        bar = window.scroll.verticalScrollBar()
        self.assertGreater(bar.maximum(), 0, 'fixture must be longer than the viewport')
        self.assertLessEqual(bar.maximum() - bar.value(), 2,
                             f'history stopped at {bar.value()} of {bar.maximum()}')
        last = window._bubbles[-1]
        bottom = last.mapTo(window.scroll.viewport(), last.rect().bottomLeft()).y()
        self.assertLessEqual(bottom, window.scroll.viewport().height())
        self.assertGreater(bottom, 0)

    def test_cold_open_delayed_history_starts_at_latest(self):
        window = self.window()
        window._submit = lambda operation, completed, failed=None: QTimer.singleShot(
            120, window, lambda: completed(operation()))
        window.show()
        window.connect_backend()
        self.settle(600)
        self.assertEqual(window.session_id, 'main')
        self.assert_latest_visible(window)

    def test_history_loaded_before_first_show_starts_at_latest(self):
        window = self.window()
        window._render_history(self.client.saved_history)
        self.settle()
        window.show()
        self.settle()
        self.assert_latest_visible(window)

    def test_close_and_reopen_moves_from_old_history_to_latest(self):
        window = self.window()
        window.show()
        window._render_history(self.client.saved_history)
        self.settle()
        bar = window.scroll.verticalScrollBar()
        bar.setValue(0)
        self.assertFalse(window._stream_follow_output)
        window.close()
        window.showNormal()
        self.settle()
        self.assert_latest_visible(window)

    def test_late_image_layout_keeps_latest_visible(self):
        window = self.window()
        loaded = []
        window._submit = lambda operation, completed, failed=None: loaded.append((operation, completed))
        self.client.saved_history = history(
            *[('assistant', [{'type': 'plain', 'text': '旧消息' * 25}]) for _ in range(20)],
            ('assistant', [{'type': 'image', 'attachment_id': 'image-1'}]),
            ('assistant', [{'type': 'plain', 'text': '最后一条：图片加载后仍在这里。'}]))
        window.show()
        window._render_history(self.client.saved_history)
        self.settle()
        self.assertEqual(len(loaded), 1)
        operation, completed = loaded[0]
        completed(operation())
        self.settle()
        self.assert_latest_visible(window)

    def test_late_image_does_not_pull_user_away_from_older_messages(self):
        window = self.window()
        loaded = []
        window._submit = lambda operation, completed, failed=None: loaded.append((operation, completed))
        self.client.saved_history['history'][-1]['content']['message'].append(
            {'type': 'image', 'attachment_id': 'image-1'})
        window.show()
        window._render_history(self.client.saved_history)
        self.settle()
        bar = window.scroll.verticalScrollBar()
        bar.setValue(0)
        operation, completed = loaded[0]
        completed(operation())
        self.settle()
        self.assertEqual(bar.value(), 0)
        self.assertGreater(bar.maximum(), 0)

    def test_pending_scroll_callback_does_not_override_manual_scroll(self):
        window = self.window()
        window.show()
        window._render_history(self.client.saved_history)
        self.settle(30)  # The existing 80ms callback is still queued.
        bar = window.scroll.verticalScrollBar()
        self.assertGreater(bar.maximum(), 0)
        bar.setValue(0)
        self.settle()
        self.assertEqual(bar.value(), 0, 'queued auto-scroll must respect manual history reading')


if __name__ == '__main__':
    unittest.main()
