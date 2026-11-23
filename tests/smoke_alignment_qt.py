"""Source Qt + real local HTTP service smoke, with fake model/TTS/ASR and no mic hardware."""
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch
from types import SimpleNamespace
os.environ['QT_QPA_PLATFORM']='offscreen'
ROOT=Path(__file__).resolve().parents[1]
os.environ['DAFEIYU_PC_ROOT']=str(ROOT)
sys.path.insert(0,str(ROOT/'desktop_bridge'));sys.path.insert(0,str(ROOT/'desktop'))
from PySide6.QtCore import QObject,Signal
from PySide6.QtWidgets import QApplication,QLabel
from nianan_client import NiananClient
import live_chat
from live_chat import AstrBotChatWindow,VoiceButton
from pet.local_memory_settings import LocalMemorySettingsPage
from pet.local_voice_settings import LocalVoiceSettingsPage
from pet.local_companion_settings import LocalCompanionSettingsPage
import companion_bridge
from companion_bridge import CompanionBridge

class SilentAudio(QObject):
    """Test playback accepts actual WAV bytes, without accessing speakers."""
    changed=Signal(str,bool)
    failed=Signal(str)
    def __init__(self,parent=None):super().__init__(parent);self.current=None;self.received=[]
    def reserve(self,key):self.current=key;return True
    def ready(self,key,data):assert data.startswith(b'RIFF');self.received.append((key,data));self.current=None
    def discard(self,key):self.current=None
    def cancel(self,keys):
        if self.current in keys:self.current=None
    def stop(self):self.current=None

