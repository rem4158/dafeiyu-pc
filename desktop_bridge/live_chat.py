"""Native chat presentation for the local PC backend."""
import json
import os
import sys
import threading
import uuid
from pathlib import Path
from types import SimpleNamespace

SOURCE = Path(__file__).resolve().parents[1] / 'desktop'
sys.path.insert(0, str(SOURCE))

from PySide6.QtCore import QBuffer, QByteArray, QIODevice, QObject, QTimer, Qt, Signal, Slot, QUrl, QSize
from PySide6.QtGui import QDesktopServices, QMovie, QPixmap
from PySide6.QtWidgets import (QApplication, QFrame, QGridLayout, QLabel,
                               QLineEdit, QListWidgetItem, QPushButton, QDialog,
                               QDialogButtonBox, QFormLayout, QHBoxLayout, QMenu, QToolButton)
from pet.config import Config
from glass_chat import GlassChatWindow, icon
from chat_protocol import ConnectionError, LoginRequired, history_messages
from nianan_client import create_backend_client
from audio_queue import AudioQueue
from chat_theme import TRANSCRIPT_STYLE, VOICE_STYLE, style_chat_menu


class Jobs(QObject):
    delivered = Signal(str, object)
    failed = Signal(str, object)
    event = Signal(object)

    def submit(self, key, operation):
        def run():
            try:
                result = operation()
            except Exception as exc:
                # Never surface request objects, token, URLs or raw transport errors.
                error = exc if isinstance(exc, ConnectionError) else ConnectionError('处理失败，请重试；可刷新查看后台保存的聊天记录')
                self.failed.emit(key, error)
            else:
                self.delivered.emit(key, result)
        threading.Thread(target=run, daemon=True, name='AstrBot-' + key.split(':')[0]).start()


class VoiceButton(QPushButton):
    """A manual voice message with an optional, initially collapsed transcript."""
    transcript_toggled = Signal()

    def __init__(self, attachment_id, parent, *, transcript=''):
        super().__init__(parent)
        self.attachment_id = attachment_id
        self._explicit_transcript = transcript if isinstance(transcript, str) and transcript.strip() else ''
        self._fallback_transcript = ''
        self.setObjectName('voice-message')
        self.setMinimumWidth(0)
        self.setMinimumHeight(40)
        self.setIconSize(QSize(21, 21))
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setStyleSheet(VOICE_STYLE)
        self.transcript_label = QLabel(parent)
        self.transcript_label.setObjectName('voice-transcript')
        self.transcript_label.setMinimumWidth(0)
        self.transcript_label.setWordWrap(True)
        self.transcript_label.setTextFormat(Qt.TextFormat.PlainText)
        self.transcript_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse |
                                                      Qt.TextInteractionFlag.TextSelectableByKeyboard)
        self.transcript_label.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.transcript_label.setAccessibleName('语音文字')
        self.transcript_label.setStyleSheet(TRANSCRIPT_STYLE)
        self.transcript_label.hide()
        self.menu = style_chat_menu(QMenu(self))
        self.transcript_action = self.menu.addAction('转文字')
        self.transcript_action.triggered.connect(self.toggle_transcript)
        self._update_transcript()
        self.set_voice_state('idle')

    @property
    def transcript(self):
        return self._explicit_transcript or self._fallback_transcript

    def set_fallback_transcript(self, text):
        self._fallback_transcript = text if isinstance(text, str) else ''
        self._update_transcript()

    def _update_transcript(self):
        self.transcript_label.setText(self.transcript)
        self.transcript_action.setEnabled(bool(self.transcript.strip()))
        self.transcript_action.setToolTip('' if self.transcript.strip() else '这条语音没有可用文字')
        if self.property('voiceState') is not None:
            self.set_voice_state(self.property('voiceState'))

    def toggle_transcript(self):
        if not self.transcript.strip():
            return
        show = self.transcript_label.isHidden()
        self.transcript_label.setVisible(show)
        self.transcript_action.setText('收起文字' if show else '转文字')
        self.transcript_toggled.emit()

    def contextMenuEvent(self, event):
        self.menu.popup(event.globalPos())
        event.accept()

    def keyPressEvent(self, event):
        if event.key() == Qt.Key.Key_Menu or (event.key() == Qt.Key.Key_F10 and
                                              event.modifiers() & Qt.KeyboardModifier.ShiftModifier):
            self.menu.popup(self.mapToGlobal(self.rect().bottomLeft()))
            event.accept()
            return
        super().keyPressEvent(event)

    def set_voice_state(self, state):
        self.setProperty('voiceState', state)
        label, detail = {
            'idle': ('语音消息', '点击播放'),
            'loading': ('加载中…', '点击取消加载'),
            'playing': ('正在播放', '点击停止播放'),
            'failed': ('重试播放', '语音加载或播放失败，点击重试'),
        }.get(state, ('语音消息', '点击播放'))
        self.setText(label)
        self.setIcon(icon('stop' if state in ('loading', 'playing') else 'speaker'))
        transcript_hint = '右键或菜单键转文字' if self.transcript.strip() else '这条语音没有可用文字'
        self.setToolTip(detail + '；' + transcript_hint)
        self.setAccessibleName('语音消息，' + detail)
        self.setAccessibleDescription(transcript_hint)
        self.style().unpolish(self)
        self.style().polish(self)
        self.update()

    @Slot(str, bool)
    def update_playing(self, key, playing):
        if key == self.attachment_id:
            self.set_voice_state('playing' if playing else 'idle')


