"""Quota card uses the backend snapshot; no service/config/model/audio calls."""
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

os.environ['QT_QPA_PLATFORM'] = 'offscreen'
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'desktop_bridge'))
from PySide6.QtCore import QCoreApplication, QEvent
from PySide6.QtWidgets import QApplication, QFrame, QLabel
import deepseek_balance as bridge


class ImmediateThread:
    def __init__(self, target, **kwargs):
        self.target = target

    def start(self):
        self.target()


class Island(QFrame):
    def __init__(self):
        super().__init__()
        self.values = []
        self._card_balance_label = QLabel(self)
        self._card_tier_label = QLabel(self)

    def set_balance_info(self, hint, text):
        self.values.append((hint, text))
        self._card_tier_label.setText(hint)
        self._card_balance_label.setText(text)


class UsageBalanceUITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        self.environment = patch.dict(os.environ, {'DAFEIYU_PC_ROOT': str(ROOT)})
        self.environment.start()
        self.island = Island()
        self.shell = SimpleNamespace(app=self.app, island=self.island,
                                     _island_tier_hint=lambda: 'DeepSeek 当前空闲')
        self.payload = {'provider': 'openai', 'balance_status': 'unsupported', 'account_available': None,
                        'available': None, 'text': '今日 1,234 tokens',
                        'hint': 'OpenAI · 账户余额未接入 · 预估 $0.0012',
                        'detail': '仅本程序当前连接，预算未设置', 'updated': '20:00'}
        self.fetches = 0
        self.clock = 10.0

        def fetch():
            self.fetches += 1
            return dict(self.payload)

        self.controller = bridge.BalanceController(self.shell, fetcher=fetch)
        self.thread = patch.object(bridge.threading, 'Thread', ImmediateThread)
        self.thread.start()
        self.time = patch.object(bridge.time, 'monotonic', side_effect=lambda: self.clock)
        self.time.start()

    def tearDown(self):
        self.thread.stop()
        self.time.stop()
        self.environment.stop()
        self.controller.deleteLater()
        self.island.deleteLater()
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.app.processEvents()

    def test_no_deepseek_hint_before_backend_snapshot(self):
        self.assertEqual(self.controller._tier_hint(), '用量与余额')

    def test_openai_hint_and_tooltip_are_used_verbatim(self):
        self.controller.refresh()
        self.assertEqual(self.island.values[-1], (self.payload['hint'], self.payload['text']))
        self.assertEqual(self.island._card_balance_label.toolTip(), self.payload['detail'])
        self.assertNotIn('DeepSeek', self.island.values[-1][0])

    def test_unsupported_false_is_not_account_insufficient(self):
        self.payload['available'] = False
        self.controller.refresh()
        self.assertNotIn('余额不足', self.island.values[-1][0])

    def test_known_insufficient_uses_only_explicit_backend_hint(self):
        self.payload.update(provider='deepseek', balance_status='known', account_available=False,
                            available=False, text='余额 ¥0.00', hint='DeepSeek · 账户余额不足 · 费用未计价')
        self.controller.refresh()
        self.assertEqual(self.island.values[-1][0].count('余额不足'), 1)

    def test_card_reopen_reads_fresh_usage_and_provider(self):
        self.controller.refresh()
        self.clock += 2
        self.payload.update(provider='deepseek', text='余额 ¥12.34', hint='DeepSeek · 账户可用 · 费用未计价')
        self.controller.refresh()
        self.assertEqual(self.fetches, 2)
        self.assertEqual(self.island.values[-2][0], '用量与余额', 'old provider cleared while rereading')
        self.assertEqual(self.island.values[-1][0], self.payload['hint'])

    def test_manual_refresh_bypasses_short_quiet_throttle(self):
        self.controller.refresh()
        self.clock += .01
        self.controller.refresh()
        self.assertEqual(self.fetches, 1)
        self.controller.refresh(force=True)
        self.assertEqual(self.fetches, 2)

    def test_failure_clears_stale_provider_and_hides_private_errors(self):
        self.controller.refresh()
        self.controller.fetcher = lambda: (_ for _ in ()).throw(RuntimeError('PRIVATE_ERROR'))
        self.clock += 2
        self.controller.refresh()
        self.assertIsNone(self.controller.cached)
        self.assertEqual(self.island.values[-1][0], '用量与余额')
        self.assertNotIn('PRIVATE', self.island.values[-1][1])

    def test_installed_tier_route_does_not_reintroduce_old_peak_labels(self):
        class Shell:
            def _island_tier_hint(self):
                return 'DeepSeek 当前空闲'
        bridge.install_balance_routes(SimpleNamespace(AppShell=Shell))
        shell = Shell()
        shell._astrbot_balance = self.controller
        self.assertEqual(shell._island_tier_hint(), '用量与余额')
        self.controller.refresh()
        self.assertEqual(shell._island_tier_hint(), self.payload['hint'])
        with patch.dict(os.environ):
            os.environ.pop('DAFEIYU_PC_ROOT', None)
            self.assertEqual(shell._island_tier_hint(), self.payload['hint'])

    def test_manual_bubble_contains_shared_detail(self):
        bubbles = []
        target = SimpleNamespace(show_bubble=lambda text, **kwargs: bubbles.append(text))
        self.controller.refresh(force=True, target=target)
        self.assertEqual(bubbles, [self.payload['text'] + '\n' + self.payload['detail']])


if __name__ == '__main__':
    unittest.main()
