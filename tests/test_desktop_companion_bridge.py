"""Media, microphone conversion and persisted proactive delivery without live services."""
import base64
import io
import json
import os
from pathlib import Path
from collections import deque
import struct
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave
os.environ['QT_QPA_PLATFORM']='offscreen'
ROOT=Path(__file__).resolve().parents[1]
os.environ['DAFEIYU_PC_ROOT']=str(ROOT)
sys.path.insert(0,str(ROOT/'desktop_bridge'));sys.path.insert(0,str(ROOT/'desktop'))
from PySide6.QtWidgets import QApplication, QMenu, QWidget
from PySide6.QtCore import QObject, Signal, QTimer
from PySide6.QtTest import QTest
from nianan_client import NiananClient
from voice_capture import pcm_to_wav
import companion_bridge
from companion_bridge import CompanionBridge,play_emotion

class Audio(QObject):
    changed=Signal(str,bool)
    failed=Signal(str)
    def __init__(self,parent=None):super().__init__(parent);self.current=None;self.keys=[]
    def stop(self):self.current=None
    def reserve(self,key):self.keys.append(key);return True
    def ready(self,key,data):self.current=key
    def discard(self,key):pass

class BridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.app=QApplication.instance() or QApplication([])
    def setUp(self):self.temp=tempfile.TemporaryDirectory(dir=ROOT/'temp');self.root=Path(self.temp.name)
    def tearDown(self):self.temp.cleanup()
    def test_chat_media_protocol_and_image_only_segments(self):
        client=NiananClient(self.root);published=[];events=[]
        client._publish_bubble=lambda text,emotion=None:published.append((text,emotion))
        client.request=lambda *_a,**_k:{'emotion':'开心','messages':[
            {'text':'你好','parts':[{'type':'plain','text':'你好'},{'type':'record','attachment_id':'voice-1'}]},
            {'parts':[{'type':'image','attachment_id':'image-1'}]}]}
        client.chat('main','hi',[],events.append)
        self.assertEqual([e['type'] for e in events],['attachment_saved','plain','attachment_saved','emotion','end'])
        self.assertEqual(events[0]['data']['type'],'record');self.assertEqual(events[2]['data']['type'],'image')
        self.assertEqual(events[0]['message_id'],events[1]['message_id'])
        self.assertNotEqual(events[0]['message_id'],events[2]['message_id'])
        self.assertEqual(published,[('你好','开心')])
        self.assertTrue(events[-1]['reply_completed'])
    def test_authenticated_media_and_asr_encoding(self):
        client=NiananClient(self.root);calls=[]
        def request(method,path,**kwargs):
            calls.append((method,path,kwargs))
            return {'data':base64.b64encode(b'RIFFfake').decode()} if method=='GET' else {'text':'识别文字'}
        client.request=request
        self.assertEqual(client.attachment('audio-id'),b'RIFFfake')
        self.assertEqual(client.transcribe(b'RIFFtest')['text'],'识别文字')
        self.assertEqual(base64.b64decode(calls[-1][2]['json']['audio']),b'RIFFtest')
    def test_pcm_normalizes_to_mono_16000_wav(self):
        pcm=struct.pack('<'+'h'*960,*([1000,-1000]*480))
        converted=pcm_to_wav(pcm,48000,2,'int16')
        with wave.open(io.BytesIO(converted),'rb') as audio:
            self.assertEqual((audio.getnchannels(),audio.getframerate(),audio.getsampwidth()),(1,16000,2))
            self.assertEqual(audio.getnframes(),160)
    def make_bridge(self,window=None):
        bubbles=[];animations=[]
        sprite=SimpleNamespace(request_link_anim=lambda name:animations.append(name))
        overlay=SimpleNamespace(sprite=sprite,lib=SimpleNamespace(names=lambda:['点击回应 - 开心跃动']),
            show_bubble=lambda text,**kwargs:bubbles.append(text) or True)
        client=SimpleNamespace(root=self.root,request=lambda *_a,**_k:{'ok':True})
        shell=SimpleNamespace(app=self.app,_pc_chat=SimpleNamespace(window=window),_overlay_shell=overlay,
            instance=SimpleNamespace(config=SimpleNamespace(get=lambda *_a:True)))
        with patch.object(companion_bridge,'AudioQueue',Audio):bridge=CompanionBridge(shell,client,auto_start=False)
        return bridge,shell,bubbles,animations
    def test_quiet_preserves_event_then_cursor_avoids_replay(self):
        bridge,shell,bubbles,animations=self.make_bridge();bridge._quiet=lambda:True
        event={'id':1,'session_id':'main','type':'assistant','emotion':'开心','messages':[{'text':'主动问候'}]}
        bridge._received({'events':[event],'cursor':1})
        self.assertEqual(bridge.cursor,0);self.assertEqual(bubbles,[])
        bridge._quiet=lambda:False;bridge._drain()
        self.assertEqual(bubbles,['主动问候']);self.assertEqual(bridge.cursor,1)
        self.assertEqual(animations,['点击回应 - 开心跃动'])
        bridge._received({'events':[event],'cursor':1});self.assertEqual(bubbles,['主动问候'])
        self.assertEqual(json.loads(bridge.cursor_path.read_text())['cursor'],1)
        bridge.stop();bridge.deleteLater()
        newer,_,bubbles2,_=self.make_bridge();newer._quiet=lambda:False
        newer._received({'events':[event],'cursor':1});self.assertEqual(bubbles2,[]);newer.stop();newer.deleteLater()
    def test_visible_chat_refreshes_authoritative_history_not_bubble(self):
        refreshed=[];played=[]
        window=SimpleNamespace(session_id='main',busy=False,_loading=False,audio=SimpleNamespace(current=None),
            isVisible=lambda:True,refresh_backend=lambda:refreshed.append(True),_play_voice=lambda key:played.append(key))
        bridge,shell,bubbles,_=self.make_bridge(window);bridge._quiet=lambda:False
        event={'id':3,'session_id':'main','type':'assistant','messages':[{'text':'新的主动消息','parts':[{'type':'record','attachment_id':'v'}]}]}
        bridge._received({'events':[event],'cursor':3})
        self.assertEqual(refreshed,[True]);self.assertEqual(played,[]);self.assertEqual(bubbles,[])
        self.assertFalse(play_emotion(shell,'未知情绪'));self.assertFalse(play_emotion(shell,'害羞'))
        bridge.stop();bridge.deleteLater()
    def test_old_qq_event_is_consumed_without_pc_display_or_notification(self):
        refreshed=[]
        window=SimpleNamespace(session_id='main',busy=True,_loading=False,audio=SimpleNamespace(current=None),
            isVisible=lambda:True,refresh_backend=lambda:refreshed.append(True))
        bridge,_,bubbles,animations=self.make_bridge(window);bridge._quiet=lambda:True
        event={'id':1,'session_id':'main','type':'assistant','source':'qq','emotion':'开心',
            'messages':[{'text':'这段只属于QQ','parts':[{'type':'record','attachment_id':'qq-v'}]}]}
        bridge._received({'events':[event],'cursor':1})
        self.assertEqual(bridge.cursor,1);self.assertFalse(bridge.queue)
        self.assertEqual(refreshed,[]);self.assertEqual(bubbles,[]);self.assertEqual(animations,[])
        self.assertEqual(bridge.audio.keys,[])
        bridge.stop();bridge.deleteLater()
        newer,_,bubbles2,_=self.make_bridge();newer._quiet=lambda:False
        newer._received({'events':[event],'cursor':1})
        self.assertEqual(newer.cursor,1);self.assertEqual(bubbles2,[])
        newer.stop();newer.deleteLater()
    def test_hidden_qq_event_cannot_acknowledge_an_earlier_unshown_pc_delivery(self):
        callbacks=[]
        window=SimpleNamespace(session_id='main',busy=True,_loading=False,audio=SimpleNamespace(current=None),
            isVisible=lambda:True,deliver_companion_event=lambda event,done:callbacks.append(done) or True)
        bridge,_,bubbles,_=self.make_bridge(window);bridge._quiet=lambda:False
        pc={'id':10,'session_id':'main','type':'assistant','source':'pc_tool','origin_request_id':'qq-parent',
            'messages':[{'text':'明确要求的PC留言'}]}
        qq={'id':11,'session_id':'main','type':'assistant','source':'qq','messages':[{'text':'QQ普通聊天'}]}
        bridge._received({'events':[pc,qq],'cursor':11})
        self.assertEqual(bridge.cursor,0);self.assertEqual(len(bridge.queue),2)
        window.busy=False;bridge._drain()
        self.assertEqual(bridge.cursor,0);self.assertEqual(len(callbacks),1)
        callbacks.pop()(True)
        self.assertEqual(bridge.cursor,10)
        bridge._drain()
        self.assertEqual(bridge.cursor,11);self.assertFalse(bridge.queue);self.assertEqual(bubbles,[])
        bridge.stop();bridge.deleteLater()
    def test_pc_tool_waits_for_busy_chat_and_delivers_once_on_each_pc_surface(self):
        refreshed=[]
        window=SimpleNamespace(session_id='main',busy=True,_loading=False,audio=SimpleNamespace(current=None),
            isVisible=lambda:True,refresh_backend=lambda:refreshed.append(True))
        bridge,_,bubbles,_=self.make_bridge(window);bridge._quiet=lambda:False
        visible={'id':20,'session_id':'main','type':'assistant','source':'pc_tool',
            'messages':[{'text':'大肥鱼非常美味！'}]}
        bridge._received({'events':[visible]})
        bridge._received({'events':[visible]})
        self.assertEqual(bridge.cursor,0);self.assertEqual(len(bridge.queue),1)
        self.assertEqual(refreshed,[]);self.assertEqual(bubbles,[])
        window.busy=False;bridge._drain()
        self.assertEqual(refreshed,[True]);self.assertEqual(bridge.cursor,20)
        self.assertEqual(bubbles,[])
        bridge._received({'events':[visible]})
        self.assertEqual(refreshed,[True]);self.assertFalse(bridge.queue)

        window.isVisible=lambda:False
        hidden={'id':21,'session_id':'main','type':'assistant','source':'pc_tool',
            'messages':[{'text':'这条只发到电脑。'}]}
        bridge._received({'events':[hidden]})
        bridge._received({'events':[visible,hidden]})
        self.assertEqual(bubbles,['这条只发到电脑。'])
        self.assertEqual(refreshed,[True]);self.assertEqual(bridge.cursor,21)
        self.assertFalse(bridge.queue);self.assertEqual(bridge.audio.keys,[])
        self.assertEqual(json.loads(bridge.cursor_path.read_text())['cursor'],21)
        bridge.stop();bridge.deleteLater()
    def test_hidden_voice_delivery_does_not_fetch_or_play_audio(self):
        bridge,_,bubbles,_=self.make_bridge();bridge._quiet=lambda:False
        event={'id':4,'session_id':'main','type':'assistant','messages':[{'text':'一条主动语音',
            'parts':[{'type':'plain','text':'一条主动语音'},{'type':'record','attachment_id':'hidden-v'}]}]}
        bridge._received({'events':[event],'cursor':4})
        self.assertEqual(bubbles,['一条主动语音']);self.assertEqual(bridge.cursor,4)
        self.assertEqual(bridge.audio.keys,[])
        bridge.stop();bridge.deleteLater()
    def test_failed_history_delivery_does_not_acknowledge_event(self):
        callbacks=[]
        window=SimpleNamespace(session_id='main',busy=False,_loading=False,audio=SimpleNamespace(current=None),
            isVisible=lambda:True,deliver_companion_event=lambda event,done:callbacks.append(done) or True)
        bridge,_,_,_=self.make_bridge(window);bridge._quiet=lambda:False
        event={'id':7,'session_id':'main','type':'assistant','messages':[{'text':'可靠交付'}]}
        bridge._received({'events':[event],'cursor':7})
        self.assertEqual(bridge.cursor,0);callbacks.pop()(False)
        self.assertEqual(bridge.cursor,0);self.assertEqual(len(bridge.queue),1)
        bridge._drain();callbacks.pop()(True)
        self.assertEqual(bridge.cursor,7);self.assertEqual(len(bridge.queue),0)
        bridge.stop();bridge.deleteLater()

    def test_bridge_propagates_quiet_to_visible_chat_without_acknowledging(self):
        quiet_calls=[]
        window=SimpleNamespace(session_id='main',busy=False,_loading=False,audio=SimpleNamespace(current=None),
            isVisible=lambda:True,set_companion_quiet=lambda value,**kw:quiet_calls.append(value))
        bridge,_,bubbles,_=self.make_bridge(window);bridge._quiet=lambda:True
        event={'id':11,'session_id':'main','type':'assistant','messages':[{'text':'等待免打扰结束'}]}
        bridge._received({'events':[event]});bridge._quiet_updated()
        self.assertEqual(quiet_calls,[True,True]);self.assertEqual(bridge.cursor,0);self.assertFalse(bubbles)
        bridge.stop();bridge.deleteLater()

    def make_quiet_chat(self):
        import live_chat
        class Client:
            backend_name='测试后台';is_local_backend=True;supports_attachments=False;username='local'
            root=self.root
        class SilentAudio(Audio):
            def __init__(self,parent=None):super().__init__(parent);self.pending=set();self.played=[]
            def reserve(self,key):self.pending.add(key);return True
            def ready(self,key,data):
                if key in self.pending:
                    self.pending.remove(key);self.current=key;self.played.append(key);self.changed.emit(key,True)
            def discard(self,key):self.pending.discard(key)
            def cancel(self,keys):
                self.pending.difference_update(keys)
                if self.current in keys:self.stop()
            def stop(self):
                key=self.current;self.current=None;self.pending.clear()
                if key:self.changed.emit(key,False)
        with patch.object(live_chat,'AudioQueue',SilentAudio):window=live_chat.AstrBotChatWindow(Client(),auto_connect=False)
        window.connected=True;window.session_id='main'
        return window

    def test_background_share_shown_in_pet_bubble_refreshes_reused_chat(self):
        from native_chat_controller import NativeChatController

        window = self.make_quiet_chat()
        controller = NativeChatController(factory=lambda: window)
        bridge, shell, bubbles, _ = self.make_bridge(window)
        shell._pc_chat = controller
        bridge._quiet = lambda: False
        history_reads = []
        messages = ['先前已经显示的聊天记录']

        def history(session_id):
            history_reads.append(session_id)
            return {'history': [
                {'id': index, 'created_at': f'2026-11-08T10:00:{index:02d}',
                 'content': {'type': 'assistant', 'message': [{'type': 'plain', 'text': text}]}}
                for index, text in enumerate(messages, start=1)
            ]}

        def wait_for_text(expected):
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline and (window._loading or
                    [bubble.content for bubble in window._bubbles] != expected):
                QTest.qWait(10)
            self.assertEqual([bubble.content for bubble in window._bubbles], expected)

        window.client.history = history
        window.client.sessions = lambda: [{'session_id': 'main', 'display_name': '隔离会话'}]
        try:
            controller.open_chat()
            window._open_session('main')
            wait_for_text(messages)
            self.assertEqual(history_reads, ['main'])
            window.composer.input.setPlainText('还没发出的草稿')
            window.close()
            self.assertFalse(window.isVisible())

            share = '逛小红书看到一篇有意思的摄影笔记。'
            messages.append(share)
            event = {'id': 1, 'session_id': 'main', 'type': 'assistant', 'source': 'background_browse',
                     'messages': [{'text': share}]}
            bridge._received({'events': [event]})
            self.assertEqual(bubbles, [share])
            self.assertEqual(bridge.cursor, 1)
            self.assertEqual([bubble.content for bubble in window._bubbles], messages[:1])

            controller.open_chat()
            self.assertIs(controller.window, window)
            wait_for_text(messages)
            self.assertEqual(history_reads, ['main', 'main'])
            self.assertEqual(window.composer.input.toPlainText(), '还没发出的草稿')
            bridge._received({'events': [event]})
            self.assertEqual(bubbles, [share])
            self.assertEqual([bubble.content for bubble in window._bubbles], messages)
        finally:
            bridge.stop()
            bridge.deleteLater()
            window.hide()
            window.deleteLater()
            self.app.processEvents()

    def test_one_menu_exit_quits_with_reusable_chat_open(self):
        from native_chat_controller import NativeChatController
        from pet.context_menus.shared import add_quit

        # The real pet window exists before the chat, and must also close on exit.
        pet_window = QWidget()
        window = self.make_quiet_chat()
        window.client.sessions = lambda: [{'session_id': 'main', 'display_name': '隔离会话'}]
        window.client.history = lambda _session_id: {'history': []}
        controller = NativeChatController(factory=lambda: window)
        menu = QMenu()
        quit_requests = []
        shutdown = []

        def quit_from_menu():
            quit_requests.append((pet_window.isVisible(), window.isVisible()))
            self.app.quit()

        def on_shutdown():
            shutdown.append(True)

        exit_action = add_quit(menu, SimpleNamespace(request_quit=quit_from_menu), icons=False)
        watchdog = QTimer()
        watchdog.setSingleShot(True)
        watchdog.timeout.connect(lambda: self.app.exit(73))
        quit_on_last = self.app.quitOnLastWindowClosed()
        self.app.setQuitOnLastWindowClosed(False)
        self.app.aboutToQuit.connect(on_shutdown)
        try:
            pet_window.show()
            controller.open_chat()
            window.composer.input.setPlainText('未发送的草稿')
            window.close_button.click()
            self.assertFalse(window.isVisible())
            controller.open_chat()
            self.assertIs(controller.window, window)
            self.assertTrue(window.isVisible())
            self.assertEqual(window.composer.input.toPlainText(), '未发送的草稿')

            QTimer.singleShot(0, exit_action.trigger)
            watchdog.start(1500)
            self.assertEqual(self.app.exec(), 0, 'one menu exit must reach Qt shutdown')
            self.assertEqual(quit_requests, [(True, True)])
            self.assertEqual(shutdown, [True])
            self.assertFalse(window.isVisible())
            self.assertFalse(pet_window.isVisible())
        finally:
            watchdog.stop()
            self.app.aboutToQuit.disconnect(on_shutdown)
            self.app.setQuitOnLastWindowClosed(quit_on_last)
            window.hide()
            window.deleteLater()
            pet_window.hide()
            pet_window.deleteLater()
            menu.deleteLater()
            self.app.processEvents()

    def test_quiet_cancels_pending_and_playing_companion_voice_only(self):
        window=self.make_quiet_chat();requests=[]
        window._submit=lambda operation,success,failure=None:requests.append(success)
        window._play_voice('pending',companion=True)
        window.set_companion_quiet(True)
        window.set_companion_quiet(False)
        requests.pop()(b'late audio')
        self.assertEqual(window.audio.played,[])
        window._play_voice('playing',companion=True);requests.pop()(b'audio')
        self.assertEqual(window.audio.current,'playing');window.set_companion_quiet(True)
        self.assertIsNone(window.audio.current)
        window._play_voice('manual');requests.pop()(b'intentional playback')
        self.assertEqual(window.audio.current,'manual')
        window.audio.stop();window.hide();window.deleteLater();self.app.processEvents()

    def test_quiet_rechecked_after_proactive_history_and_media_load(self):
        window=self.make_quiet_chat();window.show();requests=[];ack=[];quiet=[False]
        window._submit=lambda operation,success,failure=None:requests.append(success)
        window._render_history=lambda history:None
        window.set_companion_quiet(False,check=lambda:quiet[0])
        event={'session_id':'main','messages':[{'parts':[{'type':'record','attachment_id':'history-v'}]}]}
        self.assertTrue(window.deliver_companion_event(event,ack.append))
        quiet[0]=True;requests.pop()({})
        self.assertEqual(ack,[False]);self.assertFalse(window.audio.pending)
        quiet[0]=False;window._play_voice('fetch-v',companion=True)
        quiet[0]=True;requests.pop()(b'late audio')
        self.assertEqual(window.audio.played,[]);self.assertFalse(window.audio.pending)
        window.audio.stop();window.hide();window.deleteLater();self.app.processEvents()

    def test_late_proactive_history_does_not_interrupt_a_new_draft(self):
        window=self.make_quiet_chat();window.show();requests=[];ack=[];rendered=[]
        window._submit=lambda operation,success,failure=None:requests.append(success)
        window._render_history=lambda history:rendered.append(history)
        bridge,_,_,_=self.make_bridge(window)
        window.composer.input.setPlainText('  ')
        self.assertFalse(bridge.presence()['typing'])
        event={'session_id':'main'}
        self.assertTrue(window.deliver_companion_event(event,ack.append))
        self.assertFalse(window._loading)
        window.composer.input.setPlainText('我正想发下一句')
        self.assertTrue(bridge.presence()['typing'])
        self.assertFalse(window.deliver_companion_event(event,ack.append))
        requests.pop()({})
        self.assertEqual(ack,[False]);self.assertEqual(rendered,[])
        window.hide()
        self.assertFalse(bridge.presence()['typing'])
        bridge.stop();bridge.deleteLater();window.deleteLater();self.app.processEvents()

    def test_reply_receipt_requires_successful_display_completion(self):
        window=self.make_quiet_chat();requests=[]
        window.client.sessions=lambda:[]
        window.client.stop=lambda _session_id:None
        window._submit=lambda operation,success,failure=None:requests.append((success,failure))
        window._render_history=lambda history:None
        bridge,_,_,_=self.make_bridge(window)
        window._send_turn('我来聊天',[])
        success,_=requests.pop()
        self.assertTrue(bridge.presence()['busy']);self.assertIsNone(bridge.presence()['reply_completed'])
        window._stream_event((window._chat_generation,{'type':'end','message_id':'reply-1','reply_completed':True}))
        self.assertIsNone(bridge.presence()['reply_completed'])
        success({})
        receipt={'session_id':'main','request_id':'reply-1'}
        self.assertEqual(bridge.presence()['reply_completed'],receipt)
        self.assertEqual(bridge.presence()['reply_completed'],receipt)
        requests.clear()
        window._send_turn('继续',[])
        success,_=requests.pop()
        window._stream_event((window._chat_generation,{'type':'end','message_id':'reply-2','reply_completed':False}))
        success(None)
        self.assertIsNone(bridge.presence()['reply_completed'])
        requests.clear()
        window._send_turn('这轮请停',[])
        success,_=requests.pop()
        window._stream_event((window._chat_generation,{'type':'end','message_id':'reply-3','reply_completed':True}))
        window.stop_reply()
        stopped,_=requests.pop()
        success({})
        stopped(None)
        self.assertIsNone(bridge.presence()['reply_completed'])
        bridge.stop();bridge.deleteLater();window.hide();window.deleteLater();self.app.processEvents()

    def test_quiet_batch_cancellation_never_starts_another_proactive_clip(self):
        from audio_queue import AudioQueue
        queue=AudioQueue.__new__(AudioQueue);QObject.__init__(queue)
        played=[]
        class Player:
            def setSourceDevice(self,*args):pass
            def setSource(self,*args):pass
            def play(self):played.append(queue.current)
            def stop(self):pass
        queue.player=Player();queue.current=None;queue._buffer=None
        queue.pending=deque(['first','second','manual'])
        queue.data={'first':None,'second':b'RIFFready','manual':b'RIFFmanual'}
        window=self.make_quiet_chat();window.audio=queue
        window._companion_audio_keys={'first','second'}
        window.set_companion_quiet(True)
        self.assertEqual(played,['manual']);self.assertEqual(queue.current,'manual')
        self.assertFalse(queue.pending);self.assertFalse(queue.data)
        # Cancelling a currently playing proactive clip also preserves manual work.
        queue.stop();queue.current='current-proactive'
        queue.pending=deque(['next-proactive','next-manual'])
        queue.data={'next-proactive':b'RIFFready','next-manual':b'RIFFmanual'}
        window._companion_audio_keys={'current-proactive','next-proactive'}
        window.set_companion_quiet(True)
        self.assertEqual(played,['manual','next-manual']);self.assertEqual(queue.current,'next-manual')
        queue.stop();window.hide();window.deleteLater();self.app.processEvents()

    def test_asr_populates_composer_without_automatic_send(self):
        from live_chat import AstrBotChatWindow
        class Client:
            backend_name='测试后台';is_local_backend=True;supports_attachments=False;username='local'
            root=self.root
            def transcribe(self,audio):return {'text':'这是识别文字'}
            def settings(self):return {'voice':{'autoSend':False}}
        window=AstrBotChatWindow(Client(),auto_connect=False);window.connected=True;window.session_id='main'
        window._enable_connected(True);window._transcribe_audio(b'fake-wav')
        deadline=time.monotonic()+3
        while window._asr_pending and time.monotonic()<deadline:self.app.processEvents();time.sleep(.005)
        self.assertFalse(window._asr_pending);self.assertEqual(window.composer.input.toPlainText(),'这是识别文字')
        self.assertFalse(window.busy);window.audio.stop();window.hide();window.deleteLater();self.app.processEvents()
if __name__=='__main__':unittest.main()
