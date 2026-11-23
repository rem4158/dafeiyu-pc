"""Compose text and a chosen sticker together; isolated Qt and in-memory clients."""
import base64
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_voice_messages_ui import Client, ROOT, SilentAudio, history, live_chat
from PySide6.QtCore import QCoreApplication, QEvent
from PySide6.QtWidgets import QApplication, QLabel


PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAALElEQVR4nGPcdvk9AzUAE1VMYRg1iBgwGtiEwWgYEQajYUQYjIYRYTD4wggAjC4CqOc42EoAAAAASUVORK5CYII=')
FIRST = {'id': 'a' * 64, 'name': '开心', 'category': 'happy'}
SECOND = {'id': 'b' * 64, 'name': '挥手', 'category': 'hello'}


class StickerClient(Client):
    supports_stickers = True

    def __init__(self, root):
        super().__init__(root)
        self.chat_calls = []

    def sticker_image(self, key):
        return PNG

    def sessions(self):
        return []

    def stop(self, session_id):
        return {'stopped': True}

    def chat(self, session_id, text, files, emit, *, sticker_id=None):
        self.chat_calls.append((session_id, text, files, sticker_id))
        parts = ([{'type': 'plain', 'text': text}] if text else [])
        if sticker_id:
            parts.append({'type': 'image', 'sticker_id': sticker_id, 'attachment_id': 'image-1'})
        self.saved_history = history(('user', parts), ('assistant', [{'type': 'plain', 'text': '收到啦。'}]))
        return True


class StickerComposerUITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / 'temp')
        self.client = StickerClient(Path(self.temp.name))
        with patch.object(live_chat, 'AudioQueue', SilentAudio):
            self.window = live_chat.AstrBotChatWindow(self.client, auto_connect=False)
        self.pending = []
        self.window._submit = lambda operation, completed, failed=None: self.pending.append((operation, completed, failed))
        self.window.session_id = 'main'
        self.window._enable_connected(True)
        self.window.show()
        self.app.processEvents()

    def tearDown(self):
        self.window._stop_voice_playback()
        self.window.hide()
        self.window.deleteLater()
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.app.processEvents()
        self.temp.cleanup()

    def stage(self, sticker=FIRST):
        self.window.select_sticker(dict(sticker))
        self.app.processEvents()
        return self.window._draft_sticker

    def begin(self, text='今天很开心，给你看看。'):
        self.stage()
        self.window.composer.input.setPlainText(text)
        self.window.composer.send.click()
        self.app.processEvents()
        return self.pending[-1]

    def complete(self, job):
        value = job[0]()
        job[1](value)
        self.app.processEvents()
        return value

    def assert_sticker_cleared_while_waiting(self):
        self.assertTrue(self.window.composer.send.isEnabled())
        self.assertEqual(self.window.composer.send.text(), '停止')
        self.assertTrue(self.window.composer.send.property('busy'))
        self.assertTrue(self.window.sticker_draft.isHidden())
        self.assertIsNone(self.window._draft_sticker)

    def test_select_only_stages_preserves_text_and_does_not_send(self):
        text = '写到一半的文字草稿'
        self.window.composer.input.setPlainText(text)
        self.stage()
        self.assertEqual(self.window.composer.input.toPlainText(), text)
        self.assertEqual(self.window._draft_sticker['id'], FIRST['id'])
        self.assertFalse(self.window.sticker_draft.isHidden())
        self.assertFalse(self.window.busy)
        self.assertEqual(self.window._bubbles, [])
        self.assertEqual(self.client.chat_calls, [])

    def test_replace_then_remove_updates_empty_send_state(self):
        self.stage()
        self.assertTrue(self.window.composer.send.isEnabled())
        self.stage(SECOND)
        self.assertEqual(self.window._draft_sticker['id'], SECOND['id'])
        self.window.sticker_remove_button.click()
        self.app.processEvents()
        self.assertIsNone(self.window._draft_sticker)
        self.assertTrue(self.window.sticker_draft.isHidden())
        self.assertFalse(self.window.composer.send.isEnabled())
        self.assertEqual(self.client.chat_calls, [])

    def test_clearing_text_keeps_send_enabled_for_staged_sticker(self):
        self.stage()
        self.window.composer.input.setPlainText('可删掉的文字')
        self.window.composer.input.clear()
        self.window._enable_connected(True)
        self.assertTrue(self.window.composer.send.isEnabled())
        self.window.remove_sticker()
        self.assertFalse(self.window.composer.send.isEnabled())

    def test_late_preview_cannot_overwrite_replaced_or_removed_sticker(self):
        self.stage()
        first_preview = self.pending[-1]
        self.stage(SECOND)
        second_preview = self.pending[-1]
        self.complete(first_preview)
        self.assertEqual(self.window._draft_sticker['id'], SECOND['id'])
        self.assertEqual(self.window.sticker_draft_preview.text(), '加载中')
        self.window.remove_sticker()
        self.complete(second_preview)
        self.assertIsNone(self.window._draft_sticker)
        self.assertTrue(self.window.sticker_draft.isHidden())
        self.assertTrue(self.window.sticker_draft_preview.pixmap().isNull())

    def test_text_and_sticker_share_user_bubble_and_client_turn(self):
        text = '文字和表情一起发。'
        job = self.begin(text)
        self.assert_sticker_cleared_while_waiting()
        self.assertEqual(len(self.window._bubbles), 1)
        bubble = self.window._bubbles[0]
        self.assertEqual(bubble.role, 'user')
        self.assertEqual(bubble.content, text)
        self.assertTrue(any(label.text() == '正在加载图片…' for label in bubble.findChildren(QLabel)),
                        'same user bubble owns the image placeholder')
        self.complete(job)
        self.assertEqual(self.client.chat_calls, [('main', text, [], FIRST['id'])])
        self.assertFalse(self.window.busy)
        self.assertIsNone(self.window._draft_sticker)
        self.assertTrue(self.window.sticker_draft.isHidden())
        self.assertEqual(self.window.composer.input.toPlainText(), '')
        parts = self.client.saved_history['history'][0]['content']['message']
        self.assertEqual([part['type'] for part in parts], ['plain', 'image'])

    def test_sticker_without_text_can_be_sent(self):
        job = self.begin('')
        self.assert_sticker_cleared_while_waiting()
        self.complete(job)
        self.assertEqual(self.client.chat_calls, [('main', '', [], FIRST['id'])])
        self.assertIsNone(self.window._draft_sticker)

    def test_busy_turn_locks_sticker_selection_and_removal(self):
        self.begin()
        self.window.remove_sticker()
        self.window.select_sticker(dict(SECOND))
        self.assertIsNone(self.window._draft_sticker)
        self.assertFalse(self.window.sticker_button.isEnabled())
        self.assertFalse(self.window.sticker_remove_button.isEnabled())

    def test_failure_restores_sticker_and_empty_text_draft(self):
        text = '失败后保留文字和表情'
        job = self.begin(text)
        job[2](live_chat.ConnectionError('隔离失败'))
        self.app.processEvents()
        self.assertFalse(self.window.busy)
        self.assertEqual(self.window._draft_sticker, FIRST)
        self.assertFalse(self.window.sticker_draft.isHidden())
        self.assertTrue(self.window.sticker_remove_button.isEnabled())
        self.assertEqual(self.window.composer.input.toPlainText(), text)

    def test_new_text_typed_while_busy_survives_success_and_failure(self):
        job = self.begin('已发送的文字')
        self.window.composer.input.setPlainText('下一条新草稿')
        self.complete(job)
        self.assertEqual(self.window.composer.input.toPlainText(), '下一条新草稿')
        self.assertIsNone(self.window._draft_sticker)
        job = self.begin('第二条已发送的文字')
        self.window.composer.input.setPlainText('失败时也不覆盖新草稿')
        job[2](live_chat.ConnectionError('隔离失败'))
        self.assertEqual(self.window.composer.input.toPlainText(), '失败时也不覆盖新草稿')
        self.assertEqual(self.window._draft_sticker['id'], FIRST['id'])

    def test_stopped_reply_does_not_restore_sent_sticker(self):
        chat_job = self.begin()
        self.window.composer.send.click()
        stop_job = self.pending[-1]
        chat_job[1](None)
        self.assertTrue(self.window.busy)
        self.assertTrue(self.window._stop_pending)
        self.assertFalse(self.window.composer.send.isEnabled())
        self.assertIsNone(self.window._draft_sticker)
        self.assertTrue(self.window.sticker_draft.isHidden())
        stop_job[1]({'stopped': True})
        self.app.processEvents()
        self.assertFalse(self.window.busy)
        self.assertFalse(self.window._stop_pending)
        self.assertIsNone(self.window._draft_sticker)
        self.assertEqual(self.window.composer.input.toPlainText(), '')


if __name__ == '__main__':
    unittest.main()
