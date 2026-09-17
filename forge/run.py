#!/usr/bin/env python3
"""Zero-install launcher: `python3 run.py`.

Keeps working from a bare clone - no pip install, no virtualenv required.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from avernal_forge.__main__ import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
