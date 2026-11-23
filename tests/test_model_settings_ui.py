"""Model page and unified settings checks using only fake backend data."""
import copy
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import MagicMock, patch

os.environ['QT_QPA_PLATFORM'] = 'offscreen'
APP_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_ROOT / 'desktop'))
sys.path.insert(0, str(APP_ROOT / 'desktop_bridge'))
from PySide6.QtWidgets import QApplication, QDialog, QMessageBox
from pet.local_model_settings import LocalModelSettingsPage
from pet.local_token_settings import LocalTokenSettingsPage
from nianan_client import NiananClient


CLASSIFIED_FAILURES = {
    'model_test_auth': '密钥',
    'model_test_access': '权限',
    'model_test_quota': '额度不足',
    'model_test_rate_limit': '过于频繁',
    'model_test_parameters': '不兼容',
    'model_test_network': '无法连接模型服务',
    'model_test_empty': '未返回回复正文',
    'model_test_timeout': '超时',
    'model_test_failed': '连接测试失败',
}


def private_failure(code=None):
    error = RuntimeError('private-provider-body SECRET https://private.example/secret')
    if code is not None:
        error.code = code
    return error


class FakeClient:
    def __init__(self):
        self.value = {'provider': 'cloud', 'cloud': {
            'baseUrl': 'https://api.example.com/v1', 'model': 'test-model', 'apiKey': '***'},
            'ollama': {'baseUrl': 'http://127.0.0.1:11434', 'model': 'local-model'},
            'proxy': '', 'systemPrompt': 'Original persona remains unchanged'}
        self.saved = []
        self.tests = 0
        self.fail_load = False
        self.fail_save = False
        self.test_error = None

    def settings(self):
        if self.fail_load:
            raise RuntimeError('private-provider-body SECRET')
        return copy.deepcopy(self.value)

    def save_settings(self, partial):
        if self.fail_save:
            raise RuntimeError('private-provider-body SECRET')
        self.saved.append(partial)
        for key, value in partial.items():
            if isinstance(value, dict):
                self.value[key] = {**self.value.get(key, {}), **value}
                if key == 'cloud': self.value[key]['apiKey'] = '***'
            else:
                self.value[key] = value
        return self.settings()

    def request(self, method, route, **kwargs):
        assert (method, route) == ('POST', '/settings/test')
        self.tests += 1
        if self.test_error is not None:
            raise self.test_error
        return {'ok': True, 'message': '连接成功'}


class PresetClient(FakeClient):
    def __init__(self, root):
        super().__init__()
        self.root = root
        self.value['hasSavedCloudConnection'] = False
        self.value['cloud'] = {'baseUrl': 'https://api.deepseek.com/v1', 'model': 'deepseek-chat', 'apiKey': ''}
        self.value['cloudConnections'] = {}
        self.value['modelPresets'] = {
            'deepseek': {'label': 'DeepSeek', 'baseUrl': 'https://api.deepseek.com/v1',
                         'model': 'deepseek-flash', 'keyUrl': 'https://platform.deepseek.com/api_keys'},
            'qwen': {'label': '通义千问', 'baseUrl': 'https://dashscope.aliyuncs.com/compatible-mode/v1',
                     'model': 'qwen3.8-flash', 'keyUrl': 'https://bailian.console.aliyun.com/'},
        }
        self.activations = []

    def request(self, method, route, **kwargs):
        assert (method, route) == ('POST', '/settings/model/activate')
        cloud = kwargs['json']['cloud']
        self.activations.append(copy.deepcopy(cloud))
        if self.test_error is not None:
            raise self.test_error
        preset = cloud['preset']
        active = {**cloud, 'apiKey': '***'}
        if preset in self.value['modelPresets']:
            active['baseUrl'] = self.value['modelPresets'][preset]['baseUrl']
        else:
            del active['preset']
        self.value['hasSavedCloudConnection'] = True
        self.value['cloud'] = active
        self.value['cloudConnections'][preset] = active
        return {'ok': True, 'settings': self.settings()}


class ModelSettingsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        self.client = FakeClient()
        self.page = LocalModelSettingsPage(client=self.client)
        self.page.show()
        self.wait(lambda: self.page._loaded)

    def tearDown(self):
        self.page.hide()
        self.page.deleteLater()
        self.app.processEvents()

    def wait(self, check):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            self.app.processEvents()
            if check(): return
            time.sleep(.005)
        self.fail('Timed out waiting for model settings')

    def test_preset_and_custom_activation_keep_draft_keys_separate_and_open_chat(self):
        with tempfile.TemporaryDirectory(dir=APP_ROOT / 'temp') as root:
            self.page.hide()
            self.page.deleteLater()
            self.client = PresetClient(Path(root))
            self.page = LocalModelSettingsPage(client=self.client)
            self.page.show()
            self.wait(lambda: self.page._loaded)
            self.assertEqual(self.page.provider.currentData(), 'deepseek')
            self.assertTrue(self.page.url_row.isHidden())
            self.assertTrue(self.page.model_row.isHidden())
            self.assertTrue(self.page.chat_button.isHidden())
            self.assertFalse(self.page.activate_button.isEnabled())
            self.page.advanced.click()
            self.assertFalse(self.page.model_row.isHidden())
            self.page.advanced.click()
            self.page.key.setText('fake-deepseek-key')
            self.page.provider.setCurrentData('qwen')
            self.assertEqual(self.page.key.text(), '')
            self.page.provider.setCurrentData('deepseek')
            self.assertEqual(self.page.key.text(), 'fake-deepseek-key')
            self.client.test_error = private_failure('model_test_auth')
            self.page.activate_button.click()
            self.wait(lambda: not self.page._busy)
            self.assertIn('原连接设置已保留', self.page.status.text())
            self.assertNotIn('SECRET', self.page.status.text())
            self.assertEqual(self.page.key.text(), 'fake-deepseek-key')
            self.client.test_error = None
            self.page.activate_button.click()
            self.wait(lambda: not self.page._busy)
            self.assertEqual(self.client.activations[-1], {'preset': 'deepseek', 'model': 'deepseek-flash', 'apiKey': 'fake-deepseek-key'})
            self.assertEqual(self.page.key.text(), '')
            self.assertIn('留空继续使用', self.page.key.placeholderText())
            self.assertFalse(self.page.chat_button.isHidden())
            self.page.chat_button.click()
            self.assertTrue((Path(root) / 'focus-chat').is_file())
            self.page.provider.setCurrentData('cloud')
            self.assertTrue(self.page.chat_button.isHidden())
            self.assertFalse(self.page.url_row.isHidden())
            self.assertFalse(self.page.model_row.isHidden())
            self.assertTrue(self.page.save_button.isHidden())
            self.assertEqual(self.page.url.text(), '')
            self.page.url.setText('https://example.com/v1')
            self.page.model.setText('custom-model')
            self.page.key.setText('fake-custom-key')
            self.page.activate_button.click()
            self.wait(lambda: not self.page._busy)
            self.assertEqual(self.client.activations[-1], {'preset': 'custom', 'baseUrl': 'https://example.com/v1',
                                                          'model': 'custom-model', 'apiKey': 'fake-custom-key'})
            self.page.url.setText('https://other.example.com/v1')
            self.assertFalse(self.page.activate_button.isEnabled())

    def test_blank_secret_preserved_partial_save_and_manual_test_only(self):
        self.assertEqual(self.page.key.text(), '')
        self.assertEqual(self.client.tests, 0)
        self.page.model.setText('changed-model')
        self.assertFalse(self.page.test_button.isEnabled())
        self.page.test_saved()
        self.assertEqual(self.client.tests, 0)
        self.page.save_button.click()
        self.wait(lambda: not self.page._busy)
        self.assertNotIn('apiKey', self.client.saved[-1]['cloud'])
        self.assertNotIn('systemPrompt', self.client.saved[-1])
        self.assertEqual(self.client.value['systemPrompt'], 'Original persona remains unchanged')
        self.assertFalse(self.page.dirty)
        self.page.test_button.click()
        self.wait(lambda: not self.page._busy)
        self.assertEqual(self.client.tests, 1)
        self.assertIn('连接成功', self.page.status.text())
        self.page.reload()
        self.wait(lambda: not self.page._busy)
        self.assertEqual(self.page.model.text(), 'changed-model')

    def test_save_failure_keeps_draft_hides_private_error_and_retries(self):
        self.client.fail_save = True
        self.page.key.setText('new-secret')
        self.page.model.setText('changed')
        self.page.save()
        self.wait(lambda: not self.page._busy)
        self.assertTrue(self.page.dirty)
        self.assertEqual(self.page.key.text(), 'new-secret')
        self.assertNotIn('SECRET', self.page.status.text())
        self.client.fail_save = False
        self.page.save()
        self.wait(lambda: not self.page._busy)
        self.assertFalse(self.page.dirty)
        self.assertEqual(self.page.key.text(), '')
        self.assertEqual(self.client.saved[-1]['cloud']['apiKey'], 'new-secret')

    def test_classified_test_errors_show_fixed_messages_and_allow_retry(self):
        for code, expected in CLASSIFIED_FAILURES.items():
            with self.subTest(code=code):
                self.client.test_error = private_failure(code)
                self.page.test_saved()
                self.wait(lambda: not self.page._busy)
                self.assertIn(expected, self.page.status.text())
                self.assertNotIn('SECRET', self.page.status.text())
                self.assertNotIn('private.example', self.page.status.text())
                self.assertTrue(self.page.test_button.isEnabled())
                self.assertFalse(self.page.dirty)
                self.assertEqual(self.page.key.text(), '')
        self.client.test_error = None
        self.page.test_saved()
        self.wait(lambda: not self.page._busy)
        self.assertIn('连接成功', self.page.status.text())

    def test_unknown_or_old_test_errors_use_generic_message(self):
        for code in (None, 'SECRET-unknown-code', ['SECRET'], {'SECRET': True}):
            with self.subTest(code=code):
                self.client.test_error = private_failure(code)
                self.page.test_saved()
                self.wait(lambda: not self.page._busy)
                self.assertEqual(self.page.status.text(),
                    '连接测试失败，请检查已保存的地址、模型、密钥、额度和网络后重试。')

    def test_load_failure_keeps_draft_and_key_hidden(self):
        self.page.model.setText('draft-model')
        self.page.key.setText('draft-secret')
        self.client.fail_load = True
        with patch.object(self.page, 'confirm_discard', return_value=True):
            self.page.reload()
            self.wait(lambda: not self.page._busy)
        self.assertTrue(self.page.dirty)
        self.assertEqual(self.page.model.text(), 'draft-model')
        self.assertEqual(self.page.key.text(), 'draft-secret')
        self.assertEqual(self.page.key.echoMode(), self.page.key.EchoMode.Password)
        self.assertIn('读取失败', self.page.status.text())
        self.assertNotIn('SECRET', self.page.status.text())

    def test_local_provider_and_proxy_send_only_selected_model(self):
        self.page.provider.setCurrentData('ollama')
        self.page.ollama_model.setText('new-local-model')
        self.page.proxy_mode.setCurrentData('custom')
        self.page.proxy.setText('http://127.0.0.1:7890')
        self.page.save()
        self.wait(lambda: not self.page._busy)
        payload = self.client.saved[-1]
        self.assertEqual(payload['provider'], 'ollama')
        self.assertNotIn('cloud', payload)
        self.assertEqual(payload['proxy'], 'http://127.0.0.1:7890')

    def test_close_guard_retains_draft_unless_discarded(self):
        self.page.model.setText('changed')
        with patch.object(QMessageBox, 'question', return_value=QMessageBox.StandardButton.Cancel):
            self.assertFalse(self.page.can_close())
            self.assertTrue(self.page.dirty)
        with patch.object(QMessageBox, 'question', return_value=QMessageBox.StandardButton.Discard):
            self.assertTrue(self.page.can_close())
            self.assertFalse(self.page.dirty)

    def test_unified_settings_registers_page_and_save_exit_waits_for_model(self):
        from pet.config import Config
        from pet.modern_settings_dialog import ModernSettingsDialog
        with tempfile.TemporaryDirectory(dir=APP_ROOT / 'temp') as directory:
            with patch.dict(os.environ, {'DAFEIYU_PC_ROOT': str(APP_ROOT)}), \
                    patch('pet.local_model_settings.local_client', return_value=self.client), \
                    patch('pet.autostart.is_enabled', return_value=False):
                dialog = ModernSettingsDialog(Config(base=Path(directory), instance_id='test'),
                    include_ai=False, standalone=True, initial_page='模型与 API')
                dialog.show()
                page = dialog.local_model_page
                self.wait(lambda: page._loaded)
                self.assertEqual(dialog.sidebar.currentItem().text(), '模型与 API')
                page.model.setText('save-on-exit')
                with patch.object(dialog, '_save_before_close', return_value=True):
                    dialog._save()
                    self.wait(lambda: dialog.result() == QDialog.DialogCode.Accepted)
                self.assertEqual(self.client.value['cloud']['model'], 'save-on-exit')
                dialog.hide()
                dialog.deleteLater()
                self.app.processEvents()

    def test_pc_settings_hide_retired_domains_and_preserve_old_preferences(self):
        from pet.config import Config
        from pet.hotkeys import ACTIONS
        from pet.modern_settings_dialog import ModernSettingsDialog
        from pet.settings_widgets import SettingRow

        directory = Path(self.enterContext(tempfile.TemporaryDirectory(dir=APP_ROOT / 'temp')))
        self.enterContext(patch.dict(os.environ, {'DAFEIYU_PC_ROOT': str(APP_ROOT)}))
        self.enterContext(patch('pet.local_model_settings.local_client', return_value=self.client))
        autostart = self.enterContext(patch('pet.autostart.is_enabled'))
        config = Config(base=directory, instance_id='')
        old = {
            'system_notifications_enabled': False, 'autostart_wanted': True,
            'voice_chime_enabled': True, 'balance_refresh_minutes': 20,
            ACTIONS['look_screen']: 'Ctrl+F8',
        }
        for key, value in old.items():
            config.set(key, value)
        self.assertTrue(config.save())
        dialog = ModernSettingsDialog(config, include_ai=True, standalone=True)
        self.addCleanup(dialog.deleteLater)
        labels = {dialog.sidebar.item(i).text() for i in range(dialog.sidebar.count())}
        self.assertEqual(labels & {'AI 与对话', '自动化与联动', '语音', '文件识别', '更新'}, set())
        self.assertTrue({'模型与 API', 'Token 用量', '语音与表情', '主动与情绪'} <= labels)
        self.assertTrue(dialog.select_page('常规'))
        general_rows = {row.objectName() for row in dialog.pages.currentWidget().findChildren(SettingRow)}
        self.assertTrue({'settingRow_quiet_minutes_default', 'settingRow_quiet_also_on_fullscreen'} <= general_rows)
        searchable = {row.objectName() for row in dialog._search_rows}
        self.assertIn(f"settingRow_{ACTIONS['screen_capture']}", searchable)
        for key in ('system_notifications_enabled', 'autostart', 'todo_reminder_enabled', ACTIONS['look_screen']):
            self.assertNotIn(f'settingRow_{key}', searchable)
        retired_action = dialog.menu_layout_editor.item_for_action('check_update')
        self.assertIsNotNone(retired_action)
        self.assertTrue(retired_action.isHidden())

        dialog.quiet_also_on_fullscreen_check.setChecked(False)
        self.assertTrue(dialog._write_config())
        config.reload()
        self.assertFalse(config.get('quiet_also_on_fullscreen'))
        for key, value in old.items():
            self.assertEqual(config.get(key), value)
        autostart.assert_not_called()


