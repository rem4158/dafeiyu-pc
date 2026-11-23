"""Persona settings use fake backend data and temporary native settings only."""
import copy
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

os.environ['QT_QPA_PLATFORM'] = 'offscreen'
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'desktop'))
from PySide6.QtWidgets import QApplication, QDialog, QMessageBox
from pet.local_persona_settings import LocalPersonaSettingsPage


class FakeClient:
    def __init__(self):
        self.value = {'provider': 'cloud', 'cloud': {'baseUrl': 'https://api.example.com/v1',
            'model': 'test-model', 'apiKey': '***'}, 'ollama': {}, 'proxy': '',
            'characterName': '大肥鱼', 'ownerName': '主人',
            'systemPrompt': '  Original persona\nKeep whitespace.  ',
            'personality': {'dimensions': None, 'prompt': ''}}
        self.saved = []
        self.fail = False

    def settings(self):
        return copy.deepcopy(self.value)

    def save_settings(self, partial):
        if self.fail:
            raise RuntimeError('private-key-body')
        self.saved.append(copy.deepcopy(partial))
        for key, value in partial.items():
            self.value[key] = {**self.value.get(key, {}), **value} if isinstance(value, dict) else value
        return self.settings()


class PersonaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def wait(self, condition):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            self.app.processEvents()
            if condition(): return
            time.sleep(.005)
        self.fail('Timed out waiting for fake settings')

    def setUp(self):
        self.client = FakeClient()
        self.page = LocalPersonaSettingsPage(client=self.client)
        self.page.show()
        self.wait(lambda: self.page._loaded)

    def tearDown(self):
        self.page.hide()
        self.page.deleteLater()
        self.app.processEvents()

    def test_load_does_not_enable_or_save_and_name_save_is_partial(self):
        self.assertFalse(self.page.dimensions_enabled.isChecked())
        self.assertFalse(self.page.dirty)
        self.assertEqual(self.client.saved, [])
        self.assertEqual(self.page.prompt.toPlainText(), self.client.value['systemPrompt'])
        self.page.owner_name.setText('小沐')
        self.page.save()
        self.wait(lambda: not self.page._busy)
        self.assertEqual(self.client.saved, [{'ownerName': '小沐'}])
        self.assertEqual(self.client.value['cloud']['apiKey'], '***')
        self.assertEqual(self.client.value['systemPrompt'], '  Original persona\nKeep whitespace.  ')
        self.page.reload()
        self.wait(lambda: not self.page._busy)
        self.assertEqual(self.page.owner_name.text(), '小沐')

    def test_dimensions_are_original_schema_and_can_be_explicitly_disabled(self):
        self.page.dimensions_enabled.setChecked(True)
        self.page.language.setCurrentData('playful')
        self.page.archetype.setCurrentData('genki')
        self.page.sliders['warmth'].setValue(90)
        self.page.save()
        self.wait(lambda: not self.page._busy)
        dims = self.client.saved[-1]['personality']['dimensions']
        self.assertEqual(dims['languageStyle'], 'playful')
        self.assertEqual(dims['warmth'], .9)
        self.assertEqual(dims['empathyDepth'], .5)
        self.assertNotIn('cloud', self.client.saved[-1])
        self.page.language.setCurrentData('')
        self.page.save()
        self.wait(lambda: not self.page._busy)
        self.assertEqual(self.client.saved[-1]['personality']['dimensions']['languageStyle'], '')
        self.page.dimensions_enabled.setChecked(False)
        self.page.save()
        self.wait(lambda: not self.page._busy)
        self.assertEqual(self.client.saved[-1], {'personality': {'dimensions': None}})

    def test_failure_retains_prompt_and_dirty_until_retry(self):
        self.client.fail = True
        text = '  New persona\nExactly as typed.  '
        self.page.prompt.setPlainText(text)
        self.page.save()
        self.wait(lambda: not self.page._busy)
        self.assertTrue(self.page.dirty)
        self.assertEqual(self.page.prompt.toPlainText(), text)
        self.assertNotIn('private-key-body', self.page.status.text())
        self.client.fail = False
        self.page.save()
        self.wait(lambda: not self.page._busy)
        self.assertFalse(self.page.dirty)
        self.assertEqual(self.client.value['systemPrompt'], text)

    def make_dialog(self, directory):
        from pet.config import Config
        from pet.modern_settings_dialog import ModernSettingsDialog
        dialog = ModernSettingsDialog(Config(base=Path(directory), instance_id='persona-test'),
            include_ai=False, standalone=True, initial_page='人格与称呼')
        dialog.show()
        self.wait(lambda: dialog.local_model_page._loaded and dialog.local_persona_page._loaded)
        return dialog

    def test_save_exit_saves_both_pages_in_sequence(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'temp') as directory, \
                patch.dict(os.environ, {'DAFEIYU_PC_ROOT': str(ROOT)}), \
                patch('pet.local_model_settings.local_client', return_value=self.client), \
                patch('pet.autostart.is_enabled', return_value=False):
            dialog = self.make_dialog(directory)
            dialog.local_model_page.model.setText('new-model')
            dialog.local_persona_page.owner_name.setText('小沐')
            with patch.object(dialog, '_save_before_close', return_value=True):
                dialog._save()
                self.wait(lambda: dialog.result() == QDialog.DialogCode.Accepted)
            self.assertEqual(self.client.value['cloud']['model'], 'new-model')
            self.assertEqual(self.client.value['ownerName'], '小沐')
            self.assertEqual(len(self.client.saved), 2)
            dialog.deleteLater()
            self.app.processEvents()

    def test_dual_page_close_cancel_keeps_both_drafts_and_discard_is_not_asked_twice(self):
        from pet import settings_close_flow
        with tempfile.TemporaryDirectory(dir=ROOT / 'temp') as directory, \
                patch.dict(os.environ, {'DAFEIYU_PC_ROOT': str(ROOT)}), \
                patch('pet.local_model_settings.local_client', return_value=self.client), \
                patch('pet.autostart.is_enabled', return_value=False):
            dialog = self.make_dialog(directory)
            model, persona = dialog.local_model_page, dialog.local_persona_page
            model.model.setText('draft-model')
            persona.owner_name.setText('draft-name')
            with patch.object(QMessageBox, 'question', side_effect=[
                    QMessageBox.StandardButton.Discard, QMessageBox.StandardButton.Cancel]):
                self.assertFalse(dialog._save_before_close())
            self.assertTrue(model.dirty)
            self.assertTrue(persona.dirty)
            with patch.object(QMessageBox, 'question', return_value=QMessageBox.StandardButton.Discard) as question, \
                    patch('pet.settings_close_flow.save_before_close', return_value='saved'):
                self.assertTrue(dialog._save_before_close())
                self.assertTrue(dialog._save_before_close())
                self.assertEqual(question.call_count, 2)
            dialog.hide()
            dialog.deleteLater()
            self.app.processEvents()


if __name__ == '__main__': unittest.main()
