"""Make the plugin directory importable as the package ``rivet_memory``.

The repo layout uses a hyphenated directory (``rivet-memory``) for branding;
Hermes installs it as ``rivet_memory`` (underscore). Tests symlink the parent
of the plugin onto sys.path so ``import rivet_memory`` resolves whichever
shape is in front.
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

_PLUGIN_DIR = Path(__file__).resolve().parent.parent  # the rivet-memory dir


def _shim_root() -> Path:
    """Create a temp dir with ``rivet_memory`` -> plugin so imports work."""
    root = Path(tempfile.mkdtemp(prefix="rmtest-shim-"))
    link = root / "rivet_memory"
    try:
        os.symlink(_PLUGIN_DIR, link)
    except OSError:
        # Fall back to a copy if the FS doesn't allow symlinks.
        shutil.copytree(_PLUGIN_DIR, link)
    return root


@pytest.fixture(scope="session", autouse=True)
def _install_package_alias():
    root = _shim_root()
    sys.path.insert(0, str(root))
    try:
        yield
    finally:
        # Leave the temp dir on disk — tests may still hold module references.
        sys.path.remove(str(root))
