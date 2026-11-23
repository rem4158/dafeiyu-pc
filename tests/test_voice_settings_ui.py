"""Speech configuration uses fake settings only; no audio/model calls."""
import copy
import os
from pathlib import Path
import sys
import time
import types
import unittest
from unittest.mock import MagicMock, patch
os.environ['QT_QPA_PLATFORM'] = 'offscreen'
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'desktop'))
from PySide6.QtWidgets import QApplication, QMessageBox
from pet.local_voice_settings import LocalVoiceSettingsPage

class FakeClient:
    def __init__(self):
        self.value = {'voice': {'enabled': False, 'autoSpeak': True, 'autoSend': False, 'asrLanguage': 'zh',
            'ttsMode': 'preset', 'ttsFormat': 'mp3', 'presetVoice': '冰糖', 'voiceDesignPrompt': '', 'speakStyleHint': '', 'referenceAudio': ''},
            'tts': {'provider': 'mimo', 'baseUrl': 'https://api.example.com/v1', 'apiKey': '***',
                    'models': {'preset': '', 'design': '', 'clone': '', 'asr': ''}},
            'asr': {'baseUrl': '', 'apiKey': ''}, 'stickers': {'enabled': True, 'sourceRoot': 'D:\\existing-pack'},
            'systemPrompt': 'Do not change persona', 'cloud': {'apiKey': '***'}}
        self.saved = []
        self.fail = False
    def settings(self): return copy.deepcopy(self.value)
    def save_settings(self, partial):
        if self.fail: raise RuntimeError('PRIVATE_PROVIDER_BODY')
        self.saved.append(copy.deepcopy(partial))
        for key, value in partial.items(): self.value[key] = {**self.value[key], **value}
        if self.value['tts'].get('apiKey'): self.value['tts']['apiKey'] = '***'
        return self.settings()
    def request(self, method, route, **_):
        assert (method, route) == ('GET', '/stickers'), 'No TTS request may run on load/save'
        return {'packs': [{'name': 'Existing AST pack'}], 'count': 174}

class VoicePageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.app = QApplication.instance() or QApplication([])
    def setUp(self):
        self.client = FakeClient()
        self.page = LocalVoiceSettingsPage(client=self.client)
        self.page.show()
        self.wait(lambda: self.page._loaded)
    def tearDown(self):
        self.page.hide(); self.page.deleteLater(); self.app.processEvents()
    def wait(self, check):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            self.app.processEvents()
            if check(): return
            time.sleep(.005)
        self.fail('Async page timed out')
    def test_load_secret_mask_and_partial_voice_save(self):
        self.assertEqual(self.page.controls['tts.apiKey'].text(), '')
        self.assertFalse(self.page.dirty)
        self.assertIn('174', self.page.library_status.text())
        self.page.controls['voice.enabled'].setChecked(True)
        self.page.save()
        self.wait(lambda: not self.page._busy)
        self.assertEqual(set(self.client.saved[-1]), {'voice'})
        self.assertEqual(self.client.value['systemPrompt'], 'Do not change persona')
        self.assertNotIn('cloud', self.client.saved[-1])
        self.assertFalse(self.page.dirty)
    def test_new_secret_failure_retry_and_close_guard(self):
        self.page.controls['tts.apiKey'].setText('new-key')
        self.client.fail = True
        self.page.save()
        self.wait(lambda: not self.page._busy)
        self.assertTrue(self.page.dirty)
        self.assertNotIn('PRIVATE', self.page.status.text())
        with patch.object(QMessageBox, 'question', return_value=QMessageBox.StandardButton.Cancel):
            self.assertFalse(self.page.can_close(commit_discard=False))
        self.client.fail = False
        self.page.save()
        self.wait(lambda: not self.page._busy)
        self.assertEqual(self.client.saved[-1]['tts']['apiKey'], 'new-key')
        self.assertEqual(self.page.controls['tts.apiKey'].text(), '')
        self.page.controls['tts.baseUrl'].setText('https://other.example/v1')
        self.page.save()
        self.wait(lambda: not self.page._busy)
        self.assertNotIn('apiKey', self.client.saved[-1]['tts'])

    def test_preview_then_enable_and_change_requires_another_preview(self):
        speech = self.page.speech
        self.client.value['speechPresets'] = {
            'mimo': {'label': '小米 MiMo', 'baseUrl': 'https://api.xiaomimimo.com/v1',
                     'keyUrl': 'https://platform.xiaomimimo.com/', 'voice': '冰糖',
                     'models': {'preset': 'mimo-v2.5-tts', 'clone': 'clone-model'}},
            'qwen': {'label': '百炼', 'baseUrl': 'https://dashscope.aliyuncs.com/api/v1',
                     'keyUrl': 'https://bailian.console.aliyun.com/', 'voice': 'Cherry',
                     'models': {'preset': 'qwen3-tts-flash'}},
        }
        self.client.value['speechOutput'] = None
        self.page.reload()
        self.wait(lambda: not self.page._busy)
        self.assertTrue(speech.isVisible())
        self.assertTrue(speech.options.isHidden())
        self.assertTrue(speech.activate_button.isHidden())
        self.assertFalse(speech.preview_button.isEnabled())
        original = copy.deepcopy(self.client.value)
        sent = []
        ordinary_request = self.client.request
        def request(method, route, **kwargs):
            if route == '/stickers':
                return ordinary_request(method, route, **kwargs)
            sent.append((route, kwargs['json']))
            if route.endswith('/preview'):
                return {'ticket': 'fake-preview', 'audio': 'UklGRg=='}
            self.client.value['speechOutput'] = {
                'provider': 'mimo', 'protocol': 'mimo', 'baseUrl': 'https://api.xiaomimimo.com/v1',
                'apiKey': '***', 'mode': 'preset', 'model': 'mimo-v2.5-tts', 'voice': '冰糖',
                'format': 'mp3', 'detail': '', 'style': '', 'enabled': True,
            }
            return self.client.settings()
        self.client.request = request
        speech.key.setText('fake-key')
        fake_player = MagicMock()
        with patch.dict(sys.modules, {'audio_queue': types.SimpleNamespace(AudioQueue=lambda *_: fake_player)}):
            speech.preview_button.click()
            self.wait(lambda: not speech.busy)
            fake_player.ready.assert_called_once_with('tts-preview', b'RIFF')
            self.assertEqual(sent[-1][1]['provider'], 'mimo')
            self.assertEqual(self.client.value, original)
            self.assertTrue(speech.activate_button.isEnabled())
            speech.provider.setCurrentData('qwen')
            self.assertTrue(speech.activate_button.isHidden())
            self.assertEqual(speech.key.text(), '')
            speech.provider.setCurrentData('mimo')
            speech.key.setText('fake-key')
            speech.preview_button.click()
            self.wait(lambda: not speech.busy)
            speech.activate_button.click()
            self.wait(lambda: not speech.busy)
        self.assertEqual(sent[-1], ('/voice/tts/activate', {'ticket': 'fake-preview'}))
        self.assertEqual(speech.key.text(), '')
        self.assertTrue(speech.enabled.isChecked())
        self.assertFalse(self.page.controls['voice.enabled'].isChecked())
        self.assertEqual(self.client.value['asr'], original['asr'])
        self.assertEqual(self.client.value['tts'], original['tts'])
        speech.provider.setCurrentData('custom')
        self.assertFalse(speech.options.isHidden())
        speech.protocol.setCurrentData('speech')
        self.assertEqual(speech.mode.currentData(), 'preset')

if __name__ == '__main__': unittest.main()
