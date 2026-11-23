"""Native controls for the aligned Nianan proactive and emotion runtime."""
from __future__ import annotations
from datetime import datetime
from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import QLabel, QPushButton, QVBoxLayout, QWidget, QMessageBox
from .local_model_settings import _Jobs, local_client
from .settings_widgets import SettingRow, SettingsSection, ToggleSwitch, BrowserSpinBox

EMOTION_NAMES = {'joy':'喜悦','sadness':'低落','anger':'生气','curiosity':'好奇','empathy':'体贴',
                 'contentment':'满足','excitement':'兴奋','surprise':'惊讶','trust':'信任','warmth':'温暖'}
REASONS = {'not_started':'尚未启动','waiting':'等待合适时机','not_running':'尚未运行',
           'disabled':'主动陪伴已关闭','cognition_disabled':'情绪与成长已关闭',
           'quiet_hours':'免打扰中','conversation_active':'正在聊天或写消息','voice_active':'正在使用语音',
           'daily_limit':'今日次数已用完','waiting_for_reply':'等待你的回应','not_idle':'还没到聊完后的搭话时间',
           'waiting_for_desktop':'等待桌宠就绪','waiting_for_reply_display':'等待本轮回复显示完毕',
           'no_opportunity':'等待下一轮聊天','model_passed':'这次没有想说的话','interrupted':'这次主动搭话已跳过',
           'not_configured':'尚未配置聊天模型','session_changed':'对话已切换','sent':'已发送',
           'budget_blocked':'用量限额阻止本次搭话','generation_failed':'这次未能生成主动消息','in_flight':'正在准备消息'}
DAY_STATES = {'planned':'已生成日程', 'empty':'今天选择休息', 'plan_failed':'未能生成计划', 'scheduled':'已安排', 'running':'正在进行',
              'done':'已结束', 'missed':'错过时间窗口', 'failed':'活动未完成'}
DAY_RESULTS = {'recorded':'已保存经历', 'no_note':'没有可保存的经历', 'stopped':'她选择停下',
               'unverified':'模型笔记缺少可核对来源', 'disabled':'主动浏览已关闭', 'interrupted':'活动已中断',
               'timeout':'活动已超时', 'budget_blocked':'用量限额拦截', 'invalid_window':'计划时间无效', 'failed':'执行失败'}
ACTION_RESULTS = {'opened':'已打开入口', 'read':'已读到正文', 'daily_life_no_body':'未取得正文',
                  'browser_login_required':'需要登录', 'browser_verification_required':'需要验证',
                  'browser_rate_limited':'站点限流', 'interrupted':'已中断'}
SITE_NAMES = {'xiaohongshu':'小红书', 'zhihu':'知乎', 'tieba':'贴吧', 'hupu':'虎扑'}

