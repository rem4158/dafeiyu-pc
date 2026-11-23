"""Fixed-speed segmented delivery using fake responses and a non-sleeping Event."""
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'desktop_bridge'))
import nianan_client
from nianan_client import NiananClient


class FakeEvent:
    def __init__(self, cancel_after_type_waits=None):
        self.waits = []
        self._set = False
        self.type_waits = 0
        self.cancel_after_type_waits = cancel_after_type_waits

    def wait(self, seconds=None):
        self.waits.append(seconds)
        if seconds == nianan_client.TYPEWRITER_INTERVAL_SECONDS:
            self.type_waits += 1
            if self.cancel_after_type_waits is not None and self.type_waits >= self.cancel_after_type_waits:
                self.set()
        return self._set

    def set(self):
        self._set = True

    def is_set(self):
        return self._set


class TypewriterClientTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / 'temp')
        self.client = NiananClient(Path(self.temp.name))
        self.published = []
        self.client._publish_bubble = lambda text, emotion=None: self.published.append((text, emotion))

    def tearDown(self):
        self.temp.cleanup()

    def emit_item(self, item, message_id='reply-1', stopped=None):
        events = []
        event = FakeEvent() if stopped is None else stopped
        complete = self.client.emit_message(item, events.append, message_id, stopped=event)
        return complete, events, event

    def chat_response(self, response, stopped):
        requests = []

        def request(method, route, **kwargs):
            requests.append((method, route, kwargs))
            self.assertEqual((method, route), ('POST', '/chat'))
            return response

        self.client.request = request
        events = []
        with patch.object(nianan_client.threading, 'Event', return_value=stopped), \
                patch.object(nianan_client.uuid, 'uuid4', return_value=SimpleNamespace(hex='fixed-request')):
            self.client.chat('main', '测试输入', [], events.append)
        self.assertEqual(len(requests), 1, 'animation must not issue additional model requests')
        self.assertNotIn('main', self.client._stop_events)
        return events, requests

    def test_short_and_long_text_use_the_same_fixed_character_interval(self):
        self.assertEqual(nianan_client.TYPEWRITER_INTERVAL_SECONDS, .018)
        for text in ['好', '你好呀。', '这是一段更长的文字，仍然按照相同速度逐字显示。']:
            with self.subTest(text=text):
                complete, events, stopped = self.emit_item({'text': text})
                self.assertTrue(complete)
                self.assertEqual([event['data'] for event in events], list(text))
                self.assertEqual([event['streaming'] for event in events], [False] + [True] * (len(text) - 1))
                self.assertTrue(all(event['message_id'] == 'reply-1' for event in events))
                self.assertEqual(stopped.waits, [.018] * (len(text) - 1))

    def test_each_segment_starts_with_visible_text_and_preserves_unicode(self):
        events = []
        stopped = FakeEvent()
        texts = [('reply-1', '你好😊'), ('reply-2', ' \n 来啦🌙')]
        for message_id, text in texts:
            self.assertTrue(self.client.emit_message({'text': text}, events.append, message_id, stopped=stopped))
        first = [event for event in events if event['message_id'] == 'reply-1']
        second = [event for event in events if event['message_id'] == 'reply-2']
        self.assertEqual([event['data'] for event in first], ['你', '好', '😊'])
        self.assertEqual([event['data'] for event in second], [' \n 来', '啦', '🌙'])
        self.assertEqual([event['streaming'] for event in first], [False, True, True])
        self.assertEqual([event['streaming'] for event in second], [False, True, True])
        self.assertEqual(''.join(event['data'] for event in second), texts[1][1])
        self.assertEqual(stopped.waits, [.018] * 4)

    def test_voice_transcript_and_media_are_delivered_once_without_typing(self):
        text = '语音对应的整段原文😊。'
        item = {'text': text, 'parts': [
            {'type': 'plain', 'text': text},
            {'type': 'record', 'attachment_id': 'voice-1', 'transcript': text},
            {'type': 'image', 'attachment_id': 'image-1'},
        ]}
        complete, events, stopped = self.emit_item(item)
        self.assertTrue(complete)
        self.assertEqual([event['type'] for event in events], ['attachment_saved', 'plain', 'attachment_saved'])
        self.assertEqual(events[0]['data']['transcript'], text)
        self.assertEqual(events[0]['data']['id'], 'voice-1')
        self.assertEqual(events[1]['data'], text)
        self.assertFalse(events[1]['streaming'])
        self.assertEqual(events[2]['data']['id'], 'image-1')
        self.assertEqual(stopped.waits, [])
        complete, image_events, stopped = self.emit_item({'parts': [{'type': 'image', 'attachment_id': 'image-only'}]})
        self.assertTrue(complete)
        self.assertEqual(len(image_events), 1)
        self.assertEqual(image_events[0]['type'], 'attachment_saved')
        self.assertEqual(stopped.waits, [])

    def test_chat_preserves_segment_delay_ids_and_only_publishes_completed_segments(self):
        response = {'emotion': '开心', 'messages': [
            {'text': '你好', 'delay': 0},
            {'text': ' \n再见', 'delay': 1500},
            {'parts': [{'type': 'image', 'attachment_id': 'image-only'}], 'delay': 30},
        ]}
        stopped = FakeEvent()
        events, requests = self.chat_response(response, stopped)
        plain = [event for event in events if event['type'] == 'plain']
        self.assertEqual([event['data'] for event in plain], ['你', '好', ' \n再', '见'])
        self.assertEqual([event['message_id'] for event in plain],
                         ['fixed-request-0', 'fixed-request-0', 'fixed-request-1', 'fixed-request-1'])
        self.assertEqual([event['streaming'] for event in plain], [False, True, False, True])
        self.assertEqual(stopped.waits, [0, .018, 1.5, .018, .03])
        self.assertEqual(self.published, [('你好', '开心'), (' \n再见', '开心')])
        self.assertEqual(events[-1]['type'], 'end')
        self.assertEqual(requests[0][2]['json']['text'], '测试输入')

    def test_cancel_mid_segment_skips_its_overlay_and_all_later_segments(self):
        stopped = FakeEvent(cancel_after_type_waits=2)
        response = {'emotion': '开心', 'messages': [
            {'text': '完成', 'delay': 0},
            {'text': '未完', 'delay': 0},
            {'text': '不该出现', 'delay': 0},
        ]}
        events, _ = self.chat_response(response, stopped)
        self.assertEqual([event['data'] for event in events if event['type'] == 'plain'], ['完', '成', '未'])
        self.assertEqual(self.published, [('完成', '开心')], 'an unfinished segment must never flash its full text on the pet')
        self.assertFalse(any(event.get('message_id') == 'fixed-request-2' for event in events))
        self.assertEqual(events[-1]['type'], 'end')
        self.assertEqual(stopped.waits, [0, .018, 0, .018])
        complete, events, stopped = self.emit_item({'text': '不会开始'}, stopped=stopped)
        self.assertFalse(complete)
        self.assertEqual(events, [])

    def test_stop_ends_local_animation_only_after_backend_request_succeeds(self):
        stopped = FakeEvent()
        self.client._stop_events['main'] = stopped
        calls = []

        def request(method, route, **kwargs):
            self.assertFalse(stopped.is_set(), 'keep the current request active until its backend stop has settled')
            calls.append((method, route))
            return {'stopped': True}

        self.client.request = request
        self.assertEqual(self.client.stop('main'), {'stopped': True})
        self.assertTrue(stopped.is_set())
        self.assertEqual(calls, [('POST', '/sessions/main/stop')])

        failed_stop = FakeEvent()
        self.client._stop_events['main'] = failed_stop

        def fail_request(method, route, **kwargs):
            self.assertFalse(failed_stop.is_set())
            raise nianan_client.ConnectionError('隔离测试：停止请求失败')

        self.client.request = fail_request
        with self.assertRaises(nianan_client.ConnectionError):
            self.client.stop('main')
        self.assertFalse(failed_stop.is_set(), 'a failed backend stop must not prematurely release local delivery')

    def test_history_reads_do_not_replay_or_animate_saved_text(self):
        saved = {'history': [{'id': 1, 'content': {'type': 'bot', 'message': [
            {'type': 'plain', 'text': '保存的文字应完整显示。'}]}}]}
        calls = []

        def request(method, route, **kwargs):
            calls.append((method, route))
            return saved

        self.client.request = request
        with patch.object(self.client, 'emit_message', side_effect=AssertionError('History must not start a typewriter')):
            self.assertEqual(self.client.history('main'), saved)
        self.assertEqual(calls, [('GET', '/sessions/main')])
        self.assertEqual(self.published, [])

    def test_failed_voice_fallback_is_still_typed_as_ordinary_text(self):
        complete, events, stopped = self.emit_item({'text': '保留文字。', 'media_error': 'tts_failed'})
        self.assertTrue(complete)
        self.assertEqual(events[0]['type'], 'media_warning')
        self.assertEqual([event['data'] for event in events[1:]], list('保留文字。'))
        self.assertEqual(stopped.waits, [.018] * 4)


if __name__ == '__main__':
    unittest.main()
