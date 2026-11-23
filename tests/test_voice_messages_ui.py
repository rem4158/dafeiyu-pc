"""Voice-message UI checks: synthetic history, in-memory audio, and no services."""
import base64
import copy
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

os.environ['QT_QPA_PLATFORM'] = 'offscreen'
ROOT = Path(__file__).resolve().parents[1]
os.environ['DAFEIYU_PC_ROOT'] = str(ROOT)
sys.path.insert(0, str(ROOT / 'desktop'))
sys.path.insert(0, str(ROOT / 'desktop_bridge'))

from PySide6.QtCore import QCoreApplication, QEvent, QObject, Qt, Signal
from PySide6.QtGui import QFont, QFontDatabase
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication
import live_chat


class SilentAudio(QObject):
    changed = Signal(str, bool)
    failed = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.current = None
        self.pending = set()
        self.played = []

    def reserve(self, key):
        if key in self.pending or key == self.current:
            return False
        self.pending.add(key)
        return True

    def ready(self, key, data):
        if key in self.pending:
            self.pending.remove(key)
            self.current = key
            self.played.append(key)
            self.changed.emit(key, True)

    def discard(self, key):
        self.pending.discard(key)

    def cancel(self, keys):
        self.pending.difference_update(keys)
        if self.current in keys:
            previous, self.current = self.current, None
            self.changed.emit(previous, False)

    def stop(self):
        self.pending.clear()
        previous, self.current = self.current, None
        if previous is not None:
            self.changed.emit(previous, False)


class Client:
    backend_name = '隔离测试后台'
    is_local_backend = True
    supports_attachments = False
    supports_stickers = False
    username = 'local'

    def __init__(self, root):
        self.root = root
        self.attachments = []
        self.fail_audio = False
        self.saved_history = {'history': []}

    def attachment(self, key):
        self.attachments.append(key)
        if key == 'image-1':
            return base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAALElEQVR4nGPcdvk9AzUAE1VMYRg1iBgwGtiEwWgYEQajYUQYjIYRYTD4wggAjC4CqOc42EoAAAAASUVORK5CYII=')
        if self.fail_audio:
            raise RuntimeError('SECRET private-provider-body')
        return b'RIFF-not-played-by-SilentAudio'

    def history(self, session_id):
        return copy.deepcopy(self.saved_history)


def history(*messages):
    return {'history': [
        {'id': index + 1, 'created_at': f'2026-11-06T10:00:{index:02d}',
         'content': {'type': role, 'message': parts}}
        for index, (role, parts) in enumerate(messages)]}


def immediate(operation, completed, failed=None):
    try:
        result = operation()
    except Exception as error:
        if failed:
            failed(error)
        else:
            raise
    else:
        completed(result)


class VoiceMessageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / 'temp')
        self.client = Client(Path(self.temp.name))
        with patch.object(live_chat, 'AudioQueue', SilentAudio):
            self.window = live_chat.AstrBotChatWindow(self.client, auto_connect=False)
        self.window._submit = immediate
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

    def render(self, *messages):
        self.window._render_history(history(*messages))
        self.app.processEvents()

    def voice(self, key='voice-1'):
        return self.window._voice_buttons[key][0]

    def test_history_starts_collapsed_uses_explicit_transcript_and_never_autoplays(self):
        self.render(('assistant', [
            {'type': 'plain', 'text': 'compatibility plain must stay hidden'},
            {'type': 'record', 'attachment_id': 'voice-1', 'transcript': '<b>准确的语音文字</b>'}]))
        bubble, button = self.window._bubbles[0], self.voice()
        self.assertEqual(self.client.attachments, [])
        self.assertEqual(self.window.audio.played, [])
        self.assertEqual(bubble.content, '')
        self.assertEqual(bubble.body.text(), '')
        self.assertTrue(bubble.body.isHidden())
        self.assertEqual(button.transcript, '<b>准确的语音文字</b>')
        self.assertTrue(button.transcript_label.isHidden())
        self.assertEqual(button.transcript_action.text(), '转文字')
        button.transcript_action.trigger()
        self.assertFalse(button.transcript_label.isHidden())
        self.assertEqual(button.transcript_label.textFormat(), Qt.TextFormat.PlainText)
        self.assertEqual(button.transcript_action.text(), '收起文字')
        button.transcript_action.trigger()
        self.assertTrue(button.transcript_label.isHidden())

    def test_old_history_fallback_empty_voice_and_plain_image_are_preserved(self):
        self.render(
            ('assistant', [{'type': 'record', 'attachment_id': 'voice-1'},
                           {'type': 'plain', 'text': '旧语音对应原文'}]),
            ('assistant', [{'type': 'record', 'attachment_id': 'voice-empty'}]),
            ('assistant', [{'type': 'plain', 'text': '普通图文仍然显示'},
                           {'type': 'image', 'attachment_id': 'image-1'}]))
        self.assertEqual(self.voice().transcript, '旧语音对应原文')
        empty = self.voice('voice-empty')
        self.assertFalse(empty.transcript_action.isEnabled())
        self.assertIn('没有可用文字', empty.toolTip())
        empty.toggle_transcript()
        self.assertTrue(empty.transcript_label.isHidden())
        self.assertEqual(self.window._bubbles[2].content, '普通图文仍然显示')
        self.assertFalse(self.window._bubbles[2].body.isHidden())
        self.assertEqual(self.client.attachments, ['image-1'])
        self.assertEqual(self.window.audio.played, [])

    def test_live_record_then_plain_updates_hidden_transcript_without_body_render(self):
        self.window.busy = True
        self.window._live_bubble = self.window._add('assistant', '')
        generation = self.window._chat_generation
        emit = lambda event: self.window._stream_event((generation, event))
        emit({'type': 'attachment_saved', 'message_id': 'reply-1',
              'data': {'type': 'record', 'id': 'voice-1'}})
        bubble, button = self.window._live_bubble, self.voice()
        self.assertFalse(button.transcript_action.isEnabled())
        with patch.object(bubble, 'set_content', wraps=bubble.set_content) as set_content:
            emit({'type': 'plain', 'message_id': 'reply-1', 'data': '实时语音原文', 'streaming': False})
            set_content.assert_not_called()
        self.assertEqual(button.transcript, '实时语音原文')
        self.assertTrue(button.transcript_label.isHidden())
        self.assertTrue(bubble.body.isHidden())
        self.assertEqual(bubble.body.text(), '')
        self.assertEqual(self.client.attachments, [])
        self.assertEqual(self.window.audio.played, [])
        emit({'type': 'plain', 'message_id': 'reply-2', 'data': '另一条普通文字', 'streaming': False})
        self.assertEqual(self.window._live_bubble.content, '另一条普通文字')
        self.assertFalse(self.window._live_bubble.body.isHidden())

    def test_live_explicit_transcript_is_not_overwritten_by_compatibility_plain(self):
        self.window.busy = True
        self.window._live_bubble = self.window._add('assistant', '')
        generation = self.window._chat_generation
        self.window._stream_event((generation, {'type': 'attachment_saved', 'message_id': 'reply-1',
            'data': {'type': 'record', 'id': 'voice-1', 'transcript': '语音真正的原文'}}))
        self.window._stream_event((generation, {'type': 'plain', 'message_id': 'reply-1',
            'data': '兼容原文', 'streaming': False}))
        self.assertEqual(self.voice().transcript, '语音真正的原文')
        self.assertTrue(self.voice().transcript_label.isHidden())
        self.assertEqual(self.window.audio.played, [])

    def test_companion_delivery_and_history_reopen_do_not_autoplay(self):
        self.client.saved_history = history(('assistant', [
            {'type': 'record', 'attachment_id': 'voice-1', 'transcript': '主动消息'}]))
        delivered = []
        accepted = self.window.deliver_companion_event({'session_id': 'main', 'messages': [
            {'parts': [{'type': 'record', 'attachment_id': 'voice-1'}]}]}, delivered.append)
        self.assertTrue(accepted)
        self.assertEqual(delivered, [True])
        self.assertEqual(self.client.attachments, [])
        self.voice().transcript_action.trigger()
        self.window._render_history(self.client.saved_history)
        self.assertTrue(self.voice().transcript_label.isHidden())
        self.assertEqual(self.window.audio.played, [])

    def test_click_play_stop_and_keyboard_menu_are_accessible(self):
        self.render(('assistant', [{'type': 'record', 'attachment_id': 'voice-1', 'transcript': '键盘可达原文'}]))
        button = self.voice()
        button.click()
        self.assertEqual(self.window.audio.current, 'voice-1')
        self.assertEqual(button.property('voiceState'), 'playing')
        self.assertIn('停止', button.accessibleName())
        button.click()
        self.assertIsNone(self.window.audio.current)
        self.assertEqual(button.property('voiceState'), 'idle')
        button.setFocus()
        QTest.keyClick(button, Qt.Key.Key_Space)
        self.assertEqual(self.window.audio.current, 'voice-1')
        QTest.keyClick(button, Qt.Key.Key_Space)
        self.assertIsNone(self.window.audio.current)
        QTest.keyClick(button, Qt.Key.Key_Menu)
        self.app.processEvents()
        self.assertTrue(button.menu.isVisible())
        QTest.keyClick(button.menu, Qt.Key.Key_Down)
        QTest.keyClick(button.menu, Qt.Key.Key_Return)
        self.app.processEvents()
        self.assertFalse(button.transcript_label.isHidden())
        self.assertEqual(button.transcript_action.text(), '收起文字')

    def test_download_failure_shows_safe_retry_state(self):
        self.render(('assistant', [{'type': 'record', 'attachment_id': 'voice-1'}]))
        self.client.fail_audio = True
        self.voice().click()
        self.assertEqual(self.voice().property('voiceState'), 'failed')
        self.assertIn('重试', self.voice().text())
        self.assertNotIn('SECRET', self.window.status.text())
        self.assertEqual(self.window.audio.pending, set())
        self.client.fail_audio = False
        self.voice().click()
        self.assertEqual(self.window.audio.current, 'voice-1')
        self.assertEqual(self.voice().property('voiceState'), 'playing')
        self.window.audio.failed.emit('SECRET from a fake device error')
        self.window.audio.stop()
        self.assertEqual(self.voice().property('voiceState'), 'failed')
        self.assertNotIn('SECRET', self.window.status.text())

    def test_loading_second_click_cancels_and_late_download_cannot_play(self):
        self.render(('assistant', [{'type': 'record', 'attachment_id': 'voice-1'}]))
        callbacks = []
        self.window._submit = lambda operation, completed, failed=None: callbacks.append((completed, failed))
        self.voice().click()
        self.assertEqual(self.voice().property('voiceState'), 'loading')
        self.voice().click()
        self.assertEqual(self.voice().property('voiceState'), 'idle')
        callbacks[0][0](b'RIFF-late')
        self.assertEqual(self.window.audio.played, [])
        self.voice().click()
        callbacks[1][0](b'RIFF-manual')
        self.assertEqual(self.window.audio.played, ['voice-1'])

    def test_history_rebuild_discards_old_buttons_and_pending_downloads(self):
        self.render(('assistant', [{'type': 'record', 'attachment_id': 'voice-1'}]))
        callbacks = []
        self.window._submit = lambda operation, completed, failed=None: callbacks.append(completed)
        self.voice().click()
        self.render(('assistant', [{'type': 'record', 'attachment_id': 'voice-new'}]))
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        callbacks[0](b'RIFF-obsolete')
        self.assertEqual(list(self.window._voice_buttons), ['voice-new'])
        self.assertEqual(self.voice('voice-new').property('voiceState'), 'idle')
        self.assertEqual(self.window.audio.pending, set())
        self.assertEqual(self.window.audio.played, [])

    def test_narrow_window_wraps_transcript_within_voice_bubble(self):
        self.window.resize(560, 620)
        self.render(('assistant', [{'type': 'record', 'attachment_id': 'voice-1',
            'transcript': '这是一段较长的语音原文，用来检查窄窗下自动换行。' * 5}]))
        button, bubble = self.voice(), self.window._bubbles[0]
        button.transcript_action.trigger()
        self.app.processEvents()
        self.assertLessEqual(button.width(), bubble.surface.width())
        self.assertLessEqual(button.transcript_label.width(), bubble.surface.width())
        self.assertGreater(button.transcript_label.height(), button.transcript_label.fontMetrics().height())
        self.assertLessEqual(bubble.width(), self.window.scroll.viewport().width())


