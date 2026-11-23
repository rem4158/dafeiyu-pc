"""Click actual Qt chat links without opening a browser or contacting a service."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from test_voice_messages_ui import Client, ROOT, SilentAudio, history, live_chat
from PySide6.QtCore import QCoreApplication, QEvent, QPoint, QPointF, Qt
from PySide6.QtGui import QDesktopServices, QFont, QFontDatabase, QMouseEvent
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication, QWidget
from nianan_client import NiananClient


FIRST = 'https://zhuanlan.zhihu.com/p/1000000000000000001'
SECOND = 'https://zhuanlan.zhihu.com/p/1000000000000000002'


def hover_map(label):
    """Ask the actual label which address is under each sampled mouse position."""
    hovered = ['']
    def changed(address):
        hovered[0] = address
    label.linkHovered.connect(changed)
    positions = {}
    try:
        for y in range(2, label.height(), 4):
            for x in range(2, label.width(), 8):
                pos = QPoint(x, y)
                QApplication.sendEvent(label, QMouseEvent(
                    QEvent.Type.MouseMove, QPointF(pos), QPointF(label.mapToGlobal(pos)),
                    Qt.MouseButton.NoButton, Qt.MouseButton.NoButton, Qt.KeyboardModifier.NoModifier,
                ))
                positions.setdefault(hovered[0], []).append(pos)
    finally:
        label.linkHovered.disconnect(changed)
    return positions


class ChatLinkTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])
        font = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts' / 'msyh.ttc'
        if font.is_file():
            QFontDatabase.addApplicationFont(str(font))
            cls.app.setFont(QFont('Microsoft YaHei UI', 10))

    def setUp(self):
        directory = self.enterContext(tempfile.TemporaryDirectory(dir=ROOT / 'temp'))
        with patch.object(live_chat, 'AudioQueue', SilentAudio):
            self.window = live_chat.AstrBotChatWindow(Client(Path(directory)), auto_connect=False)
        self.open_url = self.enterContext(patch.object(QDesktopServices, 'openUrl', return_value=True))
        self.window.resize(600, 550)
        self.window.show()
        self.app.processEvents()
        self.addCleanup(self.dispose_window)

    def dispose_window(self):
        self.window.hide()
        self.window.deleteLater()
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.app.processEvents()

    def render(self, role, text):
        self.window._render_history(history((role, [{'type': 'plain', 'text': text}])))
        self.app.processEvents()
        return self.window._bubbles[0]

    def assert_click(self, label, pos, expected):
        self.open_url.reset_mock()
        QTest.mouseClick(label, Qt.MouseButton.LeftButton, pos=pos)
        self.assertEqual([call.args[0].toString() for call in self.open_url.call_args_list], [expected])

    def assert_copy_visible_text(self, bubble, expected):
        self.assertIsNone(bubble.findChild(QWidget, 'message-copy-button'))
        self.assertIsNone(bubble.findChild(QWidget, 'message-tools'))
        bubble.body.setFocus()
        QTest.keyClick(bubble.body, Qt.Key.Key_A, Qt.KeyboardModifier.ControlModifier)
        QTest.keyClick(bubble.body, Qt.Key.Key_C, Qt.KeyboardModifier.ControlModifier)
        self.assertEqual(self.app.clipboard().text(), expected)

    def test_history_long_url_opens_from_both_wrapped_lines(self):
        text = '天气凉了也可以看看基础保湿霜；先确认自己确实需要：' + SECOND + '。'
        bubble = self.render('assistant', text)
        hits = hover_map(bubble.body)
        self.assertEqual(set(hits) - {''}, {SECOND})
        start, end = hits[SECOND][0], hits[SECOND][-1]
        self.assertGreater(end.y() - start.y(), bubble.body.fontMetrics().height(),
                           'fixture must wrap the URL, not only the paragraph')
        self.assert_click(bubble.body, start, SECOND)
        self.assert_click(bubble.body, end, SECOND)
        self.open_url.reset_mock()
        QTest.mouseClick(bubble.body, Qt.MouseButton.LeftButton, pos=hits[''][0])
        self.open_url.assert_not_called()
        self.assert_copy_visible_text(bubble, text)
        if dest := os.environ.get('DAFEIYU_CHAT_LINKS_QA'):
            output = Path(dest)
            output.mkdir(exist_ok=True, parents=True)
            self.assertTrue(bubble.grab().save(str(output / 'wrapped-link.png')))

    def test_live_typewriter_and_reloaded_history_open_same_urls(self):
        self.window.busy = True
        raw = '按实际用量买：' + FIRST + '，另一个是 ' + SECOND
        events = []
        with patch('nianan_client.TYPEWRITER_INTERVAL_SECONDS', 0):
            self.assertTrue(NiananClient.emit_message({'text': raw}, events.append, 'reply-1'))
        for event in events[:-1]:
            self.window._stream_event((self.window._chat_generation, event))
        partial = self.window._live_bubble
        self.app.processEvents()
        self.assertEqual(partial.content, raw[:-1])
        self.assertEqual(set(hover_map(partial.body)), {''})
        QTest.mouseClick(partial.body, Qt.MouseButton.LeftButton, pos=partial.body.rect().center())
        self.open_url.assert_not_called()
        self.window._stream_event((self.window._chat_generation, events[-1]))
        self.app.processEvents()
        self.open_url.assert_not_called()
        for kind in ('live', 'history'):
            with self.subTest(kind=kind):
                bubble = self.window._live_bubble if kind == 'live' else self.render('assistant', raw)
                hits = hover_map(bubble.body)
                self.assertEqual(set(hits) - {''}, {FIRST, SECOND})
                self.assert_click(bubble.body, hits[FIRST][len(hits[FIRST]) // 2], FIRST)
                self.assert_click(bubble.body, hits[SECOND][len(hits[SECOND]) // 2], SECOND)
                self.assertEqual(bubble.content, raw)

    def test_markdown_title_opens_webpage_and_code_is_only_text(self):
        raw = '[查看资料](' + FIRST + ')，代码示例：`' + SECOND + '`'
        bubble = self.render('assistant', raw)
        hits = hover_map(bubble.body)
        self.assertEqual(set(hits) - {''}, {FIRST})
        self.assert_click(bubble.body, hits[FIRST][len(hits[FIRST]) // 2], FIRST)
        self.assert_copy_visible_text(bubble, '查看资料，代码示例：' + SECOND)
        self.assertEqual(bubble.content, raw)

    def test_user_text_preserves_query_parameters_and_ignores_non_web_scheme(self):
        url = 'http://example.test/results?a=1&b=2#part'
        raw = '链接（' + url + '）。file:///C:/ignored.txt'
        bubble = self.render('user', raw)
        hits = hover_map(bubble.body)
        self.assertEqual(set(hits) - {''}, {url})
        self.assert_click(bubble.body, hits[url][len(hits[url]) // 2], url)
        self.assert_copy_visible_text(bubble, raw)
        self.assertTrue(bubble.body.textInteractionFlags() & Qt.TextInteractionFlag.TextSelectableByMouse)


if __name__ == '__main__':
    unittest.main(verbosity=2)
