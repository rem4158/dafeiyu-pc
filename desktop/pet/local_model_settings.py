"""Local brain model settings embedded in the existing pet settings window."""
from __future__ import annotations

import os
from pathlib import Path
import sys
import threading

from PySide6.QtCore import QObject, Qt, QTimer, QUrl, Signal
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import (QDialog, QHBoxLayout, QLabel, QLineEdit, QMessageBox,
                               QPushButton, QVBoxLayout, QWidget)

from .settings_widgets import ModernSelect, SettingRow, SettingsDisclosureHeader, SettingsSection


MODEL_TEST_FAILURE_MESSAGES = {
    'not_configured': '请先保存完整的模型 API 地址、密钥和模型名称，再进行测试。',
    'busy': '当前有回复或连接测试正在进行，请稍后重试。',
    'model_test_auth': '模型服务拒绝了 API 密钥，请检查密钥是否有效。',
    'model_test_access': '模型访问受限，请检查模型权限及服务支持的地区。',
    'model_test_quota': '模型服务额度不足，请检查账户余额或用量限制。',
    'model_test_rate_limit': '模型服务请求过于频繁，请稍后重试。',
    'model_test_parameters': '模型请求不兼容，请检查 API 地址、模型名称或参数适配。',
    'model_test_network': '无法连接模型服务，请检查网络和代理后重试。',
    'model_test_empty': '模型服务未返回回复正文，请检查模型和参数适配。',
    'model_test_timeout': '连接测试超时，请检查网络和代理后重试。',
    'model_test_failed': '连接测试失败，请检查地址、模型、密钥、额度和网络后重试。',
    'invalid_settings': '请检查服务地址、模型名称和代理设置。',
}


def local_client():
    root = Path(os.environ['DAFEIYU_PC_ROOT'])
    bridge = str(root / 'desktop_bridge')
    if bridge not in sys.path:
        sys.path.insert(0, bridge)
    from nianan_client import NiananClient
    return NiananClient(root)


class _Jobs(QObject):
    completed = Signal(str, object)
    failed = Signal(str, str)

    def __init__(self, parent=None, *, error_codes=MODEL_TEST_FAILURE_MESSAGES):
        super().__init__(parent)
        self.error_codes = error_codes

    def run(self, name, operation):
        def work():
            try:
                result = operation()
                self.completed.emit(name, result)
            except Exception as error:
                # Provider/client error bodies can contain credentials and URLs.
                code = getattr(error, 'code', '')
                code = code if isinstance(code, str) and code in self.error_codes else ''
                try:
                    self.failed.emit(name, code)
                except RuntimeError:
                    pass
        threading.Thread(target=work, daemon=True, name='ModelSettings-' + name).start()