def main():
    temp=Path(tempfile.mkdtemp(prefix='alignment-qt-',dir=ROOT/'temp'))
    log=(temp/'fixture.log').open('w',encoding='utf8')
    process=subprocess.Popen(['node',str(ROOT/'backend/test-alignment-e2e.js'),'--serve',str(temp)],
        cwd=ROOT,stdin=subprocess.PIPE,stdout=log,stderr=subprocess.STDOUT,
        creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    app=QApplication.instance() or QApplication([])
    windows=[]
    def wait(condition,seconds=10):
        deadline=time.monotonic()+seconds
        while time.monotonic()<deadline:
            app.processEvents()
            if condition():return
            if process.poll() is not None:raise AssertionError('Fixture exited: '+(temp/'fixture.log').read_text('utf8'))
            time.sleep(.01)
        raise AssertionError('Qt/HTTP smoke timeout: '+(temp/'fixture.log').read_text('utf8'))
    try:
        wait(lambda:(temp/'ready.json').exists())
        ready=json.loads((temp/'ready.json').read_text('utf8'))
        client=NiananClient(Path(ready['appRoot']))
        assert client.request('GET','/health')['configured']
        with patch.object(live_chat,'AudioQueue',SilentAudio):window=AstrBotChatWindow(client,auto_connect=False)
        windows.append(window);window.show();window.session_id='main';window._enable_connected(True)
        window.composer.input.setPlainText('我住在北京。今天很开心，谢谢你陪我。请发条语音。')
        window.send_message();wait(lambda:not window.busy and len(window._bubbles)==4)
        wait(lambda:any(label.accessibleName()=='图片或表情包' for label in window.findChildren(QLabel)))
        assert len(window.findChildren(VoiceButton))==1,'one playable voice per turn'
        first_voice=window.findChildren(VoiceButton)[0]
        assert first_voice.transcript=='已经记住啦。'
        assert window._bubbles[1].content=='' and first_voice.transcript_label.isHidden()
        first_voice.transcript_action.trigger()
        assert first_voice.transcript_label.text()=='已经记住啦。' and not first_voice.transcript_label.isHidden()
        assert window._bubbles[2].content=='','image-only segment survives history refresh'
        assert window._bubbles[3].content=='今天也很开心。'
        assert len(window._bubbles[1].findChildren(VoiceButton))==1,'voice and transcript share one bubble'
        assert not window.audio.received,'new voices never autoplay or fetch audio before a click'
        first_voice.click();wait(lambda:bool(window.audio.received))
        history=client.history('main')['history']
        assert len(history)==4
        image=next(p for p in history[2]['content']['message'] if p['type']=='image')
        assert client.attachment(image['attachment_id']).startswith(b'\x89PNG')
        # ASR follows the UI worker -> HTTP -> source provider -> draft path, without a device.
        wav=window.audio.received[0][1]
        before=len(client.history('main')['history'])
        window._transcribe_audio(wav);wait(lambda:not window._asr_pending)
        assert window.composer.input.toPlainText()=='这是端到端识别文字'
        assert not window.busy and len(client.history('main')['history'])==before,'default ASR does not auto-send'
        # Every newly aligned native settings page reads the same actual backend.
        for cls in (LocalMemorySettingsPage,LocalVoiceSettingsPage,LocalCompanionSettingsPage):
            page=cls(client=client);windows.append(page);page.show();wait(lambda:page._loaded)
            assert not page.dirty
            if isinstance(page,LocalMemorySettingsPage):
                assert page.facts.topLevelItemCount()>=1
                page.facts.setCurrentItem(page.facts.topLevelItem(0));app.processEvents()
                assert '我住在北京' in page.detail.toPlainText()
            elif isinstance(page,LocalVoiceSettingsPage):
                assert '1 张' in page.library_status.text()
            else:
                assert '已开启' in page.runtime.text() or page.runtime.text()
        # Persisted actual service proactive event reaches the global desktop bridge even with chat hidden.
        bubbles=[];animations=[]
        overlay=SimpleNamespace(sprite=SimpleNamespace(request_link_anim=animations.append),
            lib=SimpleNamespace(names=lambda:['点击回应 - 开心跃动']),
            show_bubble=lambda text,**kwargs:bubbles.append(text) or True)
        shell=SimpleNamespace(app=app,_pc_chat=SimpleNamespace(window=window),_overlay_shell=overlay,
            instance=SimpleNamespace(config=SimpleNamespace(get=lambda *_:True)))
        with patch.object(companion_bridge,'AudioQueue',SilentAudio):bridge=CompanionBridge(shell,client,auto_start=False)
        bridge._quiet=lambda:False
        assert bridge.presence()['typing'],'the unsubmitted ASR draft blocks proactive dialogue'
        window.composer.input.clear();window.hide()
        assert not bridge.presence()['typing']
        assert bridge.presence()['reply_completed']['session_id']=='main','Qt reports the successfully completed reply'
        bridge.poll();wait(lambda:not bridge._inflight)
        assert client.request('GET','/companion/status')['nextEligibleAt'] is not None,'the real Qt receipt arms the server gap'
        process.stdin.write(b'tick\n');process.stdin.flush();wait(lambda:(temp/'tick.json').exists())
        assert json.loads((temp/'tick.json').read_text('utf8'))['sent']
        bridge._quiet=lambda:True;bridge.poll();wait(lambda:not bridge._inflight)
        assert bridge.cursor==0 and not bubbles,'quiet mode preserves backend event'
        bridge._quiet=lambda:False;bridge._drain();wait(lambda:bridge.cursor>0)
        assert len(bubbles)==1 and animations==['点击回应 - 开心跃动']
        assert not bridge.audio.received,'hidden proactive deliveries never autoplay'
        assert json.loads(bridge.cursor_path.read_text('utf8'))['cursor']==bridge.cursor
        bridge.stop();bridge.deleteLater()
        with patch.object(companion_bridge,'AudioQueue',SilentAudio):again=CompanionBridge(shell,client,auto_start=False)
        again._quiet=lambda:False;again.poll();wait(lambda:not again._inflight)
        assert not again.queue and len(bubbles)==1,'persistent cursor avoids replay after UI restart'
        hidden_cursor=again.cursor
        previous_reply=window.last_completed_reply
        window.show();window.composer.input.setPlainText('再聊一句。');window.send_message()
        wait(lambda:not window.busy and window.last_completed_reply is not None and window.last_completed_reply!=previous_reply)
        again.poll();wait(lambda:not again._inflight)
        assert client.request('GET','/companion/status')['nextEligibleAt'] is not None
        tick_file=temp/'tick.json';tick_file.unlink()
        process.stdin.write(b'tick\n');process.stdin.flush();wait(tick_file.exists)
        assert json.loads(tick_file.read_text('utf8'))['sent'],'a visible but idle chat permits a proactive message'
        count_before=len(window._bubbles)
        again.poll();wait(lambda:again.cursor>hidden_cursor)
        assert len(window._bubbles)==count_before+1 and '今天有没有听到好听的歌' in window._bubbles[-1].content
        assert len(bubbles)==1,'a visible chat receives the message without an extra desktop bubble'
        again.stop();again.deleteLater()
        # The actual NiananClient segmented event adapter also preserves mixed parts.
        events=[];client.chat('main','还记得我住哪里吗？',[],events.append)
        assert events[0]['type']=='plain'
        first_message_id=events[0]['message_id']
        assert ''.join(e['data'] for e in events if e['type']=='plain' and e.get('message_id')==first_message_id)=='你住在北京。'
        assert not any(e['type']=='attachment_saved' and e.get('data',{}).get('type')=='record' for e in events),'nearby replies use text'
        assert any(e['type']=='emotion' for e in events)
        print('alignment-qt: PASS (actual HTTP chat/media/ASR/settings, Qt reply receipt, draft gate, visible chat and hidden bubble, quiet preservation, animation, cursor)')
    finally:
        for window in reversed(windows):
            if hasattr(window,'audio'):window.audio.stop()
            if hasattr(window,'microphone') and window.microphone:window.microphone.cancel()
            window.hide()
        app.processEvents()
        try:
            process.communicate(b'close\n',timeout=10)
        except subprocess.TimeoutExpired:
            process.kill();process.wait(timeout=5)
        log.close()
        assert temp.resolve().is_relative_to((ROOT/'temp').resolve())
        shutil.rmtree(temp)
if __name__=='__main__':main()
