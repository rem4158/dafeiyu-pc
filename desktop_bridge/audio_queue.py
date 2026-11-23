"""Ordered in-memory playback of AstrBot voice attachments on the Qt thread."""
from collections import deque
from PySide6.QtCore import QByteArray, QBuffer, QIODevice, QObject, QTimer, QUrl, Signal
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer


class AudioQueue(QObject):
    changed = Signal(str, bool)
    failed = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.output = QAudioOutput(self)
        self.player = QMediaPlayer(self)
        self.player.setAudioOutput(self.output)
        self.output.setVolume(1.0)
        self.player.mediaStatusChanged.connect(self._status)
        self.player.errorOccurred.connect(self._error)
        self.pending = deque()
        self.data = {}
        self.current = None
        self._buffer = None

    def reserve(self, key):
        if key == self.current or key in self.data:
            return False
        if len(self.pending) >= 50:
            self.failed.emit('待播放语音过多，请稍后手动播放')
            return False
        self.pending.append(key)
        self.data[key] = None
        return True

    def ready(self, key, data):
        if key in self.data:
            self.data[key] = data
            self._next()

    def discard(self, key):
        if key in self.data:
            self.data.pop(key)
            self.pending.remove(key)
            self._next()

    def cancel(self, keys):
        keys = set(keys)
        # Prune the whole batch before advancing: discarding one by one could
        # start another ready item that is also meant to be cancelled.
        self.pending = deque(key for key in self.pending if key not in keys)
        for key in keys:
            self.data.pop(key, None)
        if self.current in keys:
            self._release()
        self._next()

    def _next(self):
        if self.current is not None or not self.pending:
            return
        key = self.pending[0]
        data = self.data.get(key)
        if data is None:
            return
        self.pending.popleft()
        self.data.pop(key)
        self.current = key
        self._buffer = QBuffer(self)
        self._buffer.setData(QByteArray(data))
        self._buffer.open(QIODevice.OpenModeFlag.ReadOnly)
        # Only authenticated bytes from AstrBot are played; no external URL.
        suffix = 'wav' if data[:4] == b'RIFF' else 'mp3'
        self.player.setSourceDevice(self._buffer, QUrl('voice.' + suffix))
        self.changed.emit(key, True)
        self.player.play()

    def _status(self, status):
        if status == QMediaPlayer.MediaStatus.EndOfMedia and self.current is not None:
            self._finish()

    def _error(self, *_args):
        if self.current is not None:
            self.failed.emit('语音播放失败，请检查声音输出设备后重试')
            self._finish()

    def _release(self):
        previous, self.current = self.current, None
        self.player.stop()
        self.player.setSource(QUrl())
        if self._buffer is not None:
            self._buffer.close()
            self._buffer.deleteLater()
            self._buffer = None
        if previous is not None:
            self.changed.emit(previous, False)

    def _finish(self):
        self._release()
        QTimer.singleShot(0, self._next)

    def stop(self):
        self.pending.clear()
        self.data.clear()
        self._release()
