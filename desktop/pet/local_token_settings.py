"""Token limits and usage from the local backend's existing budget ledger."""
from PySide6.QtCore import Qt
from PySide6.QtWidgets import QLabel, QMessageBox, QPushButton, QSlider, QVBoxLayout, QWidget

from .local_model_settings import _Jobs
from .settings_widgets import BrowserSpinBox, SettingRow, SettingsSection


MAX_TOKENS = 10_000_000
SLIDER_STEP = 10_000
ROUTE = '/usage/budget/settings'


class TokenLimitControl(QWidget):
    def __init__(self, label, parent=None):
        super().__init__(parent)
        self.slider = QSlider(Qt.Orientation.Horizontal, self)
        self.slider.setRange(0, MAX_TOKENS // SLIDER_STEP)
        self.slider.setAccessibleName(label + '滑条')
        self.value = BrowserSpinBox(self)
        self.value.setRange(0, MAX_TOKENS)
        self.value.setSpecialValueText('不限')
        self.value.setGroupSeparatorShown(True)
        self.value.setAccessibleName(label + ' Token')
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(self.slider)
        layout.addWidget(self.value)
        self.slider.valueChanged.connect(lambda n: self.value.setValue(n * SLIDER_STEP))
        self.value.valueChanged.connect(self._sync_slider)

    def _sync_slider(self, value):
        previous = self.slider.blockSignals(True)
        self.slider.setValue(max(1, (value + SLIDER_STEP // 2) // SLIDER_STEP) if value else 0)
        self.slider.blockSignals(previous)


class LocalTokenSettingsPage(QWidget):
    def __init__(self, parent=None, *, client):
        super().__init__(parent)
        self.client = client
        self._baseline = None
        self._revision = None
        self._busy = False
        self._after_save = None
        self.jobs = _Jobs(self)
        self.jobs.completed.connect(self._completed)
        self.jobs.failed.connect(self._failed)
        self.controls = {key: TokenLimitControl(label, self) for key, label in
                         [('per_task', '单次任务'), ('daily', '每天用量')]}
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(18)
        layout.addWidget(SettingsSection('Token 硬限额', [
            SettingRow('token_per_task', '单次任务', '同一个任务里的多次模型请求共用此额度。',
                       self.controls['per_task'], stacked=True),
            SettingRow('token_daily', '每天用量', '当前模型连接每天的总上限，按北京时间零点重计。',
                       self.controls['daily'], stacked=True),
        ], self))
        self.usage = QLabel('正在读取用量…', self)
        self.status = QLabel('', self)
        for label in (self.usage, self.status):
            label.setWordWrap(True)
            label.setObjectName('settingHint')
            layout.addWidget(label)
        self.save_button = QPushButton('保存 Token 限额', self)
        self.refresh_button = QPushButton('刷新用量与限额', self)
        for button in (self.save_button, self.refresh_button):
            button.setAutoDefault(False)
            layout.addWidget(button)
        layout.addStretch(1)
        for control in self.controls.values():
            control.value.valueChanged.connect(self._update)
        self.save_button.clicked.connect(self.save)
        self.refresh_button.clicked.connect(self.reload)
        self._update()

    def showEvent(self, event):
        super().showEvent(event)
        if not self.dirty:
            self.reload()

    def _snapshot(self):
        return {key: control.value.value() or None for key, control in self.controls.items()}

    @property
    def dirty(self):
        return self._baseline is not None and self._snapshot() != self._baseline

    def _update(self, *_):
        for control in self.controls.values():
            control.setEnabled(self._baseline is not None and not self._busy)
        self.save_button.setEnabled(self.dirty and not self._busy)
        self.refresh_button.setEnabled(not self._busy)

    def _start(self, name, operation):
        if self._busy:
            return False
        self._busy = True
        self._update()
        self.jobs.run(name, operation)
        return True

    def reload(self):
        if not self.dirty or self._confirm_discard():
            self._start('load', lambda: self.client.request('GET', ROUTE))

    def save(self):
        if not self.dirty:
            return False
        changes = {key: value for key, value in self._snapshot().items() if value != self._baseline[key]}
        payload = {'revision': self._revision, **changes}
        return self._start('save', lambda: self.client.request('PUT', ROUTE, json=payload))

    def save_and_then(self, callback):
        self._after_save = callback if self.save() else None

    @staticmethod
    def _usage_line(label, usage, budget, limit):
        if usage is None:
            return f'{label}：暂无用量'
        qualifier = '至少 ' if usage.get('unknown') or usage.get('pending') else ''
        text = f"{label}：已用 {qualifier}{usage['tokens']:,} Token"
        text += f' / {limit:,}' if limit is not None else ' · 不限'
        if budget.get('reserved_tokens'):
            text += f" · 预留 {budget['reserved_tokens']:,}"
        if budget.get('remaining_tokens') is not None and not usage.get('unknown'):
            text += f" · 剩余 {budget['remaining_tokens']:,}"
        if usage.get('unknown'):
            text += f" · {usage['unknown']} 次未返回用量"
        return text

    def _completed(self, name, result):
        self._busy = False
        self._revision = result['revision']
        budget = result['budget']
        policies = budget['policies']
        limits = {key: (policies[key] or {}).get('tokens') for key in self.controls}
        for key, control in self.controls.items():
            control.value.setValue(min(limits[key] or 0, MAX_TOKENS))
        self._baseline = self._snapshot()
        task_limits = [value for value in (limits['per_task'], (policies['current_task'] or {}).get('tokens'))
                       if value is not None]
        lines = [self._usage_line('今天', result['today'], budget['daily'], limits['daily']),
                 self._usage_line('最近一次任务', result['latest_task'], budget['task'],
                                  min(task_limits) if task_limits else None)]
        self.usage.setText('\n'.join(lines))
        status = '已保存。' if name == 'save' else '可拖动或输入，最大 1000 万 Token。'
        if any(limit and limit > MAX_TOKENS for limit in limits.values()):
            status += ' 以前通过聊天设置的较高限额仍有效，以上用量行显示实际限额。'
        if not result['supported']:
            status += ' 当前连接可查看用量，设置硬限额需要支持精确预先计数的 OpenAI 官方连接。'
        elif budget.get('unresolved_calls'):
            status += ' 有请求用量无法核实，已启用的限额会阻止后续请求。'
        self.status.setText(status)
        self._update()
        callback, self._after_save = self._after_save, None
        if callback:
            callback()

    def _failed(self, name, _code):
        self._busy = False
        self._after_save = None
        self.status.setText('读取失败，请检查本地后台。' if name == 'load' else
                            '保存失败。请等当前请求结束，或刷新确认当前连接和限额后重试。')
        self._update()

    def _confirm_discard(self):
        return QMessageBox.question(self, 'Token 限额尚未保存', '要放弃这些未保存的修改吗？',
            QMessageBox.StandardButton.Discard | QMessageBox.StandardButton.Cancel,
            QMessageBox.StandardButton.Cancel) == QMessageBox.StandardButton.Discard

    def can_close(self, *, commit_discard=True):
        if self._busy:
            return False
        if self.dirty:
            if not self._confirm_discard():
                return False
            if commit_discard:
                self._baseline = self._snapshot()
        return True
