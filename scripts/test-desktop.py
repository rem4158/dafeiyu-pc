"""Run the desktop regression tests with isolated settings and an offscreen Qt platform."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def main():
    root = Path(__file__).resolve().parents[1]
    temporary = root / "temp"
    temporary.mkdir(exist_ok=True)
    failures = []
    cases = sorted((root / "tests").glob("test_*.py"))
    with tempfile.TemporaryDirectory(prefix="desktop-tests-", dir=temporary) as directory:
        profile = Path(directory)
        for name in ("roaming", "local", "data", "tmp"):
            (profile / name).mkdir()
        env = dict(os.environ, QT_QPA_PLATFORM="offscreen", DAFEIYU_PC_ROOT=str(root),
                   DAFEIYU_DATA_DIR=str(profile / "data"), APPDATA=str(profile / "roaming"),
                   LOCALAPPDATA=str(profile / "local"), TEMP=str(profile / "tmp"), TMP=str(profile / "tmp"))
        for case in cases:
            print(case.name, flush=True)
            result = subprocess.run(
                [sys.executable, "-I", "-B", "-X", "utf8", "-m", "unittest", "discover",
                 "-s", str(root / "tests"), "-p", case.name],
                env=env, cwd=root,
            )
            if result.returncode:
                failures.append(case.name)
    print(f"Passed {len(cases) - len(failures)}/{len(cases)} test modules.")
    if failures:
        print("\n".join(failures), file=sys.stderr)
    return bool(failures)


if __name__ == "__main__":
    sys.exit(main())
