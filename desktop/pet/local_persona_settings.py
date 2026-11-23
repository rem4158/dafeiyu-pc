"""Nianan persona settings in the shared desktop settings window."""
from __future__ import annotations

from PySide6.QtCore import QTimer, Qt
from PySide6.QtWidgets import (QHBoxLayout, QLabel, QLineEdit, QMessageBox,
                               QPlainTextEdit, QPushButton, QSlider, QVBoxLayout, QWidget)

from .local_model_settings import _Jobs, local_client
from .settings_widgets import ModernSelect, SettingRow, SettingsSection, ToggleSwitch

LANGUAGES = (("未指定", ""), ("日常口语", "colloquial"), ("文艺温柔", "gentle"),
             ("网络俏皮", "playful"), ("古风雅韵", "classical"))
ARCHETYPES = (("未指定", ""), ("元气活泼", "genki"), ("温柔体贴", "gentle"),
              ("高冷傲娇", "cool"), ("腹黑俏皮", "scheming"), ("天然呆萌", "airhead"))
TRAITS = (
    ("proactivity", "话题主动性", "安静陪伴", "主动找话题"),
    ("empathyDepth", "安慰方式", "安静陪伴", "主动开导"),
    ("verbosity", "话语多少", "简短利落", "更愿意表达"),
    ("warmth", "表达风格", "温柔软糯", "爽快利落"),
    ("humor", "幽默程度", "正经认真", "爱开玩笑"),
    ("teasing", "打趣程度", "默默圆场", "先打趣再帮忙"),
    ("shyness", "被夸反应", "淡定接受", "容易害羞"),
    ("possessiveness", "在意表达", "保持独立", "更流露在意"),
    ("dependency", "相处距离", "有自己的重心", "更黏人"),
    ("rationality", "思考方式", "跟着感觉走", "理性分析"),
)


