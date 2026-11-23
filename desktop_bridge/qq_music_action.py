"""Open or resume only the QQ Music executable resolved by the pet's music settings."""

import json
import os
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'desktop'))

from pet import music_players, now_playing


def _is_running(exe):
    import psutil

    wanted = os.path.normcase(str(exe))
    for process in psutil.process_iter(['name']):
        if (process.info.get('name') or '').casefold() != exe.name.casefold():
            continue
        try:
            if os.path.normcase(os.path.realpath(process.exe())) == wanted:
                return True
        except (psutil.Error, OSError):
            continue
    return False


def qq_music_action(config_path, action):
    if sys.platform != 'win32' or action not in ('open', 'play'):
        return 'unsupported'
    try:
        with Path(config_path).open('rb') as handle:
            raw = handle.read(4 * 1024 * 1024 + 1)
        if len(raw) > 4 * 1024 * 1024:
            return 'config_unavailable'
        paths = json.loads(raw.decode('utf-8-sig')).get('music_player_paths', {})
        manual = paths.get('qqmusic', '') if isinstance(paths, dict) else ''
    except (OSError, ValueError, AttributeError):
        return 'config_unavailable'

    found = music_players.find_player('qqmusic', manual if isinstance(manual, str) else '')
    if not found:
        return 'player_missing'
    try:
        configured = Path(found)
        exe = configured.resolve(strict=True)
        if (not configured.is_absolute() or configured.name.casefold() != 'qqmusic.exe'
                or exe.name.casefold() != 'qqmusic.exe' or not exe.is_file()):
            return 'invalid_player'
    except (OSError, RuntimeError, ValueError):
        return 'invalid_player'

    can_play = action == 'play' and now_playing._import_winrt() is not None
    if can_play and _is_running(exe) and now_playing.play_session_for(exe.name):
        return 'play_requested'
    try:
        os.startfile(str(exe))
    except OSError:
        return 'launch_failed'

    until = time.monotonic() + 7
    running = False
    while time.monotonic() < until:
        running = _is_running(exe)
        if running:
            if action == 'open':
                return 'opened'
            if not can_play:
                return 'playback_unconfirmed'
            if now_playing.play_session_for(exe.name):
                return 'play_requested'
        time.sleep(0.35)
    return 'playback_unconfirmed' if running else 'launch_requested'


if __name__ == '__main__':
    if len(sys.argv) == 3:
        print(json.dumps({'status': qq_music_action(sys.argv[1], sys.argv[2])}))
