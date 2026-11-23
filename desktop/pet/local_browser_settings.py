"""Browser preferences, private credentials and verification in the local PC UI."""
from datetime import datetime
import time

from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtWidgets import (QCheckBox, QDialog, QDialogButtonBox, QFormLayout,
                               QHBoxLayout, QLabel, QLineEdit, QMessageBox, QPushButton,
                               QVBoxLayout, QWidget)

from .local_model_settings import _Jobs
from .settings_widgets import (BrowserSpinBox, ModernSelect, SettingRow, SettingsSection,
                               SettingsTabContainer, ToggleSwitch)

SITES = {'xiaohongshu': '小红书', 'tieba': '百度贴吧', 'hupu': '虎扑', 'zhihu': '知乎', 'weibo': '微博'}
DEFAULT_BACKGROUND_INTERVAL_MINUTES = 5
BACKGROUND_REASONS = {
    'no_task': '暂无后台浏览任务。',
    'stopped': '后台浏览已停止。',
    'budget_blocked': '已暂停，模型额度不足或预算暂不可用。',
    'connection_changed': '已暂停，模型连接已更改。',
    'browser_disabled': '浏览已关闭，任务暂缓。',
    'not_configured': '等待配置模型连接。',
    'foreground_busy': '等待当前聊天或浏览操作结束。',
    'sites_blocked': '等待站点恢复。',
    'site_blacklisted': '已暂停，任务包含禁止自主访问的网站。',
    'scheduled': '等待下次浏览。',
    'reading': '正在后台浏览。',
    'ready': '等待执行。',
    'not_running': '后台浏览当前未运行。',
}


def _background_message(response):
    task = response.get('task')
    reason = response.get('reason')
    message = BACKGROUND_REASONS.get(reason, '后台浏览状态未知。')
    if not isinstance(task, dict):
        return message
    sites = '、'.join(SITES[site] for site in task.get('sites', []) if site in SITES)
    batches = task.get('batches')
    details = [sites] if sites else []
    if isinstance(batches, int) and batches >= 0:
        details.append(f'已完成 {batches} 批')
    if details:
        message += '\n' + ' · '.join(details)
    blocked = []
    for entry in task.get('siteBlocks', []):
        site = SITES.get(entry.get('site'))
        kind = {'login_required': '需要登录', 'verification_required': '需要验证',
                'rate_limited': '暂时限流'}.get(entry.get('kind'))
        if site and kind:
            blocked.append(site + kind)
    if blocked:
        message += '\n' + '、'.join(blocked)
    next_at = response.get('nextEligibleAt')
    if reason in ('scheduled', 'sites_blocked') and isinstance(next_at, (int, float)) and next_at > 0:
        try:
            message += '\n最早可运行 ' + datetime.fromtimestamp(next_at / 1000).strftime('%m-%d %H:%M')
        except (ValueError, OverflowError, OSError):
            pass
    return message


def _session_message(response):
    if not response.get('ok'):
        code = response.get('error', {}).get('code')
        if code in ('browser_profile_busy', 'browser_login_busy'):
            return '专属浏览器正在使用，稍后可再检查。'
        return '这次未能检查，登录状态未知。'
    result = response.get('result', {})
    if result.get('evidence') == 'visitor_page':
        return '这次打开的是微博访客页，登录状态未确认。'
    message = {'signed_in': '已登录', 'login_required': '站点要求登录',
               'verification_required': '站点要求人工验证'}.get(result.get('session_status'), '登录状态未知')
    access = {'access_denied': '站点拒绝了本次访问', 'rate_limited': '站点暂时限流，稍后再查'}.get(result.get('access_status'))
    return message + ('；' + access if access else '') + '。'


