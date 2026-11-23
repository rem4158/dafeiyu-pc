"""Companion controls use a fake client; no real preferences or model calls."""
import copy,os,sys,time,unittest
from pathlib import Path
from unittest.mock import patch
os.environ['QT_QPA_PLATFORM']='offscreen'
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'desktop'))
from PySide6.QtWidgets import QApplication,QMessageBox
from pet.local_companion_settings import LocalCompanionSettingsPage
class Client:
 def __init__(self):
  self.value={'cognition':{'enabled':True},'proactive':{'enabled':True,'idleMinutes':60,'cooldownMinutes':30,
    'maxPerDay':3,'maxUnanswered':3,'quietHoursStart':23,'quietHoursEnd':7},'systemPrompt':'keep','cloud':{'apiKey':'***'}}
  self.saved=[];self.fail=False
 def settings(self):return copy.deepcopy(self.value)
 def request(self,method,path,**kwargs):
  assert (method,path)==('GET','/companion/status')
  return {'todayCount':1,'dailyLimit':3,'reason':'quiet_hours',
    'cognition':{'emotion':{'joy':.8,'sadness':.1},'narrative':{'version':2}}}
 def save_settings(self,value):
  if self.fail:raise RuntimeError('secret backend payload')
  self.saved.append(value)
  for key,fields in value.items():self.value[key]={**self.value[key],**fields}
  return self.settings()
class Tests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):cls.app=QApplication.instance() or QApplication([])
 def setUp(self):
  self.client=Client();self.page=LocalCompanionSettingsPage(client=self.client);self.page.show();self.wait(lambda:self.page._loaded)
 def tearDown(self):self.page.hide();self.page.deleteLater();self.app.processEvents()
 def wait(self,predicate):
  deadline=time.monotonic()+3
  while time.monotonic()<deadline:
   self.app.processEvents()
   if predicate():return
   time.sleep(.005)
  self.fail('UI operation timed out')
 def test_real_status_fields_and_no_auto_save(self):
  self.assertEqual(self.client.saved,[]);self.assertIn('喜悦',self.page.runtime.text())
  self.assertIn('2',self.page.runtime.text());self.assertIn('免打扰',self.page.runtime.text())
  self.assertEqual(self.page.idle.value(),3)
 def test_partial_save_preserves_persona_and_credentials(self):
  self.page.daily.setValue(5);self.page.save_button.click();self.wait(lambda:not self.page._busy)
  self.assertEqual(self.client.saved,[{'proactive':{'maxPerDay':5}}])
  self.assertEqual(self.client.value['systemPrompt'],'keep');self.assertEqual(self.client.value['cloud']['apiKey'],'***')
  self.page.reload();self.wait(lambda:not self.page._busy);self.assertEqual(self.page.daily.value(),5)
 def test_failed_save_keeps_draft_and_close_cancel(self):
  self.client.fail=True;self.page.idle.setValue(5);self.page.save();self.wait(lambda:not self.page._busy)
  self.assertTrue(self.page.dirty);self.assertEqual(self.page.idle.value(),5)
  self.assertNotIn('secret',self.page.status.text())
  with patch.object(QMessageBox,'question',return_value=QMessageBox.StandardButton.Cancel):self.assertFalse(self.page.can_close())
  self.client.fail=False;self.page.save();self.wait(lambda:not self.page._busy);self.assertFalse(self.page.dirty)
  self.assertEqual(self.client.saved,[{'proactive':{'chatGapMinutes':5}}])
  self.assertEqual(self.client.value['proactive']['cooldownMinutes'],30)
  self.assertEqual(self.client.value['proactive']['idleMinutes'],60)
 def test_cognition_toggle_and_clock_fields_are_real_payloads(self):
  self.page.cognition.setChecked(False);self.page.quiet_start.setValue(22);self.page.quiet_end.setValue(8)
  self.page.save();self.wait(lambda:not self.page._busy)
  self.assertEqual(self.client.saved[-1],{'cognition':{'enabled':False},'proactive':{'quietHoursStart':22,'quietHoursEnd':8}})
if __name__=='__main__':unittest.main()
