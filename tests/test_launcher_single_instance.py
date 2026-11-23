"""Exercise the Windows launcher lock with two processes in an isolated app root."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from launch import launch


@unittest.skipUnless(sys.platform == 'win32', 'uses Windows byte-range locks')
class SingleInstanceTests(unittest.TestCase):
    def test_repeat_launch_focuses_existing_pet_while_lock_is_held(self):
        import msvcrt

        for initial_bytes in (b'', b'0'):
            with self.subTest(initial_bytes=initial_bytes), tempfile.TemporaryDirectory() as directory:
                app_root = Path(directory)
                data = app_root / 'data'
                data.mkdir()
                lock_path = data / 'launcher.lock'
                lock_path.write_bytes(initial_bytes)
                with lock_path.open('r+b') as owner:
                    msvcrt.locking(owner.fileno(), msvcrt.LK_NBLCK, 1)
                    subprocess.run([
                        sys.executable, '-B', '-c',
                        'import sys; from launch import launch; launch(sys.argv[1])',
                        str(app_root),
                    ], cwd=ROOT, check=True, timeout=10)
                    self.assertTrue((data / 'focus-chat').is_file())
                    self.assertFalse((data / 'launcher-state.json').exists())

                (data / 'focus-chat').unlink()
                # With the owner gone this empty installation reaches the startup check.
                with self.assertRaisesRegex(RuntimeError, '安装文件不完整'):
                    launch(app_root)
                self.assertFalse((data / 'focus-chat').exists())


if __name__ == '__main__':
    unittest.main()
