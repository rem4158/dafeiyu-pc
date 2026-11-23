"""Persistent proactive delivery and safe mood-to-existing-animation routing."""
import json
import threading
from collections import deque
from pathlib import Path
from PySide6.QtCore import QObject,QTimer,Signal
from audio_queue import AudioQueue
from nianan_client import NiananClient

ANIMATIONS={
    '开心':'点击回应 - 开心跃动','happy':'点击回应 - 开心跃动','joy':'点击回应 - 开心跃动',
    '害羞':'点击回应 - 害羞惊讶','shy':'点击回应 - 害羞惊讶',
    '生气':'点击回应 - 傲娇生气（侧身展示）','angry':'点击回应 - 傲娇生气（侧身展示）',
    '记笔记':'轻快记录','看手机':'深度思考碎碎念',
}

def play_emotion(shell,emotion):
    name=ANIMATIONS.get(str(emotion or ''))
    if not name:return False
    overlay=getattr(shell,'_overlay_shell',None)
    instance=getattr(shell,'instance',None)
    target=getattr(overlay,'sprite',None) if overlay else getattr(instance,'win',None)
    library=getattr(overlay,'lib',None) if overlay else getattr(instance,'lib',None)
    names=getattr(library,'names',None)
    if target is None or not callable(names) or name not in names():return False
    action=getattr(target,'request_link_anim',None)
    if not callable(action):return False
    action(name);return True

