"""Qt sticker selection -> actual local HTTP -> persisted image; fake models only."""
import json, subprocess, tempfile, time, shutil
from pathlib import Path
from unittest.mock import patch
import smoke_alignment_qt as base
from PySide6.QtWidgets import QApplication, QToolButton, QLabel
from PySide6.QtGui import QFont, QFontDatabase
from PySide6.QtTest import QTest
from nianan_client import NiananClient
import live_chat
ROOT=base.ROOT

def main():
    temp=Path(tempfile.mkdtemp(prefix='user-sticker-qt-',dir=ROOT/'temp'))
    log=(temp/'fixture.log').open('w',encoding='utf8')
    process=subprocess.Popen(['node',str(ROOT/'backend/test-alignment-e2e.js'),'--serve',str(temp)],cwd=ROOT,
        stdin=subprocess.PIPE,stdout=log,stderr=subprocess.STDOUT,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    app=QApplication.instance() or QApplication([]);window=None
    font_path=Path('C:/Windows/Fonts/msyh.ttc')
    if font_path.is_file():
        QFontDatabase.addApplicationFont(str(font_path))
        app.setFont(QFont('Microsoft YaHei UI',10))
    def wait(condition,seconds=10):
        deadline=time.monotonic()+seconds
        while time.monotonic()<deadline:
            app.processEvents()
            if condition():return
            if process.poll() is not None:raise AssertionError((temp/'fixture.log').read_text('utf8'))
            time.sleep(.01)
        raise AssertionError('Qt sticker timeout: '+(temp/'fixture.log').read_text('utf8'))
    try:
        wait(lambda:(temp/'ready.json').exists())
        client=NiananClient(Path(json.loads((temp/'ready.json').read_text('utf8'))['appRoot']))
        catalog=client.sticker_catalog();assert len(catalog['stickers'])==1
        sticker=catalog['stickers'][0];data=client.sticker_image(sticker['id']);assert data.startswith(b'\x89PNG')
        with patch.object(live_chat,'AudioQueue',base.SilentAudio):window=live_chat.AstrBotChatWindow(client,auto_connect=False)
        window.show();window.session_id='main';window._enable_connected(True)
        draft='这句话先留在输入框。';window.composer.input.setPlainText(draft)
        assert window.sticker_button.isEnabled()
        window.sticker_button.click()
        def choices():return [b for b in window.sticker_picker.findChildren(QToolButton) if b.property('sticker_id')==sticker['id']]
        wait(lambda:window.sticker_picker is not None and bool(choices()) and choices()[0].isEnabled())
        choices()[0].click()
        wait(lambda:window._draft_sticker is not None and not window.sticker_draft_preview.pixmap().isNull())
        assert not window.busy and not client.history('main')['history'],'selection only edits the draft'
        assert window.composer.input.toPlainText()==draft
        assert not window.sticker_picker.isVisible()
        # Draft media supports removal, reselection and both native window sizes.
        window.sticker_remove_button.click()
        assert window._draft_sticker is None and window.sticker_draft.isHidden()
        window.select_sticker(sticker)
        capture=ROOT/'temp'/'mixed-sticker-validation-20261106'
        capture.mkdir(parents=True,exist_ok=True)
        for width,height in ((1000,700),(560,640)):
            window.resize(width,height);QTest.qWait(100);app.processEvents()
            assert window.sticker_remove_button.isVisible()
            assert window.composer_card.geometry().bottom()+1==window.chat_main.height()
            assert window.grab().save(str(capture/f'draft-{width}.png'))
        window.composer.send.click()
        wait(lambda:not window.busy and len(client.history('main')['history'])==4)
        wait(lambda:sum(label.accessibleName()=='图片或表情包' for label in window.findChildren(QLabel))>=2)
        assert window.composer.input.toPlainText()==''
        assert window._draft_sticker is None and window.sticker_draft.isHidden()
        history=client.history('main')['history'];user=history[0]
        assert user['content']['type']=='user'
        parts=user['content']['message'];assert [p['type'] for p in parts]==['plain','image']
        assert parts[0]['text']==draft and parts[1]['sticker_id']==sticker['id']
        assert client.attachment(parts[1]['attachment_id'])==data
        assert window._bubbles[0].content==draft
        assert len([label for label in window._bubbles[0].findChildren(QLabel) if label.accessibleName()=='图片或表情包'])==1
        QTest.qWait(100);app.processEvents()
        assert window.grab().save(str(capture/'mixed-history-560.png'))
        # A history reload keeps exactly that chosen image, not a random same-category replacement.
        window._render_history(client.history('main'))
        wait(lambda:sum(label.accessibleName()=='图片或表情包' for label in window.findChildren(QLabel))>=2)
        assert window.sticker_button.isEnabled()
        assert window.composer_card.geometry().bottom()+1==window.chat_main.height()
        # Clearing all text must still leave a single-sticker draft sendable.
        window.select_sticker(sticker)
        assert window.composer.send.isEnabled()
        window.composer.send.click()
        wait(lambda:not window.busy and len(client.history('main')['history'])==8)
        single=client.history('main')['history'][4]['content']['message']
        assert len(single)==1 and single[0]['type']=='image' and single[0]['sticker_id']==sticker['id']
        assert not window.audio.received,'all fixture audio stays silent'
        print('user-sticker-qt: PASS (picker stages/removes, explicit mixed and pure sends, actual HTTP, exact image/history, two sizes, silence; fake APIs only)')
    finally:
        if window:
            if window.sticker_picker:window.sticker_picker.hide()
            window.audio.stop();window.hide();app.processEvents()
        try:process.communicate(b'close\n',timeout=10)
        except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
        log.close()
        assert temp.resolve().is_relative_to((ROOT/'temp').resolve())
        shutil.rmtree(temp)
if __name__=='__main__':main()
