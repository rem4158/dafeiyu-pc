"""Memory settings and source/revision inspection in the unified native window."""
from __future__ import annotations
import json
import os
from pathlib import Path
from PySide6.QtCore import Qt, QTimer, QProcess, QProcessEnvironment
from PySide6.QtWidgets import (QAbstractItemView, QDialog, QDialogButtonBox, QFormLayout, QHBoxLayout, QInputDialog, QLabel, QLineEdit,
    QMessageBox, QPlainTextEdit, QPushButton, QTabWidget, QTreeWidget,
    QTreeWidgetItem, QVBoxLayout, QWidget)
from .local_model_settings import _Jobs, local_client
from .settings_widgets import BrowserSpinBox, ModernSelect, SettingRow, SettingsSection, ToggleSwitch


class LocalMemorySettingsPage(QWidget):
    def __init__(self, parent=None, *, client=None, auto_load=True):
        super().__init__(parent)
        self.client=client or local_client()
        self._loaded=False
        self._busy=False
        self._baseline=None
        self._after_save=None
        self._memory={}
        self.jobs=_Jobs(self)
        self.jobs.completed.connect(self._completed)
        self.jobs.failed.connect(self._failed)
        layout=QVBoxLayout(self)
        layout.setContentsMargins(0,0,0,0)
        layout.setSpacing(18)
        self.enabled=ToggleSwitch(self)
        self.auto_extract=ToggleSwitch(self)
        self.recent=BrowserSpinBox(self); self.recent.setRange(4,200)
        self.budget=BrowserSpinBox(self); self.budget.setRange(200,8000); self.budget.setSingleStep(100)
        layout.addWidget(SettingsSection('记忆设置',[
            SettingRow('memory_enabled','使用长期记忆','关闭时不向回复注入事实或画像；原始聊天记录仍保留。',self.enabled),
            SettingRow('memory_auto_extract','自动整理记忆','从你实际说过的话中整理事实和人物；会调用当前模型，来源和修改记录可以查看。',self.auto_extract),
            SettingRow('memory_recent','上下文消息条数','每次回复读取的最近聊天条数。',self.recent),
            SettingRow('memory_budget','记忆上下文预算','控制注入回复的记忆长度；聊天原文不自动删除。',self.budget),
        ],self))
        self.status=QLabel('正在读取记忆…',self); self.status.setWordWrap(True);self.status.setObjectName('settingHint')
        layout.addWidget(self.status)
        self.save_button=QPushButton('保存记忆设置',self)
        self.reload_button=QPushButton('刷新记忆与来源',self)
        self.save_button.setAutoDefault(False);self.reload_button.setAutoDefault(False)
        controls=QHBoxLayout(); controls.addWidget(self.save_button);controls.addWidget(self.reload_button)
        self.nebula_button=QPushButton('打开记忆星云',self)
        self.nebula_button.setAutoDefault(False)
        self.nebula_button.clicked.connect(self.open_nebula)
        controls.addWidget(self.nebula_button)
        layout.addLayout(controls)
        self.tabs=QTabWidget(self)
        self.facts=self._tree(['名称','内容','状态'])
        self.people=self._tree(['人物','关系','备注'])
        self.revisions=self._tree(['记录','对象','操作'])
        self.profile=QPlainTextEdit(self);self.profile.setReadOnly(True);self.profile.setMinimumHeight(150)
        self.events=QPlainTextEdit(self);self.events.setReadOnly(True);self.events.setMinimumHeight(150)
        self.tabs.addTab(self.facts,'事实记忆');self.tabs.addTab(self.people,'人物关系')
        self.tabs.addTab(self.profile,'用户画像');self.tabs.addTab(self.events,'事件与摘要');self.tabs.addTab(self.revisions,'修改记录')
        layout.addWidget(self.tabs)
        self.detail=QPlainTextEdit(self);self.detail.setReadOnly(True);self.detail.setMinimumHeight(140)
        self.detail.setAccessibleName('记忆来源与修改详情')
        self.detail.setPlaceholderText('选择一条记忆，查看原话来源和修改详情。')
        layout.addWidget(self.detail)
        actions=QHBoxLayout()
        self.edit_button=QPushButton('纠正所选内容',self)
        self.delete_button=QPushButton('删除所选记忆',self)
        self.undo_button=QPushButton('撤销所选修改',self)
        for button in (self.edit_button,self.delete_button,self.undo_button):
            button.setAutoDefault(False);actions.addWidget(button)
        layout.addLayout(actions)
        note=QLabel('用户画像由事实整理；纠正或删除事实后同步更新。修改记录会保留旧值，较早记录须先撤销其后的修改。',self)
        note.setObjectName('settingHint');note.setWordWrap(True);layout.addWidget(note)
        layout.addStretch(1)
        self._fields=(self.enabled,self.auto_extract,self.recent,self.budget)
        for field in (self.enabled,self.auto_extract):field.toggled.connect(self._changed)
        for field in (self.recent,self.budget):field.valueChanged.connect(self._changed)
        for tree in (self.facts,self.people,self.revisions):tree.itemSelectionChanged.connect(self._selection)
        self.tabs.currentChanged.connect(self._selection)
        self.save_button.clicked.connect(self.save);self.reload_button.clicked.connect(self.reload)
        self.edit_button.clicked.connect(self.edit_selected);self.delete_button.clicked.connect(self.delete_selected)
        self.undo_button.clicked.connect(self.undo_selected)
        self._update()
        if auto_load:QTimer.singleShot(0,self.reload)

    def _tree(self,headers):
        tree=QTreeWidget(self);tree.setHeaderLabels(headers);tree.setRootIsDecorated(False)
        tree.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection);tree.setMinimumHeight(200)
        return tree

    def open_nebula(self):
        root=Path(os.environ.get('DAFEIYU_PC_ROOT') or Path(__file__).resolve().parents[2])
        process=QProcess()
        env=QProcessEnvironment.systemEnvironment()
        env.remove('ELECTRON_RUN_AS_NODE')
        process.setProcessEnvironment(env)
        process.setProgram(str(root/'runtime'/'electron'/'electron.exe'))
        process.setArguments([str(root/'backend'/'nebula'/'main.js')])
        process.setWorkingDirectory(str(root))
        started,_=process.startDetached()
        if not started:
            self.status.setText('星云窗口未能启动，请检查本地运行环境。')

    def _snapshot(self):
        return {'enabled':self.enabled.isChecked(),'autoExtract':self.auto_extract.isChecked(),
            'maxRecentMessages':self.recent.value(),'tokenBudget':self.budget.value()}

    @property
    def dirty(self):return self._loaded and self._snapshot()!=self._baseline

    def _changed(self,*_):self._update()

    def _update(self):
        for field in self._fields:field.setEnabled(self._loaded and not self._busy)
        self.auto_extract.setEnabled(self._loaded and not self._busy and self.enabled.isChecked())
        self.save_button.setEnabled(self.dirty and not self._busy)
        self.reload_button.setEnabled(not self._busy)
        self.tabs.setEnabled(self._loaded and not self._busy)
        self._selection()

    def _start(self,name,operation,text):
        if self._busy:return False
        self._busy=True;self.status.setText(text);self._update();self.jobs.run(name,operation);return True

    def _fetch(self):return {'settings':self.client.settings(),'memory':self.client.request('GET','/memory')}

    def reload(self):
        if self.dirty and not self.confirm_discard():return
        self._start('load',self._fetch,'正在读取记忆与来源…')

    def save(self):
        if not self._loaded or self._busy:return False
        partial={'memory':self._snapshot()}
        def operation():
            settings=self.client.save_settings(partial)
            return {'settings':settings,'memory':self.client.request('GET','/memory')}
        return self._start('save',operation,'正在保存记忆设置…')

    def save_and_then(self,callback):
        if self._busy:self.status.setText('操作正在进行，请等待完成。');return
        self._after_save=callback
        if not self.save():self._after_save=None

    def _render(self,data):
        self.facts.clear();self.people.clear();self.revisions.clear()
        for fact in data.get('facts',[]):
            item=QTreeWidgetItem([str(fact.get('fact_key','')),str(fact.get('fact_value','')), '有效' if fact.get('active') else '已删除'])
            item.setData(0,Qt.ItemDataRole.UserRole,('fact',fact));self.facts.addTopLevelItem(item)
        for person in data.get('people',[]):
            item=QTreeWidgetItem([str(person.get('display_name','')),str(person.get('relation_type','')),str(person.get('notes',''))])
            item.setData(0,Qt.ItemDataRole.UserRole,('person',person));self.people.addTopLevelItem(item)
        for revision in data.get('revisions',[]):
            item=QTreeWidgetItem([str(revision['id']),str(revision['fact_id']),revision['operation']+('（已撤销）' if revision.get('undone_by') else '')])
            item.setData(0,Qt.ItemDataRole.UserRole,('revision',revision));self.revisions.addTopLevelItem(item)
        for revision in data.get('entityRevisions',[]):
            item=QTreeWidgetItem([str(revision['id']),'人物 '+str(revision['entity_id']),'纠正/删除'+('（已撤销）' if revision.get('undone_by') else '')])
            item.setData(0,Qt.ItemDataRole.UserRole,('entity-revision',revision));self.revisions.addTopLevelItem(item)
        profile=(data.get('profile') or {}).get('profile',{})
        identity=profile.get('identity',{})
        lines=[f'姓名：{identity.get("name") or "尚未记录"}',f'城市：{identity.get("city") or "尚未记录"}',
               f'职业：{identity.get("occupation") or "尚未记录"}',
               '偏好：'+'；'.join(profile.get('preferences') or []),'习惯与特点：'+'；'.join(profile.get('traits') or []),
               '近况：'+str(profile.get('recent') or ''),'沟通习惯：'+str(profile.get('tone') or '')]
        self.profile.setPlainText('\n'.join(lines))
        events=['事件：'+str(item.get('title') or '')+'\n'+str(item.get('body') or '') for item in data.get('events',[])]
        events += ['对话摘要：\n'+str(item.get('summary') or '') for item in data.get('summaries',[])]
        self.events.setPlainText('\n\n'.join(events) or '尚未整理事件或摘要。')
        for tree in (self.facts,self.people,self.revisions):tree.resizeColumnToContents(0)

    def _completed(self,name,result):
        self._busy=False
        if name in ('load','save'):
            self._loaded=False;settings=result.get('settings',{}).get('memory',{})
            self.enabled.setChecked(settings.get('enabled',True));self.auto_extract.setChecked(settings.get('autoExtract',True))
            self.recent.setValue(settings.get('maxRecentMessages',30));self.budget.setValue(settings.get('tokenBudget',800))
            self._baseline=self._snapshot();self._loaded=True;self._memory=result.get('memory',{})
        else:self._memory=result
        self._render(self._memory)
        self.status.setText('记忆设置已保存。' if name=='save' else '已读取记忆，选择条目可查看来源与修订。')
        self._update()
        if name=='save' and self._after_save is not None:
            callback,self._after_save=self._after_save,None;callback()

    def _failed(self,name):
        self._busy=False;self._after_save=None
        self.status.setText('记忆操作未完成，修改仍保留。请确认后台已启动，或刷新后重试。');self._update()

    def _selected(self):
        tree=self.tabs.currentWidget()
        if not isinstance(tree,QTreeWidget):return None
        item=tree.currentItem();return item.data(0,Qt.ItemDataRole.UserRole) if item else None

    def _selection(self):
        selection=self._selected() if hasattr(self,'tabs') else None
        ready=bool(selection) and self._loaded and not self._busy
        kind=selection[0] if selection else ''
        data=selection[1] if selection else {}
        if selection:
            if kind=='fact':
                text='名称：'+str(data.get('fact_key',''))+'\n内容：'+str(data.get('fact_value',''))
                text+='\n\n原始来源（之后的手动纠正见修改记录）：\n'+str(data.get('source_text') or '没有可用的原话来源。')
            elif kind=='person':
                relation={'family':'家人','friend':'朋友','colleague':'同事','other':'其他'}.get(data.get('relation_type'),'其他')
                text='人物：'+str(data.get('display_name',''))+'\n关系：'+relation+'\n备注：'+str(data.get('notes',''))
                text+='\n\n来源原话：\n'+str(data.get('source_text') or '没有可用的原话来源。')
            else:
                before=json.loads(data.get('before_json') or 'null') or {}
                after=json.loads(data.get('after_json') or 'null') or {}
                text='修改前：'+str(before.get('fact_value') or before.get('notes') or '无')
                text+='\n修改后：'+str(after.get('fact_value') or after.get('notes') or '已删除')
                text+='\n操作来源：'+('手动纠正' if data.get('actor')=='user' or kind=='entity-revision' else '对话自动整理')
                if data.get('evidence'):text+='\n\n依据原话：\n'+data['evidence']
            self.detail.setPlainText(text)
        self.edit_button.setEnabled(ready and (kind=='person' or (kind=='fact' and data.get('active'))))
        self.delete_button.setEnabled(self.edit_button.isEnabled())
        self.undo_button.setEnabled(ready and kind in ('revision','entity-revision') and not data.get('undone_by'))

    def _action(self,method,path,body=None):
        def operation():
            self.client.request(method,path,**({'json':body} if body is not None else {}))
            return self.client.request('GET','/memory')
        self._start('action',operation,'正在更新记忆…')

    def edit_selected(self):
        selected=self._selected()
        if not selected:return
        kind,data=selected
        if kind=='person':
            dialog=QDialog(self);dialog.setWindowTitle('纠正人物关系');dialog.setMinimumWidth(400)
            form=QFormLayout(dialog)
            name=QLineEdit(str(data.get('display_name','')),dialog)
            relation=ModernSelect(dialog,width=200)
            for label,key in [('家人','family'),('朋友','friend'),('同事','colleague'),('其他','other')]:relation.addItem(label,key)
            relation.setCurrentData(data.get('relation_type','other'))
            notes=QPlainTextEdit(dialog);notes.setPlainText(str(data.get('notes','')))
            form.addRow('人物称呼',name);form.addRow('关系',relation);form.addRow('已确认的备注',notes)
            buttons=QDialogButtonBox(QDialogButtonBox.StandardButton.Save|QDialogButtonBox.StandardButton.Cancel,dialog)
            buttons.accepted.connect(dialog.accept);buttons.rejected.connect(dialog.reject);form.addRow(buttons)
            if dialog.exec()==QDialog.DialogCode.Accepted and name.text().strip():
                self._action('PUT',f"/memory/people/{data['id']}",{'displayName':name.text().strip(),'relationType':relation.currentData(),'notes':notes.toPlainText().strip()})
            return
        text,ok=QInputDialog.getMultiLineText(self,'纠正记忆','填写已确认的内容：',str(data.get('fact_value','')))
        if ok and text.strip():self._action('PUT',f"/memory/facts/{data['id']}",{'factValue':text.strip()})

    def delete_selected(self):
        selected=self._selected()
        if not selected:return
        kind,data=selected
        if QMessageBox.question(self,'删除记忆','删除此条记忆？可以在修改记录中撤销。')!=QMessageBox.StandardButton.Yes:return
        self._action('DELETE',f"/memory/{'facts' if kind=='fact' else 'people'}/{data['id']}")

    def undo_selected(self):
        selected=self._selected()
        if not selected:return
        kind,data=selected
        self._action('POST',f"/memory/{'revisions' if kind=='revision' else 'entity-revisions'}/{data['id']}/undo",{})

    def confirm_discard(self):
        return QMessageBox.question(self,'记忆设置尚未保存','要放弃记忆设置修改吗？',
            QMessageBox.StandardButton.Discard|QMessageBox.StandardButton.Cancel,
            QMessageBox.StandardButton.Cancel)==QMessageBox.StandardButton.Discard

    def can_close(self,*,commit_discard=True):
        if self._busy:self.status.setText('操作正在进行，请等待完成。');return False
        if self.dirty:
            if not self.confirm_discard():return False
            if commit_discard:self._baseline=self._snapshot()
        return True
