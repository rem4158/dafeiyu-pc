"""Local Nianan service adapter for the existing desktop chat protocol."""
import base64
import json
import os
import threading
import uuid
from pathlib import Path
from urllib.parse import quote

import requests

from chat_protocol import ConnectionError, validate_base

TYPEWRITER_INTERVAL_SECONDS = 0.018
USAGE_BUDGET_ERRORS = {
    'usage_budget_exceeded': '已达到本程序的模型用量限额，本次请求已停止；可解除本程序限额后再发送',
    'usage_budget_preflight_required': '本程序限额需要先核算请求的预留用量，本次请求已停止',
    'usage_budget_unavailable': '本程序限额暂时无法校验，本次请求已停止，请稍后重试',
    'usage_budget_unpriced': '当前模型尚无可核验的美元计价，无法在费用限额内发起请求',
    'usage_budget_context_required': '本次请求缺少任务额度关联，已停止以避免越过限额',
    'usage_budget_unresolved': '本程序存在尚未确认用量的调用，当前无法确认剩余额度',
    'usage_budget_count_failed': '本次请求的用量预估失败，已停止以避免越过限额',
    'usage_budget_unsupported': '当前模型接口暂不支持所需的限额预检，本次请求已停止',
}


class NiananClient:
    backend_name = '大肥鱼本地后台'
    supports_attachments = False
    supports_stickers = True
    is_local_backend = True

    def __init__(self, app_root):
        self.app_root = Path(app_root)
        self.root = self.app_root / 'data'
        self.username = 'local'
        self._stop_events = {}
        self._lock = threading.Lock()

    def _connection(self):
        try:
            path = self.root / 'backend.json'
            if path.stat().st_size > 4096:
                raise ValueError()
            data = json.loads(path.read_text('utf-8-sig'))
            base = validate_base(data['url'])
            token = data['token']
            if not isinstance(token, str) or len(token) < 16 or len(token) > 512:
                raise ValueError()
            return base, token
        except (OSError, ValueError, KeyError, TypeError, ConnectionError):
            raise ConnectionError('本地后台尚未就绪，请通过“大肥鱼 PC 启动”打开') from None

    def request(self, method, path, *, error_messages=None, **kwargs):
        base, token = self._connection()
        with requests.Session() as session:
            session.trust_env = False  # Only loopback traffic bypasses the proxy.
            try:
                response = session.request(method, base + path,
                                           headers={'Authorization': 'Bearer ' + token},
                                           timeout=kwargs.pop('timeout',(5,240)), allow_redirects=False, **kwargs)
            except requests.RequestException:
                raise ConnectionError('无法连接大肥鱼本地后台，或等待回复超时；请重新启动后刷新会话') from None
            with response:
                try:
                    data = response.json()
                except ValueError:
                    raise ConnectionError('本地后台返回了无法读取的消息') from None
                if not response.ok:
                    # Do not display server/provider error bodies: they may contain secrets.
                    code = data.get('code', '') if isinstance(data, dict) else ''
                    if not isinstance(code, str):
                        code = ''
                    errors = {
                        'not_configured': '请先在“后台设置”中填写模型 API 地址、密钥和模型名称',
                        'model_test_failed': '连接测试失败，请检查 API 地址、密钥、模型名称、额度和网络',
                        'model_test_timeout': '连接测试超时，请检查网络和代理后重试',
                        'model_test_auth': '模型服务拒绝了 API 密钥，请检查密钥是否有效',
                        'model_test_access': '模型访问受限，请检查模型权限及服务支持的地区',
                        'model_test_quota': '模型服务额度不足，请检查账户余额或用量限制',
                        'model_test_rate_limit': '模型服务请求过于频繁，请稍后重试',
                        'model_test_parameters': '模型请求不兼容，请检查 API 地址、模型名称或参数适配',
                        'model_test_network': '无法连接模型服务，请检查网络和代理后重试',
                        'model_test_empty': '模型服务未返回回复正文，请检查模型和参数适配',
                        'busy': '当前有回复或连接测试正在进行，请稍后重试',
                        'session_busy': '这段对话还有回复正在处理，请在回复结束后移除',
                        'session_hidden': '这段对话已从列表移除，请刷新并切换至当前对话',
                        'invalid_settings': '设置未保存，请检查输入的名称、数值、地址和代理格式',
                        **USAGE_BUDGET_ERRORS,
                        'sticker_not_found': '这张表情已不可用，请刷新表情面板后重新选择',
                        'invalid_sticker': '这张表情已不可用，请重新打开表情面板选择',
                        'stickers_disabled': '表情包已关闭，请在桌宠设置的语音与表情页开启',
                        'voice_disabled': '请先在语音与表情设置中配置并启用语音功能',
                        'asr_failed': '语音识别失败，请检查语音 API、模型和网络',
                        'tts_failed': '语音合成失败，文字回复仍可正常查看',
                        'tts_preview_settings': '请检查语音服务的 Key、模型和音色设置。',
                        'tts_preview_auth': '语音服务拒绝访问，请检查 Key 和服务权限。',
                        'tts_preview_quota': '语音服务额度不足，请检查账户余额。',
                        'tts_preview_rate': '语音请求过于频繁，请稍后再试。',
                        'tts_preview_timeout': '试听超时，请检查网络后重试。',
                        'tts_preview_audio': '语音服务未返回可播放的 MP3 或 WAV。',
                        'tts_preview_failed': '试听失败，请检查语音服务和网络后重试。',
                        'tts_preview_expired': '试听已失效，请重新试听后启用。',
                        'MODEL_NOT_CONFIGURED': '请先在“后台设置”中填写模型 API 地址、密钥和模型名称',
                        'cancelled': '回复已停止，已保存的内容可刷新查看',
                        'CANCELLED': '回复已停止，已保存的内容可刷新查看',
                    }
                    if error_messages:
                        errors.update(error_messages)
                    error = ConnectionError(errors.get(code, f'本地后台请求失败（HTTP {response.status_code}），请检查后台设置或日志'))
                    error.code = code if code in errors else ''
                    raise error from None
                return data

    def restore_login(self):
        self.request('GET', '/health')

    def remember_login(self):
        return  # The launcher owns the local service credentials.

    def sessions(self):
        return self.request('GET', '/sessions')

    def create_session(self):
        return self.request('POST', '/sessions', json={})['session_id']

    def hide_session(self, session_id):
        return self.request('POST', '/sessions/' + quote(session_id, safe='') + '/hide', json={})

    def history(self, session_id):
        return self.request('GET', '/sessions/' + quote(session_id, safe=''))

    def settings(self):
        return self.request('GET', '/settings')

    def save_settings(self, settings):
        return self.request('PUT', '/settings', json=settings)

    def clear_usage_budget(self):
        return self.request('POST', '/usage/budget/clear', json={})

    def stop(self, session_id):
        result = self.request('POST', '/sessions/' + quote(session_id, safe='') + '/stop', json={})
        with self._lock:
            pending = self._stop_events.get(session_id)
            if pending is not None:
                pending.set()
        return result

    def chat(self, session_id, text, files, emit, *, sticker_id=None):
        if files:
            raise ConnectionError('此阶段暂未接入图片和附件，请先发送文字')
        request_id = uuid.uuid4().hex
        stopped = threading.Event()
        with self._lock:
            self._stop_events[session_id] = stopped
        try:
            payload = {'session_id': session_id, 'text': text, 'request_id': request_id}
            if sticker_id is not None:
                payload['sticker_id'] = sticker_id
            # A browser login can wait for a PC/QQ code or a manual verification.
            result = self.request('POST', '/chat', json=payload, timeout=(5, 1800))
            emotion = result.get('emotion')
            for index,item in enumerate(result.get('messages', [])):
                if not isinstance(item,dict):
                    continue
                delay=item.get('delay',0)
                delay=max(0,min(10000,delay)) if isinstance(delay,(int,float)) else 0
                if stopped.wait(delay/1000):
                    break
                if not self.emit_message(item,emit,f'{request_id}-{index}',stopped=stopped):
                    break
                bubble_text=item.get('text') or '\n'.join(part.get('text','') for part in item.get('parts',[]) if part.get('type')=='plain')
                if bubble_text:
                    self._publish_bubble(bubble_text,emotion)
            if not stopped.is_set() and emotion and not any(item.get('text') or any(part.get('type')=='plain' and part.get('text') for part in item.get('parts',[])) for item in result.get('messages',[]) if isinstance(item,dict)):
                self._publish_bubble('',emotion)
            if emotion and not stopped.is_set():
                emit({'type':'emotion','data':emotion,'message_id':request_id})
            if result.get('budget_blocked') is True and not stopped.is_set():
                code = result.get('budget_error')
                code = code if isinstance(code, str) and code in USAGE_BUDGET_ERRORS else 'usage_budget_exceeded'
                emit({'type': 'usage_budget_blocked', 'data': code, 'message_id': request_id})
            end = {'type': 'end', 'message_id': request_id}
            if (result.get('messages') and not result.get('cancelled') and not result.get('budget_blocked')
                    and not stopped.is_set()):
                end['reply_completed'] = True
            emit(end)
            return not stopped.is_set()
        finally:
            with self._lock:
                if self._stop_events.get(session_id) is stopped:
                    del self._stop_events[session_id]

    def sticker_catalog(self):
        return self.request('GET', '/stickers/catalog')

    def sticker_image(self, sticker_id):
        if not isinstance(sticker_id, str) or len(sticker_id) != 64 or any(c not in '0123456789abcdef' for c in sticker_id):
            raise ConnectionError('表情标识无效，请重新选择')
        result = self.request('GET', '/stickers/' + sticker_id)
        try:
            data = base64.b64decode(result['data'], validate=True)
            if not data or len(data) > 20 * 1024 * 1024:
                raise ValueError()
            return data
        except (KeyError, TypeError, ValueError):
            raise ConnectionError('表情图片暂时无法读取，请重新打开面板') from None

    def attachment(self,attachment_id):
        result=self.request('GET','/media/'+quote(str(attachment_id),safe=''))
        try:
            data=base64.b64decode(result['data'],validate=True)
            if len(data)>20*1024*1024:
                raise ValueError()
            return data
        except (KeyError,TypeError,ValueError):
            raise ConnectionError('本地媒体暂时无法读取，请刷新后重试') from None

    def transcribe(self,audio):
        if len(audio)>8*1024*1024:
            raise ConnectionError('录音过长，请缩短后重试')
        return self.request('POST','/voice/asr',json={'audio':base64.b64encode(audio).decode('ascii'),'mime':'audio/wav'})

    @staticmethod
    def emit_message(item,emit,message_id,*,stopped=None):
        stopped = stopped if stopped is not None else threading.Event()
        if stopped.is_set():
            return False
        if item.get('media_error'):
            emit({'type':'media_warning','data':'语音生成失败，已保留文字；请检查语音设置。','message_id':message_id})
        parts=item.get('parts') or ([{'type':'plain','text':item['text']}] if item.get('text') else [])
        if item.get('text') and not any(part.get('type')=='plain' for part in parts):
            parts=[*parts,{'type':'plain','text':item['text']}]
        has_voice = any(part.get('type')=='record' and part.get('attachment_id') for part in parts)
        # Audio first lets the existing UI put transcript and voice in one bubble.
        ordered=[p for p in parts if p.get('type')=='record']+[p for p in parts if p.get('type')=='plain']+[p for p in parts if p.get('type') not in ('plain','record')]
        for part in ordered:
            if stopped.is_set():
                return False
            if part.get('type')=='plain':
                text = part.get('text','')
                if not isinstance(text, str) or not text.strip():
                    continue
                if has_voice:
                    # A voice's saved transcript is hidden, not a typed text reply.
                    emit({'type':'plain','data':text,'streaming':False,'message_id':message_id})
                    continue
                # Begin each segment with a visible character. Leading whitespace
                # travels with it so the UI's empty-event filter cannot merge rows.
                first_end = len(text) - len(text.lstrip()) + 1
                emit({'type':'plain','data':text[:first_end],'streaming':False,'message_id':message_id,
                      'segment_complete':first_end == len(text)})
                for end, character in enumerate(text[first_end:], start=first_end + 1):
                    if stopped.wait(TYPEWRITER_INTERVAL_SECONDS):
                        return False
                    emit({'type':'plain','data':character,'streaming':True,'message_id':message_id,
                          'segment_complete':end == len(text)})
            elif part.get('type') in ('record','image','file','video') and part.get('attachment_id'):
                emit({'type':'attachment_saved','data':{**part,'id':part['attachment_id']},'message_id':message_id})
        return not stopped.is_set()

    def _publish_bubble(self, text, emotion=None):
        """Publish only newly delivered segments; history reads never replay them."""
        try:
            # Keep one event below BubbleBridge's bounded pending-line buffer.
            message = json.dumps({'text': str(text)[:3000],'emotion':emotion}, ensure_ascii=False) + '\n'
            self.root.mkdir(parents=True, exist_ok=True)
            with (self.root / 'messages.jsonl').open('a', encoding='utf-8') as output:
                output.write(message)
        except OSError:
            # A bubble delivery failure must not fail an already successful chat.
            pass


def create_backend_client():
    return NiananClient(Path(os.environ.get('DAFEIYU_PC_ROOT') or Path(__file__).resolve().parents[1]))