class LoginWindowControl(QWidget):
    finished = Signal(str, dict)

    def __init__(self, client, get_site, parent=None, *, ticket=None):
        super().__init__(parent)
        self.client = client
        self.get_site = get_site
        self.ticket = ticket
        self.operation_id = None
        self.jobs = _Jobs(self)
        self.jobs.completed.connect(self._completed)
        self.jobs.failed.connect(self._failed)
        self.button = QPushButton('打开专属登录窗口', self)
        self.button.clicked.connect(self.open_window)
        self.status = QLabel(self)
        self.status.setWordWrap(True)
        self.status.hide()
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(self.button)
        layout.addWidget(self.status)
        self.timer = QTimer(self)
        self.timer.setSingleShot(True)
        self.timer.timeout.connect(lambda: self.jobs.run('poll', lambda: self.client.request('GET', '/browser/login')))

    def open_window(self):
        body = {'site': self.get_site()}
        if self.ticket:
            body['ticket_id'] = self.ticket
        self.button.setEnabled(False)
        self.status.show()
        self.status.setText('正在打开 Chrome…')
        self.jobs.run('open', lambda: self.client.request('POST', '/browser/login', json=body))

    def _completed(self, name, result):
        if name == 'open':
            self.operation_id = result.get('operation_id')
        elif not self.operation_id or result.get('operation_id') != self.operation_id:
            self.button.setEnabled(True)
            self.status.setText('这次窗口的结果已更新，请重新检查站点登录状态。')
            return
        if name == 'open' or result.get('state') == 'opening':
            self.status.setText('请在专属 Chrome 中完成验证，然后关闭该窗口。')
            self.timer.start(1500)
        elif result.get('state') == 'checking':
            self.status.setText('专属窗口已关闭，正在核对登录状态…')
            self.timer.start(1500)
        else:
            self.button.setEnabled(True)
            if result.get('state') == 'closed':
                session = result.get('session')
                if isinstance(session, dict):
                    self.status.setText('专属窗口已关闭。')
                    self.finished.emit(result.get('site', ''), session)
                elif result.get('resumed'):
                    self.status.setText('专属窗口已关闭，正在重试刚才的网页。')
                else:
                    self.status.setText('专属窗口已关闭，登录状态未确认。')
            else:
                message = {'browser_rate_limited': '站点暂时限流，稍后再打开登录窗口。',
                           'browser_profile_busy': '专属浏览器正在使用，稍后再试。'}.get(result.get('code'))
                self.status.setText(message or '登录窗口未完成，请检查本机 Chrome 后重试。')

    def _failed(self, *_):
        self.button.setEnabled(True)
        self.status.setText('未能打开或查询窗口。请先结束其他浏览任务，再重试。')


class BrowserVerifyDialog(QDialog):
    """Runs independently of the chat input, including while that chat awaits a code."""
    def __init__(self, challenge, client, parent=None):
        super().__init__(parent)
        self.client = client
        self.ticket = challenge['id']
        self.site = challenge['site']
        self.manual = challenge['method'] == 'manual'
        self._working = False
        self._ended = False
        self.setWindowTitle(SITES[self.site] + '登录验证')
        self.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint, True)
        self.setAttribute(Qt.WidgetAttribute.WA_QuitOnClose, False)
        self.setMinimumWidth(330)
        layout = QVBoxLayout(self)
        self.code = None
        if self.manual:
            self.login = LoginWindowControl(client, lambda: self.site, self, ticket=self.ticket)
            hint = '请在专属 Chrome 中完成' + SITES[self.site] + '验证。关窗后会重试刚才的网页。'
        else:
            medium = '短信' if challenge['method'] == 'sms' else '邮箱'
            hint = '登录' + SITES[self.site] + '需要' + medium + '验证码。请输入大肥鱼账号收到的码，只用于这次登录。'
        self.status = QLabel(hint, self)
        self.status.setWordWrap(True)
        layout.addWidget(self.status)
        if self.manual:
            layout.addWidget(self.login)
        if not self.manual:
            self.code = QLineEdit(self)
            self.code.setEchoMode(QLineEdit.EchoMode.Password)
            self.code.setMaxLength(10)
            self.code.setAccessibleName('登录验证码')
            layout.addWidget(self.code)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel, self)
        self.buttons = buttons
        self.submit = buttons.button(QDialogButtonBox.StandardButton.Ok)
        self.submit.setText('已完成，继续' if self.manual else '提交验证码')
        buttons.button(QDialogButtonBox.StandardButton.Cancel).setText('取消本次验证')
        buttons.accepted.connect(self._submit)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)
        self.jobs = _Jobs(self)
        self.jobs.completed.connect(lambda name, _: self.end_notice(
            '已取消本次站点验证。' if name == 'cancel' else '已提交，正在继续原来的浏览。'))
        self.jobs.failed.connect(self._failed)
        self.expiry = QTimer(self)
        self.expiry.setSingleShot(True)
        self.expiry.timeout.connect(lambda: self.end_notice('本次站点验证已过期，请重新发起浏览。'))
        expires_at = challenge.get('expiresAt')
        if isinstance(expires_at, (int, float)):
            self.expiry.start(max(0, min(86400000, int(expires_at - time.time() * 1000))))

    def _submit(self):
        if self._working:
            return
        data = {'id': self.ticket}
        if self.manual:
            data['confirmed'] = True
        else:
            code = self.code.text().strip()
            if not (4 <= len(code) <= 10 and code.isascii() and code.isalnum()):
                self.status.setText('请填写 4 至 10 位字母或数字验证码。')
                return
            self.code.clear()
            data['code'] = code
        self._working = True
        self.submit.setEnabled(False)
        self.jobs.run('submit', lambda: self.client.request('POST', '/browser/verify', json=data))

    def reject(self):
        if self._ended:
            self.dismiss()
            return
        if self._working:
            return
        self._working = True
        self.submit.setEnabled(False)
        self.jobs.run('cancel', lambda: self.client.request('POST', '/browser/verify/cancel', json={'id': self.ticket}))

    def _failed(self, *_):
        if self._ended:
            return
        self._working = False
        self.submit.setEnabled(True)
        self.status.setText('操作未完成。若登录窗口仍在，请先关窗；若任务尚有效，可再试一次。')

    def end_notice(self, text='本次验证已结束，可能已在另一端处理或停止。'):
        if self._ended:
            return
        self._ended = True
        self.expiry.stop()
        if self.code:
            self.code.clear()
            self.code.hide()
        if self.manual:
            self.login.hide()
        self.buttons.hide()
        self.status.setText(text)
        QTimer.singleShot(1600, self, self.dismiss)

    def dismiss(self):
        if self.code:
            self.code.clear()
        QDialog.accept(self)


