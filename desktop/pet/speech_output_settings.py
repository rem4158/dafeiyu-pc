"""Draft, preview and explicitly activate speech output on the voice settings page."""
from base64 import b64decode

from PySide6.QtCore import Qt, QUrl, Signal
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import QHBoxLayout, QLabel, QLineEdit, QPlainTextEdit, QPushButton, QVBoxLayout, QWidget

from .local_model_settings import _Jobs
from .settings_widgets import ModernSelect, SettingRow, SettingsDisclosureHeader, SettingsSection, ToggleSwitch


ERRORS = {
    'tts_preview_settings': '请检查语音服务的 Key、模型和音色设置。',
    'tts_preview_auth': '语音服务拒绝访问，请检查 Key 和服务权限。',
    'tts_preview_quota': '语音服务额度不足，请检查账户余额。',
    'tts_preview_rate': '语音请求过于频繁，请稍后再试。',
    'tts_preview_timeout': '试听超时，请检查网络后重试。',
    'tts_preview_audio': '语音服务未返回可播放的 MP3 或 WAV。',
    'tts_preview_expired': '试听已失效，请重新试听后启用。',
    'busy': '当前有试听或聊天正在进行，请稍后重试。',
}


class SpeechOutputSettings(QWidget):
    busy_changed = Signal()

    def __init__(self, client, parent=None):
        super().__init__(parent)
        self.client = client
        self.busy = False
        self.presets = {}
        self.active = None
        self.ticket = None
        self.audio = b''
        self.player = None
        self.playback_failed = False
        self._loading = False
        self._parent_busy = False
        self.jobs = _Jobs(self, error_codes=ERRORS)
        self.jobs.completed.connect(self._completed)
        self.jobs.failed.connect(self._failed)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(8)
        self.provider = ModernSelect(self, width=248)
        self.key = QLineEdit(self)
        self.key.setEchoMode(QLineEdit.EchoMode.Password)
        self.summary = QLabel(self)
        self.summary.setObjectName('settingHint')
        self.summary.setWordWrap(True)
        self.section = SettingsSection('语音回复', [
            SettingRow('speech_provider', '语音服务商', '', self.provider, stacked=True),
            SettingRow('speech_api_key', 'API Key', '', self.key, stacked=True),
        ], self)
        layout.addWidget(self.section)
        self.key_link = QPushButton('去官方平台获取 Key', self)
        self.key_link.clicked.connect(self._open_key_page)
        layout.addWidget(self.key_link, 0, Qt.AlignmentFlag.AlignLeft)
        layout.addWidget(self.summary)

        self.advanced = SettingsDisclosureHeader('高级设置', self)
        self.advanced.toggled.connect(self._update)
        self.advanced.setAutoDefault(False)
        layout.addWidget(self.advanced)
        self.protocol = ModernSelect(self, width=248)
        self.protocol.addItem('聊天音频 · /chat/completions', 'chat')
        self.protocol.addItem('语音合成 · /audio/speech', 'speech')
        self.url = QLineEdit(self)
        self.url.setPlaceholderText('https://api.example.com/v1')
        self.model = QLineEdit(self)
        self.voice = QLineEdit(self)
        self.mode = ModernSelect(self, width=248)
        self.detail = QPlainTextEdit(self)
        self.detail.setMaximumHeight(75)
        self.style = QLineEdit(self)
        self.format = ModernSelect(self, width=248)
        self.format.addItem('MP3', 'mp3')
        self.format.addItem('WAV', 'wav')
        self.rows = {
            key: SettingRow('speech_' + key, title, hint, widget, stacked=True)
            for key, title, hint, widget in [
                ('protocol', '接口格式', '', self.protocol),
                ('url', 'API 地址', '填写服务商提供的 API 基础地址。', self.url),
                ('mode', '音色模式', '', self.mode),
                ('model', '模型名称', '', self.model),
                ('voice', '音色名称', '使用服务商支持的音色名称或 ID。', self.voice),
                ('detail', '音色描述或参考音频', '', self.detail),
                ('style', '朗读风格', '仅部分模型支持。', self.style),
                ('format', '音频格式', '', self.format),
            ]
        }
        self.options = SettingsSection('合成参数', list(self.rows.values()), self)
        layout.addWidget(self.options)
        buttons = QHBoxLayout()
        self.preview_button = QPushButton('试听', self)
        self.play_button = QPushButton('再听一次', self)
        self.activate_button = QPushButton('启用语音回复', self)
        for button in (self.preview_button, self.play_button, self.activate_button, self.key_link):
            button.setAutoDefault(False)
        for button in (self.preview_button, self.play_button, self.activate_button):
            buttons.addWidget(button)
        layout.addLayout(buttons)
        self.preview_button.clicked.connect(self.preview)
        self.play_button.clicked.connect(self._play)
        self.activate_button.clicked.connect(self.activate)
        self.status = QLabel(self)
        self.status.setObjectName('settingHint')
        self.status.setWordWrap(True)
        self.status.setAccessibleName('语音试听状态')
        layout.addWidget(self.status)
        self.enabled = ToggleSwitch(self)
        self.enabled.toggled.connect(self._set_enabled)
        self.enabled_section = SettingsSection('当前配置', [
            SettingRow('speech_output_enabled', '语音回复', '', self.enabled),
        ], self)
        layout.addWidget(self.enabled_section)
        self.provider.currentIndexChanged.connect(self._provider_changed)
        self.protocol.currentIndexChanged.connect(self._protocol_changed)
        self.mode.currentIndexChanged.connect(self._mode_changed)
        self.format.currentIndexChanged.connect(self._draft_changed)
        for widget in (self.key, self.url, self.model, self.voice, self.detail, self.style):
            widget.textChanged.connect(self._draft_changed)
        self.hide()

    def load(self, settings):
        self.presets = settings.get('speechPresets', {})
        self.setVisible(bool(self.presets))
        if not self.presets:
            return
        self._loading = True
        self.active = settings.get('speechOutput')
        self.provider.clear()
        for name, preset in self.presets.items():
            self.provider.addItem(preset['label'], name)
        self.provider.addItem('自定义', 'custom')
        self.provider.setCurrentData(self.active['provider'] if self.active else 'mimo')
        self._fill()
        self.enabled.setChecked(bool(self.active and self.active['enabled']))
        self._loading = False
        self._draft_changed()

    def set_parent_busy(self, busy):
        self._parent_busy = busy
        if self.presets:
            self._update()

    def _fill(self):
        provider = self.provider.currentData()
        active = self.active if self.active and self.active['provider'] == provider else {}
        self.protocol.setCurrentData(active.get('protocol', 'chat'))
        self._fill_modes(active.get('mode', 'preset'))
        self.url.setText(active.get('baseUrl', '') if provider == 'custom' else '')
        self.model.setText(active.get('model', ''))
        self.voice.setText(active.get('voice', ''))
        self.detail.setPlainText(active.get('detail', ''))
        self.style.setText(active.get('style', ''))
        self.format.setCurrentData(active.get('format', 'mp3'))
        self.key.clear()

    def _fill_modes(self, desired):
        preset = self.presets.get(self.provider.currentData())
        modes = preset['models'] if preset else (
            ('preset',) if self.protocol.currentData() == 'speech' else ('preset', 'design', 'clone'))
        self.mode.clear()
        for label, mode in (('预设音色', 'preset'), ('音色设计', 'design'), ('参考音克隆', 'clone')):
            if mode in modes:
                self.mode.addItem(label, mode)
        self.mode.setCurrentData(desired)

    def _provider_changed(self, *_):
        if self._loading:
            return
        self._loading = True
        self._fill()
        self._loading = False
        self._draft_changed()

    def _protocol_changed(self, *_):
        if self._loading:
            return
        self._loading = True
        self._fill_modes(self.mode.currentData())
        self.model.clear()
        self.detail.clear()
        self._loading = False
        self._draft_changed()

    def _mode_changed(self, *_):
        if self._loading:
            return
        self._loading = True
        active = self.active
        if active and (active['provider'], active['mode']) == (self.provider.currentData(), self.mode.currentData()):
            self.model.setText(active['model'])
            self.detail.setPlainText(active['detail'])
        else:
            self.model.clear()
            self.detail.clear()
        self._loading = False
        self._draft_changed()

    def _draft_changed(self, *_):
        if self._loading:
            return
        self.ticket = None
        self.audio = b''
        self.stop()
        self.status.setText('试听会合成一句短句，可能产生少量用量。')
        self._update()

    def _preset(self):
        return self.presets.get(self.provider.currentData())

    def _can_use_saved_key(self):
        preset = self._preset()
        url = preset['baseUrl'] if preset else self.url.text().strip().rstrip('/')
        return bool(self.active and self.active['apiKey'] and self.active['provider'] == self.provider.currentData()
                    and self.active['baseUrl'] == url)

    def _update(self, *_):
        if self._loading:
            return
        preset = self._preset()
        custom = self.provider.currentData() == 'custom'
        mode = self.mode.currentData()
        defaults = preset['models'] if preset else {}
        voice = preset['voice'] if preset else ''
        self.key_link.setVisible(bool(preset))
        self.key.setPlaceholderText('已保存密钥，留空继续使用' if self._can_use_saved_key() else '粘贴 API Key')
        self.model.setPlaceholderText(defaults.get(mode, '填写模型名称'))
        self.voice.setPlaceholderText(voice or '填写音色名称或 ID')
        self.detail.setPlaceholderText('本机 WAV 或 MP3 的完整路径' if mode == 'clone' else '描述想要的音色')
        chosen_voice = self.voice.text().strip() or voice
        self.summary.setText(('音色：芊悦（Cherry）' if chosen_voice == 'Cherry' else '音色：' + chosen_voice)
                             if preset and mode == 'preset' else '')
        self.summary.setVisible(bool(self.summary.text()))
        advanced = self.advanced.isChecked()
        self.advanced.setVisible(not custom)
        self.options.setVisible(custom or advanced)
        self.rows['protocol'].setVisible(custom)
        self.rows['url'].setVisible(custom)
        self.rows['mode'].setVisible(self.mode.count() > 1)
        self.rows['voice'].setVisible(mode == 'preset')
        self.rows['detail'].setVisible(mode in ('design', 'clone'))
        self.rows['style'].setVisible(self.provider.currentData() != 'qwen' or 'instruct' in self.model.text().lower())
        self.rows['format'].setVisible(self.provider.currentData() != 'qwen' and mode != 'clone')
        self.options.card.refresh_separators()
        self.enabled_section.setVisible(bool(self.active))
        if self.active:
            current_name = self.presets.get(self.active['provider'], {}).get('label', '自定义')
            self.enabled_section.rows[0].hint_label.setText(current_name + ' · ' + self.active['model'])
        ready = not self.busy and not self._parent_busy
        for control in (self.section, self.advanced, self.options, self.enabled, self.key_link):
            control.setEnabled(ready)
        can_preview = bool(self.key.text().strip() or self._can_use_saved_key())
        if custom:
            can_preview = can_preview and bool(self.url.text().strip() and self.model.text().strip())
            if mode == 'preset':
                can_preview = can_preview and bool(self.voice.text().strip())
        if mode != 'preset':
            can_preview = can_preview and bool(self.detail.toPlainText().strip())
        self.preview_button.setEnabled(ready and can_preview)
        self.play_button.setVisible(bool(self.audio))
        self.play_button.setEnabled(ready)
        self.activate_button.setVisible(bool(self.ticket))
        self.activate_button.setEnabled(ready and not self.playback_failed)

    def _open_key_page(self):
        preset = self._preset()
        if preset:
            QDesktopServices.openUrl(QUrl(preset['keyUrl']))

    def _start(self, name, operation, status):
        self.busy = True
        self.status.setText(status)
        self._update()
        self.busy_changed.emit()
        self.jobs.run(name, operation)

    def preview(self):
        if not self.preview_button.isEnabled():
            return
        self._draft_changed()
        provider = self.provider.currentData()
        payload = {
            'provider': provider, 'apiKey': self.key.text().strip(), 'mode': self.mode.currentData(),
            'model': self.model.text().strip(), 'voice': self.voice.text().strip(),
            'format': self.format.currentData(), 'detail': self.detail.toPlainText().strip(),
            'style': self.style.text().strip(),
        }
        if provider == 'custom':
            payload.update(protocol=self.protocol.currentData(), baseUrl=self.url.text().strip())
        self._start('preview', lambda: self.client.request('POST', '/voice/tts/preview', json=payload),
                    '正在合成试听…')

    def activate(self):
        if not self.ticket or not self.activate_button.isEnabled():
            return
        ticket = self.ticket
        self.stop()
        self._start('activate', lambda: self.client.request('POST', '/voice/tts/activate', json={'ticket': ticket}),
                    '正在启用语音回复…')

    def _set_enabled(self, enabled):
        if self._loading or self.busy or self._parent_busy or not self.active:
            return
        self._start('toggle', lambda: self.client.save_settings({'speechOutputEnabled': enabled}),
                    '正在保存语音回复开关…')

    def _play(self):
        if not self.audio or not self.isVisible():
            return
        if self.player is None:
            from audio_queue import AudioQueue
            self.player = AudioQueue(self)
            self.player.failed.connect(self._playback_error)
        self.playback_failed = False
        self.player.stop()
        self.player.reserve('tts-preview')
        self.player.ready('tts-preview', self.audio)
        self._update()

    def _playback_error(self, message):
        self.playback_failed = True
        self.status.setText(message)
        self._update()

    def stop(self):
        if self.player is not None:
            self.player.stop()

    def hideEvent(self, event):
        self.stop()
        super().hideEvent(event)

    def _completed(self, name, result):
        self.busy = False
        if name == 'preview':
            self.ticket = result['ticket']
            self.audio = b64decode(result['audio'])
            self.playback_failed = False
            self.status.setText('试听已生成。满意后可启用语音回复。')
            self._play()
        elif name == 'activate':
            self.load(result)
            self.status.setText('语音回复已启用。')
        else:
            self.active = result['speechOutput']
            self._draft_changed()
            self.status.setText('语音回复已启用。' if self.active['enabled'] else '语音回复已关闭。')
        self._update()
        self.busy_changed.emit()

    def _failed(self, name, code):
        self.busy = False
        if name == 'toggle' and self.active:
            self._loading = True
            self.enabled.setChecked(self.active['enabled'])
            self._loading = False
        if code == 'tts_preview_expired':
            self.ticket = None
        self.status.setText(ERRORS.get(code, '试听失败，请检查语音服务和网络后重试。' if name == 'preview'
                                      else '语音回复设置未保存，请稍后重试。'))
        self._update()
        self.busy_changed.emit()
