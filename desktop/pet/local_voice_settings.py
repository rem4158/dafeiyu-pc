"""Nianan speech and existing AstrBot sticker settings in the unified window."""
from __future__ import annotations
from PySide6.QtCore import QTimer
from PySide6.QtWidgets import QLabel, QLineEdit, QMessageBox, QPlainTextEdit, QPushButton, QVBoxLayout, QWidget
from .local_model_settings import _Jobs, local_client
from .speech_output_settings import SpeechOutputSettings
from .settings_widgets import ModernSelect, SettingRow, SettingsSection, ToggleSwitch


class LocalVoiceSettingsPage(QWidget):
    def __init__(self, parent=None, *, client=None, auto_load=True):
        super().__init__(parent)
        self.client = client or local_client()
        self._loaded = False
        self._busy = False
        self._baseline = None
        self._after_save = None
        self.jobs = _Jobs(self)
        self.jobs.completed.connect(self._completed)
        self.jobs.failed.connect(self._failed)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(18)
        self.controls = {}
        self.speech = SpeechOutputSettings(self.client, self)
        self.speech.busy_changed.connect(self._update)
        layout.addWidget(self.speech)
        def toggle(key, title, hint):
            item = ToggleSwitch(self)
            item.toggled.connect(self._changed)
            self.controls[key] = item
            return SettingRow('voice_' + key.replace('.', '_'), title, hint, item)
        def field(key, title, hint, secret=False, multiline=False):
            item = QPlainTextEdit(self) if multiline else QLineEdit(self)
            if multiline: item.setMaximumHeight(100)
            elif secret:
                item.setEchoMode(QLineEdit.EchoMode.Password)
                item.setPlaceholderText('留空保留已保存密钥')
            item.setMinimumWidth(0)
            item.setAccessibleName(title)
            item.textChanged.connect(self._changed)
            self.controls[key] = item
            return SettingRow('voice_' + key.replace('.', '_'), title, hint, item, stacked=True)
        def select(key, title, hint, choices):
            item = ModernSelect(self, width=240)
            for label, value in choices: item.addItem(label, value)
            item.currentIndexChanged.connect(self._changed)
            self.controls[key] = item
            return SettingRow('voice_' + key.replace('.', '_'), title, hint, item, stacked=True)
        self.interaction = SettingsSection('语音交互', [
            toggle('voice.enabled', '启用聊天语音', '开启后可使用聊天录音和语音回复；请先配置支持语音的 API。'),
            toggle('voice.autoSpeak', '偶尔语音回复', '文字为主，偶尔发送语音；点击语音条播放，右键可转文字。'),
            toggle('voice.autoSend', '识别后直接发送', '关闭时识别结果先放入输入框，供你检查后发送。'),
            select('voice.asrLanguage', '识别语言', '用于语音输入。', [('中文', 'zh'), ('英语', 'en'), ('日语', 'ja'), ('自动', 'auto')]),
        ], self)
        layout.addWidget(self.interaction)
        self.legacy_api = SettingsSection('原有语音 API', [
            select('tts.provider', '语音提供商', '沿用念安的语音提供商实现。', [('小米 MiMo', 'mimo'), ('通义千问 Qwen', 'qwen'), ('自定义聊天音频 API', 'custom')]),
            field('tts.baseUrl', 'TTS API 地址', '可单独填写；留空沿用聊天 API。纯文字模型不支持语音。'),
            field('tts.apiKey', 'TTS API 密钥', '已保存密钥不回显；留空保留。', secret=True),
            field('tts.models.preset', '预设音色模型', 'MiMo 和 Qwen 留空使用各自默认模型；自定义须填写。'),
            field('tts.models.design', '音色设计模型', '用于音色设计模式。'),
            field('tts.models.clone', '参考音克隆模型', '用于参考音克隆；Qwen 暂不支持此模式。'),
            field('tts.models.asr', '语音识别模型', 'MiMo 留空使用 mimo-v2.5-asr；其他 API 请填写准确名称。'),
        ], self, advanced=True, description='保留原有语音与录音识别共用的连接。')
        layout.addWidget(self.legacy_api)
        self.legacy_voice = SettingsSection('原有回复音色', [
            select('voice.ttsMode', '音色模式', '保留念安的预设、设计和参考音克隆模式。', [('预设音色', 'preset'), ('音色设计', 'design'), ('参考音克隆', 'clone')]),
            field('voice.presetVoice', '预设音色名称', '使用提供商支持的音色名称；例如 MiMo 的冰糖。'),
            field('voice.voiceDesignPrompt', '音色描述', '音色设计模式使用，不会改变聊天人格。', multiline=True),
            field('voice.speakStyleHint', '朗读风格', '可选，例如自然、清晰、不要拖长尾音。'),
            field('voice.referenceAudio', '参考音频路径', '克隆模式使用本机 mp3/wav；不会复制原念安的角色参考音。'),
            select('voice.ttsFormat', '音频格式', '保存到本机聊天附件，可重复播放。', [('MP3', 'mp3'), ('WAV', 'wav')]),
        ], self, advanced=True)
        layout.addWidget(self.legacy_voice)
        layout.addWidget(SettingsSection('独立识别 API', [
            field('asr.baseUrl', 'ASR API 地址', '可选；留空沿用 TTS API。'),
            field('asr.apiKey', 'ASR API 密钥', '可选；未配置时沿用 TTS 密钥。留空保留原值。', secret=True),
        ], self))
        layout.addWidget(SettingsSection('表情包', [
            toggle('stickers.enabled', '使用已有表情包', '直接读取 AstrBot 表情包管理器已选资源包，无需运行 AstrBot。'),
            field('stickers.sourceRoot', '表情包管理器数据目录', '包含 selection_rules.json 和 packs 的目录；不移动或修改原素材。'),
        ], self))
        self.library_status = QLabel('正在检查表情包来源…', self)
        self.library_status.setWordWrap(True)
        self.library_status.setObjectName('settingHint')
        layout.addWidget(self.library_status)
        self.status = QLabel('正在读取语音配置…', self)
        self.status.setObjectName('settingHint')
        self.status.setWordWrap(True)
        self.status.setAccessibleName('语音配置状态')
        layout.addWidget(self.status)
        self.save_button = QPushButton('保存语音与表情配置', self)
        self.reload_button = QPushButton('重新读取', self)
        for button in (self.save_button, self.reload_button):
            button.setAutoDefault(False)
            layout.addWidget(button)
        layout.addStretch(1)
        self.save_button.clicked.connect(self.save)
        self.reload_button.clicked.connect(self.reload)
        self._update()
        if auto_load: QTimer.singleShot(0, self.reload)

    def _snapshot(self):
        values = {}
        for key, widget in self.controls.items():
            if isinstance(widget, ToggleSwitch): value = widget.isChecked()
            elif isinstance(widget, ModernSelect): value = widget.currentData()
            elif isinstance(widget, QPlainTextEdit): value = widget.toPlainText()
            else: value = widget.text().strip()
            target = values
            parts = key.split('.')
            for part in parts[:-1]: target = target.setdefault(part, {})
            target[parts[-1]] = value
        return values

    @property
    def dirty(self):
        return self._loaded and self._snapshot() != self._baseline

    def _changed(self, *_): self._update()

    def _update(self):
        busy = self._busy or self.speech.busy
        self.speech.set_parent_busy(not self._loaded or self._busy)
        self.legacy_voice.setVisible(not bool(self.speech.active))
        hint = self.interaction.rows[0]
        hint.label.setText('启用聊天录音' if self.speech.active else '启用聊天语音')
        hint.hint_label.setText('开启后可以录音并转文字。' if self.speech.active
                                else '开启后可使用原有录音和语音回复设置。')
        for widget in self.controls.values(): widget.setEnabled(self._loaded and not busy)
        self.save_button.setEnabled(self.dirty and not busy)
        self.reload_button.setEnabled(not busy)

    def _start(self, name, operation, text):
        if self._busy or self.speech.busy: return False
        self._busy = True
        self.status.setText(text)
        self._update()
        self.jobs.run(name, operation)
        return True

    def _library(self):
        try: return self.client.request('GET', '/stickers')
        except Exception: return {'count': 0, 'packs': []}

    def reload(self):
        if self.dirty and not self.confirm_discard(): return
        self._start('load', lambda: {'settings': self.client.settings(), 'library': self._library()}, '正在读取语音配置…')

    def save(self):
        if not self._loaded or self._busy or self.speech.busy: return False
        current = self._snapshot()
        payload = {key: value for key, value in current.items() if value != self._baseline[key]}
        for key in ('tts', 'asr'):
            if key in payload and not payload[key].get('apiKey'): payload[key].pop('apiKey', None)
        if not payload: return False
        return self._start('save', lambda: {'settings': self.client.save_settings(payload), 'library': self._library()}, '正在保存语音配置…')

    def save_and_then(self, callback):
        self._after_save = callback
        if not self.save(): self._after_save = None

    def _completed(self, name, result):
        self._busy = False
        self._loaded = False
        settings = result.get('settings', {})
        if name == 'load':
            self.speech.load(settings)
        for key, widget in self.controls.items():
            value = settings
            for part in key.split('.'): value = value.get(part, {}) if isinstance(value, dict) else {}
            if isinstance(widget, ToggleSwitch): widget.setChecked(value is True)
            elif isinstance(widget, ModernSelect): widget.setCurrentData(value if isinstance(value, str) else '')
            elif isinstance(widget, QPlainTextEdit): widget.setPlainText(value if isinstance(value, str) else '')
            else:
                widget.setText('' if key.endswith('.apiKey') else value if isinstance(value, str) else '')
                if key.endswith('.apiKey'): widget.setPlaceholderText('已配置密钥，留空保留' if value else '未配置；留空可沿用上级密钥')
        library = result.get('library', {})
        names = '、'.join(item.get('name', '') for item in library.get('packs', []))
        self.library_status.setText(f"已有表情包：{names or '尚未找到资源包'}；共 {library.get('count', 0)} 张。")
        self._baseline = self._snapshot()
        self._loaded = True
        self.status.setText('语音与表情配置已保存。' if name == 'save' else '已读取当前语音与表情配置。')
        self._update()
        if name == 'save' and self._after_save:
            callback, self._after_save = self._after_save, None
            callback()

    def _failed(self, _name):
        self._busy = False
        self._after_save = None
        self.status.setText('操作失败，修改仍保留。请检查本地后台和配置后重试。')
        self._update()

    def confirm_discard(self):
        return QMessageBox.question(self, '语音配置尚未保存', '要放弃未保存的语音与表情配置吗？',
            QMessageBox.StandardButton.Discard | QMessageBox.StandardButton.Cancel,
            QMessageBox.StandardButton.Cancel) == QMessageBox.StandardButton.Discard

    def can_close(self, *, commit_discard=True):
        if self._busy or self.speech.busy: return False
        if self.dirty:
            if not self.confirm_discard(): return False
            if commit_discard: self._baseline = self._snapshot()
        return True
