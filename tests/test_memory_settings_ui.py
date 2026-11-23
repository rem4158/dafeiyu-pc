"""Native memory management checks with fake records only."""
import copy
import os
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch
os.environ['QT_QPA_PLATFORM']='offscreen'
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'desktop'))
from PySide6.QtWidgets import QApplication,QInputDialog,QMessageBox
from pet.local_memory_settings import LocalMemorySettingsPage

class Client:
    def __init__(self):
        self.saved=[];self.operations=[];self.fail=False
        self.settings_value={'memory':{'enabled':True,'autoExtract':True,'maxRecentMessages':30,'tokenBudget':800},'cloud':{'apiKey':'***'}}
        self.data={'facts':[{'id':1,'category':'profile','fact_key':'城市','fact_value':'北京','active':1,'source_text':'我住在北京。'}],
            'people':[{'id':1,'display_name':'小明','relation_type':'friend','notes':'喜欢画画','source_text':'我朋友叫小明'}],
            'profile':{'profile':{'identity':{'city':'北京'}}},'revisions':[], 'events':[], 'summaries':[]}
    def settings(self):return copy.deepcopy(self.settings_value)
    def save_settings(self,partial):
        if self.fail:raise RuntimeError('private-secret')
        self.saved.append(partial);self.settings_value['memory'].update(partial['memory']);return self.settings()
    def request(self,method,path,**kwargs):
        if method=='GET':return copy.deepcopy(self.data)
        self.operations.append((method,path,kwargs.get('json')))
        if method=='PUT':
            old=self.data['facts'][0]['fact_value'];new=kwargs['json']['factValue']
            self.data['facts'][0]['fact_value']=new
            self.data['revisions']=[{'id':3,'fact_id':1,'operation':'edit','actor':'user','before_json':'{"fact_value":"'+old+'"}','after_json':'{"fact_value":"'+new+'"}'}]
        if path.endswith('/undo'):self.data['facts'][0]['fact_value']='北京';self.data['revisions'][0]['undone_by']=4
        return {'ok':True}

class MemoryUiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.app=QApplication.instance() or QApplication([])
    def setUp(self):
        self.client=Client();self.page=LocalMemorySettingsPage(client=self.client);self.page.show();self.wait(lambda:self.page._loaded)
    def tearDown(self):self.page.hide();self.page.deleteLater();self.app.processEvents()
    def wait(self,condition):
        deadline=time.monotonic()+3
        while time.monotonic()<deadline:
            self.app.processEvents()
            if condition():return
            time.sleep(.005)
        self.fail('Memory UI timeout')
    def test_load_source_and_partial_settings_save(self):
        self.assertEqual(self.client.saved,[])
        self.page.facts.setCurrentItem(self.page.facts.topLevelItem(0));self.app.processEvents()
        self.assertIn('我住在北京',self.page.detail.toPlainText());self.assertNotIn('source_text',self.page.detail.toPlainText())
        self.page.recent.setValue(40);self.page.save_button.click();self.wait(lambda:not self.page._busy)
        self.assertEqual(set(self.client.saved[0]),{'memory'})
        self.assertEqual(self.client.saved[0]['memory']['maxRecentMessages'],40)
        self.assertFalse(self.page.dirty)
    def test_correction_and_undo_use_memory_routes(self):
        self.page.facts.setCurrentItem(self.page.facts.topLevelItem(0))
        with patch.object(QInputDialog,'getMultiLineText',return_value=('上海',True)):self.page.edit_button.click()
        self.wait(lambda:not self.page._busy)
        self.assertEqual(self.client.operations[0],('PUT','/memory/facts/1',{'factValue':'上海'}))
        self.page.tabs.setCurrentWidget(self.page.revisions);self.page.revisions.setCurrentItem(self.page.revisions.topLevelItem(0))
        self.page.undo_button.click();self.wait(lambda:not self.page._busy)
        self.assertEqual(self.client.operations[-1][1],'/memory/revisions/3/undo')
    def test_failure_and_cancel_keep_draft(self):
        self.client.fail=True;self.page.budget.setValue(1200);self.page.save();self.wait(lambda:not self.page._busy)
        self.assertTrue(self.page.dirty);self.assertNotIn('private-secret',self.page.status.text())
        with patch.object(QMessageBox,'question',return_value=QMessageBox.StandardButton.Cancel):
            self.assertFalse(self.page.can_close(commit_discard=False))
        self.assertTrue(self.page.dirty)
        self.client.fail=False;self.page.save();self.wait(lambda:not self.page._busy);self.assertFalse(self.page.dirty)
if __name__=='__main__':unittest.main()
