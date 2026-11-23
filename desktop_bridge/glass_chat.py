"""NianAn-inspired native glass theme, painted over one static wallpaper."""
import os
from pathlib import Path
from PIL import Image, ImageFilter
from PySide6.QtCore import QByteArray, QEvent, QPoint, QRectF, QSize, Qt
from PySide6.QtGui import QColor, QIcon, QImage, QPainter, QPainterPath, QPixmap, QTextDocument
from PySide6.QtSvg import QSvgRenderer
from PySide6.QtWidgets import QApplication, QFrame, QHBoxLayout, QLabel, QSlider, QToolButton, QVBoxLayout, QSizePolicy
from pet.chat.widgets import ChatWindow
from chat_theme import ChatMenuFilter, style_chat_menu

BACKGROUND = Path(__file__).resolve().parents[1] / 'assets' / 'bg.png'
INK = '#243654'
PATHS = {
    'minimize': '<path d="M5 12h14"/>',
    'close': '<path d="M18 6L6 18M6 6l12 12"/>',
    'pin': '<path d="M12 17v5M9 3h6l1 7h1a2 2 0 0 1 2 2 4 4 0 0 1-4 4H9a4 4 0 0 1-4-4 2 2 0 0 1 2-2h1l1-7z"/>',
    'settings': '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>',
    'sidebar': '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
    'image': '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><path d="m21 15-5-5L5 21"/>',
    'sticker': '<circle cx="12" cy="12" r="9"/><path d="M8 14a4 4 0 0 0 8 0M8 9h.01M16 9h.01"/>',
    'mic': '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/>',
    'call': '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72l.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45l2.81.7A2 2 0 0 1 22 16.92z"/>',
    'speaker': '<path d="M11 5L6 9H2v6h4l5 4V5zM15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/>',
    'send': '<path d="m3 3 18 9-18 9 3-9-3-9zM6 12h15"/>',
    'new': '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 7v10M7 12h10"/>',
    'refresh': '<path d="M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3"/>',
    'stop': '<rect x="6" y="6" width="12" height="12" rx="2"/>',
}


def icon(name):
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="{INK}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">{PATHS[name]}</svg>'
    renderer = QSvgRenderer(QByteArray(svg.encode()))
    pix = QPixmap(40, 40)
    pix.fill(Qt.GlobalColor.transparent)
    painter = QPainter(pix)
    renderer.render(painter)
    painter.end()
    return QIcon(pix)