class LocalBrowserSettingsPage(QWidget):
    def __init__(self, parent=None, *, client, auto_load=True):
        super().__init__(parent)
        self.client = client
        self._baseline = None
        self._busy = False
        self._after_save = None
        self.accounts = {}
        self._sessions = {}
        self._background = {}
        self._background_pending = False
        self.jobs = _Jobs(self)
        self.jobs.completed.connect(self._completed)
        self.jobs.failed.connect(self._failed)
        self.background_jobs = _Jobs(self)
        self.background_jobs.completed.connect(self._background_completed)
        self.background_jobs.failed.connect(self._background_failed)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        self.enabled = ToggleSwitch(self)
        self.proactive = ToggleSwitch(self)
        self.background_interval = BrowserSpinBox(self)
        self.background_interval.setFixedWidth(140)
        self.background_interval.setRange(1, 120)
        self.background_interval.setSuffix(' 分钟')
        self.background_interval.setValue(DEFAULT_BACKGROUND_INTERVAL_MINUTES)
        self.site = ModernSelect(self)
        for key, name in SITES.items():
            self.site.addItem(name, key)
        self.account_state = QLabel(self)
        self.edit = QPushButton('填写账号和密码', self)
        self.clear = QPushButton('移除凭据', self)
        self.disconnect = QPushButton('解除本机连接', self)
        account = QWidget(self)
        box = QHBoxLayout(account)
        box.setContentsMargins(0, 0, 0, 0)
        box.addWidget(self.account_state, 1)
        box.addWidget(self.edit)
        box.addWidget(self.clear)
        session = QWidget(self)
        session_layout = QVBoxLayout(session)
        session_layout.setContentsMargins(0, 0, 0, 0)
        self.session_state = QLabel(session)
        self.session_state.setWordWrap(True)
        self.check_session_button = QPushButton('检查登录状态', session)
        self.check_session_button.clicked.connect(self.check_session)
        session_layout.addWidget(self.check_session_button)
        session_layout.addWidget(self.session_state)
        self.login = LoginWindowControl(client, self.site.currentData, self)
        self.login.finished.connect(self._show_session)
        self.blocked_sites = {site: ToggleSwitch(self) for site in SITES}
        background = QWidget(self)
        background_layout = QVBoxLayout(background)
        background_layout.setContentsMargins(0, 0, 0, 0)
        self.background_state = QLabel('尚未读取后台浏览任务。', background)
        self.background_state.setWordWrap(True)
        self.background_refresh = QPushButton('刷新任务状态', background)
        self.background_refresh.clicked.connect(self.refresh_background)
        self.background_stop = QPushButton('停止后台浏览', background)
        self.background_stop.clicked.connect(self.stop_background)
        self.background_stop.setEnabled(False)
        background_actions = QHBoxLayout()
        background_actions.addWidget(self.background_refresh)
        background_actions.addWidget(self.background_stop)
        background_layout.addWidget(self.background_state)
        background_layout.addLayout(background_actions)
        tabs = SettingsTabContainer(self)
        preferences = QWidget(tabs)
        preferences_layout = QVBoxLayout(preferences)
        preferences_layout.setContentsMargins(0, 0, 0, 0)
        preferences_layout.addWidget(SettingsSection('图文浏览', [
            SettingRow('browser_enabled', '允许浏览网页', '在对话中进行全网搜索、阅读公开网页或使用社区浏览工具。', self.enabled),
            SettingRow('browser_proactive', '允许主动浏览', '主动搭话时可以自己逛网页。主动搭话和记忆都开启时，也可每天自行安排一次浏览。', self.proactive),
            SettingRow('browser_background_interval', '后台浏览间隔', '每批后台浏览之间的间隔。', self.background_interval, stacked=True),
            SettingRow('browser_background', '后台浏览任务', '在聊天里交代持续逛小红书或知乎。', background, stacked=True),
        ], preferences))
        preferences_layout.addWidget(SettingsSection('自主访问黑名单', [
            SettingRow('browser_block_' + site, SITES[site], '打开后禁止自主访问。你在聊天中明确要求查看时仍可访问。', toggle)
            for site, toggle in self.blocked_sites.items()
        ], preferences))
        preferences_layout.addStretch(1)
        tabs.addTab('preferences', '浏览与权限', preferences)
        accounts_page = QWidget(tabs)
        accounts_layout = QVBoxLayout(accounts_page)
        accounts_layout.setContentsMargins(0, 0, 0, 0)
        self.credential_row = SettingRow('browser_account', '保存的凭据', '默认只在本次后台运行时使用。', account, stacked=True)
        self.account_hint = QLabel(accounts_page)
        self.account_hint.setWordWrap(True)
        accounts_layout.addWidget(SettingsSection('第三方账号', [
            SettingRow('browser_site', '站点', '', self.site),
            SettingRow('browser_session', '登录状态', '', session, stacked=True),
            SettingRow('browser_account_access', '可用范围', '', self.account_hint, stacked=True),
            self.credential_row,
            SettingRow('browser_login', '手动登录或验证', '在大肥鱼的专属窗口登录。完成后关闭窗口即可。', self.login, stacked=True),
            SettingRow('browser_disconnect', '解除连接', '清除该站在大肥鱼浏览器中的登录状态和保存的凭据。', self.disconnect, stacked=True),
        ], accounts_page))
        accounts_layout.addStretch(1)
        tabs.addTab('accounts', '第三方账号', accounts_page)
        layout.addWidget(tabs)
        self.status = QLabel(self)
        self.status.setWordWrap(True)
        layout.addWidget(self.status)
        self.save_button = QPushButton('保存浏览设置', self)
        self.save_button.clicked.connect(self.save)
        self.reload_button = QPushButton('重新读取', self)
        self.reload_button.clicked.connect(self.reload)
        actions = QHBoxLayout()
        actions.addWidget(self.save_button)
        actions.addWidget(self.reload_button)
        actions.addStretch(1)
        layout.addLayout(actions)
        layout.addStretch(1)
        self.enabled.toggled.connect(self._update)
        self.proactive.toggled.connect(self._update)
        self.background_interval.valueChanged.connect(self._update)
        self.site.currentIndexChanged.connect(self._update)
        for toggle in self.blocked_sites.values():
            toggle.toggled.connect(self._update)
        self.edit.clicked.connect(self.edit_account)
        self.clear.clicked.connect(self.clear_account)
        self.disconnect.clicked.connect(self.disconnect_account)
        self._update()
        if auto_load:
            QTimer.singleShot(0, self.reload)

    def _snapshot(self):
        return {'enabled': self.enabled.isChecked(), 'proactive': self.proactive.isChecked(),
                'backgroundIntervalMinutes': self.background_interval.value(),
                'autonomousBlockedSites': [site for site, toggle in self.blocked_sites.items() if toggle.isChecked()]}

    @property
    def dirty(self):
        return self._baseline is not None and self._snapshot() != self._baseline

    def _update(self, *_):
        ready = self._baseline is not None and not self._busy
        site = self.site.currentData()
        saved = site in self.accounts.get('sites', [])
        self.account_state.setText('已记住' if site in self.accounts.get('remembered', [])
                                   else '本次可用' if saved else '未填写')
        self.enabled.setEnabled(ready)
        self.proactive.setEnabled(ready and self.enabled.isChecked())
        self.background_interval.setEnabled(ready)
        for toggle in self.blocked_sites.values():
            toggle.setEnabled(ready)
        self.site.setEnabled(ready)
        self.credential_row.setVisible(site != 'weibo')
        self.account_hint.setText('微博通过专属窗口手动登录。可在聊天里明确请求读取热搜榜。'
                                  if site == 'weibo' else '用于该站的图文浏览。')
        self.edit.setEnabled(ready)
        self.clear.setEnabled(ready and saved)
        self.disconnect.setEnabled(ready)
        self.login.setEnabled(ready and self._baseline.get('enabled', False))
        self.check_session_button.setEnabled(ready and self._baseline.get('enabled', False))
        self.session_state.setText(self._sessions.get(site, '尚未检查此站点。'))
        self.save_button.setEnabled(ready and self.dirty)
        self.reload_button.setEnabled(not self._busy)

    def _run(self, name, operation):
        if self._busy:
            return
        self._busy = True
        self._update()
        self.jobs.run(name, operation)

    def reload(self):
        if self.dirty and not self._discard():
            return
        self._run('load', lambda: (self.client.settings()['browser'], self.client.request('GET', '/browser/accounts')))
        self.refresh_background()

    def _stoppable_background_id(self):
        task = self._background.get('task')
        if isinstance(task, dict) and task.get('status') in ('active', 'paused'):
            return task.get('taskId')
        return None

    def _run_background(self, name, operation):
        if self._background_pending:
            return
        self._background_pending = True
        self.background_refresh.setEnabled(False)
        self.background_stop.setEnabled(False)
        self.background_jobs.run(name, operation)

    def refresh_background(self):
        self._run_background('status', lambda: self.client.request('GET', '/browser/background'))

    def stop_background(self):
        task_id = self._stoppable_background_id()
        if task_id:
            self._run_background('stop', lambda: self.client.request('POST', '/browser/background/stop',
                                                                      json={'task_id': task_id}))

    def _background_completed(self, _, result):
        self._background_pending = False
        self._background = result if isinstance(result, dict) else {}
        self.background_state.setText(_background_message(self._background))
        self.background_refresh.setEnabled(True)
        self.background_stop.setEnabled(bool(self._stoppable_background_id()))

    def _background_failed(self, name, *_):
        self._background_pending = False
        self.background_state.setText('停止结果未确认，请刷新任务状态。' if name == 'stop' else '未能读取任务状态。')
        self.background_refresh.setEnabled(True)
        self.background_stop.setEnabled(bool(self._stoppable_background_id()))

    def check_session(self):
        if self._busy:
            return
        site = self.site.currentData()
        self._run('session', lambda: (site, self.client.request('POST', '/browser/session', json={'site': site})))
        self.session_state.setText('正在检查此站点…')

    def _show_session(self, site, response):
        if site in SITES:
            checked_at = response.get('result', {}).get('checked_at')
            when = ''
            if isinstance(checked_at, str):
                try:
                    when = ' ' + datetime.fromisoformat(checked_at).astimezone().strftime('%m-%d %H:%M')
                except ValueError:
                    pass
            self._sessions[site] = '最近检查' + when + '：' + _session_message(response)
            if site == self.site.currentData():
                self.session_state.setText(self._sessions[site])

    def save(self):
        if self.dirty:
            changes = {key: value for key, value in self._snapshot().items() if value != self._baseline[key]}
            self._run('save', lambda: self.client.save_settings({'browser': changes})['browser'])

    def save_and_then(self, callback):
        self._after_save = callback
        self.save()

    def _discard(self):
        answer = QMessageBox.question(self, '浏览设置尚未保存', '放弃这些修改吗？',
            QMessageBox.StandardButton.Discard | QMessageBox.StandardButton.Cancel, QMessageBox.StandardButton.Cancel)
        return answer == QMessageBox.StandardButton.Discard

    def can_close(self, *, commit_discard=True):
        if self._busy or (self.dirty and not self._discard()):
            return False
        if self.dirty and commit_discard:
            self._baseline = self._snapshot()
        return True

    def edit_account(self):
        site = self.site.currentData()
        dialog = QDialog(self)
        dialog.setWindowTitle(SITES[site] + '账号')
        form = QFormLayout(dialog)
        user = QLineEdit(dialog)
        user.setMaxLength(256)
        password = QLineEdit(dialog)
        password.setMaxLength(512)
        password.setEchoMode(QLineEdit.EchoMode.Password)
        password.setPlaceholderText('仅使用验证码登录时可留空')
        remember = QCheckBox('在这台电脑上加密记住账号', dialog)
        remember.setEnabled(bool(self.accounts.get('canRemember')))
        form.addRow('账号或手机号', user)
        form.addRow('密码', password)
        form.addRow(remember)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Save | QDialogButtonBox.StandardButton.Cancel, dialog)
        save = buttons.button(QDialogButtonBox.StandardButton.Save)
        save.setText('保存')
        buttons.button(QDialogButtonBox.StandardButton.Cancel).setText('取消')
        save.setEnabled(False)
        def validate():
            save.setEnabled(bool(user.text().strip()))
        user.textChanged.connect(validate)
        password.textChanged.connect(validate)
        buttons.accepted.connect(dialog.accept)
        buttons.rejected.connect(dialog.reject)
        form.addRow(buttons)
        if dialog.exec() == QDialog.DialogCode.Accepted:
            self._set_account(site, user.text().strip(), password.text(), remember.isChecked())
        password.clear()
        user.clear()
        dialog.deleteLater()

    def clear_account(self):
        self._set_account(self.site.currentData(), '', '', False)

    def disconnect_account(self):
        site = self.site.currentData()
        answer = QMessageBox.question(self, '解除本机连接',
            f'清除大肥鱼在{SITES[site]}的本机登录状态和已保存凭据？',
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.Cancel, QMessageBox.StandardButton.Cancel)
        if answer == QMessageBox.StandardButton.Yes:
            self._run('disconnect', lambda: self.client.request('POST', '/browser/accounts/disconnect', json={'site': site}))

    def _set_account(self, site, user, password, remember):
        values = {'site': site, 'username': user, 'password': password, 'remember': remember}
        self._run('account', lambda: self.client.request('PUT', '/browser/accounts', json=values))

    def _completed(self, name, result):
        self._busy = False
        if name == 'session':
            self._show_session(*result)
            self._update()
            return
        if name in ('load', 'save'):
            if name == 'load':
                result, self.accounts = result
            self.enabled.setChecked(result['enabled'])
            self.proactive.setChecked(result['proactive'])
            self.background_interval.setValue(result.get('backgroundIntervalMinutes', DEFAULT_BACKGROUND_INTERVAL_MINUTES))
            blocked = result.get('autonomousBlockedSites', [])
            for site, toggle in self.blocked_sites.items():
                toggle.setChecked(site in blocked)
            self._baseline = self._snapshot()
        elif name == 'disconnect':
            self.accounts = result['accounts']
            self._sessions[result['site']] = '本机连接已解除。'
        else:
            self.accounts = result
        self.status.setText({'load': '已读取当前设置。', 'save': '浏览设置已保存。', 'account': '账号凭据已更新。',
                             'disconnect': '该站本机登录状态和凭据已清除。'}[name])
        self._update()
        if name == 'save':
            self.refresh_background()
        if name == 'save' and self._after_save:
            callback, self._after_save = self._after_save, None
            callback()

    def _failed(self, name, *_):
        self._busy = False
        self._after_save = None
        if name == 'session':
            self._show_session(self.site.currentData(), {})
            self._update()
            return
        self.status.setText('操作未完成。请检查本地后台和当前浏览任务后重试。')
        self._update()
