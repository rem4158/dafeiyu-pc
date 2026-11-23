"""Exercise the private browser UI without a real account, service or Chrome window."""
import os
from pathlib import Path
import sys
import time
import unittest
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

os.environ['QT_QPA_PLATFORM'] = 'offscreen'
ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'desktop'), str(ROOT / 'desktop_bridge')]
from PySide6.QtCore import QObject, Signal
from PySide6.QtGui import QFont, QFontDatabase
from PySide6.QtWidgets import QApplication, QDialog, QLabel, QMessageBox, QScrollArea, QVBoxLayout
from companion_bridge import CompanionBridge
from pet.local_browser_settings import BrowserVerifyDialog, LocalBrowserSettingsPage
from pet.settings_theme_qss import _settings_stylesheet


class BrowserUI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        self.calls = []
        self.saved = {'enabled': True, 'proactive': True}
        self.login = 'idle'
        self.login_result = {}
        self.accounts = {'sites': [], 'remembered': [], 'canRemember': False}
        self.background = {'task': None, 'running': True, 'working': False,
                           'reason': 'no_task', 'nextEligibleAt': None}
        self.client = SimpleNamespace(request=self.request, settings=lambda: {'browser': dict(self.saved)},
                                      save_settings=self.save)

    def save(self, payload):
        self.calls.append(('PUT', '/settings', payload))
        self.saved.update(payload['browser'])
        return {'browser': dict(self.saved)}

    def request(self, method, route, **kwargs):
        values = kwargs.get('json')
        self.calls.append((method, route, values))
        if route == '/browser/accounts':
            if method == 'PUT':
                self.accounts['sites'] = [values['site']] if values['username'] else []
            return dict(self.accounts)
        if route == '/browser/login':
            if method == 'POST':
                self.login = 'opening'
            return {'state': self.login, 'site': 'xiaohongshu', 'operation_id': 'fixture-window', **self.login_result}
        if route == '/browser/session':
            return {'ok': True, 'result': {'site': values['site'], 'session_status': 'unknown',
                                          'access_status': 'access_denied'}}
        if route == '/browser/accounts/disconnect':
            return {'ok': True, 'site': values['site'], 'accounts': dict(self.accounts)}
        if route == '/browser/background':
            return self.background
        if route == '/browser/background/stop':
            self.assertEqual(values, {'task_id': self.background['task']['taskId']})
            self.background = {**self.background, 'reason': 'stopped',
                               'task': {**self.background['task'], 'status': 'stopped'}}
            return self.background
        return {'accepted': True}

    def wait(self, predicate):
        deadline = time.monotonic() + 3
        while not predicate() and time.monotonic() < deadline:
            self.app.processEvents()
            time.sleep(.005)
        self.assertTrue(predicate())

    def test_settings_save_close_and_write_only_credentials(self):
        page = LocalBrowserSettingsPage(client=self.client)
        self.wait(lambda: page._baseline is not None)
        page.enabled.click()
        self.assertFalse(page.proactive.isEnabled())
        page.save()
        self.wait(lambda: not page._busy)
        self.assertFalse(page.login.isEnabled())
        page.enabled.click()
        page.save()
        self.wait(lambda: not page._busy)
        self.assertTrue(page.login.isEnabled())
        page.proactive.setChecked(False)
        saved = []
        page.save_and_then(lambda: saved.append(True))
        self.wait(lambda: saved == [True])
        self.assertIn(('PUT', '/settings', {'browser': {'proactive': False}}), self.calls)
        page._set_account('xiaohongshu', 'fixture-account', '', False)
        self.wait(lambda: not page._busy)
        self.assertEqual(page.account_state.text(), '本次可用')
        page.clear_account()
        self.wait(lambda: not page._busy)
        self.assertEqual(page.account_state.text(), '未填写')
        self.assertTrue(page.can_close())
        page.deleteLater()

    def test_background_interval_defaults_saves_and_reloads(self):
        page = LocalBrowserSettingsPage(client=self.client)
        self.wait(lambda: page.background_interval.isEnabled())
        self.assertEqual(page.background_interval.value(), 5)
        self.assertFalse(page.dirty)
        self.assertEqual(page.background_interval.accessibleName(), '后台浏览间隔')
        page.background_interval.setValue(8)
        self.assertTrue(page.save_button.isEnabled())
        page.save_button.click()
        self.wait(lambda: not page._busy)
        self.assertIn(('PUT', '/settings', {'browser': {'backgroundIntervalMinutes': 8}}), self.calls)
        self.assertFalse(page.dirty)
        self.saved['backgroundIntervalMinutes'] = 12
        page.reload_button.click()
        self.wait(lambda: not page._busy)
        self.assertEqual(page.background_interval.value(), 12)
        self.assertFalse(page.dirty)

    def test_blacklist_and_weibo_account_use_separate_controls(self):
        page = LocalBrowserSettingsPage(client=self.client)
        self.wait(lambda: page._baseline is not None)
        page.blocked_sites['tieba'].setChecked(True)
        page.save()
        self.wait(lambda: not page._busy)
        self.assertIn(('PUT', '/settings', {'browser': {'autonomousBlockedSites': ['tieba']}}), self.calls)
        page.site.setCurrentIndex(4)
        self.assertEqual(page.site.currentData(), 'weibo')
        self.assertTrue(page.credential_row.isHidden())
        self.assertIn('热搜榜', page.account_hint.text())
        with patch.object(QMessageBox, 'question', return_value=QMessageBox.StandardButton.Yes):
            page.disconnect_account()
        self.wait(lambda: not page._busy)
        self.assertIn(('POST', '/browser/accounts/disconnect', {'site': 'weibo'}), self.calls)
        self.assertIn('已解除', page.session_state.text())
        self.assertTrue(page.blocked_sites['tieba'].isChecked())
        page.deleteLater()
        page.deleteLater()

    def test_challenge_poll_bypasses_busy_chat_and_never_appends_history(self):
        bridge = SimpleNamespace(_browser_ticket=None, _browser_dialog=None, _stopped=False, client=self.client)
        value = {'id': 'abc012345678', 'site': 'zhihu', 'method': 'sms'}
        CompanionBridge._browser_challenge(bridge, value)
        dialog = bridge._browser_dialog
        self.assertTrue(dialog.isVisible())
        CompanionBridge._browser_challenge(bridge, value)
        self.assertIs(dialog, bridge._browser_dialog)
        dialog.code.setText('12')
        dialog._submit()
        self.assertFalse(self.calls)
        dialog.code.setText('012345')
        dialog._submit()
        self.wait(lambda: not dialog.isVisible())
        self.assertEqual(self.calls, [('POST', '/browser/verify', {'id': value['id'], 'code': '012345'})])
        self.assertEqual(dialog.code.text(), '')
        CompanionBridge._browser_challenge(bridge, None)
        self.assertIsNone(bridge._browser_dialog)

    def test_site_session_status_is_separate_from_credentials_and_checked_after_window(self):
        page = LocalBrowserSettingsPage(client=self.client)
        self.wait(lambda: page.check_session_button.isEnabled())
        self.assertFalse(any(path == '/browser/session' for _, path, _ in self.calls))
        page.check_session_button.click()
        self.wait(lambda: not page._busy)
        self.assertIn(('POST', '/browser/session', {'site': 'xiaohongshu'}), self.calls)
        self.assertIn('登录状态未知', page.session_state.text())
        self.assertIn('拒绝', page.session_state.text())
        self.assertEqual(page.account_state.text(), '未填写')
        page.login.open_window()
        self.wait(lambda: page.login.timer.isActive())
        self.login = 'closed'
        self.login_result = {'session': {'ok': True, 'result': {'session_status': 'signed_in'}}}
        self.wait(lambda: '已登录' in page.session_state.text())
        page.site.setCurrentIndex(page.site.findData('zhihu'))
        self.assertIn('尚未检查', page.session_state.text())
        page.site.setCurrentIndex(page.site.findData('xiaohongshu'))
        self.assertIn('已登录', page.session_state.text())
        page.login._completed('poll', {'state': 'closed', 'operation_id': 'another-window', 'site': 'xiaohongshu',
                                       'session': {'ok': True, 'result': {'session_status': 'login_required'}}})
        self.assertIn('已登录', page.session_state.text(), 'another window cannot replace this observation')
        page.deleteLater()

    def test_local_background_stop_is_available_when_browsing_and_budget_blocked(self):
        self.saved['enabled'] = False
        self.background = {**self.background, 'reason': 'budget_blocked', 'task': {
            'taskId': 'fixture-background-task', 'status': 'paused', 'sites': ['xiaohongshu', 'zhihu'],
            'batches': 3, 'siteBlocks': [{'site': 'zhihu', 'kind': 'login_required'}],
        }}
        page = LocalBrowserSettingsPage(client=self.client)
        self.wait(lambda: page._baseline is not None and page.background_stop.isEnabled())
        self.assertFalse(page.login.isEnabled())
        self.assertIn('额度不足', page.background_state.text())
        self.assertIn('已完成 3 批', page.background_state.text())
        self.assertIn('知乎需要登录', page.background_state.text())
        page.background_stop.click()
        self.wait(lambda: '后台浏览已停止' in page.background_state.text())
        self.assertFalse(page.background_stop.isEnabled())
        self.assertIn(('POST', '/browser/background/stop', {'task_id': 'fixture-background-task'}), self.calls)
        self.assertFalse(any(route in ('/browser/login', '/browser/session') for _, route, _ in self.calls))
        page.deleteLater()

    def test_real_bridge_poll_can_verify_while_chat_is_hidden_busy_or_modal(self):
        class NoAudio(QObject):
            changed = Signal(str, bool)
            current = None
            def stop(self): pass
        hidden = QDialog()
        hidden.busy = True
        hidden._loading = False
        hidden.session_id = 'isolated-chat'
        hidden.audio = SimpleNamespace(current=None)
        shell = SimpleNamespace(app=self.app, _pc_chat=SimpleNamespace(window=hidden), instance=None)
        challenge = {'id': 'abcdef123456', 'site': 'hupu', 'method': 'email'}
        replies = []
        def transport(method, route, **kwargs):
            if route == '/companion/presence':
                self.assertTrue(kwargs['json']['busy'])
                self.assertFalse(kwargs['json']['chat_open'])
            if route == '/events':
                return {'events': [], 'browser_challenge': challenge}
            if route == '/browser/verify':
                replies.append(kwargs['json'])
            return {}
        with tempfile.TemporaryDirectory(dir=ROOT / 'temp') as directory:
            client = SimpleNamespace(root=Path(directory), request=transport)
            with patch('companion_bridge.AudioQueue', NoAudio):
                bridge = CompanionBridge(shell, client, auto_start=False)
            bridge._quiet = lambda: False
            modal = QDialog()
            modal.setModal(True)
            modal.show()
            try:
                bridge.poll()
                self.wait(lambda: bridge._browser_dialog is not None)
                dialog = bridge._browser_dialog
                self.assertTrue(dialog.isVisible() and dialog.code.isEnabled())
                self.assertIs(dialog.parentWidget(), modal)
                dialog.code.setText('000123')
                dialog.submit.click()
                self.wait(lambda: len(replies) == 1)
                self.assertEqual(replies[0], {'id': challenge['id'], 'code': '000123'})
                bridge.poll()
                self.wait(lambda: not bridge._inflight)
                self.assertIs(bridge._browser_dialog, dialog)
                self.assertIn('已提交', dialog.status.text())
                self.assertFalse(list(Path(directory).iterdir()), 'no cursor or chat content should be created')
                bridge._received({'events': [], 'browser_challenge': None})
                self.wait(lambda: bridge._browser_dialog is None)
                self.assertFalse(hidden.isVisible())
            finally:
                bridge.stop()
                modal.close()
                bridge.deleteLater()
        hidden.deleteLater()

    def test_manual_confirmation_remains_available_as_fallback(self):
        dialog = BrowserVerifyDialog({'id': 'a12345678901', 'site': 'xiaohongshu', 'method': 'manual'}, self.client)
        dialog.show()
        self.assertIsNone(dialog.code)
        dialog.login.open_window()
        self.wait(lambda: dialog.login.timer.isActive())
        self.assertEqual(self.calls, [('POST', '/browser/login', {'site': 'xiaohongshu', 'ticket_id': dialog.ticket})])
        self.login = 'closed'
        self.wait(lambda: dialog.login.button.isEnabled())
        dialog._submit()
        self.wait(lambda: not dialog.isVisible())
        self.assertEqual(self.calls[-1], ('POST', '/browser/verify', {'id': dialog.ticket, 'confirmed': True}))
        dialog.deleteLater()

    def test_expired_or_stopped_prompt_is_cleared_and_inert(self):
        bridge = SimpleNamespace(_browser_ticket=None, _browser_dialog=None, _stopped=False, client=self.client)
        current = {'id': 'ff0011223344', 'site': 'zhihu', 'method': 'sms', 'expiresAt': int(time.time()*1000) + 60}
        CompanionBridge._browser_challenge(bridge, current)
        dialog = bridge._browser_dialog
        dialog.code.setText('000999')
        self.wait(lambda: dialog._ended)
        self.assertIn('过期', dialog.status.text())
        self.assertFalse(dialog.code.text())
        self.assertFalse(dialog.buttons.isVisible())
        CompanionBridge._browser_challenge(bridge, current)
        self.assertIs(dialog, bridge._browser_dialog)
        CompanionBridge._browser_challenge(bridge, None)
        self.wait(lambda: bridge._browser_dialog is None)
        self.assertFalse(self.calls)


