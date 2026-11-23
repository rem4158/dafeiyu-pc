"""Shared presentation for native chat voice controls and small popups."""
from PySide6.QtCore import QEvent, QObject, Qt
from PySide6.QtGui import QPainter
from PySide6.QtWidgets import QFrame, QMenu, QStyle, QStyleOption


COLORS = {
    'ink': '#243654',
    'muted': '#4b5c78',
    'accent': '#658fbc',
    'outline': '#b7c9e5',
    'hover': '#dee8fa',
    'pressed': '#c9d9f5',
    'surface': '#f5f8ff',
    'disabled': '#63738c',
}

# Small floating windows need a readable surface over arbitrary desktop content;
# their tint matches the composer without pretending to blur that content.
POPUP_STYLE = (
    'background:rgba(245,248,255,247);border:1px solid #b7c9e5;'
    'border-radius:14px;color:#243654;font-family:"Microsoft YaHei UI";font-size:13px;'
)

MENU_STYLE = '''
QMenu {background:rgba(245,248,255,250);color:#243654;border:1px solid #b7c9e5;
    border-radius:12px;padding:5px;font-family:"Microsoft YaHei UI";font-size:13px;}
QMenu::item {min-height:20px;padding:5px 20px 5px 12px;margin:2px 0;
    border:1px solid transparent;border-radius:7px;color:#243654;background:transparent;}
QMenu::item:selected {background:#dee8fa;color:#243654;border-color:#c5d5ef;}
QMenu::item:pressed {background:#c9d9f5;}
QMenu::item:disabled {color:#63738c;background:transparent;border-color:transparent;}
QMenu::separator {height:1px;background:#d4def0;margin:5px 8px;}
QMenu::icon {padding-left:3px;}
'''

VOICE_STYLE = '''
QPushButton#voice-message {color:#243654;background:rgba(219,230,250,85);
    border:1px solid rgba(169,191,227,100);border-radius:10px;
    padding:6px 10px;text-align:left;font-size:14px;}
QPushButton#voice-message:hover {background:rgba(218,230,251,185);border-color:#b7c9e5;}
QPushButton#voice-message:pressed {background:rgba(194,213,245,235);}
QPushButton#voice-message[voiceState="loading"] {background:rgba(222,232,250,210);border-color:#b7c9e5;}
QPushButton#voice-message[voiceState="playing"] {background:rgba(183,204,242,225);border-color:#96add4;}
QPushButton#voice-message[voiceState="playing"]:hover {background:rgba(169,195,239,240);}
QPushButton#voice-message[voiceState="failed"] {color:#7c3434;background:rgba(251,236,233,225);border-color:#d9b6b2;}
QPushButton#voice-message[voiceState="failed"]:hover {background:rgba(246,221,217,240);}
QPushButton#voice-message:focus {border-color:#658fbc;}
QPushButton#voice-message:disabled {color:#63738c;background:rgba(231,237,249,100);border-color:transparent;}
'''

TRANSCRIPT_STYLE = '''
QLabel#voice-transcript {color:#334b70;background:transparent;border:0;
    padding:9px 4px 2px;font-size:14px;selection-background-color:#b8d0f4;selection-color:#203151;}
'''


class ChatPopupFrame(QFrame):
    """Paint the styled surface explicitly on a translucent top-level frame."""

    def paintEvent(self, event):
        option = QStyleOption()
        option.initFrom(self)
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        self.style().drawPrimitive(QStyle.PrimitiveElement.PE_Widget, option, painter, self)


def style_chat_menu(menu):
    """Style an existing menu while retaining its actions and native shortcuts."""
    if not menu.property('chatMenuThemed'):
        menu.setProperty('chatMenuThemed', True)
        menu.setProperty('modernDark', False)
        menu.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        menu.setWindowFlag(Qt.WindowType.FramelessWindowHint, True)
        menu.setStyleSheet(MENU_STYLE)
    return menu


class ChatMenuFilter(QObject):
    """Theme lazily created menus belonging to one chat window only."""

    def eventFilter(self, obj, event):
        if event.type() in (QEvent.Type.Polish, QEvent.Type.Show) and isinstance(obj, QMenu):
            ancestor = obj.parentWidget()
            while ancestor is not None:
                if ancestor is self.parent():
                    style_chat_menu(obj)
                    break
                ancestor = ancestor.parentWidget()
        return False