class ModelErrorAdapterTests(unittest.TestCase):
    def failed_request(self, payload):
        client = NiananClient(APP_ROOT)
        response = MagicMock()
        response.ok = False
        response.status_code = 502
        response.json.return_value = payload
        response.__enter__.return_value = response
        session = MagicMock()
        session.request.return_value = response
        session.__enter__.return_value = session
        with patch.object(client, '_connection', return_value=('http://127.0.0.1:1', 'fake-local-token')), \
                patch('nianan_client.requests.Session', return_value=session):
            with self.assertRaises(RuntimeError) as caught:
                client.request('POST', '/settings/test', json={})
        return caught.exception

    def test_only_whitelisted_codes_and_fixed_messages_leave_adapter(self):
        for code, expected in CLASSIFIED_FAILURES.items():
            with self.subTest(code=code):
                error = self.failed_request({'code': code, 'message': 'SECRET private-provider-body'})
                self.assertEqual(error.code, code)
                self.assertIn(expected, str(error))
                self.assertNotIn('SECRET', str(error))
        for code in ('SECRET-unknown-code', ['SECRET'], {'SECRET': True}, None):
            with self.subTest(code=code):
                error = self.failed_request({'code': code, 'message': 'SECRET private-provider-body'})
                self.assertEqual(error.code, '')
                self.assertIn('本地后台请求失败', str(error))
                self.assertNotIn('SECRET', str(error))


