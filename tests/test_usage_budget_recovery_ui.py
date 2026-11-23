"""Explicit local quota recovery only: fake Qt/client data, no API/model/audio."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_voice_messages_ui import Client, ROOT, SilentAudio, history, live_chat
from nianan_client import NiananClient
from PySide6.QtCore import QCoreApplication, QEvent
from PySide6.QtWidgets import QApplication


BUDGET_CODES = (
    'usage_budget_exceeded', 'usage_budget_preflight_required',
    'usage_budget_unavailable', 'usage_budget_unpriced',
    'usage_budget_context_required', 'usage_budget_unresolved',
    'usage_budget_count_failed', 'usage_budget_unsupported',
)


def budget_error(code='usage_budget_exceeded'):
    error = live_chat.ConnectionError('已达到本程序用量限额。')
    error.code = code
    return error


class RecoveryClient(Client):
    supports_stickers = True

    def __init__(self, root):
        super().__init__(root)
        self.clears = 0
        self.chats = 0
        self.clear_error = None

    def clear_usage_budget(self):
        self.clears += 1
        if self.clear_error:
            raise self.clear_error
        return {'ok': True, 'budget': {'enabled': False}}

    def chat(self, *args, **kwargs):
        self.chats += 1
        raise budget_error()

    def sessions(self):
        return []


class BudgetRecoveryUITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / 'temp')
        self.client = RecoveryClient(Path(self.temp.name))
        with patch.object(live_chat, 'AudioQueue', SilentAudio):
            self.window = live_chat.AstrBotChatWindow(self.client, auto_connect=False)
        self.pending = []
        self.window._submit = lambda operation, success, failure=None: self.pending.append((operation, success, failure))
        self.window.session_id = 'main'
        self.window._enable_connected(True)
        self.window.show()
        self.app.processEvents()

    def tearDown(self):
        self.dispose(self.window)
        self.temp.cleanup()

    def dispose(self, window):
        window._stop_voice_playback()
        window.hide()
        window.deleteLater()
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.app.processEvents()

    def reveal(self):
        self.window._show_error(budget_error())
        self.app.processEvents()
        self.assertFalse(self.window.budget_clear_button.isHidden())

    def complete(self, job):
        operation, success, failure = job
        try:
            result = operation()
        except Exception as error:
            failure(error)
        else:
            success(result)
        self.app.processEvents()

    def test_hidden_until_budget_error_and_outside_composer(self):
        button = self.window.budget_clear_button
        self.assertTrue(button.isHidden())
        toolbar_width = self.window.composer.toolbar.width()
        self.assertEqual(toolbar_width, 174)
        self.window._show_error(live_chat.ConnectionError('普通请求失败'))
        self.assertTrue(button.isHidden())
        for code in ('model_test_quota', None, ['usage_budget_exceeded']):
            self.window._show_error(budget_error(code))
            self.assertTrue(button.isHidden())
        self.reveal()
        self.assertEqual(button.text(), '解除本程序限额')
        self.assertFalse(self.window.composer.toolbar.isAncestorOf(button))
        self.assertEqual(self.window.composer.toolbar.width(), toolbar_width)
        self.assertEqual(self.client.clears, 0)
        self.assertEqual(self.client.chats, 0)

    def test_recovery_remains_in_header_area_at_both_window_sizes(self):
        self.reveal()
        for width, height in ((1040, 760), (620, 650)):
            with self.subTest(width=width):
                self.window.resize(width, height)
                self.app.processEvents()
                button = self.window.budget_clear_button
                row = self.window._budget_recovery_row
                self.assertTrue(row.rect().contains(button.geometry()))
                self.assertLess(row.geometry().bottom(), self.window.composer_card.geometry().top())
                self.assertEqual(self.window.composer.toolbar.width(), 174)

    def test_clear_requires_click_and_does_not_resend_or_change_draft(self):
        self.window.clear_usage_budget()
        self.assertEqual(self.pending, [], 'hidden recovery cannot be invoked')
        self.reveal()
        self.window.composer.input.setPlainText('保留未发送草稿')
        self.window.budget_clear_button.click()
        self.assertEqual(len(self.pending), 1)
        self.assertTrue(self.window._loading)
        self.assertFalse(self.window.budget_clear_button.isEnabled())
        self.assertFalse(self.window.composer.send.isEnabled())
        self.window.clear_usage_budget()
        self.assertEqual(len(self.pending), 1, 'in-flight clear is deduplicated')
        self.complete(self.pending.pop())
        self.assertEqual(self.client.clears, 1)
        self.assertEqual(self.client.chats, 0)
        self.assertFalse(self.window._loading)
        self.assertFalse(self.window._budget_recovery_pending)
        self.assertTrue(self.window.budget_clear_button.isHidden())
        self.assertTrue(self.window._budget_recovery_row.isHidden())
        self.assertEqual(self.window.composer.input.toPlainText(), '保留未发送草稿')
        self.assertEqual(self.window._bubbles, [])
        self.assertIn('限额已解除', self.window.status.text())
        self.assertIn('刷新确认聊天记录', self.window.status.text())
        self.assertEqual(self.window.status.toolTip(), self.window.status.text())

    def test_busy_loading_disconnected_and_audio_states_block_clear(self):
        self.reveal()
        for attribute in ('busy', '_loading', '_asr_pending'):
            with self.subTest(attribute=attribute):
                setattr(self.window, attribute, True)
                self.window._enable_connected(True)
                self.assertFalse(self.window.budget_clear_button.isEnabled())
                self.window.clear_usage_budget()
                self.assertEqual(self.pending, [])
                setattr(self.window, attribute, False)
        self.window._enable_connected(False)
        self.assertFalse(self.window.budget_clear_button.isEnabled())
        self.window.clear_usage_budget()
        self.assertEqual(self.pending, [])
        self.window._enable_connected(True)
        self.assertTrue(self.window.budget_clear_button.isEnabled())

    def test_failed_clear_retains_button_and_allows_explicit_retry(self):
        self.reveal()
        self.client.clear_error = budget_error('usage_budget_unavailable')
        self.window.budget_clear_button.click()
        self.complete(self.pending.pop())
        self.assertEqual(self.client.clears, 1)
        self.assertFalse(self.window._loading)
        self.assertFalse(self.window.budget_clear_button.isHidden())
        self.assertTrue(self.window.budget_clear_button.isEnabled())
        self.assertIn('限额', self.window.status.text())
        self.client.clear_error = None
        self.window.budget_clear_button.click()
        self.complete(self.pending.pop())
        self.assertEqual(self.client.clears, 2)
        self.assertTrue(self.window.budget_clear_button.isHidden())
        self.assertEqual(self.client.chats, 0)

    def test_unsuccessful_receipt_never_claims_clear(self):
        self.reveal()
        for result in (None, {}, {'ok': False}, {'ok': 1}):
            self.window.budget_clear_button.click()
            self.pending.pop()[1](result)
            self.assertFalse(self.window.budget_clear_button.isHidden())
            self.assertTrue(self.window.budget_clear_button.isEnabled())
            self.assertIn('未完成', self.window.status.text())
            self.assertNotIn('已解除', self.window.status.text())

    def test_chat_budget_failure_reveals_recovery_without_automatic_clear(self):
        self.window.composer.input.setPlainText('这次额度不足')
        self.window.send_message()
        self.complete(self.pending.pop())
        self.assertEqual(self.client.chats, 1)
        self.assertEqual(self.client.clears, 0)
        self.assertFalse(self.window.busy)
        self.assertFalse(self.window.budget_clear_button.isHidden())
        self.assertEqual(self.window.composer.input.toPlainText(), '这次额度不足')
        self.assertEqual([bubble.role for bubble in self.window._bubbles], ['user'])

    def test_disconnect_during_clear_remains_disconnected(self):
        self.reveal()
        self.window.budget_clear_button.click()
        self.window._enable_connected(False)
        self.complete(self.pending.pop())
        self.assertFalse(self.window.connected)
        self.assertFalse(self.window.composer.send.isEnabled())

    def test_committed_budget_receipt_reveals_recovery_and_finishes_normally(self):
        user_text, receipt = '以后每天限额一千 token', '限额已保存，本轮后续模型请求已停止。'
        self.window.composer.input.setPlainText(user_text)
        self.window.send_message()
        chat_job = self.pending.pop()
        generation = self.window._chat_generation
        self.window._stream_event((generation, {'type': 'plain', 'data': receipt,
            'streaming': False, 'message_id': 'receipt-1'}))
        old_status, old_run = self.window.status.text(), self.window._live_run_id
        self.window._stream_event((generation, {'type': 'usage_budget_blocked',
            'data': 'usage_budget_exceeded', 'message_id': 'request-1'}))
        self.assertTrue(self.window.busy)
        self.assertFalse(self.window.budget_clear_button.isHidden())
        self.assertFalse(self.window.budget_clear_button.isEnabled())
        self.assertEqual(self.window.status.text(), old_status)
        self.assertEqual(self.window._live_run_id, old_run)
        self.assertEqual(self.window._live_bubble.content, receipt)
        self.assertTrue(self.window.stop_button.isEnabled())
        self.assertEqual(self.client.clears, 0)
        chat_job[1](history(('user', [{'type': 'plain', 'text': user_text}]),
                            ('assistant', [{'type': 'plain', 'text': receipt}])))
        self.app.processEvents()
        self.assertFalse(self.window.busy)
        self.assertTrue(self.window.budget_clear_button.isEnabled())
        self.assertEqual(self.window.composer.input.toPlainText(), '', 'committed receipt must not restore failed draft')
        self.assertEqual([bubble.content for bubble in self.window._bubbles], [user_text, receipt])

    def test_budget_receipt_event_keeps_stop_pending_controls_and_ignores_stale(self):
        self.window.composer.input.setPlainText('预算回执')
        self.window.send_message()
        event = {'type': 'usage_budget_blocked', 'data': 'usage_budget_exceeded'}
        self.window._stream_event((self.window._chat_generation - 1, event))
        self.assertTrue(self.window.budget_clear_button.isHidden())
        self.window._stop_pending = True
        self.window.stop_button.setEnabled(False)
        self.window.composer.send.setEnabled(False)
        self.window.status.setText('正在停止回复…')
        self.window._stream_event((self.window._chat_generation, event))
        self.assertFalse(self.window.budget_clear_button.isHidden())
        self.assertFalse(self.window.budget_clear_button.isEnabled())
        self.assertTrue(self.window._stop_pending)
        self.assertFalse(self.window.stop_button.isEnabled())
        self.assertFalse(self.window.composer.send.isEnabled())
        self.assertEqual(self.window.status.text(), '正在停止回复…')
        self.assertIsNone(self.window._live_bubble)

    def test_old_client_has_no_recovery_controls(self):
        with patch.object(live_chat, 'AudioQueue', SilentAudio):
            old_window = live_chat.AstrBotChatWindow(Client(Path(self.temp.name)), auto_connect=False)
        try:
            old_window._show_error(budget_error())
            self.assertIsNone(old_window.budget_clear_button)
            self.assertIsNone(old_window._budget_recovery_row)
            old_window.clear_usage_budget()
        finally:
            self.dispose(old_window)


class BudgetClientAdapterTests(unittest.TestCase):
    def receive_chat_receipt(self, code, *, stop_on_text=False, blocked=True):
        client = NiananClient(ROOT)
        response = MagicMock()
        response.ok = True
        response.json.return_value = {'budget_blocked': blocked, 'budget_error': code,
            'text': '限额已保存。', 'messages': [{'text': '限额已保存。'}], 'budget': {'enabled': True}}
        response.__enter__.return_value = response
        session = MagicMock()
        session.request.return_value = response
        session.__enter__.return_value = session
        events = []
        def emit(event):
            events.append(event)
            if stop_on_text and event.get('type') == 'plain':
                client._stop_events['main'].set()
        with patch.object(client, '_connection', return_value=('http://127.0.0.1:1', 'fake-local-token')), \
                patch('nianan_client.requests.Session', return_value=session), \
                patch('nianan_client.TYPEWRITER_INTERVAL_SECONDS', 0), \
                patch.object(client, '_publish_bubble'):
            completed = client.chat('main', '保存额度', [], emit)
        return completed, events

    def test_http200_budget_receipt_emits_safe_event_after_reply_before_end(self):
        for code in (*BUDGET_CODES, 'usage_budget_SECRET https://private.invalid', None, [], {}):
            with self.subTest(code=code):
                completed, events = self.receive_chat_receipt(code)
                self.assertTrue(completed)
                blocked = [event for event in events if event['type'] == 'usage_budget_blocked']
                self.assertEqual(len(blocked), 1)
                expected = code if isinstance(code, str) and code in BUDGET_CODES else 'usage_budget_exceeded'
                self.assertEqual(blocked[0]['data'], expected)
                self.assertEqual(events[-2:], [blocked[0], {'type': 'end', 'message_id': blocked[0]['message_id']}])
                self.assertEqual(''.join(event['data'] for event in events if event['type'] == 'plain'), '限额已保存。')

    def test_stopped_or_regular_receipt_does_not_emit_budget_event(self):
        completed, events = self.receive_chat_receipt('usage_budget_exceeded', stop_on_text=True)
        self.assertFalse(completed)
        self.assertNotIn('usage_budget_blocked', [event['type'] for event in events])
        completed, events = self.receive_chat_receipt('usage_budget_exceeded', blocked=False)
        self.assertTrue(completed)
        self.assertNotIn('usage_budget_blocked', [event['type'] for event in events])

    def test_clear_uses_only_authenticated_local_endpoint(self):
        client = NiananClient(ROOT)
        response = MagicMock()
        response.ok = True
        response.json.return_value = {'ok': True, 'budget': {'enabled': False}}
        response.__enter__.return_value = response
        session = MagicMock()
        session.request.return_value = response
        session.__enter__.return_value = session
        with patch.object(client, '_connection', return_value=('http://127.0.0.1:1', 'fake-local-token')), \
                patch('nianan_client.requests.Session', return_value=session):
            self.assertTrue(client.clear_usage_budget()['ok'])
        session.request.assert_called_once_with('POST', 'http://127.0.0.1:1/usage/budget/clear',
            headers={'Authorization': 'Bearer fake-local-token'}, timeout=(5, 240), allow_redirects=False, json={})
        self.assertFalse(session.trust_env)

    def test_budget_codes_are_sanitized_and_preserved_only_from_allowlist(self):
        client = NiananClient(ROOT)
        for code in (*BUDGET_CODES, 'usage_budget_private-secret', None, [], {}):
            with self.subTest(code=code):
                response = MagicMock()
                response.ok = False
                response.status_code = 409
                response.json.return_value = {'code': code, 'message': 'SECRET https://private.invalid/token'}
                response.__enter__.return_value = response
                session = MagicMock()
                session.request.return_value = response
                session.__enter__.return_value = session
                with patch.object(client, '_connection', return_value=('http://127.0.0.1:1', 'fake-local-token')), \
                        patch('nianan_client.requests.Session', return_value=session):
                    with self.assertRaises(live_chat.ConnectionError) as caught:
                        client.request('POST', '/chat', json={})
                self.assertEqual(caught.exception.code, code if isinstance(code, str) and code in BUDGET_CODES else '')
                self.assertNotIn('SECRET', str(caught.exception))
                self.assertNotIn('private.invalid', str(caught.exception))
                self.assertNotIn('private-secret', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
