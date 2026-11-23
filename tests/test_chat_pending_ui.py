"""Pending replies use status only; actual content creates each assistant bubble."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_voice_messages_ui import Client, ROOT, SilentAudio, history, live_chat
from PySide6.QtCore import QCoreApplication, QEvent
from PySide6.QtGui import QFont, QFontDatabase
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication, QLabel


class PendingClient(Client):
    def sessions(self):
        return []

    def stop(self, session_id):
        return {'stopped': True}


class ChatPendingUITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / 'temp')
        self.client = PendingClient(Path(self.temp.name))
        with patch.object(live_chat, 'AudioQueue', SilentAudio):
            self.window = live_chat.AstrBotChatWindow(self.client, auto_connect=False)
        self.pending = []
        self.window._submit = lambda operation, completed, failed=None: self.pending.append((operation, completed, failed))
        self.window.session_id = 'main'
        self.window.connected = True
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

    def begin(self, text='今天忙完了，陪我聊一会儿吧。'):
        self.window.composer.input.setPlainText(text)
        self.window._send_turn(text, [])
        self.app.processEvents()
        return self.pending[-1]

    def emit(self, event, generation=None):
        self.window._stream_event((self.window._chat_generation if generation is None else generation, event))
        self.app.processEvents()

    def assistants(self):
        return [bubble for bubble in self.window._bubbles if bubble.role == 'assistant']

    def assert_no_assistant(self):
        self.assertEqual(self.assistants(), [], 'waiting must not leave a visible empty assistant surface')
        self.assertIsNone(self.window._live_bubble)

    def test_send_waits_with_only_user_bubble_and_status(self):
        self.begin()
        self.assertTrue(self.window.busy)
        self.assertEqual([bubble.role for bubble in self.window._bubbles], ['user'])
        self.assertIn('回复', self.window.status.text())
        self.assert_no_assistant()
        QTest.qWait(25)
        self.app.processEvents()
        self.assert_no_assistant()
        self.assertEqual(self.client.attachments, [])

    def test_non_content_and_stale_events_never_create_waiting_bubble(self):
        self.begin()
        events = [
            {'type': 'plain', 'data': '', 'streaming': False},
            {'type': 'plain', 'data': '  \n\t ', 'streaming': False},
            {'type': 'plain', 'data': '', 'streaming': True},
            {'type': 'attachment_saved', 'data': {'type': 'record'}},
            {'type': 'attachment_saved', 'data': 'invalid attachment'},
            {'type': 'attachment_saved', 'data': {'type': 'record', 'id': []}},
            {'type': 'attachment_saved', 'data': {'type': 'record', 'id': {}}},
            {'type': 'attachment_saved', 'data': {'type': 'image', 'id': ''}},
            {'type': 'attachment_saved', 'data': {'type': 'unknown', 'id': 'bad'}},
            {'type': 'plain', 'chain_type': 'reasoning', 'data': '先考虑怎样自然地回复。'},
            {'type': 'plain', 'chain_type': 'tool_call', 'data': '处理中'},
            {'type': 'media_warning', 'data': '语音生成失败，已保留文字。'},
            {'type': 'end'},
            {'type': 'error'},
        ]
        for event in events:
            with self.subTest(event=event):
                self.emit(event)
                self.assert_no_assistant()
        self.emit({'type': 'plain', 'data': '旧回复必须忽略', 'streaming': False},
                  generation=self.window._chat_generation - 1)
        self.assert_no_assistant()
        self.assertEqual(self.client.attachments, [])

    def test_first_text_and_later_segment_each_create_only_populated_bubble(self):
        self.begin()
        self.assert_no_assistant()
        self.emit({'type': 'plain', 'message_id': 'reply-1', 'data': '忙完啦，先坐下来歇歇。', 'streaming': False})
        first = self.window._live_bubble
        self.assertEqual(first.content, '忙完啦，先坐下来歇歇。')
        self.assertFalse(first.body.isHidden())
        self.assertEqual(len(self.assistants()), 1)
        QTest.qWait(25)
        self.app.processEvents()
        self.assertEqual(self.assistants(), [first], 'the gap between segments has no empty next bubble')
        self.emit({'type': 'plain', 'message_id': 'reply-2', 'data': '我在听，你慢慢说。', 'streaming': False})
        self.assertEqual([bubble.content for bubble in self.assistants()],
                         ['忙完啦，先坐下来歇歇。', '我在听，你慢慢说。'])

    def test_streaming_chunks_reuse_first_populated_bubble(self):
        self.begin()
        self.emit({'type': 'plain', 'message_id': 'stream-1', 'data': '你', 'streaming': True})
        first = self.window._live_bubble
        self.emit({'type': 'plain', 'message_id': 'stream-1', 'data': '好', 'streaming': True})
        self.emit({'type': 'plain', 'message_id': 'stream-1', 'data': ' ', 'streaming': True})
        self.emit({'type': 'plain', 'message_id': 'stream-1', 'data': '呀。', 'streaming': True})
        self.assertEqual(self.assistants(), [first])
        self.assertEqual(first.content, '你好 呀。')
        self.assertFalse(first.body.isHidden())

    def test_first_voice_is_real_content_and_paired_plain_stays_hidden(self):
        self.begin()
        self.assert_no_assistant()
        self.emit({'type': 'attachment_saved', 'message_id': 'reply-voice',
                   'data': {'type': 'record', 'id': 'voice-1'}})
        voice_bubble = self.window._live_bubble
        button = self.window._voice_buttons['voice-1'][0]
        self.assertEqual(self.assistants(), [voice_bubble])
        self.assertFalse(button.isHidden())
        self.emit({'type': 'plain', 'message_id': 'reply-voice', 'data': '这条语音对应的原文。', 'streaming': False})
        self.assertEqual(self.assistants(), [voice_bubble])
        self.assertEqual(voice_bubble.content, '')
        self.assertTrue(voice_bubble.body.isHidden())
        self.assertEqual(button.transcript, '这条语音对应的原文。')
        self.assertTrue(button.transcript_label.isHidden())
        self.assertEqual(self.window.audio.played, [])
        self.assertEqual(self.client.attachments, [])
        self.emit({'type': 'plain', 'message_id': 'reply-next', 'data': '另一条文字回复。', 'streaming': False})
        self.assertEqual(len(self.assistants()), 2)
        self.assertEqual(self.window._live_bubble.content, '另一条文字回复。')

    def test_first_image_creates_media_bubble_without_text_placeholder(self):
        self.begin()
        self.assert_no_assistant()
        self.emit({'type': 'attachment_saved', 'message_id': 'reply-image',
                   'data': {'type': 'image', 'id': 'image-1'}})
        bubble = self.window._live_bubble
        self.assertEqual(self.assistants(), [bubble])
        self.assertEqual(bubble.content, '')
        image_job = self.pending[-1]
        image_job[1](self.client.attachment('image-1'))
        self.app.processEvents()
        labels = [label for label in bubble.findChildren(QLabel) if label.accessibleName() == '图片或表情包']
        self.assertEqual(len(labels), 1)
        self.assertFalse(labels[0].isHidden())
        self.assertTrue(bubble.body.isHidden())
        self.assertEqual(self.window.audio.played, [])

    def test_failure_and_stop_before_first_content_do_not_leave_empty_bubble(self):
        failed_job = self.begin('这条请求会失败。')
        failed_job[2](live_chat.ConnectionError('隔离测试请求失败'))
        self.app.processEvents()
        self.assertFalse(self.window.busy)
        self.assert_no_assistant()
        self.assertEqual(self.window.composer.input.toPlainText(), '这条请求会失败。')

        stopped_job = self.begin('这条请求将在正文前停止。')
        self.window.stop_reply()
        self.assert_no_assistant()
        stop_job = self.pending[-1]
        stop_job[1]({'stopped': True})
        self.client.saved_history = history(('user', [{'type': 'plain', 'text': '这条请求将在正文前停止。'}]))
        stopped_job[1](self.client.history('main'))
        self.app.processEvents()
        self.assertFalse(self.window.busy)
        self.assert_no_assistant()
        self.assertEqual([bubble.role for bubble in self.window._bubbles], ['user'])

    def test_stopped_typewriter_keeps_partial_text_without_history_reveal(self):
        saved = history(('user', [{'type': 'plain', 'text': '测试停止'}]),
                        ('assistant', [{'type': 'plain', 'text': '先显示这一部分，还有尚未显示的后半段。'}]))
        self.client.history = Mock(return_value=saved)
        def chat(session_id, text, files, emit):
            emit({'type': 'plain', 'data': '先显示这一部分', 'streaming': False, 'message_id': 'partial'})
            return False
        self.client.chat = chat
        chat_job = self.begin('测试停止')
        self.window.stop_reply()
        stop_job = self.pending[-1]
        result = chat_job[0]()
        self.assertIsNone(result)
        self.client.history.assert_not_called()
        chat_job[1](result)
        self.assertTrue(self.window.busy, 'send stays locked until the stop HTTP callback has settled')
        self.assertFalse(self.window.composer.send.isEnabled())
        stop_job[1]({'stopped': True})
        self.assertFalse(self.window.busy)
        self.assertFalse(self.window._stop_pending)
        self.assertEqual([bubble.content for bubble in self.assistants()], ['先显示这一部分'])
        self.client.history.assert_not_called()
        self.window._render_history(self.client.history('main'))
        self.assertEqual(self.assistants()[0].content, '先显示这一部分，还有尚未显示的后半段。',
                         'an explicit history read still shows the saved complete message')

    def test_natural_finish_during_stop_waits_for_stop_http_before_unlocking(self):
        chat_job = self.begin()
        self.window.stop_reply()
        stop_job = self.pending[-1]
        saved = history(('assistant', [{'type': 'plain', 'text': '自然完成的回复。'}]))
        chat_job[1](saved)
        self.assertTrue(self.window.busy)
        self.assertFalse(self.window.composer.send.isEnabled())
        stop_job[1]({'stopped': False})
        self.assertFalse(self.window.busy)
        self.assertEqual(self.assistants()[0].content, '自然完成的回复。')

    def test_chat_failure_during_stop_also_waits_for_stop_request(self):
        chat_job = self.begin('失败后保留草稿')
        self.window.stop_reply()
        stop_job = self.pending[-1]
        chat_job[2](live_chat.ConnectionError('聊天请求失败'))
        self.assertTrue(self.window.busy)
        stop_job[2](live_chat.ConnectionError('停止请求失败'))
        self.assertFalse(self.window.busy)
        self.assertFalse(self.window._stop_pending)
        self.assertIsNone(self.window._deferred_chat_completion)
        self.assertEqual(self.window.composer.input.toPlainText(), '失败后保留草稿')
        self.assert_no_assistant()


def render_preview():
    ChatPendingUITests.setUpClass()
    font_path = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts' / 'msyh.ttc'
    if font_path.is_file():
        QFontDatabase.addApplicationFont(str(font_path))
        ChatPendingUITests.app.setFont(QFont('Microsoft YaHei UI', 10))
    case = ChatPendingUITests(methodName='test_send_waits_with_only_user_bubble_and_status')
    case.setUp()
    try:
        case.window.resize(1000, 700)
        case.begin()
        for _ in range(3):
            case.app.processEvents()
        waiting = ROOT / 'temp' / 'chat-pending-waiting.png'
        case.window.grab().save(str(waiting))
        case.emit({'type': 'plain', 'message_id': 'preview-1', 'data': '忙完啦，先坐下来歇歇。我陪你聊一会儿。', 'streaming': False})
        for _ in range(3):
            case.app.processEvents()
        received = ROOT / 'temp' / 'chat-pending-received.png'
        case.window.grab().save(str(received))
        print(waiting)
        print(received)
    finally:
        case.tearDown()


if __name__ == '__main__':
    if '--preview' in sys.argv:
        render_preview()
    else:
        unittest.main()
