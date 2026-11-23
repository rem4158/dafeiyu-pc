"""Bounded, asynchronous picker for the selected local sticker library."""
import io
import queue
import threading
from collections import OrderedDict

from PIL import Image
from PySide6.QtCore import QEvent, QPoint, QSize, Qt, Signal
from PySide6.QtGui import QColor, QPainter, QPainterPath, QPen, QPixmap
from PySide6.QtWidgets import (QApplication, QComboBox, QFrame, QGridLayout, QHBoxLayout,
                               QLabel, QPushButton, QToolButton, QVBoxLayout)
from chat_theme import ChatPopupFrame, COLORS, POPUP_STYLE

STYLE = f'''
QFrame#sticker-picker, QFrame#sticker-preview {{{POPUP_STYLE}}}
QLabel {{color:{COLORS['ink']};background:transparent;border:0;}}
QLabel#sticker-title {{font-size:14px;font-weight:600;}}
QLabel#sticker-status, QLabel#sticker-page {{color:{COLORS['muted']};font-size:12px;}}
QLabel#sticker-preview-text {{color:{COLORS['ink']};font-size:13px;}}
QPushButton,QComboBox {{color:{COLORS['ink']};background:rgba(255,255,255,132);border:1px solid {COLORS['outline']};border-radius:8px;padding:5px 9px;font-size:13px;}}
QPushButton:hover,QComboBox:hover {{background:{COLORS['hover']};border-color:#8ca6d0;}}
QPushButton:pressed,QComboBox:on {{background:{COLORS['pressed']};border-color:{COLORS['accent']};}}
QPushButton:focus,QComboBox:focus {{border-color:{COLORS['accent']};}}
QPushButton:disabled,QComboBox:disabled {{color:{COLORS['disabled']};background:rgba(235,241,251,110);border-color:rgba(183,201,229,110);}}
QComboBox {{padding-right:28px;}}
QComboBox::drop-down {{width:24px;border:0;}}
QComboBox::down-arrow {{image:none;}}
QToolButton#sticker-cell {{color:{COLORS['ink']};background:rgba(255,255,255,112);border:1px solid rgba(183,201,229,150);border-radius:10px;font-size:12px;}}
QToolButton#sticker-cell:hover {{background:{COLORS['hover']};border-color:#8ca6d0;}}
QToolButton#sticker-cell:pressed {{background:{COLORS['pressed']};border-color:{COLORS['accent']};}}
QToolButton#sticker-cell[failed="true"] {{color:#7c3434;background:rgba(255,239,235,210);border-color:#ddb9b5;}}
QToolButton#sticker-cell:disabled {{color:{COLORS['disabled']};background:rgba(255,255,255,65);border-color:rgba(183,201,229,95);}}
QToolButton#sticker-cell:focus {{border-color:{COLORS['accent']};}}
'''

CATEGORY_STYLE = f'''
QAbstractItemView {{color:{COLORS['ink']};background:{COLORS['surface']};border:1px solid {COLORS['outline']};padding:4px;outline:0;selection-background-color:{COLORS['hover']};selection-color:{COLORS['ink']};font-size:13px;}}
QAbstractItemView::item {{min-height:28px;padding:3px 8px;border-radius:6px;}}
QAbstractItemView::item:selected {{background:{COLORS['hover']};color:{COLORS['ink']};}}
QAbstractItemView::item:hover {{background:{COLORS['hover']};}}
QScrollBar:vertical {{background:transparent;width:6px;margin:2px 0;}}
QScrollBar::handle:vertical {{background:rgba(101,143,188,120);border-radius:3px;min-height:24px;}}
QScrollBar::handle:vertical:hover {{background:{COLORS['accent']};}}
QScrollBar::add-line:vertical,QScrollBar::sub-line:vertical {{height:0;}}
'''


class _CategoryComboBox(QComboBox):
    """Keep a visible chevron when the system palette differs from the popup."""

    def paintEvent(self, event):
        super().paintEvent(event)
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        pen = QPen(QColor(COLORS['ink'] if self.isEnabled() else COLORS['disabled']), 1.6)
        pen.setCapStyle(Qt.PenCapStyle.RoundCap)
        pen.setJoinStyle(Qt.PenJoinStyle.RoundJoin)
        painter.setPen(pen)
        x, y = self.width() - 14, self.height() / 2
        path = QPainterPath()
        path.moveTo(x - 3.5, y - 1.5)
        path.lineTo(x, y + 2)
        path.lineTo(x + 3.5, y - 1.5)
        painter.drawPath(path)