def screenshots():
    fixture = BrowserUI()
    fixture.setUpClass()
    app = fixture.app
    font = Path('C:/Windows/Fonts/msyh.ttc')
    if font.is_file():
        QFontDatabase.addApplicationFont(str(font))
        app.setFont(QFont('Microsoft YaHei', 10))
    out = ROOT / 'temp' / 'browser-auth-validation-20261106'
    out.mkdir(exist_ok=True)
    for width in (860, 430):
        fixture.setUp()
        window = QDialog()
        window.setObjectName('ModernSettingsDialog')
        window.setStyleSheet(_settings_stylesheet('light'))
        layout = QVBoxLayout(window)
        layout.setContentsMargins(24, 20, 24, 20)
        layout.addWidget(QLabel('浏览器', window))
        scroll = QScrollArea(window)
        scroll.setObjectName('settingsScroll')
        scroll.setWidgetResizable(True)
        page = LocalBrowserSettingsPage(client=fixture.client)
        scroll.setWidget(page)
        layout.addWidget(scroll)
        window.resize(width, 760)
        window.show()
        fixture.wait(lambda: page._baseline is not None)
        app.processEvents()
        assert scroll.horizontalScrollBar().maximum() == 0
        assert window.grab().save(str(out / f'settings-{width}.png'))
        window.close()
        window.deleteLater()
    for method in ('manual', 'sms'):
        dialog = BrowserVerifyDialog({'id': 'aa0011223344', 'site': 'xiaohongshu', 'method': method}, fixture.client)
        dialog.show()
        app.processEvents()
        assert dialog.grab().save(str(out / f'verify-{method}.png'))
        dialog.dismiss()
        dialog.deleteLater()


if __name__ == '__main__':
    if '--screenshots' in sys.argv:
        screenshots()
    else:
        unittest.main()