QSS = '''
QDialog#chat-window { background:transparent; color:#243654; font-family:"Microsoft YaHei UI"; }
QFrame#phone-shell { background:rgba(255,255,255,12); border:1px solid rgba(255,255,255,115); border-radius:14px; }
QFrame#deepseek-sidebar { background:rgba(244,248,255,185); border:0; border-right:1px solid rgba(255,255,255,100); }
QFrame#chat-main, QFrame#floating-composer { background:transparent; }
QFrame#chat-main-header { background:rgba(255,255,255,200); border:0; border-bottom:1px solid rgba(255,255,255,85); }
QLabel#title-label {color:#203151; font-size:16px; font-weight:600;}
QLabel#status-label {color:#334b70; font-size:11px;}
QLabel#brand-label {color:#243654; font-size:16px;}
QScrollArea#message-scroll, QScrollArea#message-scroll QWidget#qt_scrollarea_viewport,
QWidget#message-view, QWidget#message-timeline {background:transparent; border:0;}
QFrame#message-surface[role="assistant"] {background:rgba(250,252,255,214); border:1px solid rgba(255,255,255,170); border-radius:14px; border-top-left-radius:6px; padding:11px 14px;}
QFrame#message-surface[role="user"] {background:rgba(219,228,251,236); border:1px solid rgba(235,241,255,205); border-radius:14px; border-top-right-radius:6px; padding:11px 14px;}
QFrame#message-surface[role="assistant"][state="error"], QFrame#message-surface[role="user"][state="error"] {background:rgba(255,242,239,242); border-color:#ddb9b5; padding:0;}
QFrame#message-bubble[state="stopped"] {background:transparent;}
QLabel#bubble-body {color:#203151; font-size:14px; background:transparent;}
QFrame#chat-composer {background:rgba(245,248,255,204); border:1px solid rgba(255,255,255,175); border-radius:14px;}
QFrame#chat-composer[inputFocused="true"] {background:rgba(248,250,255,218);border-color:#8ca6d0;}
QPlainTextEdit#chat-input {background:transparent; color:#243654; placeholder-text-color:#4b5c78; border:0;border-radius:0;padding:6px 4px;font-size:14px;selection-background-color:#b8d0f4;selection-color:#203151;}
QPlainTextEdit#chat-input:focus {border:0;}
QPlainTextEdit#chat-input:read-only {color:#536887;}
QFrame#composer-toolbar {background:transparent;}
QLabel#composer-hint {color:#334b70; font-size:10px;}
QLabel#empty-state {color:#243654;background:rgba(248,250,255,220);border-radius:12px;padding:12px 22px;font-size:14px;}
QToolButton#window-minimize-button, QToolButton#window-pin-button, QToolButton#window-close-button,
QToolButton#sidebar-toggle-button, QToolButton#glass-settings, QToolButton#composer-attach-button,
QToolButton#glass-mic, QToolButton#glass-call, QToolButton#glass-speaker, QToolButton#glass-sticker {
background:rgba(255,255,255,90);border:1px solid rgba(255,255,255,40);border-radius:8px;width:30px;height:30px;color:#243654;}
QToolButton:hover {background:rgba(255,255,255,170);}
QToolButton:focus {border:1px solid #658fbc;}
QToolButton#window-pin-button:checked {background:rgba(185,166,245,165);}
QToolButton#window-close-button:hover {background:rgba(254,202,202,215);}
QFrame#composer-toolbar QToolButton {background:transparent;border:1px solid transparent;border-radius:8px;width:30px;height:30px;}
QFrame#composer-toolbar QToolButton:hover {background:rgba(255,255,255,170);}
QFrame#composer-toolbar QToolButton:pressed {background:rgba(195,213,244,195);}
QFrame#composer-toolbar QToolButton:checked {background:rgba(195,213,244,210);border-color:#8ca6d0;}
QFrame#composer-toolbar QToolButton:focus {border-color:#658fbc;}
QFrame#composer-toolbar QToolButton:disabled {background:transparent;border-color:transparent;}
QToolButton#send-button {background:rgba(183,204,242,240);color:#243654;border:1px solid rgba(154,180,224,180);border-radius:10px;width:70px;height:30px;font-size:13px;font-weight:600;}
QToolButton#send-button:hover {background:rgba(165,192,238,250);border-color:#8ca6d0;}
QToolButton#send-button:pressed {background:rgba(145,177,231,255);}
QToolButton#send-button:focus {border-color:#47699e;}
QToolButton#send-button[busy="true"] {background:rgba(245,215,177,245);border-color:rgba(208,172,126,210);}
QToolButton#send-button[busy="true"]:hover {background:rgba(239,201,151,250);}
QToolButton#send-button[busy="true"]:pressed {background:rgba(230,184,124,255);}
QToolButton#send-button:disabled {background:rgba(240,245,255,100);color:#536887;border-color:rgba(255,255,255,110);}
QToolButton:disabled {color:#59718f;}
QFrame#glass-controls {background:rgba(245,249,255,220);border:0;}
QFrame#glass-controls QLabel {color:#243654;}
QScrollBar:vertical {background:transparent;width:6px;}
QScrollBar::handle:vertical {background:rgba(255,255,255,150);border-radius:3px;min-height:30px;}
QListWidget#session-list::item:selected {background:rgba(255,255,255,140);color:#203151;}
QToolButton#hide-session-button {color:#344a69;background:transparent;border:1px solid transparent;border-radius:6px;padding:3px 6px;font-size:12px;}
QToolButton#hide-session-button:hover {background:rgba(255,255,255,175);}
QToolButton#hide-session-button:focus {border-color:#658fbc;}
QToolButton#hide-session-button:disabled {color:#677489;}
'''