class TokenSettingsTests(unittest.TestCase):
    def test_slider_numeric_edit_and_usage(self):
        app = QApplication.instance() or QApplication([])
        client = MagicMock()
        budget = {'policies': {'daily': {'tokens': 1_000_000}, 'per_task': None, 'current_task': None},
                  'daily': {'reserved_tokens': 100, 'remaining_tokens': 979_900}, 'task': {}}
        data = {'revision': 'loaded', 'supported': True, 'budget': budget,
                'today': {'tokens': 20_000}, 'latest_task': {'tokens': 3000}}
        page = LocalTokenSettingsPage(client=client)
        page._completed('load', data)
        self.assertIn('已用 20,000 Token / 1,000,000', page.usage.text())
        self.assertIn('预留 100', page.usage.text())
        self.assertIn('已用 3,000 Token', page.usage.text())
        page.controls['per_task'].slider.setValue(1000)
        self.assertEqual(page.controls['per_task'].value.value(), 10_000_000)
        page.controls['daily'].value.setValue(123456)
        self.assertEqual(page.controls['daily'].value.value(), 123456)
        client.request.return_value = data
        self.assertTrue(page.save())
        deadline = time.monotonic() + 3
        while page._busy and time.monotonic() < deadline:
            app.processEvents()
            time.sleep(.01)
        self.assertFalse(page._busy)
        client.request.assert_called_once_with('PUT', '/usage/budget/settings',
            json={'revision': 'loaded', 'daily': 123456, 'per_task': 10_000_000})
        page.deleteLater()


if __name__ == '__main__':
    unittest.main()
