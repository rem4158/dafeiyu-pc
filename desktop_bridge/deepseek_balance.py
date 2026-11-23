"""Present the PC backend's local usage and balance snapshot."""
import logging
import os
import threading
import time
from datetime import datetime
from pathlib import Path

from PySide6.QtCore import QObject, Signal


class BalanceError(RuntimeError):
    pass


def fetch_balance():
    from nianan_client import NiananClient

    root = Path(os.environ.get('DAFEIYU_PC_ROOT') or Path(__file__).resolve().parents[1])
    try:
        return NiananClient(root).request('GET', '/balance')
    except Exception:
        raise BalanceError('用量与余额查询暂不可用，请检查本地后台连接') from None


class BalanceController(QObject):
    result = Signal(object)

    def __init__(self, shell, fetcher=fetch_balance):
        super().__init__(shell.app)
        self.shell = shell
        self.fetcher = fetcher
        self.busy = False
        self.cached = None
        self.last_attempt = None
        self.bubble_target = None
        self.result.connect(self._received)

    def refresh(self, force=False, target=None):
        island = getattr(self.shell, 'island', None)
        if island is None:
            return
        now = time.monotonic()
        if target is not None:
            self.bubble_target = target
        if self.busy:
            return
        if self.last_attempt and not force and now - self.last_attempt < 1:
            return
        self.last_attempt = now
        self.busy = True
        island.set_balance_info('用量与余额', '正在读取用量…')
        def query():
            try:
                payload = self.fetcher()
                payload['updated'] = datetime.now().strftime('%H:%M')
                self.result.emit(payload)
            except Exception as exc:
                message = str(exc) if isinstance(exc, BalanceError) else '用量与余额读取失败，请稍后重试'
                self.result.emit({'error': message})
        threading.Thread(target=query, daemon=True, name='Usage-balance').start()

    def _received(self, payload):
        self.busy = False
        if 'error' not in payload:
            self.cached = (time.monotonic(), payload)
            logging.info('本地用量与余额状态已更新')
        else:
            self.cached = None
        self._present(payload)

    def _tier_hint(self):
        return str(self.cached[1].get('hint') or '用量与余额') if self.cached else '用量与余额'

    def _present(self, payload):
        island = getattr(self.shell, 'island', None)
        if island is not None:
            if 'error' in payload:
                island.set_balance_info(self._tier_hint(), payload['error'])
            else:
                hint = payload.get('hint')
                if not hint:
                    hint = self._tier_hint() + ' · ' + payload.get('updated', '') + ' 更新'
                island.set_balance_info(hint, payload['text'])
                for name in ('_card_balance_label', '_card_tier_label'):
                    label = getattr(island, name, None)
                    if label is not None:
                        label.setToolTip(str(payload.get('detail') or ''))
        target, self.bubble_target = self.bubble_target, None
        if target is not None and callable(getattr(target, 'show_bubble', None)):
            text = payload.get('error') or payload['text'] + '\n' + payload['detail']
            target.show_bubble(text, duration_ms=8000)


def install_balance_routes(app_module):
    def controller(shell):
        if not hasattr(shell, '_astrbot_balance'):
            shell._astrbot_balance = BalanceController(shell)
        return shell._astrbot_balance

    def quiet(shell, *, force=False):
        controller(shell).refresh(force=force)

    def manual(shell, parent=None):
        target = parent
        if target is None or not callable(getattr(target, 'show_bubble', None)):
            target = getattr(shell, '_overlay_shell', None) or getattr(shell, 'win', None)
        controller(shell).refresh(force=True, target=target)

    def tier_hint(shell):
        return controller(shell)._tier_hint()

    app_module.AppShell._quiet_balance_refresh = quiet
    app_module.AppShell.show_balance = manual
    app_module.AppShell._island_tier_hint = tier_hint