class LocalCompanionSettingsPage(QWidget):
    def __init__(self,parent=None,*,client=None,auto_load=True):
        super().__init__(parent)
        self.client=client or local_client();self._loaded=False;self._busy=False;self._baseline=None;self._after_save=None
        self.jobs=_Jobs(self);self.jobs.completed.connect(self._completed);self.jobs.failed.connect(self._failed)
        layout=QVBoxLayout(self);layout.setContentsMargins(0,0,0,0);layout.setSpacing(18)
        self.cognition=ToggleSwitch(self);self.proactive=ToggleSwitch(self)
        self.idle=self._spin('聊完多久后可以主动',1,1440,' 分钟')
        self.daily=self._spin('每日主动上限',0,50,' 次')
        self.unanswered=self._spin('连续未回复上限',1,20,' 次')
        self.quiet_start=self._spin('免打扰开始时间',0,23,' 时')
        self.quiet_end=self._spin('免打扰结束时间',0,23,' 时')
        layout.addWidget(SettingsSection('情绪与成长',[
            SettingRow('companion_cognition','启用情绪与成长','让情绪、关系、内驱力和成长状态随真实互动变化。关闭时主动判定也暂停。',self.cognition)
        ],self))
        layout.addWidget(SettingsSection('主动陪伴',[
            SettingRow('companion_proactive','允许主动搭话','启动后和一轮电脑聊天结束后，各有一次主动搭话机会。写消息、等待回复或使用语音时会避开。',self.proactive),
            SettingRow('companion_idle','聊完多久后可以主动','从大肥鱼显示完回复开始算，到了时间她也可以选择不说。',self.idle,stacked=True),
            SettingRow('companion_daily','每日主动上限','设为 0 时不发送主动消息。',self.daily,stacked=True),
            SettingRow('companion_unanswered','连续未回复上限','达到后等待你的下一次回应，避免连续打扰。',self.unanswered,stacked=True),
        ],self))
        layout.addWidget(SettingsSection('免打扰时段',[
            SettingRow('companion_quiet_start','开始时间','使用电脑本地时间，支持跨午夜。',self.quiet_start,stacked=True),
            SettingRow('companion_quiet_end','结束时间','开始与结束相同时，不额外限制时段；桌宠免打扰仍然有效。',self.quiet_end,stacked=True),
        ],self))
        self.runtime=QLabel('尚未读取运行状态',self);self.runtime.setWordWrap(True);self.runtime.setObjectName('settingHint')
        layout.addWidget(self.runtime)
        self.day=QLabel('尚未读取今日活动',self);self.day.setWordWrap(True);self.day.setObjectName('settingHint')
        self.day.setTextFormat(Qt.TextFormat.PlainText)
        layout.addWidget(self.day)
        self.status=QLabel('正在读取配置…',self);self.status.setWordWrap(True);self.status.setObjectName('settingHint');layout.addWidget(self.status)
        self.save_button=QPushButton('保存主动与情绪配置',self);self.reload_button=QPushButton('重新读取',self)
        self.refresh_button=QPushButton('刷新运行状态',self)
        for button in (self.save_button,self.reload_button,self.refresh_button):button.setAutoDefault(False);layout.addWidget(button)
        layout.addStretch(1)
        self._controls=(self.cognition,self.proactive,self.idle,self.daily,self.unanswered,self.quiet_start,self.quiet_end)
        self.cognition.toggled.connect(self._changed);self.proactive.toggled.connect(self._changed)
        for field in self._controls[2:]:field.valueChanged.connect(self._changed)
        self.save_button.clicked.connect(self.save);self.reload_button.clicked.connect(self.reload);self.refresh_button.clicked.connect(self.refresh_status)
        self._update()
        if auto_load:QTimer.singleShot(0,self.reload)
    def _spin(self,label,minimum,maximum,suffix):
        control=BrowserSpinBox(self);control.setFixedWidth(140);control.setRange(minimum,maximum);control.setSuffix(suffix);control.setAccessibleName(label);return control
    def _snapshot(self):
        return {'cognition':{'enabled':self.cognition.isChecked()},'proactive':{'enabled':self.proactive.isChecked(),
            'chatGapMinutes':self.idle.value(),'maxPerDay':self.daily.value(),
            'maxUnanswered':self.unanswered.value(),'quietHoursStart':self.quiet_start.value(),'quietHoursEnd':self.quiet_end.value()}}
    @property
    def dirty(self):return self._loaded and self._snapshot()!=self._baseline
    def _changed(self,*_):
        if self._loaded and not self._busy:self.status.setText('配置尚未保存。' if self.dirty else '已读取当前配置。')
        self._update()
    def _update(self):
        for control in self._controls:control.setEnabled(self._loaded and not self._busy)
        self.save_button.setEnabled(self.dirty and not self._busy);self.reload_button.setEnabled(not self._busy)
        self.refresh_button.setEnabled(self._loaded and not self._busy)
    def _start(self,name,operation,text):
        if self._busy:return False
        self._busy=True;self.status.setText(text);self._update();self.jobs.run(name,operation);return True
    def reload(self):
        if self.dirty and not self.confirm_discard():return
        def load():return {'settings':self.client.settings(),'runtime':self.client.request('GET','/companion/status')}
        self._start('load',load,'正在读取配置…')
    def save(self):
        if not self._loaded or self._busy:return False
        value=self._snapshot();payload={}
        for group,fields in value.items():
            changed={k:v for k,v in fields.items() if self._baseline[group].get(k)!=v}
            if changed:payload[group]=changed
        if not payload:return False
        return self._start('save',lambda:self.client.save_settings(payload),'正在保存配置…')
    def save_and_then(self,callback):
        self._after_save=callback
        if not self.save():self._after_save=None
    def refresh_status(self):self._start('status',lambda:self.client.request('GET','/companion/status'),'正在刷新运行状态…')
    def _show_runtime(self,value):
        # Display actual persisted cognition, not a decorative fake mood meter.
        cognition=value.get('cognition') or {};emotion=cognition.get('emotion') or {}
        dominant=max(emotion,key=emotion.get) if emotion else None
        label=EMOTION_NAMES.get(dominant,dominant) if dominant else '等待互动'
        narrative=cognition.get('narrative') or {}
        reason=REASONS.get(value.get('reason'), '等待下一次判定')
        self.runtime.setText(f"当前情绪：{label}；成长叙事版本：{narrative.get('version', 1)}\n今日主动：{value.get('todayCount',0)} / {value.get('dailyLimit',0)}；{reason}")
        day = value.get('dailyLife')
        if not day:
            self.day.setText('大肥鱼的一天：暂无今日活动记录。')
            return
        lines = [f"大肥鱼的一天 · {day['day']} · {DAY_STATES.get(day.get('status'), '状态未知')}"]
        if day.get('report'):
            lines.append(DAY_RESULTS.get(day['report'].get('outcome'), '计划未完成'))
        def clock(value):
            return datetime.fromtimestamp(value / 1000).strftime('%H:%M')
        for entry in day.get('entries', []):
            status = DAY_STATES.get(entry['status'], '状态未知')
            if entry['kind'] == 'rest':
                status = '休息时段已过' if entry['status'] == 'done' else '预留休息'
            lines.append(f"\n{clock(entry['startAt'])}–{clock(entry['endAt'])}  {entry['intent']}  ·  {status}")
            lines.append(f"缘由：{entry['reason']}")
            if entry.get('movedFrom') is not None:
                lines.append(f"原定 {clock(entry['movedFrom'])}，已改期")
            if entry.get('startedAt') is not None:
                started = clock(entry['startedAt'])
                lines.append(f"实际开始 {started}" if entry['status'] == 'running' else
                             f"实际 {started}–{clock(entry['updatedAt'])}")
            experience, report = entry.get('experience'), entry.get('report') or {}
            if experience:
                lines.append(f"经历：{experience['summary']}")
            elif report:
                lines.append(DAY_RESULTS.get(report.get('outcome'), '本次没有可保存的经历'))
            for action in report.get('actions', []):
                site = SITE_NAMES.get(action.get('site'), '网站')
                lines.append(f"{site} · {ACTION_RESULTS.get(action.get('outcome'), '读取未完成')}")
        self.day.setText('\n'.join(lines))
    def _completed(self,name,result):
        self._busy=False
        if name in ('load','save'):
            settings=result['settings'] if name=='load' else result
            self._loaded=False;cognition=settings.get('cognition') or {};proactive=settings.get('proactive') or {}
            self.cognition.setChecked(cognition.get('enabled',True));self.proactive.setChecked(proactive.get('enabled',True))
            for field,key,default in [(self.idle,'chatGapMinutes',3),
                (self.daily,'maxPerDay',3),(self.unanswered,'maxUnanswered',3),(self.quiet_start,'quietHoursStart',23),(self.quiet_end,'quietHoursEnd',7)]:field.setValue(proactive.get(key,default))
            self._baseline=self._snapshot();self._loaded=True
            if name=='load':self._show_runtime(result['runtime'])
            self.status.setText('配置已保存。' if name=='save' else '已读取当前配置。')
        else:self._show_runtime(result);self.status.setText('运行状态已更新。')
        self._update()
        if name=='save' and self._after_save is not None:
            callback,self._after_save=self._after_save,None;callback()
    def _failed(self,name):
        self._busy=False;self._after_save=None
        self.status.setText('读取失败，请确认本地后台已启动后重试。' if name=='load' else '操作失败，修改仍保留。请等待当前回复结束后重试。');self._update()
    def confirm_discard(self):
        return QMessageBox.question(self,'主动与情绪配置尚未保存','要放弃这些未保存的修改吗？',
            QMessageBox.StandardButton.Discard|QMessageBox.StandardButton.Cancel,QMessageBox.StandardButton.Cancel)==QMessageBox.StandardButton.Discard
    def can_close(self,*,commit_discard=True):
        if self._busy:self.status.setText('操作正在进行，请等待完成后再关闭。');return False
        if self.dirty:
            if not self.confirm_discard():return False
            if commit_discard:self._baseline=self._snapshot()
        return True