class GlassChatWindow(ChatWindow):
    def __init__(self, config, character_id, **kwargs):
        config.data.update(modern_chat_background=str(BACKGROUND) if BACKGROUND.is_file() else '', modern_chat_background_opacity=100,
                           modern_chat_background_fill='cover', modern_chat_card_opacity=20)
        self._glass_ready = False
        self._glass_blur = None
        self._glass_scaled = None
        self._glass_scaled_size = None
        super().__init__(config, character_id, **kwargs)
        if BACKGROUND.is_file():
            try:
                with Image.open(BACKGROUND) as source:
                    image = source.convert('RGBA').filter(ImageFilter.GaussianBlur(12))
                data = image.tobytes()
                self._glass_blur = QPixmap.fromImage(
                    QImage(data, image.width, image.height, image.width * 4, QImage.Format.Format_RGBA8888).copy()
                )
            except OSError:
                pass
        self.setWindowTitle('大肥鱼 · 聊天')
        self.title_label.setText('大肥鱼')
        self.brand_label.setText('大肥鱼')
        self.subtitle_label.hide()
        self.provider_label.hide()
        self.status.setText('正在连接本地后台')
        self.status_dot.setText('')
        self.sidebar.setFixedWidth(210)
        self._sidebar_open = False
        self.sidebar.hide()
        for button, name in ((self.minimize_button,'minimize'),(self.pin_button,'pin'),
                             (self.close_button,'close'),(self.sidebar_toggle_button,'sidebar'),
                             (self.composer.attach_button,'image'),(self.composer.send,'send')):
            button.setIcon(icon(name))
            button.setIconSize(QSize(16,16))
        self.settings_button = QToolButton(self.title_bar)
        self.settings_button.setObjectName('glass-settings')
        self.settings_button.setAccessibleName('玻璃外观设置')
        self.settings_button.setToolTip('玻璃外观设置')
        self.settings_button.setIcon(icon('settings'))
        header = self.title_bar.layout()
        header.removeWidget(self.minimize_button)
        header.removeWidget(self.pin_button)
        header.removeWidget(self.close_button)
        for button in (self.minimize_button,self.pin_button,self.settings_button,self.close_button):
            header.addWidget(button)
        self.controls = QFrame(self.chat_main)
        self.controls.setObjectName('glass-controls')
        row = QHBoxLayout(self.controls)
        row.setContentsMargins(18,10,18,10)
        row.addWidget(QLabel('气泡透明度'))
        self.opacity_slider = QSlider(Qt.Orientation.Horizontal)
        self.opacity_slider.setRange(70,95)
        self.opacity_slider.setValue(84)
        self.opacity_slider.setAccessibleName('消息气泡不透明度')
        row.addWidget(self.opacity_slider)
        self.opacity_label = QLabel('84%')
        row.addWidget(self.opacity_label)
        self.chat_main_layout.insertWidget(1,self.controls)
        self.controls.hide()
        self.settings_button.clicked.connect(lambda: self.controls.setVisible(not self.controls.isVisible()))
        self.opacity_slider.valueChanged.connect(self._change_opacity)
        footer = self.composer.toolbar.layout()
        self.voice_buttons = []
        for name, title in (('call','语音通话'),('mic','语音输入'),('speaker','自动朗读')):
            button = QToolButton(self.composer.toolbar)
            button.setObjectName('glass-'+name)
            button.setIcon(icon(name))
            button.setToolTip(title+'（尚未接入）')
            button.setAccessibleName(title+'，尚未接入')
            button.setEnabled(False)
            footer.insertWidget(1,button)
            self.voice_buttons.append(button)
        footer.removeWidget(self.composer.hint)
        self.composer.hint.hide()
        footer.removeWidget(self.composer.send)
        composer_layout=self.composer.layout()
        composer_layout.removeWidget(self.composer.input)
        composer_layout.removeWidget(self.composer.toolbar)
        line=QHBoxLayout()
        line.setSpacing(8)
        self.composer.toolbar.setFixedWidth(140)
        line.addWidget(self.composer.toolbar, 0, Qt.AlignmentFlag.AlignVCenter)
        line.addWidget(self.composer.input,1)
        line.addWidget(self.composer.send, 0, Qt.AlignmentFlag.AlignVCenter)
        composer_layout.addLayout(line)
        composer_layout.setContentsMargins(12,8,12,8)
        self.composer.input.setMinimumWidth(0)
        self.composer.input.setMinimumHeight(44)
        self.composer.input.setMaximumHeight(64)
        self.composer.input.document().setDocumentMargin(2)
        self.composer.setProperty('inputFocused', False)
        self.composer.input.installEventFilter(self)
        self.composer.input.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.composer.input.customContextMenuRequested.connect(self._show_input_context_menu)
        self.composer.send.setFixedSize(80,36)
        self.composer.send.setText('发送')
        self.composer.send.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextBesideIcon)
        self.composer.setGraphicsEffect(None)
        self._glass_ready = True
        self._style()
        self._chat_menu_filter = ChatMenuFilter(self)
        QApplication.instance().installEventFilter(self._chat_menu_filter)
        self.resize(1000,700)

    def send_message(self):
        return

    def _style(self):
        super()._style()
        if getattr(self,'_glass_ready',False):
            self.setStyleSheet(self.styleSheet()+QSS)

    def _change_opacity(self,value):
        self.opacity_label.setText(str(value)+'%')
        self._style()
        self.setStyleSheet(self.styleSheet()+f'QFrame#message-surface[role="assistant"] {{background:rgba(250,252,255,{int(255*value/100)});}}')

    def eventFilter(self, obj, event):
        if obj is getattr(getattr(self, 'composer', None), 'input', None):
            if event.type() in (QEvent.Type.FocusIn, QEvent.Type.FocusOut):
                self.composer.setProperty('inputFocused', event.type() == QEvent.Type.FocusIn)
                self.composer.style().unpolish(self.composer)
                self.composer.style().polish(self.composer)
                self.composer.update()
        return super().eventFilter(obj, event)

    def _create_input_context_menu(self):
        return style_chat_menu(self.composer.input.createStandardContextMenu())

    def _show_input_context_menu(self, point):
        menu = self._create_input_context_menu()
        menu.setAttribute(Qt.WidgetAttribute.WA_DeleteOnClose)
        menu.popup(self.composer.input.mapToGlobal(point))

    def _update_conversation_height(self):
        """Keep the composer at the bottom in both empty and populated conversations."""
        if not hasattr(self, 'scroll'):
            return
        for spacer in (self.content_top_spacer, self.content_bottom_spacer):
            spacer.changeSize(0, 0, QSizePolicy.Policy.Minimum, QSizePolicy.Policy.Fixed)
        self.scroll.setMinimumHeight(0)
        self.scroll.setMaximumHeight(16777215)
        self.scroll.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.composer_card.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.chat_main_layout.setStretchFactor(self.scroll, 1)
        self.chat_main_layout.setStretchFactor(self.composer_card, 0)
        self.chat_main_layout.invalidate()
        self.message_host_layout.invalidate()

    def _update_bubble_widths(self):
        available = max(260,self.scroll.viewport().width()-2*self.message_horizontal_margin)
        for bubble in self._bubbles:
            # Measure displayed text, including explicit line breaks. Cache old
            # bubbles so an 18ms typewriter tick only measures its changing row.
            text = bubble.body.text()
            key = (text, bubble.body.textFormat(), bubble.body.font().key())
            if getattr(bubble, '_glass_measure_key', None) != key:
                if bubble.body.textFormat() == Qt.TextFormat.RichText:
                    document = QTextDocument()
                    document.setDefaultFont(bubble.body.font())
                    document.setDocumentMargin(0)
                    document.setHtml(text)
                    width = document.idealWidth()
                else:
                    metrics = bubble.body.fontMetrics()
                    width = max((metrics.horizontalAdvance(line) for line in text.splitlines()), default=0)
                bubble._glass_text_width = int(width + 1)
                bubble._glass_measure_key = key
            cap = min(480, max(210, int(available * .72)))
            controls_width = max((control.sizeHint().width() + 32
                                  for control in (bubble.thinking_toggle, bubble.error_actions)
                                  if not control.isHidden()), default=0)
            cap = min(available, max(cap, controls_width))
            desired = min(cap, max(64, bubble._glass_text_width + 32,
                                   bubble.property('mediaWidth') or 0, controls_width))
            bubble.body.setMinimumWidth(0)
            bubble.setFixedWidth(desired)

    def resizeEvent(self,event):
        super().resizeEvent(event)
        self.composer_card_layout.setContentsMargins(22,8,22,20)
        self.message_horizontal_margin=24
        self.message_host_layout.setContentsMargins(24,26,24,20)
        self.message_host_layout.setSpacing(16)
        self._update_bubble_widths()

    def paintEvent(self,event):
        super().paintEvent(event)
        if self._glass_blur is None:
            return
        target=self.phone_shell.geometry()
        if self._glass_scaled_size != target.size():
            self._glass_scaled=self._glass_blur.scaled(target.size(),Qt.AspectRatioMode.KeepAspectRatioByExpanding,Qt.TransformationMode.SmoothTransformation)
            self._glass_scaled_size=target.size()
        painter=QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        x=target.x()+(target.width()-self._glass_scaled.width())//2
        y=target.y()+(target.height()-self._glass_scaled.height())//2
        for widget in (self.title_bar,self.composer,self.sidebar):
            if widget.isHidden():
                continue
            origin=widget.mapTo(self,QPoint(0,0))
            clip=QPainterPath()
            clip.addRoundedRect(QRectF(origin.x(),origin.y(),widget.width(),widget.height()),12,12)
            painter.save()
            painter.setClipPath(clip)
            painter.drawPixmap(x,y,self._glass_scaled)
            painter.restore()
        painter.end()
