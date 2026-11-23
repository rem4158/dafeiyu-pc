"""Local chat sidebar organization with synthetic sessions and a silent Qt window."""
import json
import os
from collections import deque
from copy import deepcopy
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_voice_messages_ui import Client, ROOT, SilentAudio, history, immediate, live_chat
from nianan_client import NiananClient
from PySide6.QtCore import QCoreApplication, QEvent, QRect, Qt
from PySide6.QtGui import QFont, QFontDatabase
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication


class SessionClient(Client):
    def __init__(self, root):
        super().__init__(root)
        self.titles = {'first': '大肥鱼 PC 聊天', 'second': '大肥鱼 PC 聊天', 'main': '主对话'}
        self.visible = list(self.titles)
        self.messages = {
            key: history(('user', [{'type': 'plain', 'text': f'第 {index} 次聊天的原文'}]))
            for index, key in enumerate(self.titles, start=1)
        }
        self.hide_calls = []
        self.created = []

    def restore_login(self):
        pass

    def remember_login(self):
        pass

    def sessions(self):
        return [{'session_id': key, 'display_name': self.titles[key], 'creator': 'local'}
                for key in self.visible]

    def history(self, session_id):
        return deepcopy(self.messages[session_id])

    def create_session(self):
        key = 'new-' + str(len(self.created) + 1)
        self.created.append(key)
        self.visible.append(key)
        self.titles[key] = '大肥鱼 PC 聊天'
        self.messages[key] = history()
        return key

    def hide_session(self, session_id):
        self.hide_calls.append(session_id)
        if session_id in self.visible:
            self.visible.remove(session_id)
        if not self.visible:
            self.create_session()
        return {'session_id': session_id, 'next_session_id': self.visible[0],
                'sessions': self.sessions()}


class SessionListTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])
        chinese_font = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts' / 'msyh.ttc'
        if chinese_font.is_file():
            QFontDatabase.addApplicationFont(str(chinese_font))
            cls.app.setFont(QFont('Microsoft YaHei UI', 10))

    def setUp(self):
        directory = self.enterContext(tempfile.TemporaryDirectory(dir=ROOT / 'temp'))
        self.client = SessionClient(Path(directory))
        self.window = self.open_window()

    def open_window(self):
        with patch.object(live_chat, 'AudioQueue', SilentAudio):
            window = live_chat.AstrBotChatWindow(self.client, auto_connect=False)
        self.addCleanup(self.dispose_window, window)
        for method in ('delete', 'clear'):
            trap = self.enterContext(patch.object(window.store, method,
                                                   side_effect=AssertionError('legacy destructive operation')))
            self.addCleanup(trap.assert_not_called)
        window._submit = immediate
        window.resize(960, 640)
        window.show()
        window.connect_backend()
        self.app.processEvents()
        if not window.sidebar.isVisible():
            window.toggle_sidebar()
            self.app.processEvents()
        return window

    def dispose_window(self, window):
        window._stop_voice_playback()
        window.hide()
        window.deleteLater()
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.app.processEvents()

    def sidebar_ids(self, window):
        return [window.session_list.item(i).data(Qt.ItemDataRole.UserRole)
                for i in range(window.session_list.count())]

    def test_selected_duplicate_by_id_and_reopen(self):
        window = self.window
        original = deepcopy(self.client.messages)
        window.session_list.setCurrentRow(1)
        button = window.hide_session_button
        self.assertTrue(button.isVisible())
        self.assertEqual(button.text(), '从列表移除')
        self.assertNotEqual(button.focusPolicy(), Qt.FocusPolicy.NoFocus)
        self.assertTrue(window.delete_session_button.isHidden())
        self.assertTrue(window.clear_button.isHidden())
        self.assertEqual(window.session_id, 'second')
        self.assertEqual(window.session_list.item(0).text(), window.session_list.item(1).text())
        window.composer.input.setPlainText('还没有发出的草稿')
        output = os.environ.get('DAFEIYU_SESSION_LIST_QA')
        if output:
            dest = Path(output)
            dest.mkdir(exist_ok=True, parents=True)
            preview = QRect(0, 0, window.sidebar.width(), 250)
            self.assertTrue(window.sidebar.grab(preview).save(str(dest / 'sidebar.png')))
        button.setFocus()
        QTest.keyClick(button, Qt.Key.Key_Space)
        self.app.processEvents()
        self.assertEqual(self.client.hide_calls, ['second'])
        self.assertEqual(window.session_id, 'first')
        self.assertEqual(self.sidebar_ids(window), ['first', 'main'])
        self.assertEqual(window.composer.input.toPlainText(), '还没有发出的草稿')
        self.assertEqual(self.client.messages, original)
        window.refresh_backend()
        self.assertEqual(self.sidebar_ids(window), ['first', 'main'])
        window.close()
        # A stale selection can survive an interrupted write or hide in a second client.
        window._state_path.write_text(json.dumps({'session_id': 'second'}), encoding='utf-8')
        reopened = self.open_window()
        self.assertEqual(self.sidebar_ids(reopened), ['first', 'main'])
        self.assertEqual(reopened.session_id, 'first')
        self.assertEqual(self.client.created, [])

    def test_hide_last_including_main_opens_only_one_empty_conversation(self):
        for expected in ('first', 'second', 'main'):
            self.assertEqual(self.window.session_id, expected)
            self.window.hide_session_button.click()
        self.assertEqual(self.client.hide_calls, ['first', 'second', 'main'])
        self.assertEqual(self.client.created, ['new-1'])
        self.assertEqual(self.sidebar_ids(self.window), ['new-1'])
        self.assertEqual(self.window.session_id, 'new-1')
        self.assertEqual(self.window._bubbles, [])
        self.assertTrue(self.client.history('main')['history'])
        self.window.refresh_backend()
        self.assertEqual(self.client.created, ['new-1'])

    def test_failure_and_inflight_click_leave_selection_retryable(self):
        window = self.window
        window.composer.input.setPlainText('先留着')
        jobs = deque()
        window._submit = lambda op, done, failed=None: jobs.append((op, done, failed))
        button = window.hide_session_button
        button.click()
        self.assertFalse(button.isEnabled())
        self.assertFalse(window.session_list.isEnabled())
        button.click()
        self.assertEqual(len(jobs), 1)
        with patch.object(self.client, 'hide_session', side_effect=live_chat.ConnectionError('整理失败')):
            immediate(*jobs.popleft())
        self.assertTrue(button.isEnabled())
        self.assertEqual(self.sidebar_ids(window), ['first', 'second', 'main'])
        self.assertEqual(window.session_id, 'first')
        self.assertEqual(window.composer.input.toPlainText(), '先留着')
        window._submit = immediate
        button.click()
        self.assertEqual(self.sidebar_ids(window), ['second', 'main'])

    def test_capture_and_generation_block_action(self):
        window = self.window
        button = window.hide_session_button
        window._set_busy(True)
        self.assertFalse(button.isEnabled())
        button.click()
        window._set_busy(False)
        window._asr_pending = True
        window._enable_connected(True)
        self.assertFalse(button.isEnabled())
        button.click()
        self.assertEqual(self.client.hide_calls, [])
        window._asr_pending = False
        window._enable_connected(True)
        self.assertTrue(button.isEnabled())

    def test_successful_hide_with_history_failure_recovers_on_refresh(self):
        window = self.window
        window.composer.input.setPlainText('保留草稿')
        with patch.object(self.client, 'history', side_effect=live_chat.ConnectionError('加载失败')):
            window.hide_session_button.click()
        self.assertEqual(self.client.visible, ['second', 'main'])
        self.assertNotIn('first', self.sidebar_ids(window))
        self.assertFalse(window.session_id == 'first' and window.composer.send.isEnabled())
        self.assertEqual(window.composer.input.toPlainText(), '保留草稿')
        window.refresh_backend()
        self.assertEqual(window.session_id, 'second')
        self.assertEqual(self.sidebar_ids(window), ['second', 'main'])
        self.assertEqual(self.client.hide_calls, ['first'])
        self.assertEqual(self.client.created, [])

    def test_refresh_replaces_externally_hidden_current_selection(self):
        self.client.hide_session(self.window.session_id)
        self.window.refresh_backend()
        self.assertEqual(self.sidebar_ids(self.window), ['second', 'main'])
        self.assertEqual(self.window.session_id, 'second')
        self.assertEqual(self.client.created, [])

    def test_late_previous_chat_list_does_not_restore_hidden_duplicate(self):
        window = self.window
        jobs = deque()
        window._submit = lambda op, done, failed=None: jobs.append((op, done, failed))
        # Finishing a reply starts a background list refresh. Hold its old snapshot.
        with patch.object(self.client, 'chat', create=True, return_value=True):
            window._send_turn('你好', [])
            immediate(*jobs.popleft())
        read_list, show_list, _ = jobs.popleft()
        old_list = read_list()
        window.session_list.setCurrentRow(1)
        while jobs:
            immediate(*jobs.popleft())
        window.hide_session_button.click()
        while jobs:
            immediate(*jobs.popleft())
        self.assertEqual(window.session_id, 'first')
        show_list(old_list)
        self.assertEqual(self.sidebar_ids(window), ['first', 'main'])

    def test_local_client_posts_only_to_hide_endpoint(self):
        adapter = NiananClient(self.client.root)
        response = {'session_id': 'first', 'next_session_id': 'second', 'sessions': []}
        with patch.object(adapter, 'request', return_value=response) as request:
            self.assertEqual(adapter.hide_session('first'), response)
        self.assertEqual(request.call_args.args[:2], ('POST', '/sessions/first/hide'))


if __name__ == '__main__':
    unittest.main()