class StickerPicker(ChatPopupFrame):
    selected = Signal(object)
    _ready = Signal(str, str, int, object)
    _failed = Signal(str, str, int)
    COLUMNS = 6
    ROWS = 3
    CACHE_LIMIT = 48

    def __init__(self, client, parent=None):
        super().__init__(parent, Qt.WindowType.Popup | Qt.WindowType.FramelessWindowHint)
        self.client = client
        self.setObjectName('sticker-picker')
        self.setAccessibleName('选择要添加的表情包')
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setStyleSheet(STYLE)
        self._catalog = None
        self._catalog_loading = False
        self._catalog_version = 0
        self._generation = 0
        self._page = 0
        self._columns = self.COLUMNS
        self._rows = self.ROWS
        self._filtered = []
        self._items = {}
        self._cells = {}
        self._cache = OrderedDict()
        self._stop = threading.Event()
        self._tasks = queue.Queue()
        self._anchor = None
        self._hovered = None
        self._ready.connect(self._received)
        self._failed.connect(self._failure)
        self.destroyed.connect(lambda *_args, stop=self._stop: stop.set())
        outer = QVBoxLayout(self)
        outer.setContentsMargins(12, 12, 12, 10)
        outer.setSpacing(9)
        heading = QHBoxLayout()
        title = QLabel('表情包', self); title.setObjectName('sticker-title')
        heading.addWidget(title); heading.addStretch()
        self.reload_button = QPushButton('刷新', self)
        self.reload_button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.reload_button.clicked.connect(self.reload)
        heading.addWidget(self.reload_button)
        close = QPushButton('关闭', self); close.clicked.connect(self.hide)
        close.setCursor(Qt.CursorShape.PointingHandCursor)
        heading.addWidget(close); outer.addLayout(heading)
        self.categories = _CategoryComboBox(self)
        self.categories.setAccessibleName('表情分类')
        self.categories.view().setStyleSheet(CATEGORY_STYLE)
        self.categories.addItem('全部分类', '')
        self.categories.currentIndexChanged.connect(self._filter)
        outer.addWidget(self.categories)
        self.status = QLabel('正在读取表情库…', self)
        self.status.setObjectName('sticker-status')
        self.status.setWordWrap(True)
        outer.addWidget(self.status)
        self.grid_host = QFrame(self)
        self.grid_host.setStyleSheet('QFrame {background:transparent;border:0;}')
        self.grid = QGridLayout(self.grid_host)
        self.grid.setContentsMargins(0, 0, 0, 0)
        self.grid.setSpacing(5)
        outer.addWidget(self.grid_host)
        footer = QHBoxLayout()
        self.previous = QPushButton('上一页', self)
        self.previous.setCursor(Qt.CursorShape.PointingHandCursor)
        self.previous.clicked.connect(lambda: self._change_page(-1))
        self.page_label = QLabel('', self)
        self.page_label.setObjectName('sticker-page')
        self.page_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.next = QPushButton('下一页', self)
        self.next.setCursor(Qt.CursorShape.PointingHandCursor)
        self.next.clicked.connect(lambda: self._change_page(1))
        footer.addWidget(self.previous); footer.addWidget(self.page_label, 1); footer.addWidget(self.next)
        outer.addLayout(footer)
        self.preview = ChatPopupFrame(self, Qt.WindowType.ToolTip | Qt.WindowType.FramelessWindowHint)
        self.preview.setObjectName('sticker-preview'); self.preview.setStyleSheet(STYLE)
        self.preview.setAttribute(Qt.WidgetAttribute.WA_StyledBackground)
        self.preview.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        pl = QVBoxLayout(self.preview); pl.setContentsMargins(10, 10, 10, 10)
        self.preview_image = QLabel(self.preview)
        self.preview_image.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.preview_text = QLabel(self.preview)
        self.preview_text.setObjectName('sticker-preview-text')
        self.preview_text.setWordWrap(True)
        self.preview_text.setMaximumWidth(240)
        pl.addWidget(self.preview_image); pl.addWidget(self.preview_text)
        self.setFixedWidth(438)
        self.previous.setEnabled(False); self.next.setEnabled(False)
        for index in range(2):
            threading.Thread(target=self._worker, daemon=True, name=f'StickerPicker-{index}').start()

    def _worker(self):
        while not self._stop.is_set():
            try: job = self._tasks.get(timeout=.3)
            except queue.Empty: continue
            kind, key, generation = job
            if kind == 'image' and generation != self._generation:
                continue
            try:
                if kind == 'catalog':
                    value = self.client.sticker_catalog()
                else:
                    raw = self.client.sticker_image(key)
                    if not isinstance(raw, bytes) or not raw or len(raw) > 20*1024*1024:
                        raise ValueError('Invalid image')
                    with Image.open(io.BytesIO(raw)) as source:
                        if source.width * source.height > 16_000_000:
                            raise ValueError('Image too large')
                        source.seek(0)
                        im = source.convert('RGBA')
                    im.thumbnail((240, 240), Image.Resampling.LANCZOS)
                    preview = io.BytesIO(); im.save(preview, format='PNG')
                    im.thumbnail((58, 58), Image.Resampling.LANCZOS)
                    thumb = io.BytesIO(); im.save(thumb, format='PNG')
                    value = (thumb.getvalue(), preview.getvalue())
                if not self._stop.is_set():
                    self._ready.emit(kind, key, generation, value)
            except Exception:
                if not self._stop.is_set():
                    try: self._failed.emit(kind, key, generation)
                    except RuntimeError: return

    def open_above(self, anchor):
        self._anchor = anchor
        self._position()
        self.show(); self.raise_(); self.categories.setFocus()
        if self._catalog is None and not self._catalog_loading:
            self.reload()

    def _position(self):
        if self._anchor is None: return
        anchor = self._anchor
        screen = anchor.screen() or QApplication.primaryScreen()
        bounds = screen.availableGeometry()
        parent = self.parentWidget()
        if parent is not None:
            intersection = bounds.intersected(parent.window().frameGeometry())
            if intersection.width() >= 300 and intersection.height() >= 300:
                bounds = intersection
        self.setFixedWidth(min(438, max(280, bounds.width()-16)))
        columns = max(3, min(self.COLUMNS, (self.width()-18)//70))
        rows = max(1, min(self.ROWS, (bounds.height()-180)//70))
        if (columns, rows) != (self._columns, self._rows):
            self._columns, self._rows = columns, rows
            if self._catalog is not None:
                self._page = 0; self._render_page(); return
        self._placement_bounds = bounds
        self.adjustSize()
        self._place_current()

    def _place_current(self):
        if self._anchor is None or not hasattr(self, '_placement_bounds'): return
        anchor, bounds = self._anchor, self._placement_bounds
        point = anchor.mapToGlobal(QPoint(0, 0))
        x = max(bounds.left()+8, min(point.x(), bounds.right()-self.width()-7))
        y = point.y()-self.height()-8
        if y < bounds.top()+8:
            y = min(point.y()+anchor.height()+8, bounds.bottom()-self.height()-7)
        self.move(x, max(bounds.top()+8, y))

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self._place_current()

    def reload(self):
        if self._catalog_loading: return
        self._catalog_loading = True; self._catalog_version += 1
        self.reload_button.setEnabled(False)
        self.status.setText('正在读取表情库…')
        self._tasks.put(('catalog', '', self._catalog_version))

    def _received(self, kind, key, generation, value):
        if kind == 'catalog':
            if generation != self._catalog_version: return
            self._catalog_loading = False; self.reload_button.setEnabled(True)
            if not isinstance(value, dict):
                self._failure('catalog', key, generation); return
            self._catalog = value
            self._items = {item['id']: dict(item) for item in value.get('stickers', [])
                           if isinstance(item, dict) and isinstance(item.get('id'), str)}
            selected = self.categories.currentData()
            self.categories.blockSignals(True)
            self.categories.clear(); self.categories.addItem('全部分类', '')
            for item in value.get('categories', []):
                if not isinstance(item, dict): continue
                name = str(item.get('name', ''))
                label = str(item.get('label') or item.get('description') or name)
                if len(label) > 22: label = label[:22]+'…'
                self.categories.addItem(f'{label}（{item.get("count", 0)}）', name)
            at = self.categories.findData(selected)
            self.categories.setCurrentIndex(max(0, at)); self.categories.blockSignals(False)
            self._filter(); return
        if generation != self._generation: return
        thumb, preview = QPixmap(), QPixmap()
        if not thumb.loadFromData(value[0]) or not preview.loadFromData(value[1]):
            self._failure(kind, key, generation); return
        self._cache[key] = (thumb, preview); self._cache.move_to_end(key)
        while len(self._cache) > self.CACHE_LIMIT: self._cache.popitem(last=False)
        button = self._cells.get(key)
        if button is not None:
            from PySide6.QtGui import QIcon
            button.setIcon(QIcon(thumb)); button.setEnabled(True); button.setText('')
        if self._hovered == key: self._show_preview(key)

    def _failure(self, kind, key, generation):
        if kind == 'catalog':
            if generation != self._catalog_version: return
            self._catalog_loading = False; self.reload_button.setEnabled(True)
            self.status.setText('表情库读取失败，请点击“刷新”重试。')
            return
        if generation != self._generation: return
        button = self._cells.get(key)
        if button is not None:
            button.setText('重试'); button.setEnabled(True)
            button.setProperty('failed', True)
            button.style().unpolish(button); button.style().polish(button)
            button.setToolTip('缩略图读取失败，点击重试')

    def _filter(self):
        category = self.categories.currentData() or ''
        self._filtered = [item for item in self._items.values() if not category or item.get('category') == category]
        self._page = 0; self._render_page()

    def _change_page(self, delta):
        page_size = self._columns*self._rows
        maximum = max(0, (len(self._filtered)-1)//page_size)
        self._page = max(0, min(maximum, self._page+delta))
        self._render_page()

    def _render_page(self):
        from PySide6.QtGui import QIcon
        self._generation += 1; self._hovered = None; self.preview.hide()
        while self.grid.count():
            item = self.grid.takeAt(0)
            if item.widget(): item.widget().deleteLater()
        self._cells.clear()
        page_size = self._columns*self._rows
        total = len(self._filtered)
        start = self._page*page_size
        self.status.setText('点击添加到输入区，可与文字一起发送；悬停可预览。' if total else
                            '表情功能已关闭，可在“语音与表情”设置中开启。' if self._catalog and not self._catalog.get('enabled', True) else
                            '暂无可用表情，请检查“语音与表情”的表情库配置。')
        for index, item in enumerate(self._filtered[start:start+page_size]):
            key = item['id']
            button = QToolButton(self.grid_host); button.setObjectName('sticker-cell')
            button.setFixedSize(64, 64); button.setIconSize(QSize(58, 58))
            button.setCursor(Qt.CursorShape.PointingHandCursor)
            title = str(item.get('name') or item.get('category') or '表情包')
            button.setAccessibleName('添加表情：'+title); button.setToolTip(title)
            button.setProperty('sticker_id', key); button.installEventFilter(self)
            button.clicked.connect(lambda checked=False, sticker_id=key: self._choose(sticker_id))
            if key in self._cache:
                button.setIcon(QIcon(self._cache[key][0])); self._cache.move_to_end(key)
            else:
                button.setText('加载中'); button.setEnabled(False)
                self._tasks.put(('image', key, self._generation))
            self.grid.addWidget(button, index//self._columns, index%self._columns)
            self._cells[key] = button
        pages = max(1, (total+page_size-1)//page_size)
        self.page_label.setText(f'{self._page+1} / {pages} · {total} 张')
        self.previous.setEnabled(self._page>0); self.next.setEnabled(self._page+1<pages)
        self._position()

    def _choose(self, key):
        button = self._cells.get(key)
        if button is not None and button.property('failed'):
            button.setProperty('failed', False); button.setEnabled(False); button.setText('加载中')
            button.style().unpolish(button); button.style().polish(button)
            self._tasks.put(('image', key, self._generation)); return
        item = self._items.get(key)
        if item is not None:
            self.hide(); self.selected.emit(dict(item))

    def eventFilter(self, obj, event):
        if isinstance(obj, QToolButton) and obj.property('sticker_id'):
            key = obj.property('sticker_id')
            if event.type() in (QEvent.Type.Enter, QEvent.Type.FocusIn):
                self._hovered = key; self._show_preview(key)
            elif event.type() in (QEvent.Type.Leave, QEvent.Type.FocusOut):
                self._hovered = None; self.preview.hide()
        return super().eventFilter(obj, event)

    def _show_preview(self, key):
        if key not in self._cache or not self.isVisible(): return
        button = self._cells.get(key)
        if button is None: return
        self.preview_image.setPixmap(self._cache[key][1])
        item = self._items[key]
        self.preview_text.setText(str(item.get('name') or item.get('category') or '表情包'))
        self.preview.adjustSize()
        point = button.mapToGlobal(QPoint(button.width()+8, 0))
        bounds = button.screen().availableGeometry()
        point.setX(max(bounds.left()+8, min(point.x(), bounds.right()-self.preview.width()-8)))
        point.setY(max(bounds.top()+8, min(point.y(), bounds.bottom()-self.preview.height()-8)))
        self.preview.move(point); self.preview.show()

    def keyPressEvent(self, event):
        if event.key() == Qt.Key.Key_Escape:
            self.hide(); event.accept(); return
        super().keyPressEvent(event)

    def hideEvent(self, event):
        self.preview.hide(); self._hovered = None
        super().hideEvent(event)

    def shutdown(self):
        self._stop.set(); self.hide()