class LocalPersonaSettingsPage(QWidget):
    """Save only changed persona fields; leave model credentials and history alone."""
    def __init__(self, parent=None, *, client=None, auto_load=True):
        super().__init__(parent)
        self.client = client or local_client()
        self._loaded = False
        self._busy = False
        self._baseline = None
        self._loaded_dimensions = {}
        self._after_save = None
        self.jobs = _Jobs(self)
        self.jobs.completed.connect(self._completed)
        self.jobs.failed.connect(self._failed)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(18)
        self.character_name = self._field("角色称呼")
        self.owner_name = self._field("你的称呼")
        layout.addWidget(SettingsSection("称呼", [
            SettingRow("persona_character_name", "角色称呼", "聊天时使用的角色名字，不会更换桌宠形象。", self.character_name, stacked=True),
            SettingRow("persona_owner_name", "你的称呼", "告诉角色如何称呼你，不会更换用户或聊天记录。", self.owner_name, stacked=True),
        ], self))
        self.prompt = QPlainTextEdit(self)
        self.prompt.setAccessibleName("角色人格提示词")
        self.prompt.setMinimumHeight(180)
        self.prompt.setPlaceholderText("保留你原有的人格设定，按需编辑。")
        layout.addWidget(SettingsSection("人格原文", [SettingRow(
            "persona_system_prompt", "角色人格提示词", "保留原有内容；保存后用于后续回复。这里不编辑模型密钥。",
            self.prompt, stacked=True)], self))
        self.dimensions_enabled = ToggleSwitch(self)
        layout.addWidget(SettingsSection("性格参数", [SettingRow(
            "persona_dimensions_enabled", "使用念安性格参数", "默认沿用已保存状态。关闭时只使用人格原文；开启后增加下面的表达偏好。",
            self.dimensions_enabled)], self))
        self.dimensions_host = QWidget(self)
        dimensions_layout = QVBoxLayout(self.dimensions_host)
        dimensions_layout.setContentsMargins(0, 0, 0, 0)
        dimensions_layout.setSpacing(18)
        self.language = self._select(LANGUAGES)
        self.archetype = self._select(ARCHETYPES)
        rows = [
            SettingRow("persona_language_style", "语言风格", "不指定时沿用人格原文。", self.language, stacked=True),
            SettingRow("persona_archetype", "性格底色", "与原有人格一起影响表达，不会重置经历或关系。", self.archetype, stacked=True),
        ]
        self.sliders = {}
        self.values = {}
        for key, title, left, right in TRAITS:
            host = QWidget(self)
            row = QHBoxLayout(host)
            row.setContentsMargins(0, 0, 0, 0)
            slider = QSlider(Qt.Orientation.Horizontal, host)
            slider.setRange(0, 100)
            slider.setValue(50)
            slider.setAccessibleName(title)
            value = QLabel("50%", host)
            value.setObjectName("settingHint")
            value.setMinimumWidth(38)
            row.addWidget(slider, 1)
            row.addWidget(value)
            slider.valueChanged.connect(lambda n, label=value: label.setText(f"{n}%"))
            slider.valueChanged.connect(self._changed)
            self.sliders[key] = slider
            self.values[key] = value
            rows.append(SettingRow("persona_" + key, title, f"左：{left}；右：{right}。居中时不强调这一偏好。", host, stacked=True))
        dimensions_layout.addWidget(SettingsSection("表达偏好", rows, self.dimensions_host))
        note = QLabel("这些参数先影响聊天表达；不会开启主动消息或改变主动频率。", self.dimensions_host)
        note.setObjectName("settingHint")
        note.setWordWrap(True)
        dimensions_layout.addWidget(note)
        layout.addWidget(self.dimensions_host)
        self.status = QLabel("正在读取人格配置…", self)
        self.status.setObjectName("settingHint")
        self.status.setWordWrap(True)
        self.status.setAccessibleName("人格配置状态")
        layout.addWidget(self.status)
        self.save_button = QPushButton("保存人格配置", self)
        self.reload_button = QPushButton("重新读取", self)
        for button in (self.save_button, self.reload_button):
            button.setAutoDefault(False)
            layout.addWidget(button)
        layout.addStretch(1)
        self._controls = (self.character_name, self.owner_name, self.prompt,
                          self.dimensions_enabled, self.language, self.archetype, *self.sliders.values())
        self.character_name.textChanged.connect(self._changed)
        self.owner_name.textChanged.connect(self._changed)
        self.prompt.textChanged.connect(self._changed)
        self.dimensions_enabled.toggled.connect(self._changed)
        self.language.currentIndexChanged.connect(self._changed)
        self.archetype.currentIndexChanged.connect(self._changed)
        self.save_button.clicked.connect(self.save)
        self.reload_button.clicked.connect(self.reload)
        self._update()
        if auto_load:
            QTimer.singleShot(0, self.reload)

    def _field(self, name):
        field = QLineEdit(self)
        field.setAccessibleName(name)
        field.setMaxLength(60)
        field.setMinimumWidth(0)
        return field

    def _select(self, choices):
        control = ModernSelect(self, width=240)
        for label, value in choices:
            control.addItem(label, value)
        return control

    def _dimensions(self):
        if not self.dimensions_enabled.isChecked():
            return None
        result = {}
        for key, slider in self.sliders.items():
            original = self._loaded_dimensions.get(key)
            unchanged = isinstance(original, (int, float)) and round(original * 100) == slider.value()
            result[key] = original if unchanged else slider.value() / 100
        # Empty values explicitly remove a previously chosen style on the backend.
        result['languageStyle'] = self.language.currentData() or ''
        result['archetype'] = self.archetype.currentData() or ''
        return result

    def _snapshot(self):
        return {'characterName': self.character_name.text().strip(),
                'ownerName': self.owner_name.text().strip(),
                'systemPrompt': self.prompt.toPlainText(),
                'personality': {'dimensions': self._dimensions()}}

    @property
    def dirty(self):
        return self._loaded and self._snapshot() != self._baseline

    def _changed(self, *_):
        if self._loaded and not self._busy:
            self.status.setText('修改尚未保存。' if self.dirty else '当前人格配置已保存。')
        self._update()

    def _update(self):
        self.dimensions_host.setVisible(self.dimensions_enabled.isChecked())
        for control in self._controls:
            control.setEnabled(self._loaded and not self._busy)
        self.save_button.setEnabled(self.dirty and not self._busy)
        self.reload_button.setEnabled(not self._busy)

    def _start(self, name, operation, text):
        if self._busy:
            return False
        self._busy = True
        self.status.setText(text)
        self._update()
        self.jobs.run(name, operation)
        return True

    def reload(self):
        if self.dirty and not self.confirm_discard():
            return
        self._start('load', self.client.settings, '正在读取人格配置…')

    def save(self):
        if not self._loaded or self._busy:
            return False
        current = self._snapshot()
        if not current['characterName'] or not current['ownerName']:
            self.status.setText('请填写角色称呼和你的称呼。')
            return False
        if len(current['systemPrompt']) > 50000:
            self.status.setText('人格提示词不能超过 50000 字。')
            return False
        payload = {key: value for key, value in current.items() if value != self._baseline[key]}
        if not payload:
            return False
        return self._start('save', lambda: self.client.save_settings(payload), '正在保存人格配置…')

    def save_and_then(self, callback):
        if self._busy:
            self.status.setText('操作正在进行，请等待完成后再保存并退出。')
            return
        self._after_save = callback
        if not self.save():
            self._after_save = None

    def _completed(self, name, result):
        self._busy = False
        self._loaded = False
        self.character_name.setText(result.get('characterName', '大肥鱼'))
        self.owner_name.setText(result.get('ownerName', '主人'))
        self.prompt.setPlainText(result.get('systemPrompt', ''))
        dims = (result.get('personality') or {}).get('dimensions')
        self.dimensions_enabled.setChecked(isinstance(dims, dict))
        dims = dims if isinstance(dims, dict) else {}
        self._loaded_dimensions = dict(dims)
        self.language.setCurrentData(dims.get('languageStyle', ''))
        self.archetype.setCurrentData(dims.get('archetype', ''))
        for key, slider in self.sliders.items():
            value = dims.get(key, .5)
            slider.setValue(round(float(value) * 100) if isinstance(value, (int, float)) else 50)
        self._baseline = self._snapshot()
        self._loaded = True
        self.status.setText('人格配置已保存。' if name == 'save' else '已读取当前人格配置。')
        self._update()
        if name == 'save' and self._after_save is not None:
            callback, self._after_save = self._after_save, None
            callback()

    def _failed(self, name):
        self._busy = False
        self._after_save = None
        self.status.setText('读取失败，请确认本地后台已启动后重新读取。' if name == 'load'
                            else '保存失败，修改仍保留。请等待当前聊天结束或检查输入后重试。')
        self._update()

    def confirm_discard(self):
        return QMessageBox.question(self, '人格配置尚未保存',
            '人格配置尚未保存。要放弃这些修改吗？',
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
