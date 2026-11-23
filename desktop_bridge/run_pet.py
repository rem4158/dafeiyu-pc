"""Start the desktop pet and connect it to the local PC backend."""
import json
import os
import sys
from collections import deque
from pathlib import Path

PC_ROOT = Path(__file__).resolve().parents[1]
os.environ['DAFEIYU_PC_ROOT'] = str(PC_ROOT)
os.environ['APPDATA'] = str(PC_ROOT / 'data' / 'pet-appdata')
Path(os.environ['APPDATA']).mkdir(parents=True, exist_ok=True)
EVENTS = PC_ROOT / 'data' / 'messages.jsonl'
sys.path.insert(0, str(PC_ROOT / 'desktop'))

from PySide6.QtCore import QObject, QTimer
from pet import app as pet_app
from native_chat_controller import NativeChatController, install_chat_routes
from deepseek_balance import install_balance_routes
from pet.sprite_menu_facade import SpriteMenuFacade


class BubbleBridge(QObject):
    def __init__(self, shell):
        super().__init__(shell.app)
        self.shell = shell
        self.position = EVENTS.stat().st_size if EVENTS.exists() else 0
        self.pending = b""
        self.queue = deque(maxlen=100)
        self.busy = False
        focus = EVENTS.parent / 'focus-chat'
        self.focus_stamp = focus.stat().st_mtime_ns if focus.exists() else 0
        self.timer = QTimer(self)
        self.timer.timeout.connect(self.poll)
        self.timer.start(400)

    def poll(self):
        focus = EVENTS.parent / 'focus-chat'
        try:
            stamp = focus.stat().st_mtime_ns
            if stamp != self.focus_stamp:
                self.focus_stamp = stamp
                window = getattr(self.shell, '_pc_chat', None)
                if window is not None:
                    window.open_chat()
        except OSError:
            pass
        try:
            if EVENTS.exists():
                if EVENTS.stat().st_size < self.position:
                    self.position, self.pending = 0, b""
                with EVENTS.open("rb") as f:
                    f.seek(self.position)
                    chunk = f.read(65536)
                    self.position = f.tell()
                lines = (self.pending + chunk).split(b"\n")
                self.pending = lines.pop()[-16384:]
                for line in lines:
                    try:
                        msg = json.loads(line.decode("utf-8"))
                        text = str(msg.get("text", "")).strip()
                        if not text and msg.get('emotion'):
                            from companion_bridge import play_emotion
                            play_emotion(self.shell,msg['emotion'])
                        if text:
                            self.queue.append({'text':text,'emotion':msg.get('emotion')})
                    except (ValueError, UnicodeError, AttributeError):
                        continue
        except OSError:
            return
        if self.busy or not self.queue:
            return
        target = getattr(self.shell, "_overlay_shell", None) or getattr(self.shell.instance, "win", None)
        if target is None:
            return
        message = self.queue[0]
        text = message['text']
        duration = max(4000, min(20000, len(text) * 180))
        if target.show_bubble(text, duration_ms=duration):
            self.queue.popleft()
            if message.get('emotion'):
                from companion_bridge import play_emotion
                play_emotion(self.shell,message['emotion'])
            self.busy = True
            QTimer.singleShot(duration + 250, self._done)

    def _done(self):
        self.busy = False


_start = pet_app.AppShell.start


def start_with_bridge(self):
    self._pc_chat = NativeChatController(settings_opener=(
        lambda: self.instance.open_modern_settings(initial_page='模型与 API')
    ))
    _start(self)
    self._pc_bubble_bridge = BubbleBridge(self)
    from companion_bridge import CompanionBridge
    self._companion_bridge = CompanionBridge(self)
    QTimer.singleShot(1500, lambda: self._quiet_balance_refresh())
    for instance in getattr(self, 'instances', []):
        window = getattr(instance, 'win', None)
        if window is not None:
            window.on_open_chat = self._pc_chat.open_chat
    tray = getattr(self, 'tray', None)
    if tray is not None:
        menu = tray.contextMenu()
        if menu is not None:
            def add_chat_action():
                if not any(a.objectName() == 'dafeiyu-pc-chat' for a in menu.actions()):
                    action = menu.addAction('打开聊天')
                    action.setObjectName('dafeiyu-pc-chat')
                    action.triggered.connect(self._pc_chat.open_chat)
                if not any(a.objectName() == 'dafeiyu-balance' for a in menu.actions()):
                    action = menu.addAction('查询用量与余额')
                    action.setObjectName('dafeiyu-balance')
                    action.triggered.connect(lambda: self.show_balance())
            menu.aboutToShow.connect(add_chat_action)


pet_app.AppShell.start = start_with_bridge
install_chat_routes(pet_app, SpriteMenuFacade)
install_balance_routes(pet_app)
if __name__ == "__main__":
    sys.exit(pet_app.main(enable_chat=False))