class AstrBotChatWindow(GlassChatWindow):
    def __init__(self, client=None, auto_connect=True):
        self.client = client or create_backend_client()
        self.backend_name = getattr(self.client, 'backend_name', 'AstrBot')
        self.local_backend = getattr(self.client, 'is_local_backend', False)
        self.supports_attachments = getattr(self.client, 'supports_attachments', True)
        self.session_id = ''
        self.busy = False
        self.connected = False
        self._callbacks = {}
        self._asr_pending = False
        self.microphone = None
        self._live_bubble = None
        self._live_text = ''
        self._live_reasoning = ''
        self._live_segment_text = ''
        self._live_segment_used = False
        self._live_media_seen = set()
        self._live_voice_pending = None
        self._live_run_id = ''
        self._companion_quiet = False
        self._companion_quiet_check = None
        self._companion_audio_epoch = 0
        self._companion_audio_keys = set()
        self._media_cache = {}
        self._media_waiters = {}
        self._voice_buttons = {}
        self._voice_states = {}
        self._voice_fetches = {}
        self._voice_epoch = 0
        self._view_generation = 0
        self._loading = False
        self._shown_once = False
        self._budget_recovery_pending = False
        self._chat_generation = 0
        self.last_completed_reply = None
        self._completed_reply_id = None
        self._reply_stop_requested = False
        self._stop_pending = False
        self._deferred_chat_completion = None
        self._state_path = self.client.root / 'chat-state.json'
        config = Config(base=self.client.root / 'native-chat-data', instance_id='pc')
        super().__init__(config, 'shenshen')
        self.setAttribute(Qt.WidgetAttribute.WA_QuitOnClose, False)
        self.jobs = Jobs(self)
        self.jobs.delivered.connect(self._delivered)
        self.jobs.failed.connect(self._failed)
        self.jobs.event.connect(self._stream_event)
        self.audio = AudioQueue(self)
        self.audio.failed.connect(self._voice_audio_failed)
        self.audio.changed.connect(self._companion_audio_changed)
        self.audio.changed.connect(self._voice_audio_changed)
        self.setWindowTitle('大肥鱼 · 聊天')
        self.status.setText('正在连接' + self.backend_name + '…')
        self.empty_state.setText('和大肥鱼聊点什么吧')
        self.composer.input.setPlaceholderText('Enter 发送，Shift+Enter 换行')
        self.composer.notice.connect(lambda text: self.status.setText(text))
        self._replace_actions()
        self._install_budget_recovery()
        self._build_login()
        self._install_microphone()
        self._install_stickers()
        self._set_busy(False)
        self._enable_connected(False)
        if auto_connect:
            QTimer.singleShot(0, self.connect_backend)

    # Upstream's SessionStore and model ChatService are deliberately not used.
    def _get_session(self):
        return SimpleNamespace(messages=[], title='大肥鱼', id='pc')

    def _refresh_sessions(self):
        return

    def _load(self):
        return

    def _replace_actions(self):
        for button, name, label, callback in zip(
                self.voice_buttons, ('new', 'refresh', 'stop'),
                ('开启新对话', '刷新会话 / 重新连接', '停止回复'),
                (self.new_session, self.refresh_backend, self.stop_reply)):
            button.setIcon(icon(name))
            button.setToolTip(label)
            button.setAccessibleName(label)
            button.clicked.connect(callback)
        self.new_button, self.refresh_button, self.stop_button = self.voice_buttons
        self.composer.attach_button.setToolTip('添加图片或文本附件' if self.supports_attachments else '此阶段先支持文字聊天，图片和附件尚未接入')
        self.composer.attach_button.setAccessibleName('添加图片或文本附件')
        self.composer.send.setAccessibleName('发送消息')
        self.brand_label.setText('大肥鱼 · 本地聊天' if self.local_backend else 'AstrBot 会话')
        # Hide destructive upstream actions: they operate on its separate store.
        for widget in (self.multi_select_button, self.batch_action_bar,
                       self.delete_session_button, self.clear_button, self.follow_button):
            widget.hide()
        self.hide_session_button = None
        if self.local_backend and callable(getattr(self.client, 'hide_session', None)):
            button = QToolButton(self.sidebar)
            button.setObjectName('hide-session-button')
            button.setText('从列表移除')
            button.setAccessibleName('从列表移除选中的会话')
            hint = '收起选中的会话，保留聊天原文和记忆'
            button.setToolTip(hint)
            button.setAccessibleDescription(hint)
            button.setCursor(Qt.CursorShape.PointingHandCursor)
            button.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
            button.clicked.connect(self.hide_current_session)
            self.session_heading.addWidget(button)
            self.setTabOrder(self.session_list, button)
            self.hide_session_button = button

    def _install_budget_recovery(self):
        self.budget_clear_button = None
        self._budget_recovery_row = None
        if not callable(getattr(self.client, 'clear_usage_budget', None)):
            return
        row = QFrame(self.chat_main)
        row.setObjectName('usage-budget-recovery')
        row.setStyleSheet('''
            QFrame#usage-budget-recovery {background:rgba(245,248,255,225);border:0;}
            QToolButton {color:#243654;background:rgba(210,226,250,225);border:1px solid #9bb8df;
                border-radius:8px;padding:5px 10px;font-size:12px;}
            QToolButton:hover {background:#e3efff;}
            QToolButton:focus {border-color:#4f78a8;}
            QToolButton:disabled {color:#536887;background:rgba(225,232,243,170);border-color:#bacbdf;}
        ''')
        layout = QHBoxLayout(row)
        layout.setContentsMargins(18, 3, 18, 5)
        button = QToolButton(row)
        button.setText('解除本程序限额')
        button.setAccessibleName('解除本程序限额')
        button.setToolTip('解除当前模型连接的全部本程序限额；不会自动重发，也不影响平台账户额度。')
        button.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        button.clicked.connect(self.clear_usage_budget)
        layout.addWidget(button)
        layout.addStretch(1)
        self.chat_main_layout.insertWidget(1, row)
        self.budget_clear_button = button
        self._budget_recovery_row = row
        button.hide()
        row.hide()

    def clear_usage_budget(self):
        button = self.budget_clear_button
        if button is None or button.isHidden() or not self._can_clear_usage_budget():
            return
        self._budget_recovery_pending = True
        self._loading = True
        self._enable_connected(self.connected)
        self.status.setText('正在解除本程序限额…')

        def failed(error):
            self._budget_recovery_pending = False
            self._loading = False
            self._enable_connected(self.connected)
            self._show_error(error)

        def cleared(result):
            if not isinstance(result, dict) or result.get('ok') is not True:
                failed(ConnectionError('解除本程序限额未完成，请稍后重试。'))
                return
            self._budget_recovery_pending = False
            self._loading = False
            button.hide()
            self._budget_recovery_row.hide()
            self._enable_connected(self.connected)
            text = '本程序限额已解除。可重新发送；如上一轮已有回复，请先刷新确认聊天记录。'
            self.status.setText(text)
            self.status.setToolTip(text)

        self._submit(self.client.clear_usage_budget, cleared, failed)

    def _can_clear_usage_budget(self):
        return bool(self.connected and not self.busy and not self._loading
            and not self._budget_recovery_pending and not self._asr_pending
            and not (self.microphone and self.microphone.recording))

    def _show_budget_recovery(self):
        if self.budget_clear_button is not None:
            self._budget_recovery_row.show()
            self.budget_clear_button.show()
            self.budget_clear_button.setEnabled(self._can_clear_usage_budget())

    def _build_login(self):
        # Local chat needs no connection/settings strip; configuration lives in the pet settings.
        self.login_panel = None
        if self.local_backend:
            return
        self.login_panel = QFrame(self.chat_main)
        self.login_panel.setStyleSheet('QFrame {background:rgba(245,249,255,235);border-radius:10px;} QLineEdit {padding:7px;color:#243654;background:white;} QPushButton {padding:7px;color:#243654;background:#e4efff;}')
        layout = QGridLayout(self.login_panel)
        note = QLabel('登录本机 AstrBot。密码不会保存；登录会话由 Windows 加密保存。')
        note.setWordWrap(True)
        layout.addWidget(note, 0, 0, 1, 3)
        self.login_username = QLineEdit('rem')
        self.login_username.setPlaceholderText('AstrBot 用户名')
        self.login_username.setAccessibleName('AstrBot 用户名')
        self.login_password = QLineEdit()
        self.login_password.setEchoMode(QLineEdit.EchoMode.Password)
        self.login_password.setPlaceholderText('AstrBot 登录密码')
        self.login_password.setAccessibleName('AstrBot 登录密码')
        self.login_code = QLineEdit()
        self.login_code.setPlaceholderText('两步验证码（如有）')
        self.login_code.setAccessibleName('两步验证码，可选')
        layout.addWidget(self.login_username, 1, 0)
        layout.addWidget(self.login_password, 1, 1)
        layout.addWidget(self.login_code, 1, 2)
        self.login_button = QPushButton('连接 AstrBot')
        self.login_button.clicked.connect(self.login)
        self.login_password.returnPressed.connect(self.login)
        layout.addWidget(self.login_button, 2, 0, 1, 3)
        self.chat_main_layout.insertWidget(1, self.login_panel)
        self.login_panel.hide()

    def open_backend_settings(self):
        if self.busy or self._loading:
            return
        opener = getattr(self, 'settings_opener', None)
        if self.local_backend and callable(opener):
            opener()
            return
        self._submit(self.client.settings, self._show_backend_settings)

    def _show_backend_settings(self, current):
        dialog = QDialog(self)
        dialog.setWindowTitle('大肥鱼 · 后台设置')
        dialog.setMinimumWidth(440)
        form = QFormLayout(dialog)
        note = QLabel('模型配置仅保存在本机。留空密钥将保留已配置的密钥。')
        note.setWordWrap(True)
        form.addRow(note)
        cloud = current.get('cloud', {})
        url = QLineEdit(cloud.get('baseUrl', ''))
        url.setPlaceholderText('https://api.deepseek.com/v1')
        model = QLineEdit(cloud.get('model', ''))
        model.setPlaceholderText('模型名称')
        key = QLineEdit()
        key.setEchoMode(QLineEdit.EchoMode.Password)
        key.setPlaceholderText('已配置，留空保留' if cloud.get('apiKey') else '填写 API Key')
        form.addRow('API 地址', url)
        form.addRow('模型名称', model)
        form.addRow('API 密钥', key)
        result = QLabel('')
        result.setWordWrap(True)
        form.addRow(result)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Save | QDialogButtonBox.StandardButton.Cancel)
        buttons.button(QDialogButtonBox.StandardButton.Save).setText('保存')
        buttons.button(QDialogButtonBox.StandardButton.Cancel).setText('取消')
        form.addRow(buttons)
        buttons.rejected.connect(dialog.reject)
        def save():
            if not url.text().strip() or not model.text().strip() or (not key.text().strip() and not cloud.get('apiKey')):
                result.setText('请填写 API 地址、模型名称和密钥')
                return
            buttons.setEnabled(False)
            payload = {'provider': 'cloud', 'cloud': {
                'baseUrl': url.text().strip(), 'model': model.text().strip(),
                'apiKey': key.text().strip() or '***',
            }}
            def saved(_):
                key.clear()
                dialog.accept()
                self.status.setText('配置已保存，可以开始聊天')
            def failed(error):
                buttons.setEnabled(True)
                result.setText(str(error))
            self._submit(lambda: self.client.save_settings(payload), saved, failed)
        buttons.accepted.connect(save)
        self._backend_settings_dialog = dialog
        dialog.open()

    def _install_stickers(self):
        self.sticker_picker = None
        self._draft_sticker = None
        if not getattr(self.client, 'supports_stickers', False):
            return
        self.sticker_button = QToolButton(self.composer.toolbar)
        self.sticker_button.setObjectName('glass-sticker')
        self.sticker_button.setIcon(icon('sticker'))
        self.sticker_button.setToolTip('添加或替换表情包')
        self.sticker_button.setAccessibleName('添加或替换表情包')
        self.sticker_button.clicked.connect(self._open_sticker_picker)
        self.composer.toolbar.layout().insertWidget(2, self.sticker_button)
        self.composer.toolbar.setFixedWidth(174)
        self.sticker_draft = QFrame(self.composer)
        self.sticker_draft.setObjectName('sticker-draft')
        self.sticker_draft.setStyleSheet('''
            QFrame#sticker-draft {background:transparent;}
            QLabel {color:#334b70;background:transparent;font-size:12px;}
            QToolButton {color:#243654;background:transparent;border:1px solid transparent;border-radius:7px;}
            QToolButton:hover {background:rgba(255,255,255,170);}
            QToolButton:focus {border-color:#658fbc;}
            QToolButton:disabled {color:#536887;}
        ''')
        row = QHBoxLayout(self.sticker_draft)
        row.setContentsMargins(4, 0, 0, 4)
        row.setSpacing(10)
        self.sticker_draft_preview = QLabel(self.sticker_draft)
        self.sticker_draft_preview.setFixedSize(44, 44)
        self.sticker_draft_preview.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.sticker_draft_preview.setAccessibleName('待发送表情预览')
        row.addWidget(self.sticker_draft_preview)
        hint = QLabel('已添加表情，可与文字一起发送', self.sticker_draft)
        hint.setWordWrap(True)
        hint.setMinimumWidth(0)
        row.addWidget(hint, 1)
        self.sticker_remove_button = QToolButton(self.sticker_draft)
        self.sticker_remove_button.setIcon(icon('close'))
        self.sticker_remove_button.setFixedSize(30, 30)
        self.sticker_remove_button.setToolTip('移除待发送表情')
        self.sticker_remove_button.setAccessibleName('移除待发送表情')
        self.sticker_remove_button.clicked.connect(self.remove_sticker)
        row.addWidget(self.sticker_remove_button)
        self.composer.layout().insertWidget(0, self.sticker_draft)
        self.sticker_draft.hide()

    def _open_sticker_picker(self):
        if not self._can_send_sticker():
            return
        if self.sticker_picker is None:
            from sticker_picker import StickerPicker
            self.sticker_picker = StickerPicker(self.client, self)
            self.sticker_picker.selected.connect(self.select_sticker)
        self.sticker_picker.open_above(self.sticker_button)

    def _can_send_sticker(self):
        return (getattr(self.client, 'supports_stickers', False) and self.connected and self.session_id
                and not self.busy and not self._loading and not self._asr_pending
                and not (self.microphone and self.microphone.recording))

    def select_sticker(self, sticker):
        if not self._can_send_sticker() or not isinstance(sticker, dict) or not sticker.get('id'):
            return
        self._draft_sticker = dict(sticker)
        draft = self._draft_sticker
        self.sticker_draft_preview.clear()
        self.sticker_draft_preview.setText('加载中')
        self.sticker_draft_preview.setToolTip(str(sticker.get('name') or '表情包'))
        self.sticker_draft.show()
        self.composer.set_pending_media(True)
        self._enable_connected(self.connected)
        self.composer.input.setFocus()
        self._update_conversation_height()
        key = 'picker-sticker:' + sticker['id']
        def loaded(data):
            if self._draft_sticker is not draft:
                return
            pixmap = QPixmap()
            if pixmap.loadFromData(data):
                self.sticker_draft_preview.setPixmap(pixmap.scaled(
                    self.sticker_draft_preview.size(), Qt.AspectRatioMode.KeepAspectRatio,
                    Qt.TransformationMode.SmoothTransformation))
                if len(self._media_cache) >= 40:
                    self._media_cache.pop(next(iter(self._media_cache)))
                self._media_cache[key] = data
            else:
                failed(None)
        def failed(error):
            if self._draft_sticker is draft:
                self.sticker_draft_preview.setText('表情')
                self.sticker_draft_preview.setToolTip('预览暂不可用，可移除或重新选择')
        if key in self._media_cache:
            loaded(self._media_cache[key])
        else:
            self._submit(lambda: self.client.sticker_image(sticker['id']), loaded, failed)

    def remove_sticker(self):
        if self.busy:
            return
        self._clear_draft_sticker()
        self.composer.input.setFocus()

    def _clear_draft_sticker(self):
        self._draft_sticker = None
        self.sticker_draft.hide()
        self.sticker_draft_preview.clear()
        self.composer.set_pending_media(False)
        self._enable_connected(self.connected)
        self._update_conversation_height()

    def _install_microphone(self):
        if not self.local_backend:
            return
        from voice_capture import MicrophoneRecorder
        self.microphone = MicrophoneRecorder(self)
        self.microphone.finished.connect(self._transcribe_audio)
        self.microphone.failed.connect(self._microphone_failed)
        self.mic_button = QToolButton(self.composer.toolbar)
        self.mic_button.setObjectName('composer-attach-button')
        self.mic_button.setIcon(icon('mic'))
        self.mic_button.setToolTip('语音输入：点击录音，再次点击停止')
        self.mic_button.setAccessibleName('开始或停止语音输入')
        self.mic_button.setCheckable(True)
        self.mic_button.clicked.connect(self._toggle_microphone)
        self.composer.toolbar.layout().insertWidget(1,self.mic_button)

    def _microphone_failed(self,text):
        self.mic_button.setChecked(False)
        self.status.setText(text)
        self._enable_connected(self.connected)

    def _toggle_microphone(self):
        if self.microphone.recording:
            self.microphone.stop()
            return
        if self.busy or self._loading or self._asr_pending or not self.connected:
            self.mic_button.setChecked(False)
            return
        self.audio.stop()
        if self.microphone.start():
            self.mic_button.setChecked(True)
            self.status.setText('正在录音，点击麦克风停止（最多 45 秒）…')
        self._enable_connected(self.connected)

    def _transcribe_audio(self,data):
        self.mic_button.setChecked(False)
        self._asr_pending=True
        self._enable_connected(self.connected)
        self.status.setText('正在识别语音…')
        def work():
            result=self.client.transcribe(data)
            settings=self.client.settings()
            return result.get('text',''),bool(settings.get('voice',{}).get('autoSend',False))
        def done(result):
            self._asr_pending=False
            text,auto_send=result
            self._enable_connected(self.connected)
            if not text.strip():
                self.status.setText('没有识别到有效文字，请重新录音。')
                return
            draft=self.composer.input.toPlainText().strip()
            self.composer.input.setPlainText((draft+'\n' if draft else '')+text.strip())
            self.status.setText('语音已转为文字，可修改后发送。')
            if auto_send and self.isVisible():
                self.send_message()
        def failed(error):
            self._asr_pending=False
            self._enable_connected(self.connected)
            self._show_error(error)
        self._submit(work,done,failed)

    def _submit(self, operation, success, failure=None):
        key = uuid.uuid4().hex
        self._callbacks[key] = (success, failure)
        self.jobs.submit(key, operation)

    def _delivered(self, key, value):
        callback, _ = self._callbacks.pop(key, (None, None))
        if callback:
            callback(value)

    def _failed(self, key, error):
        _, failure = self._callbacks.pop(key, (None, None))
        if failure:
            failure(error)
        else:
            self._show_error(error)

    def _show_error(self, error):
        self.status.setText(str(error))
        self.status.setToolTip(str(error))
        code = getattr(error, 'code', '')
        if isinstance(code, str) and code.startswith('usage_budget_'):
            self._show_budget_recovery()
        if isinstance(error, LoginRequired):
            self._enable_connected(False)
            if self.login_panel is not None:
                self.login_panel.show()

    def _enable_connected(self, value):
        self.connected = value
        self.composer.input.setReadOnly(not value)
        self.composer.attach_button.setEnabled(self.supports_attachments and value and not self.busy and not self._loading)
        self.new_button.setEnabled(value and not self.busy and not self._loading)
        self.refresh_button.setEnabled(not self.busy and not self._loading)
        self.session_list.setEnabled(value and not self.busy and not self._loading)
        self.new_session_button.setEnabled(value and not self.busy and not self._loading)
        self.stop_button.setEnabled(self.busy)
        self.composer._update_enabled()
        recording=bool(self.microphone and self.microphone.recording)
        if hasattr(self,'mic_button'):
            self.mic_button.setEnabled(value and not self.busy and not self._loading and not self._asr_pending)
        if hasattr(self, 'sticker_button'):
            self.sticker_button.setEnabled(bool(self._can_send_sticker()))
            self.sticker_remove_button.setEnabled(not self.busy)
            if self.sticker_picker is not None and not self.sticker_button.isEnabled():
                self.sticker_picker.hide()
        if self.budget_clear_button is not None:
            self.budget_clear_button.setEnabled(self._can_clear_usage_budget())
        if recording or self._asr_pending:
            self.composer.input.setReadOnly(True)
            for button in (self.new_button,self.refresh_button,self.new_session_button,self.session_list):button.setEnabled(False)
        self._update_hide_button()
        if not value or not self.session_id or self._loading or recording or self._asr_pending:
            self.composer.send.setEnabled(False)

    def _set_busy(self, value):
        self.busy = value
        self.composer.set_busy(value)
        self.composer.send.setText('停止' if value else '发送')
        self.composer.send.setIcon(icon('stop' if value else 'send'))
        self._enable_connected(self.connected)

    def connect_backend(self):
        if self._loading or self.busy:
            return
        self._loading = True
        self._enable_connected(False)
        self.status.setText('正在连接' + self.backend_name + '…')
        def load():
            self.client.restore_login()
            sessions = self.client.sessions()
            if sessions:
                self.client.username = sessions[0].get('creator', '')
            self.client.remember_login()
            return sessions
        self._submit(load, self._connected, self._connection_failed)

    def _connection_failed(self, error):
        self._loading = False
        self._show_error(error)
        self._enable_connected(False)

    def login(self):
        if not self.login_password.text() or self._loading:
            return
        username, password, code = self.login_username.text(), self.login_password.text(), self.login_code.text()
        self._loading = True
        self.login_button.setEnabled(False)
        def authenticate():
            self.client.login(username, password, code)
            return self.client.sessions()
        def success(sessions):
            self.login_password.clear()
            self.login_code.clear()
            self.login_button.setEnabled(True)
            self._connected(sessions)
        def failed(error):
            self.login_button.setEnabled(True)
            self._connection_failed(error)
        self._submit(authenticate, success, failed)

    def _connected(self, sessions):
        self._loading = False
        if self.login_panel is not None:
            self.login_panel.hide()
        self._enable_connected(True)
        try:
            saved_id = json.loads(self._state_path.read_text('utf-8'))['session_id']
        except (OSError, ValueError, KeyError):
            saved_id = ''
        target = self.session_id or saved_id
        if self.local_backend and sessions:
            self._open_session(target, visible_sessions=sessions)
        elif target in {row['session_id'] for row in sessions}:
            self._open_session(target)
        else:
            self._populate_sessions(sessions)
            self.new_session()

    def _populate_sessions(self, sessions):
        self.session_list.blockSignals(True)
        self.session_list.clear()
        for row in sessions:
            item = QListWidgetItem(row.get('display_name') or '未命名对话')
            item.setData(Qt.ItemDataRole.UserRole, row['session_id'])
            self.session_list.addItem(item)
            if row['session_id'] == self.session_id:
                self.session_list.setCurrentItem(item)
        self.session_list.blockSignals(False)
        self._update_hide_button()

    def _update_hide_button(self):
        if self.hide_session_button is not None:
            item = self.session_list.currentItem()
            self.hide_session_button.setEnabled(bool(
                self.session_list.isEnabled() and self.session_id and item
                and item.data(Qt.ItemDataRole.UserRole) == self.session_id
            ))

    def _on_session_changed(self, index):
        if index >= 0 and not self.busy and not self._loading:
            item = self.session_list.item(index)
            self._open_session(item.data(Qt.ItemDataRole.UserRole))

    def _on_session_item_clicked(self, item):
        return  # currentRowChanged already opens it exactly once.

    def new_session(self):
        if not self.connected or self.busy or self._loading:
            return
        self._loading = True
        self._enable_connected(True)
        self.status.setText('正在开启新对话…')
        self._submit(self.client.create_session, self._open_session, self._load_failed)

    def hide_current_session(self):
        if self.hide_session_button is None or not self.hide_session_button.isEnabled():
            return
        session_id = self.session_id
        self._loading = True
        self._enable_connected(True)
        self.status.setText('正在从列表移除…')

        def hidden(result):
            if (not isinstance(result, dict) or result.get('session_id') != session_id
                    or not isinstance(result.get('sessions'), list) or not result.get('next_session_id')):
                self._open_session(session_id)
                return
            self._open_session(result['next_session_id'], visible_sessions=result['sessions'],
                               notice='已从列表移除，聊天原文和记忆已保留')

        self._submit(lambda: self.client.hide_session(session_id), hidden, self._load_failed)

    def _open_session(self, session_id, *, visible_sessions=None, notice=None):
        if session_id != self.session_id:
            self._stop_voice_playback()
        self._loading = True
        self._enable_connected(True)
        self.status.setText('正在加载对话…')
        def loaded(target, history, sessions):
            self.session_id = target
            try:
                self._state_path.parent.mkdir(parents=True, exist_ok=True)
                self._state_path.write_text(json.dumps({'session_id': target}), 'utf-8')
            except OSError:
                # A read-only local state directory must not block backend history.
                self.status.setToolTip('无法记住当前会话，聊天记录仍保存在后台')
            self._loading = False
            self._populate_sessions(sessions)
            self._render_history(history)
            self.status.setText(notice or '已连接' + self.backend_name)
            self._enable_connected(True)
            if notice and self.sidebar.isVisible():
                self.session_list.setFocus()
            else:
                self.composer.input.setFocus()

        def open_visible(sessions):
            # Archived history is readable by ID. Choose only from the visible list and
            # stop displaying an archived session even if the next history fails to load.
            visible = {row['session_id'] for row in sessions}
            if self.session_id and self.session_id not in visible:
                self.session_id = ''
                self._render_history({})
            if not self.session_id:
                self._populate_sessions(sessions)
            if not sessions:
                self._load_failed(ConnectionError('没有可显示的会话，请刷新或开启新对话'))
                return
            target = session_id if session_id in visible else sessions[0]['session_id']
            self._submit(lambda: self.client.history(target),
                         lambda history: loaded(target, history, sessions), self._load_failed)

        if not self.local_backend:
            self._submit(lambda: (self.client.history(session_id), self.client.sessions()),
                         lambda data: loaded(session_id, *data), self._load_failed)
        elif visible_sessions is None:
            self._submit(self.client.sessions, open_visible, self._load_failed)
        else:
            open_visible(visible_sessions)

    def has_visible_draft(self):
        return bool(self.isVisible() and not self.isMinimized() and (self.composer.input.toPlainText().strip()
                                         or self._draft_sticker is not None or self.composer.attachment_paths))

    def deliver_companion_event(self,event,delivered):
        session_id=self.session_id
        if self.busy or self._loading or self.has_visible_draft() or event.get('session_id') != session_id:
            return False
        view_generation=self._view_generation
        chat_generation=self._chat_generation
        def loaded(history):
            # A user can start drafting or sending while the history request is in flight.
            if (not self.isVisible() or self.busy or self._loading or self.has_visible_draft()
                    or self.audio.current or self._voice_fetches or self._asr_pending
                    or (self.microphone and self.microphone.recording) or self._companion_suppressed()
                    or self.session_id != session_id
                    or self._view_generation != view_generation or self._chat_generation != chat_generation):
                delivered(False)
                return
            self._render_history(history)
            self.status.setText('已收到新的主动消息')
            delivered(True)
        self._submit(lambda:self.client.history(session_id),loaded,lambda _error:delivered(False))
        return True

    def _load_failed(self, error):
        # A clicked row can fail to load. Keep the selection on the conversation
        # still on screen so its list action and draft target remain unambiguous.
        if self.session_id:
            for index in range(self.session_list.count()):
                if self.session_list.item(index).data(Qt.ItemDataRole.UserRole) == self.session_id:
                    self.session_list.setCurrentRow(index)
                    break
        self._loading = False
        self._enable_connected(self.connected)
        self._show_error(error)

    def refresh_backend(self):
        if self.busy or self._loading:
            return
        if not self.connected:
            self.connect_backend()
        else:
            self._open_session(self.session_id)

    def _render_history(self, history):
        self._view_generation += 1
        self._stop_voice_playback()
        self._voice_buttons.clear()
        self._voice_states.clear()
        self._clear_message_rows()
        for role, parts in history_messages(history):
            texts = [part.get('text', '') for part in parts if part.get('type') == 'plain']
            media = [p for p in parts if p.get('type') in ('image', 'record', 'file', 'video')]
            if not texts and not media:
                continue
            has_voice = any(p.get('type') == 'record' and p.get('attachment_id') for p in media)
            original = '\n'.join(texts)
            # Keep paired plain text out of both the body and its Markdown renderer.
            bubble = self._add(role, '' if has_voice else original)
            for part in media:
                self._attach_media(bubble, part, fallback_transcript=original if has_voice else '')
        self._set_empty_state(not self._bubbles)
        self._update_bubble_widths()
        self._update_conversation_height()
        self._bottom(always=True)

    def _attach_media(self, bubble, part, *, fallback_transcript=''):
        attachment_id = part.get('attachment_id')
        sticker_id = part.get('sticker_id') if not attachment_id else None
        if sticker_id:
            attachment_id = 'picker-sticker:' + sticker_id
        if part.get('type') == 'record' and attachment_id:
            button = VoiceButton(attachment_id, bubble.surface, transcript=part.get('transcript', ''))
            button.set_fallback_transcript(fallback_transcript or bubble.content)
            voices = getattr(bubble, '_voice_messages', [])
            voices.append(button)
            bubble._voice_messages = voices
            bubble.surface_layout.insertWidget(0, button)
            bubble.surface_layout.insertWidget(1, button.transcript_label)
            bubble.set_content('', markdown=False)
            bubble.body.hide()
            bubble.setMinimumHeight(0)
            bubble.setProperty('mediaWidth', max(bubble.property('mediaWidth') or 0, 244))
            self._voice_buttons.setdefault(attachment_id, []).append(button)
            button.set_voice_state(self._voice_states.get(attachment_id, 'idle'))
            button.transcript_toggled.connect(self._voice_layout_changed)
            button.clicked.connect(lambda: self._play_voice(attachment_id))
            return
        label = QLabel(bubble.surface)
        label.setWordWrap(True)
        label.setStyleSheet('color:#243654;background:transparent;padding:5px;')
        bubble.surface_layout.addWidget(label)
        if part.get('type') != 'image' or not attachment_id:
            label.setText('附件：' + part.get('filename', part.get('type', '文件')) + '（可在 AstrBot 后台查看）')
            return
        label.setText('正在加载图片…')
        generation = self._view_generation
        def show(data):
            if generation != self._view_generation:
                return
            pixmap = QPixmap()
            if pixmap.loadFromData(data):
                available = self.scroll.viewport().width() - 2 * self.message_horizontal_margin
                size = pixmap.size().scaled(QSize(min(320, max(100, int(available * .72)-48)), 280), Qt.AspectRatioMode.KeepAspectRatio)
                buffer = QBuffer(label)
                buffer.setData(QByteArray(data))
                buffer.open(QIODevice.OpenModeFlag.ReadOnly)
                movie = QMovie(buffer, QByteArray(), label)
                if movie.isValid() and movie.frameCount() > 1:
                    movie.setScaledSize(size)
                    label.setMovie(movie)
                    movie.start()
                else:
                    movie.deleteLater()
                    buffer.deleteLater()
                    label.setPixmap(pixmap.scaled(size, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation))
                label.setAccessibleName('图片或表情包')
                label.setFixedSize(size)
                bubble.setProperty('mediaWidth', max(bubble.property('mediaWidth') or 0, size.width() + 48))
                bubble.body.setVisible(bool(bubble.content))
                bubble.setMinimumHeight(0)
                self._update_bubble_widths()
                self._update_conversation_height()
            else:
                label.setText('图片暂无法预览，可在 AstrBot 后台查看')
        if attachment_id in self._media_cache:
            show(self._media_cache[attachment_id])
        else:
            def loaded(data):
                # Bounded in-memory cache, never executes/downloads remote URLs.
                if len(self._media_cache) >= 40:
                    self._media_cache.pop(next(iter(self._media_cache)))
                self._media_cache[attachment_id] = data
                show(data)
            self._submit(lambda: self.client.sticker_image(sticker_id) if sticker_id else self.client.attachment(attachment_id), loaded,
                         lambda error: label.setText('图片加载失败，点击刷新重试') if generation == self._view_generation else None)

    def _companion_suppressed(self):
        if callable(self._companion_quiet_check):
            return bool(self._companion_quiet_check())
        return self._companion_quiet

    def set_companion_quiet(self, quiet, check=None):
        self._companion_quiet = bool(quiet)
        if callable(check):
            self._companion_quiet_check = check
        if not quiet:
            return
        self._companion_audio_epoch += 1
        keys = set(self._companion_audio_keys)
        self.audio.cancel(keys)
        for key in keys:
            self._voice_fetches.pop(key, None)
            self._set_voice_state(key, 'idle')
        self._companion_audio_keys.clear()

    def _companion_audio_changed(self, key, playing):
        if not playing:
            self._companion_audio_keys.discard(key)

    def _voice_layout_changed(self):
        self._update_bubble_widths()
        self._update_conversation_height()

    def _set_voice_state(self, key, state):
        self._voice_states[key] = state
        for button in self._voice_buttons.get(key, []):
            button.set_voice_state(state)

    def _voice_audio_changed(self, key, playing):
        if playing:
            self._set_voice_state(key, 'playing')
        elif self._voice_states.get(key) != 'failed':
            self._set_voice_state(key, 'idle')

    def _voice_audio_failed(self, _text):
        key = self.audio.current
        if key is not None:
            self._set_voice_state(key, 'failed')
        self.status.setText('语音播放失败，请检查声音输出设备后点击语音条重试。')

    def _stop_voice_playback(self):
        # Downloads may finish after a refresh, a second click, or a session switch.
        self._voice_epoch += 1
        self._voice_fetches.clear()
        self.audio.stop()
        self._companion_audio_keys.clear()
        for key, state in list(self._voice_states.items()):
            if state in ('loading', 'playing'):
                self._set_voice_state(key, 'idle')

    def _play_voice(self, attachment_id, *, companion=False):
        if companion and self._companion_suppressed():
            return
        if self.audio.current == attachment_id or attachment_id in self._voice_fetches:
            self._stop_voice_playback()
            return
        self._stop_voice_playback()
        if not self.audio.reserve(attachment_id):
            self._set_voice_state(attachment_id, 'failed')
            return
        epoch = self._voice_epoch
        generation = self._view_generation
        self._voice_fetches[attachment_id] = epoch
        self._set_voice_state(attachment_id, 'loading')
        if companion:
            self._companion_audio_keys.add(attachment_id)
        def loaded(data):
            if epoch != self._voice_epoch or generation != self._view_generation or self._voice_fetches.get(attachment_id) != epoch:
                return
            self._voice_fetches.pop(attachment_id, None)
            if companion and self._companion_suppressed():
                self.set_companion_quiet(True)
                self._set_voice_state(attachment_id, 'idle')
                return
            if not isinstance(data, (bytes, bytearray)) or not data:
                failed(None)
                return
            self.audio.ready(attachment_id, data)
        def failed(error):
            if epoch != self._voice_epoch or generation != self._view_generation:
                return
            self._voice_fetches.pop(attachment_id, None)
            self._companion_audio_keys.discard(attachment_id)
            self.audio.discard(attachment_id)
            self._set_voice_state(attachment_id, 'failed')
            self.status.setText('语音加载失败，点击语音条重试。')
        self._submit(lambda: self.client.attachment(attachment_id), loaded, failed)

    def _next_live_segment(self):
        self._live_voice_pending = None
        if self._live_bubble is None or self._live_segment_used:
            if self._live_bubble is not None:
                self._live_bubble.finish_thinking()
                self._live_bubble.set_state('done')
            self._live_bubble = self._add('assistant', '')
        if self._live_reasoning:
            self._live_bubble.append_reasoning(self._live_reasoning)
            self._live_reasoning = ''
        self._live_segment_used = True
        self._live_segment_text = ''

    def send_message(self):
        if self.busy:
            self.stop_reply()
            return
        if not self.connected or self._loading or not self.session_id or self._asr_pending or (self.microphone and self.microphone.recording):
            return
        text = self.composer.input.toPlainText().strip()
        files = list(self.composer.attachment_paths)
        if files and not self.supports_attachments:
            self.status.setText('此阶段暂未接入图片和附件，请移除附件后发送文字')
            return
        sticker = self._draft_sticker
        if not text and not files and sticker is None:
            return
        self._send_turn(text, files, sticker=sticker)

    def _send_turn(self, text, files, *, sticker=None):
        if sticker is not None:
            user_bubble = self._add('user', text)
            self._attach_media(user_bubble, {'type': 'image', 'sticker_id': sticker['id']})
        else:
            self._add('user', text + ('\n' if text and files else '') + '\n'.join('附件：'+p.name for p in files))
        # The status bar owns waiting feedback. Insert a reply row only when
        # actual text or media arrives, so slow requests do not leave a white card.
        self._live_bubble = None
        self._live_text = ''
        self._live_reasoning = ''
        self._live_segment_text = ''
        self._live_segment_used = False
        self._live_media_seen.clear()
        self._live_voice_pending = None
        self._live_run_id = ''
        self.last_completed_reply = None
        self._completed_reply_id = None
        self._reply_stop_requested = False
        self.composer.input.clear()
        if sticker is not None:
            self._clear_draft_sticker()
        self._set_busy(True)
        self._chat_generation += 1
        generation = self._chat_generation
        session_id = self.session_id
        self._media_warning = ''
        self.status.setText('大肥鱼正在回复…')
        def run():
            emit = lambda event: self.jobs.event.emit((generation, event))
            if sticker is None:
                completed = self.client.chat(session_id, text, files, emit)
            else:
                completed = self.client.chat(session_id, text, files, emit, sticker_id=sticker['id'])
            if completed is False:
                return None  # A stopped animation must not reveal its remaining saved text.
            return self.client.history(session_id)
        def finished(history):
            if self._stop_pending:
                self._deferred_chat_completion = lambda: finished(history)
                return
            if sticker is None:
                self.composer.clear_attachments()  # Clipboard files must survive upload.
            if history is None and self._live_bubble is not None:
                self._live_bubble.finish_thinking()
                self._live_bubble.set_state('done')
            self._live_bubble = None
            self._set_busy(False)
            if history is not None:
                self._render_history(history)
                if self._completed_reply_id and not self._reply_stop_requested:
                    self.last_completed_reply = {'session_id':session_id,'request_id':self._completed_reply_id}
            self.status.setText('已停止显示。' if history is None else
                                getattr(self, '_media_warning', '') or '已连接' + self.backend_name)
            view_generation = self._view_generation
            def refresh_list(sessions):
                if self._view_generation == view_generation and self.session_id == session_id and not self._loading:
                    self._populate_sessions(sessions)
            self._submit(self.client.sessions, refresh_list)
        def failed(error):
            if self._stop_pending:
                self._deferred_chat_completion = lambda: failed(error)
                return
            self._set_busy(False)
            if self._live_bubble:
                if not getattr(self._live_bubble, '_voice_messages', None):
                    self._live_bubble.set_content(self._live_segment_text or '未能完成回复。已发送的消息可通过刷新会话确认；请勿重复发送。')
                self._live_bubble.set_state('error')
                self._update_bubble_widths()
                self._update_conversation_height()
                self._bottom()
            if sticker is not None and self._draft_sticker is None:
                self.select_sticker(sticker)
            self._show_error(error)
            # Keep uploaded draft attachments for explicit user recovery.
            if not self.composer.input.toPlainText():
                self.composer.input.setPlainText(text)
        self._submit(run, finished, failed)

    def _stream_event(self, value):
        generation, event = value
        if generation != self._chat_generation or not self.busy:
            return
        kind, text = event.get('type'), event.get('data', '')
        if kind == 'usage_budget_blocked':
            self._show_budget_recovery()
            return
        if kind == 'end' and event.get('reply_completed') is True:
            self._completed_reply_id = event.get('message_id')
        if event.get('message_id'):
            self._live_run_id = event['message_id']
        chain = event.get('chain_type')
        if kind == 'media_warning':
            self._media_warning = str(text)
            self.status.setText(self._media_warning)
        elif kind == 'plain' and chain == 'reasoning':
            if not isinstance(text, str) or not text.strip():
                return
            if self._live_bubble is None:
                self._live_reasoning += text
                self.status.setText('大肥鱼正在思考…')
            else:
                self._live_bubble.append_reasoning(text)
        elif kind == 'plain' and chain not in ('tool_call', 'tool_call_result'):
            streaming = bool(event.get('streaming'))
            if not isinstance(text, str) or not text or (not text.strip() and
                                                       (not streaming or not self._live_segment_used)):
                return
            pending = self._live_voice_pending
            paired_voice = pending is not None and pending == event.get('message_id', '')
            if not paired_voice and (not streaming or not self._live_segment_used):
                self._next_live_segment()
            self._live_segment_text += str(text)
            self._live_text += str(text) if event.get('streaming') else ('\n' if self._live_text else '') + str(text)
            if paired_voice:
                for button in getattr(self._live_bubble, '_voice_messages', []):
                    button.set_fallback_transcript(self._live_segment_text)
                self._live_bubble.body.hide()
            else:
                complete = event.get('segment_complete')
                self._live_bubble.set_content(self._live_segment_text, markdown=complete is True,
                                              partial=complete is False)
                self._live_bubble.body.show()
            self._live_bubble.finish_thinking()
            self._live_bubble.set_state('done')
            self._update_bubble_widths()
            self._update_conversation_height()
            self._bottom()
        elif kind == 'attachment_saved':
            part = event.get('data') or {}
            if not isinstance(part, dict):
                return
            attachment_id = part.get('id')
            if not isinstance(attachment_id, str) or not attachment_id.strip():
                return
            if part.get('type') in ('image', 'record', 'file', 'video') and attachment_id not in self._live_media_seen:
                self._live_media_seen.add(attachment_id)
                self._next_live_segment()
                self._live_bubble.finish_thinking()
                self._live_bubble.set_state('done')
                self._attach_media(self._live_bubble, {**part, 'attachment_id': attachment_id})
                if part.get('type') == 'record':
                    self._live_voice_pending = event.get('message_id', '')
                self._update_bubble_widths()
                self._update_conversation_height()
                self._bottom()
        elif chain in ('tool_call', 'tool_call_result'):
            self.status.setText('大肥鱼正在使用工具…')
        elif kind == 'error':
            self.status.setText(self.backend_name + '回复出错，请查看后台日志')

    def stop_reply(self):
        self._stop_voice_playback()
        if not self.busy or not self.stop_button.isEnabled():
            return
        self._reply_stop_requested = True
        self.stop_button.setEnabled(False)
        self.composer.send.setEnabled(False)
        self._stop_pending = True
        session_id = self.session_id
        self.status.setText('正在停止回复…')
        def release_stop():
            self._stop_pending = False
            completion, self._deferred_chat_completion = self._deferred_chat_completion, None
            if completion is not None:
                completion()
        def stopped(_):
            self.status.setText('已请求停止，正在保存已有回复…')
            release_stop()
        def failed(error):
            release_stop()
            if self.busy:
                self.stop_button.setEnabled(True)
                self.composer.send.setEnabled(True)
            self._show_error(error)
        self._submit(lambda: self.client.stop(session_id), stopped, failed)

    def showEvent(self, event):
        super().showEvent(event)
        if self._shown_once and self.local_backend and self.connected and self.session_id:
            # A bubble shown while this window was hidden already acknowledged
            # its delivery. Reopening the window must read the saved history.
            QTimer.singleShot(0, self, self._refresh_reopened_history)
        self._shown_once = True

    def _refresh_reopened_history(self):
        if (self.isVisible() and not self.isMinimized() and self.connected and self.session_id
                and not self._asr_pending and not self.audio.current and not self._voice_fetches
                and not (self.microphone and self.microphone.recording)):
            self.refresh_backend()

    def closeEvent(self, event):
        if self.sticker_picker is not None:
            self.sticker_picker.hide()
        if self.microphone and self.microphone.recording:
            self.microphone.cancel()
            self.mic_button.setChecked(False)
            self._enable_connected(self.connected)
        # The window is reusable. Accept its close event so it cannot veto app exit.
        self._stop_voice_playback()
        event.accept()


def create_chat_window():
    return AstrBotChatWindow()


if __name__ == '__main__':
    app = QApplication(sys.argv)
    window = create_chat_window()
    window.show()
    sys.exit(app.exec())
