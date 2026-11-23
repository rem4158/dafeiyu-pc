"""Start the local brain and pet as one hidden, independently owned application."""
import ctypes
import errno
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parent


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def service_request(root, route='/health', method='GET', timeout=2):
    """Read rotated credentials on each local request, never through a proxy."""
    descriptor = root / 'data' / 'backend.json'
    if descriptor.stat().st_size > 4096:
        raise ValueError('Invalid backend descriptor')
    data = json.loads(descriptor.read_text('utf-8-sig'))
    url = urlsplit(data['url'])
    if (url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port
            or url.username or url.password or url.path not in ('', '/')
            or url.query or url.fragment or not isinstance(data.get('token'), str)
            or len(data['token']) < 16):
        raise ValueError('Invalid local service address')
    request = Request(data['url'].rstrip('/') + route,
                      headers={'Authorization': 'Bearer ' + data['token']}, method=method)
    with build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=timeout) as response:
        # Local service responses must not redirect credentials elsewhere.
        if response.geturl() != request.full_url:
            raise ValueError('Unexpected redirect')
        return json.loads(response.read(65536))


def is_ready(root):
    try:
        health = service_request(root)
        return health.get('status') == 'ok' and health.get('backend') == 'nianan'
    except (OSError, ValueError, KeyError, URLError):
        return False


def stop_backend(root):
    try:
        service_request(root, '/shutdown', 'POST')
    except (OSError, ValueError, KeyError, URLError):
        pass


def launch(root=ROOT):
    root = Path(root)
    data = root / 'data'
    logs = root / 'logs'
    data.mkdir(parents=True, exist_ok=True)
    logs.mkdir(parents=True, exist_ok=True)
    # This lock remains held throughout the pet's lifetime; repeated launches focus it.
    lock = (data / 'launcher.lock').open('a+b')
    import msvcrt
    # Windows can lock byte zero even in an empty file. Reading it first fails
    # when another launcher owns it, before we can signal the existing chat.
    lock.seek(0)
    try:
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError as error:
        lock.close()
        if error.errno != errno.EACCES:
            raise
        (data / 'focus-chat').write_text(str(time.time()), 'utf-8')
        return

    backend = None
    pet = None
    owned_descriptor = None
    try:
        env = dict(os.environ, DAFEIYU_PC_ROOT=str(root))
        env.pop('DAFEIYU_DATA_DIR', None)
        # Electron must run its app entry, even when launched from an agent shell.
        env.pop('ELECTRON_RUN_AS_NODE', None)
        electron = root / 'runtime' / 'electron' / 'electron.exe'
        python = root / '.venv' / 'Scripts' / 'pythonw.exe'
        if not python.is_file():
            python = root / 'runtime' / 'python' / 'pythonw.exe'
        bridge = root / 'desktop_bridge' / 'run_pet.py'
        for entry in (electron, python, bridge, root / 'backend' / 'package.json'):
            if not entry.is_file():
                raise RuntimeError('安装文件不完整，请重新部署大肥鱼 PC。')
        if not is_ready(root):
            with (logs / 'backend.log').open('ab') as output:
                backend = subprocess.Popen([str(electron), str(root / 'backend')],
                    cwd=root, env=env, stdout=output, stderr=output,
                    creationflags=subprocess.CREATE_NO_WINDOW)
            deadline = time.monotonic() + 35
            while not is_ready(root):
                if backend.poll() is not None:
                    raise RuntimeError('念安后台启动失败，请查看 logs/backend.log。')
                if time.monotonic() >= deadline:
                    raise RuntimeError('念安后台启动超时，请查看 logs/backend.log。')
                time.sleep(0.2)
        owned_descriptor = (data / 'backend.json').read_bytes()
        with (logs / 'pet.log').open('ab') as output:
            pet = subprocess.Popen([str(python), '-B', str(bridge)],
                cwd=root / 'desktop', env=env, stdout=output, stderr=output,
                creationflags=subprocess.CREATE_NO_WINDOW)
        (data / 'launcher-state.json').write_text(json.dumps({
            'pet_pid': pet.pid, 'backend_pid': backend.pid if backend else None,
        }), 'utf-8')
        code = pet.wait()
        if code:
            raise RuntimeError('桌宠运行异常，请查看 logs/pet.log。')
    finally:
        # Reclaim an orphaned service as well; rotated descriptors identify replacements.
        try:
            same_service = owned_descriptor is not None and (data / 'backend.json').read_bytes() == owned_descriptor
        except OSError:
            same_service = False
        if same_service or (backend is not None and owned_descriptor is None):
            stop_backend(root)
        if backend is not None:
            try:
                backend.wait(timeout=8)
            except subprocess.TimeoutExpired:
                backend.terminate()
                backend.wait(timeout=5)
        lock.close()


if __name__ == '__main__':
    if '--check' in sys.argv:
        print(json.dumps({'ready': is_ready(ROOT)}, ensure_ascii=False))
    else:
        try:
            launch()
        except Exception as error:
            (ROOT / 'logs').mkdir(exist_ok=True)
            # No request URLs, API credentials or conversation contents in errors.
            message = str(error) if isinstance(error, RuntimeError) else '启动失败，请检查安装目录和运行日志。'
            ctypes.windll.user32.MessageBoxW(None, message, '大肥鱼 PC', 0x10)