def render_preview():
    app = QApplication.instance() or QApplication([])
    # Offscreen Qt does not automatically discover Windows font fallbacks.
    font_path = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts' / 'msyh.ttc'
    if font_path.is_file():
        QFontDatabase.addApplicationFont(str(font_path))
        app.setFont(QFont('Microsoft YaHei UI', 10))
    with tempfile.TemporaryDirectory(dir=ROOT / 'temp') as directory:
        client = Client(Path(directory))
        with patch.object(live_chat, 'AudioQueue', SilentAudio):
            window = live_chat.AstrBotChatWindow(client, auto_connect=False)
        window._submit = immediate
        window.session_id = 'main'
        window.connected = True
        window._enable_connected(True)
        window.status.setText('已连接大肥鱼本地后台')
        window._render_history(history(
            ('user', [{'type': 'plain', 'text': '今天忙了一整天，终于可以歇会儿了。'}]),
            ('assistant', [{'type': 'record', 'attachment_id': 'voice-1',
                            'transcript': '辛苦啦，先坐下来喝口水吧。我陪你慢慢聊。'},
                           {'type': 'plain', 'text': '辛苦啦，先坐下来喝口水吧。我陪你慢慢聊。'}]),
            ('assistant', [{'type': 'record', 'attachment_id': 'voice-2'},
                           {'type': 'plain', 'text': '想说什么都可以，我在听。'}]),
            ('assistant', [{'type': 'plain', 'text': '也可以只安静待一会儿。'}])))
        window._voice_buttons['voice-1'][0].transcript_action.trigger()
        window._voice_buttons['voice-2'][0].click()  # SilentAudio only: preview the playing state.
        window.show()
        for name, size in (('regular', (1000, 700)), ('narrow', (560, 700))):
            window.resize(*size)
            for _ in range(4):
                app.processEvents()
            path = ROOT / 'temp' / f'voice-messages-{name}.png'
            window.grab().save(str(path))
            print(path)
        window.hide()
        window.deleteLater()
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        app.processEvents()


if __name__ == '__main__':
    if '--preview' in sys.argv:
        render_preview()
    else:
        unittest.main()
