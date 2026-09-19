"""Persisted connector settings: what is switched on, and the user's own keys.

Secrets live in one file with 0600 permissions and are never returned by the
API, never logged, and never included in any response body.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any


class ConnectorStore:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()
        self._data: dict[str, Any] = {
            "online": False,
            "enabled": [],
            "extra_domains": [],
            "credentials": {},
        }
        self.load()

    def load(self) -> None:
        if not self.path.is_file():
            return
        try:
            loaded = json.loads(self.path.read_text())
        except (OSError, ValueError):
            return
        if isinstance(loaded, dict):
            with self._lock:
                self._data.update(
                    {k: v for k, v in loaded.items() if k in self._data}
                )

    def save(self) -> None:
        with self._lock:
            payload = json.dumps(self._data, indent=2)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix(".tmp")
        temp.write_text(payload)
        try:
            os.chmod(temp, 0o600)
        except OSError:
            pass
        temp.replace(self.path)

    # ------------------------------------------------------------- settings

    @property
    def online(self) -> bool:
        with self._lock:
            return bool(self._data.get("online"))

    def set_online(self, value: bool) -> None:
        with self._lock:
            self._data["online"] = bool(value)
        self.save()

    def enabled_ids(self, default: list[str]) -> list[str]:
        with self._lock:
            stored = self._data.get("enabled")
        return list(stored) if stored else list(default)

    def set_enabled(self, ids: list[str]) -> None:
        with self._lock:
            self._data["enabled"] = sorted(set(ids))
        self.save()

    @property
    def extra_domains(self) -> list[str]:
        with self._lock:
            return list(self._data.get("extra_domains") or [])

    # ---------------------------------------------------------- credentials

    def credentials(self, connector_id: str) -> dict[str, str]:
        """Environment variables win, so secrets need not be written to disk."""
        with self._lock:
            stored = dict(self._data.get("credentials", {}).get(connector_id, {}))
        prefix = f"AVERNAL_FORGE_{connector_id.upper()}_"
        for key, value in os.environ.items():
            if key.startswith(prefix) and value:
                stored[key[len(prefix):].lower()] = value
        return stored

    def set_credentials(self, connector_id: str, values: dict[str, str]) -> None:
        with self._lock:
            bucket = self._data.setdefault("credentials", {})
            current = dict(bucket.get(connector_id, {}))
            for key, value in values.items():
                if value == "":
                    current.pop(key, None)      # empty string clears a field
                elif value is not None:
                    current[key] = str(value)
            if current:
                bucket[connector_id] = current
            else:
                bucket.pop(connector_id, None)
        self.save()

    def clear_credentials(self, connector_id: str) -> None:
        with self._lock:
            self._data.get("credentials", {}).pop(connector_id, None)
        self.save()
