"""Picker protocol/lifecycle checks with local fake images, no services or devices."""
import io
import os
from pathlib import Path
import sys
import threading
import time
import unittest
os.environ['QT_QPA_PLATFORM']='offscreen'
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'desktop_bridge'))
from PIL import Image
from PySide6.QtCore import QPoint,Qt
from PySide6.QtGui import QKeyEvent
from PySide6.QtCore import QEvent
from PySide6.QtWidgets import QApplication,QWidget,QPushButton
from sticker_picker import StickerPicker

class Client:
    def __init__(self,count=60):
        self.items=[{'id':f'{i:064x}','name':f'表情{i}','category':'happy' if i<count//2 else 'sad','description':'开心' if i<count//2 else '难过','pack_id':'test'} for i in range(count)]
        self.calls=[];self.lock=threading.Lock();self.active=0;self.maximum=0;self.fail=False;self.enabled=True
        stream=io.BytesIO();Image.new('RGB',(140,100),(100,150,200)).save(stream,format='PNG');self.png=stream.getvalue()
    def sticker_catalog(self):
        if self.fail:raise RuntimeError('fake error')
        return {'enabled':self.enabled,'stickers':self.items if self.enabled else [],'categories':[
            {'name':'happy','description':'开心','count':len(self.items)//2},
            {'name':'sad','description':'难过','count':len(self.items)-len(self.items)//2}], 'packs':[]}
    def sticker_image(self,key):
        with self.lock:self.calls.append(key);self.active+=1;self.maximum=max(self.maximum,self.active)
        time.sleep(.01)
        with self.lock:self.active-=1
        return self.png

class PickerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.app=QApplication.instance() or QApplication([])
    def setUp(self):
        self.client=Client();self.parent=QWidget();self.parent.resize(700,540);self.parent.move(20,20)
        self.anchor=QPushButton('表情',self.parent);self.anchor.move(20,480);self.anchor.resize(50,30);self.parent.show()
        self.picker=StickerPicker(self.client,self.parent)
    def tearDown(self):
        self.picker.shutdown();self.parent.hide();self.parent.deleteLater();self.app.processEvents()
    def wait(self,condition):
        deadline=time.monotonic()+4
        while not condition() and time.monotonic()<deadline:self.app.processEvents();time.sleep(.01)
        self.app.processEvents();self.assertTrue(condition())
    def ready_page(self):self.wait(lambda:self.picker._cells and all(b.isEnabled() for b in self.picker._cells.values()))
    def test_paged_loading_filter_preview_and_selection(self):
        self.picker.open_above(self.anchor);self.ready_page()
        first=len(self.picker._cells);self.assertEqual(first,18);self.assertEqual(len(self.client.calls),18);self.assertLessEqual(self.client.maximum,2)
        selected=[];self.picker.selected.connect(selected.append)
        key=next(iter(self.picker._cells));self.picker._show_preview(key);self.app.processEvents();self.assertTrue(self.picker.preview.isVisible())
        self.picker.next.click();self.ready_page();self.assertNotIn(key,self.picker._cells)
        self.picker.previous.click();self.ready_page();self.assertEqual(len(self.client.calls),36,'cached page should not refetch')
        self.picker.categories.setCurrentIndex(2);self.ready_page();self.assertTrue(all(x['category']=='sad' for x in self.picker._filtered))
        key=next(iter(self.picker._cells));self.picker._cells[key].click()
        self.assertEqual(selected,[self.picker._items[key]]);self.assertFalse(self.picker.isVisible());self.assertFalse(self.picker.preview.isVisible())
    def test_error_retry_empty_and_escape(self):
        self.client.fail=True;self.picker.open_above(self.anchor)
        self.wait(lambda:not self.picker._catalog_loading);self.assertIn('失败',self.picker.status.text())
        self.client.fail=False;self.client.enabled=False;self.picker.reload();self.wait(lambda:self.picker._catalog is not None)
        self.assertIn('已关闭',self.picker.status.text());self.assertFalse(self.picker._cells)
        self.picker.keyPressEvent(QKeyEvent(QEvent.Type.KeyPress,Qt.Key.Key_Escape,Qt.KeyboardModifier.NoModifier))
        self.assertFalse(self.picker.isVisible())
    def test_small_window_bounds_and_bounded_cache(self):
        self.parent.resize(360,350);self.anchor.move(20,300)
        self.picker.open_above(self.anchor);self.ready_page()
        bounds=self.parent.frameGeometry();self.assertTrue(bounds.contains(self.picker.frameGeometry()),(bounds,self.picker.frameGeometry()))
        self.assertLessEqual(self.picker._columns,4)
        while self.picker.next.isEnabled():self.picker.next.click();self.ready_page()
        self.assertLessEqual(len(self.picker._cache),48)

if __name__=='__main__':unittest.main()
