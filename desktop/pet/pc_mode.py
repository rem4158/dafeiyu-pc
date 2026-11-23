"""Detect the PC launcher in the desktop pet and settings processes."""
import os


def is_pc_mode() -> bool:
    return bool(os.environ.get("DAFEIYU_PC_ROOT"))