class LocalModelSettingsPage(QWidget):
    """Edit saved model configuration without touching persona or pet settings."""
    def __init__(self, parent=None, *, client=None, auto_load=True):
        super().__init__(parent)
        self.client = client or local_client()
        self._loaded = False
        self._busy = False
        self._baseline = None
        self._saved = {}
        self._presets = {}
        self._connection_drafts = {}
        self._selected = None
        self._after_save = None
        self.jobs = _Jobs(self)
        self.jobs.completed.connect(self._completed)
        self.jobs.failed.connect(self._failed)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(18)
        self.provider = ModernSelect(self, width=240)
        self.provider.setAccessibleName('模型服务商')
        self.provider.addItem('自定义（OpenAI 兼容）', 'cloud')
        self.provider.addItem('本机 Ollama', 'ollama')
        layout.addWidget(SettingsSection('聊天模型', [SettingRow(
            'local_model_provider', '模型服务商', '',
            self.provider, stacked=True)], self))

        self.url = self._field('API 地址', 'https://api.example.com/v1')
        self.key = self._field('API 密钥', '输入 API Key')
        self.key.setEchoMode(QLineEdit.EchoMode.Password)
        key_host = QWidget(self)
        key_layout = QHBoxLayout(key_host)
        key_layout.setContentsMargins(0, 0, 0, 0)
        key_layout.addWidget(self.key, 1)
        self.reveal = QPushButton('显示', key_host)
        self.reveal.setAutoDefault(False)
        self.reveal.setCheckable(True)
        self.reveal.setAccessibleName('显示或隐藏新输入的 API 密钥')
        self.reveal.toggled.connect(self._reveal_key)
        key_layout.addWidget(self.reveal)
        self.model = self._field('模型名称', '填写服务商提供的模型名称')
        self.key_link = QPushButton('去官方平台获取 Key', self)
        self.key_link.setAutoDefault(False)
        self.key_link.clicked.connect(self._open_key_page)
        self.url_row = SettingRow('local_model_url', 'API 地址', '填写服务商提供的兼容 API 基础地址。', self.url, stacked=True)
        self.model_row = SettingRow('local_model_name', '模型名称', '填写服务商提供的模型名称。', self.model, stacked=True)
        self.preset_model = QLabel(self)
        self.preset_model.setObjectName('settingHint')
        self.preset_model.setWordWrap(True)
        self.advanced = SettingsDisclosureHeader('高级设置', self)
        self.advanced.setAutoDefault(False)
        self.advanced.toggled.connect(self._update)
        self.cloud_section = SettingsSection('云端 API', [
            self.url_row,
            SettingRow('local_model_key', 'API 密钥', '', key_host, stacked=True),
            self.model_row,
        ], self)
        layout.addWidget(self.cloud_section)
        preset_details = QVBoxLayout()
        preset_details.setSpacing(8)
        preset_details.addWidget(self.key_link, 0, Qt.AlignmentFlag.AlignLeft)
        preset_details.addWidget(self.preset_model)
        preset_details.addWidget(self.advanced)
        layout.addLayout(preset_details)
        self.ollama_url = self._field('Ollama 地址', 'http://127.0.0.1:11434')
        self.ollama_model = self._field('Ollama 模型名称', '填写已安装的模型名称')
        self.ollama_section = SettingsSection('本机 Ollama', [
            SettingRow('local_ollama_url', '服务地址', 'Ollama 在本机运行时通常使用此端口。', self.ollama_url, stacked=True),
            SettingRow('local_ollama_model', '模型名称', '填写本机已经安装的模型名称。', self.ollama_model, stacked=True),
        ], self)
        layout.addWidget(self.ollama_section)
        self.proxy_mode = ModernSelect(self, width=240)
        self.proxy_mode.addItem('跟随系统代理', 'system')
        self.proxy_mode.addItem('指定本机代理', 'custom')
        self.proxy = self._field('本机代理地址', 'http://127.0.0.1:7890')
        self.proxy_row = SettingRow('local_model_proxy_address', '代理地址',
            '支持本机 HTTP 或 SOCKS5 代理，端口以你的代理软件为准。', self.proxy, stacked=True)
        self.network_section = SettingsSection('网络', [
            SettingRow('local_model_proxy_mode', '模型请求代理', '跟随系统时沿用当前 Clash 等系统代理设置。', self.proxy_mode, stacked=True),
            self.proxy_row,
        ], self)
        layout.addWidget(self.network_section)
        self.status = QLabel('正在读取模型配置…', self)
        self.status.setObjectName('settingHint')
        self.status.setWordWrap(True)
        self.status.setAccessibleName('模型配置状态')
        layout.addWidget(self.status)
        actions = QWidget(self)
        buttons = QVBoxLayout(actions)
        buttons.setContentsMargins(0, 0, 0, 0)
        buttons.setSpacing(8)
        self.save_button = QPushButton('保存模型配置', actions)
        self.test_button = QPushButton('测试已保存配置', actions)
        self.activate_button = QPushButton('测试并启用', actions)
        self.chat_button = QPushButton('开始聊天', actions)
        self._activated = False
        self.reload_button = QPushButton('重新读取', actions)
        for button in (self.activate_button, self.chat_button, self.save_button, self.test_button, self.reload_button):
            button.setAutoDefault(False)
            buttons.addWidget(button)
        layout.addWidget(actions)
        note = QLabel('连接测试会发送一条固定短句，可能消耗少量额度。', self)
        note.setObjectName('settingHint')
        note.setWordWrap(True)
        layout.addWidget(note)
        layout.addStretch(1)
        self._fields = (self.url, self.key, self.model, self.ollama_url, self.ollama_model, self.proxy)
        self.provider.currentIndexChanged.connect(self._provider_changed)
        self.proxy_mode.currentIndexChanged.connect(self._changed)
        for field in self._fields:
            field.textChanged.connect(self._changed)
        self.save_button.clicked.connect(self.save)
        self.test_button.clicked.connect(self.test_saved)
        self.activate_button.clicked.connect(self.activate)
        self.chat_button.clicked.connect(self.open_chat)
        self.reload_button.clicked.connect(self.reload)
        self._update()
        if auto_load:
            QTimer.singleShot(0, self.reload)

    def _field(self, label, placeholder):
        field = QLineEdit(self)
        field.setAccessibleName(label)
        field.setPlaceholderText(placeholder)
        field.setMinimumWidth(0)
        return field

    def _reveal_key(self, checked):
        self.key.setEchoMode(QLineEdit.EchoMode.Normal if checked else QLineEdit.EchoMode.Password)
        self.reveal.setText('隐藏' if checked else '显示')

    def _snapshot(self):
        selected = self.provider.currentData()
        values = ((self.url.text().strip(), self.key.text().strip(), self.model.text().strip())
                  if selected != 'ollama' else (self.ollama_url.text().strip(), self.ollama_model.text().strip()))
        proxy = self.proxy.text().strip() if self.proxy_mode.currentData() == 'custom' else ''
        return selected, values, proxy

    @property
    def dirty(self):
        return self._loaded and self._snapshot() != self._baseline

    def _changed(self, *_):
        if self._loaded and not self._busy:
            if self.dirty:
                self.status.setText('修改尚未启用。')
            elif self._saved.get('hasSavedCloudConnection') is False and self.provider.currentData() in self._presets:
                self.status.setText('选择服务商，粘贴 API Key 后即可测试。')
            else:
                self.status.setText('当前配置已保存。')
        self._update()

    def _saved_cloud(self, selected):
        saved = self._saved.get('cloudConnections', {}).get('custom' if selected == 'cloud' else selected)
        if saved is not None:
            return saved
        cloud = self._saved.get('cloud', {})
        return cloud if (self._saved.get('hasSavedCloudConnection', True) and
                         (cloud.get('preset') or 'cloud') == selected) else {}

    def _provider_changed(self, *_):
        selected = self.provider.currentData()
        previous = self._selected
        self._selected = selected
        if not self._loaded:
            return
        if previous and previous != 'ollama':
            self._connection_drafts[previous] = self.url.text(), self.key.text(), self.model.text()
        if selected != 'ollama':
            saved = self._saved_cloud(selected)
            preset = self._presets.get(selected, {})
            url, key, model = self._connection_drafts.get(selected, (
                saved.get('baseUrl', preset.get('baseUrl', '')), '', saved.get('model', preset.get('model', '')),
            ))
            self.url.setText(url)
            self.key.setText(key)
            self.model.setText(model)
        self.reveal.setChecked(False)
        self._changed()

    def _open_key_page(self):
        preset = self._presets.get(self.provider.currentData())
        if preset:
            QDesktopServices.openUrl(QUrl(preset['keyUrl']))

    def _update(self):
        selected = self.provider.currentData()
        cloud = selected != 'ollama'
        preset = self._presets.get(selected)
        advanced = self.advanced.isChecked()
        saved_cloud = self._saved_cloud(selected)
        saved_key = saved_cloud.get('apiKey') and self.url.text().strip() == saved_cloud.get('baseUrl')
        self.key.setPlaceholderText('已保存密钥，留空继续使用' if saved_key else '粘贴 API Key')
        self.cloud_section.setVisible(cloud)
        self.ollama_section.setVisible(not cloud)
        self.key_link.setVisible(bool(preset))
        self.preset_model.setVisible(bool(preset) and not advanced)
        self.preset_model.setText('模型：' + self.model.text() if preset else '')
        self.advanced.setVisible(bool(preset))
        self.advanced.setAccessibleName('收起高级设置' if advanced else '展开高级设置')
        self.url_row.setVisible(cloud and not preset)
        self.model_row.setVisible(cloud and (not preset or advanced))
        self.cloud_section.card.refresh_separators()
        self.network_section.setVisible(not preset or advanced)
        self.proxy_row.setVisible(self.proxy_mode.currentData() == 'custom')
        for widget in (*self._fields, self.provider, self.proxy_mode, self.reveal, self.advanced, self.key_link):
            widget.setEnabled(self._loaded and not self._busy)
        legacy_actions = not self._presets or not cloud
        self.save_button.setVisible(legacy_actions)
        self.save_button.setEnabled(self.dirty and not self._busy)
        self.test_button.setVisible(legacy_actions)
        self.test_button.setEnabled(self._loaded and not self._busy and not self.dirty)
        self.activate_button.setVisible(bool(self._presets) and cloud)
        self.activate_button.setEnabled(self._loaded and not self._busy and bool(saved_key or self.key.text().strip()))
        self.chat_button.setVisible(self._activated and not self._busy and not self.dirty)
        self.reload_button.setVisible(not self._loaded or not cloud or not self._presets or bool(preset and advanced))
        self.reload_button.setEnabled(not self._busy)

    def _start(self, name, operation, text):
        if self._busy:
            return
        self._busy = True
        self.status.setText(text)
        self._update()
        self.jobs.run(name, operation)

    def reload(self):
        if self.dirty and not self.confirm_discard():
            return
        self._start('load', self.client.settings, '正在读取模型配置…')

    def _payload(self, *, activation=False):
        selected = self.provider.currentData()
        provider = 'ollama' if selected == 'ollama' else 'cloud'
        section = {'baseUrl': self.url.text().strip(), 'model': self.model.text().strip()} if provider == 'cloud' else {
            'baseUrl': self.ollama_url.text().strip(), 'model': self.ollama_model.text().strip()}
        if not section['baseUrl'] or not section['model']:
            self.status.setText('请填写服务地址和模型名称。')
            return None
        if provider == 'cloud':
            preset = self._presets.get(selected)
            if preset:
                section.pop('baseUrl')
                section['preset'] = selected
            elif activation or self._saved.get('cloud', {}).get('preset'):
                section['preset'] = 'custom'
            if self.key.text().strip():
                section['apiKey'] = self.key.text().strip()
            elif activation and (not self._saved_cloud(selected).get('apiKey') or
                    self.url.text().strip() != self._saved_cloud(selected).get('baseUrl')):
                self.status.setText('请粘贴此连接的 API Key。')
                return None
        proxy = self.proxy.text().strip() if self.proxy_mode.currentData() == 'custom' else ''
        if self.proxy_mode.currentData() == 'custom' and not proxy:
            self.status.setText('请填写本机代理地址，或选择跟随系统代理。')
            return None
        return {'provider': provider, provider: section, 'proxy': proxy}

    def save(self):
        if self._presets and self.provider.currentData() != 'ollama':
            return self.activate()
        payload = self._payload()
        if payload is None:
            return False
        self._start('save', lambda: self.client.save_settings(payload), '正在保存模型配置…')
        return self._busy

    def activate(self):
        if not self._loaded or self._busy:
            return False
        payload = self._payload(activation=True)
        if payload is None:
            return False
        self._activated = False
        self._start('activate', lambda: self.client.request('POST', '/settings/model/activate', json=payload),
                    '正在测试所选连接…')
        return self._busy

    def open_chat(self):
        if self._busy or self.dirty or not self._activated:
            return
        window = self.window()
        if isinstance(window, QDialog) and not window.close():
            return
        try:
            (self.client.root / 'focus-chat').touch()
        except (AttributeError, OSError):
            self.status.setText('请从桌宠右键菜单打开「聊一聊」。')

    def save_and_then(self, callback):
        if self._busy:
            self.status.setText('操作正在进行，请等待完成后再保存并退出。')
            return
        self._after_save = callback
        if not self.save():
            self._after_save = None

    def test_saved(self):
        if not self._loaded or self.dirty:
            return
        self._start('test', lambda: self.client.request('POST', '/settings/test', json={}), '正在测试已保存配置…')

    def _completed(self, name, result):
        self._busy = False
        if name == 'activate':
            result = result['settings']
        if name in ('load', 'save', 'activate'):
            self._loaded = False
            self._saved = result
            self._presets = result.get('modelPresets', {})
            self._connection_drafts.clear()
            self.provider.clear()
            for key, preset in self._presets.items():
                self.provider.addItem(preset['label'], key)
            self.provider.addItem('自定义（OpenAI 兼容）', 'cloud')
            self.provider.addItem('本机 Ollama', 'ollama')
            cloud, ollama = result.get('cloud', {}), result.get('ollama', {})
            selected = 'ollama' if result.get('provider') == 'ollama' else cloud.get('preset') or 'cloud'
            if selected == 'cloud' and not cloud.get('apiKey') and self._presets and not result.get('hasSavedCloudConnection', True):
                selected = next(iter(self._presets))
                cloud = self._presets[selected]
            self.provider.setCurrentData(selected)
            self._selected = self.provider.currentData()
            self.url.setText(cloud.get('baseUrl', ''))
            self.model.setText(cloud.get('model', ''))
            self.key.clear()
            self.reveal.setChecked(False)
            self.ollama_url.setText(ollama.get('baseUrl', 'http://127.0.0.1:11434'))
            self.ollama_model.setText(ollama.get('model', ''))
            self.proxy.setText(result.get('proxy') or '')
            self.proxy_mode.setCurrentData('custom' if result.get('proxy') else 'system')
            self._baseline = self._snapshot()
            self._loaded = True
            self._activated = name == 'activate'
            status = {'save': '模型配置已保存。', 'load': '已读取当前配置。',
                      'activate': '连接成功，已启用。'}[name]
            if name == 'load' and not result.get('hasSavedCloudConnection', True) and selected in self._presets:
                status = '选择服务商，粘贴 API Key 后即可测试。'
            self.status.setText(status)
        else:
            self.status.setText('连接成功。' if result.get('ok') else '连接测试失败，请检查配置后重试。')
        self._update()
        if name in ('save', 'activate') and self._after_save is not None:
            callback, self._after_save = self._after_save, None
            callback()

    def _failed(self, name, code=''):
        self._busy = False
        self._after_save = None
        messages = {
            'load': '读取失败，请确认大肥鱼本地后台已启动，然后重新读取。',
            'save': '保存失败，修改仍保留。请等待当前聊天结束并检查配置，再点击保存。',
            'test': '连接测试失败，请检查已保存的地址、模型、密钥、额度和网络后重试。',
        }
        text = messages.get(name, '操作失败，请重试。')
        if name == 'activate':
            detail = MODEL_TEST_FAILURE_MESSAGES.get(code, '连接测试失败，请检查当前草稿后重试。')
            if code == 'not_configured':
                detail = '请填写完整的模型配置与密钥。'
            text = detail + ' 原连接设置已保留。'
        if name == 'test' and isinstance(code, str):
            text = MODEL_TEST_FAILURE_MESSAGES.get(code, text)
        self.status.setText(text)
        self._update()

    def confirm_discard(self):
        return QMessageBox.question(self, '模型配置尚未保存',
            '模型配置尚未保存。要放弃这些修改吗？',
            QMessageBox.StandardButton.Discard | QMessageBox.StandardButton.Cancel,
            QMessageBox.StandardButton.Cancel) == QMessageBox.StandardButton.Discard

    def can_close(self, *, commit_discard=True):
        if self._busy:
            self.status.setText('操作正在进行，请等待完成后再关闭设置。')
            return False
        if self.dirty:
            if not self.confirm_discard():
                return False
            if commit_discard:
                self._baseline = self._snapshot()
        return True