class CompanionBridge(QObject):
    delivered=Signal(object)
    media_ready=Signal(str,object)
    quiet_changed=Signal()
    def __init__(self,shell,client=None,*,auto_start=True):
        super().__init__(shell.app)
        self.shell=shell;self.client=client or NiananClient(__import__('os').environ['DAFEIYU_PC_ROOT'])
        self.cursor_path=self.client.root/'event-cursor.json'
        self.cursor=0;self.partial=None
        try:
            saved=json.loads(self.cursor_path.read_text('utf-8'))
            self.cursor=int(saved.get('cursor',0));self.partial=saved.get('partial')
        except (OSError,ValueError,TypeError):pass
        self._inflight=False;self._presenting=False;self._stopped=False
        self._browser_dialog = None
        self._browser_ticket = None
        self.queue=deque();self.queued=set()
        self.audio=AudioQueue(self);self.audio.changed.connect(self._audio_changed)
        self.media_ready.connect(self._media_received)
        self.delivered.connect(self._received)
        self.quiet_changed.connect(self._quiet_updated)
        self._quiet_state=None
        try:
            from pet.quiet_mode import shared_quiet_state
            self._quiet_state=shared_quiet_state()
            self._quiet_state.add_listener(self.quiet_changed.emit)
        except ImportError:pass
        self.timer=QTimer(self);self.timer.timeout.connect(self.poll)
        if auto_start:self.timer.start(3000);QTimer.singleShot(500,self.poll)
        shell.app.aboutToQuit.connect(self.stop)

    def _window(self):return getattr(getattr(self.shell,'_pc_chat',None),'window',None)

    def _quiet(self):
        try:
            from pet.quiet_mode import shared_quiet_state
            config=getattr(getattr(self.shell,'instance',None),'config',None)
            fullscreen=bool(config.get('quiet_also_on_fullscreen',True)) if config else True
            return bool(shared_quiet_state().suppression_active(also_on_fullscreen=fullscreen))
        except (ImportError,AttributeError):return False

    def presence(self):
        window=self._window();session=getattr(window,'session_id','')
        if not session:
            try:session=json.loads((self.client.root/'chat-state.json').read_text('utf-8')).get('session_id','')
            except (OSError,ValueError):pass
        recording=bool(getattr(getattr(window,'microphone',None),'recording',False))
        has_draft=getattr(window,'has_visible_draft',None)
        return {'session_id':session or 'main','chat_open':bool(window and window.isVisible()),
            'busy':bool(window and (window.busy or window._loading)),
            'voice_active':bool(self.audio.current or (window and window.audio.current) or recording
                                or getattr(window,'_asr_pending',False) or getattr(window,'_voice_fetches',None)),
            'typing':bool(callable(has_draft) and has_draft()),
            'reply_completed':getattr(window,'last_completed_reply',None),
            'quiet':self._quiet()}

    def poll(self):
        if self._inflight or self._stopped:return
        presence=self.presence()
        self._sync_quiet(presence['quiet'])
        self._inflight=True;cursor=self.cursor
        def work():
            try:
                self.client.request('POST','/companion/presence',json=presence,timeout=(2,5))
                result=self.client.request('GET','/events',params={'after':cursor},timeout=(2,5))
            except Exception:result=None
            try:self.delivered.emit(result)
            except RuntimeError:pass
        threading.Thread(target=work,daemon=True,name='CompanionEvents').start()

    def _received(self,result):
        self._inflight=False
        if self._stopped:return
        if result:
            if 'browser_challenge' in result:
                self._browser_challenge(result['browser_challenge'])
            for event in result.get('events',[]):
                identifier=event.get('id')
                if not isinstance(identifier,int) or identifier<=self.cursor or identifier in self.queued:continue
                self.queue.append(event);self.queued.add(identifier)
        self._drain()

    def _browser_challenge(self, challenge):
        # The original chat may be busy waiting for this answer. Keep this separate
        # from assistant messages, cursor files and the chat input/history.
        ticket = challenge.get('id') if isinstance(challenge, dict) else None
        if ticket == self._browser_ticket and not self._stopped:
            return
        if self._browser_dialog is not None:
            dialog = self._browser_dialog
            if ticket or self._stopped or not dialog.isVisible():
                dialog.dismiss()
                dialog.deleteLater()
                self._browser_dialog = None
            else:
                def retired(_result):
                    if self._browser_dialog is dialog:
                        self._browser_dialog = None
                        dialog.deleteLater()
                dialog.finished.connect(retired)
                dialog.end_notice()
        self._browser_ticket = ticket
        if ticket:
            from pet.local_browser_settings import BrowserVerifyDialog, SITES
            if challenge.get('site') not in SITES or challenge.get('method') not in ('manual', 'sms', 'email'):
                return
            from PySide6.QtWidgets import QApplication
            self._browser_dialog = BrowserVerifyDialog(challenge, self.client, QApplication.activeModalWidget())
            self._browser_dialog.show()
            self._browser_dialog.raise_()

    def _persist(self):
        try:
            self.client.root.mkdir(parents=True,exist_ok=True)
            temporary=self.cursor_path.with_suffix('.tmp')
            temporary.write_text(json.dumps({'cursor':self.cursor,'partial':self.partial}),'utf-8')
            temporary.replace(self.cursor_path)
        except OSError:pass

    def _done(self,event):
        self.cursor=max(self.cursor,event['id']);self.partial=None;self._persist()
        self.queue.popleft();self.queued.discard(event['id'])

    def _drain(self):
        if self._stopped or self._presenting or not self.queue:return
        event=self.queue[0]
        # A poll started before the backend update may still contain an old QQ
        # notification. Acknowledge it in order without displaying or bubbling.
        if event.get('source')=='qq':self._done(event);self._drain();return
        presence=self.presence()
        self._sync_quiet(presence['quiet'])
        if presence['quiet'] or presence['busy'] or presence['voice_active'] or presence['typing']:return
        if event.get('type')!='assistant':self._done(event);self._drain();return
        window=self._window()
        messages=event.get('messages') or ([{'text':event.get('text','')}])
        if window and window.isVisible() and event.get('session_id')==window.session_id:
            receiver=getattr(window,'deliver_companion_event',None)
            if callable(receiver):
                self._presenting=True
                def delivered(ok):
                    self._presenting=False
                    if self._stopped:return
                    if ok:
                        play_emotion(self.shell,event.get('emotion'))
                        self._done(event)
                if not receiver(event,delivered):self._presenting=False
                return
            window.refresh_backend()
            play_emotion(self.shell,event.get('emotion'));self._done(event);return
        index=self.partial.get('next_segment',0) if self.partial and self.partial.get('event_id')==event['id'] else 0
        if index>=len(messages):self._done(event);self._drain();return
        message=messages[index];text=message.get('text') or '\n'.join(p.get('text','') for p in message.get('parts',[]) if p.get('type')=='plain')
        target=getattr(self.shell,'_overlay_shell',None) or getattr(getattr(self.shell,'instance',None),'win',None)
        duration=max(4000,min(20000,len(text)*180))
        if text and (target is None or not target.show_bubble(text,duration_ms=duration)):return
        play_emotion(self.shell,event.get('emotion'))
        # Voice attachments remain in chat history for deliberate click-to-play.
        self.partial={'event_id':event['id'],'next_segment':index+1};self._persist()
        if index+1>=len(messages):self._done(event)
        self._presenting=True
        QTimer.singleShot(duration,self._release)

    def _release(self):self._presenting=False;self._drain()

    def _play_voice(self,key):
        if not self.audio.reserve(key):return
        def work():
            try:data=self.client.attachment(key)
            except Exception:
                data=None
            try:self.media_ready.emit(key,data)
            except RuntimeError:pass
        threading.Thread(target=work,daemon=True,name='CompanionVoice').start()

    def _sync_quiet(self, quiet):
        if quiet:
            self.audio.stop()
        window = self._window()
        setter = getattr(window, 'set_companion_quiet', None)
        if callable(setter):
            setter(quiet, check=self._quiet)

    def _quiet_updated(self):
        quiet = self._quiet()
        self._sync_quiet(quiet)
        if not quiet:self._drain()

    def _media_received(self,key,data):
        if data is None:self.audio.discard(key)
        else:self.audio.ready(key,data)

    def _audio_changed(self,_key,playing):
        if not playing:
            def done():
                try:self.client.request('POST','/companion/playback-done',json={})
                except Exception:pass
            threading.Thread(target=done,daemon=True).start()

    def stop(self):
        self._stopped=True;self.timer.stop();self.audio.stop()
        self._browser_challenge(None)
        if self._quiet_state is not None:self._quiet_state.remove_listener(self.quiet_changed.emit)
