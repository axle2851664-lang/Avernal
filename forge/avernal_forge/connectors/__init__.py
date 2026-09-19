"""Connector registry.

Owns the network gate and decides, from what the user has enabled and
configured, which hosts are reachable at all.
"""

from __future__ import annotations

import time
from typing import Any

from .base import Connector, CredentialField, Reference
from .net import NetworkBlocked, NetworkError, NetworkGate, redact
from .openverse import OpenverseConnector
from .pinterest import PinterestConnector
from .reddit import RedditConnector
from .reso import ResoConnector
from .social import BlueskyConnector, MastodonConnector
from .store import ConnectorStore
from .webpage import RobotsDisallowed, WebPageConnector
from .wikimedia import CommonsConnector, WikipediaConnector

__all__ = [
    "Connector",
    "ConnectorHub",
    "ConnectorStore",
    "CredentialField",
    "NetworkBlocked",
    "NetworkError",
    "NetworkGate",
    "Reference",
    "RobotsDisallowed",
    "redact",
]

#: Connectors that need no signup are on by default; the rest are opt-in.
DEFAULT_ENABLED = ["wikipedia", "commons", "openverse", "webpage"]


class ConnectorHub:
    def __init__(self, config: Any, store: ConnectorStore) -> None:
        self.config = config
        self.store = store
        self.gate = NetworkGate(config)
        self.connectors: list[Connector] = [
            WikipediaConnector(config),
            CommonsConnector(config),
            OpenverseConnector(config),
            WebPageConnector(config),
            RedditConnector(config),
            PinterestConnector(config),
            MastodonConnector(config),
            BlueskyConnector(config),
            ResoConnector(config),
        ]
        self.refresh()

    # --------------------------------------------------------------- state

    def refresh(self) -> None:
        """Recompute the effective online flag and the host allowlist."""
        forced = bool(getattr(self.config, "online_forced", False))
        self.config.online = forced or self.store.online

        allowed: set[str] = set(self.store.extra_domains)
        for connector in self.connectors:
            if connector.id not in self.enabled_ids:
                continue
            credentials = self.store.credentials(connector.id)
            if connector.needs_credentials and not connector.configured(credentials):
                continue
            allowed.update(connector.domains)
            allowed.update(connector.extra_domains(credentials))
        self.gate.set_allowed_domains(allowed)

    @property
    def enabled_ids(self) -> list[str]:
        return self.store.enabled_ids(DEFAULT_ENABLED)

    def set_online(self, value: bool) -> None:
        self.store.set_online(bool(value))
        self.refresh()

    def set_enabled(self, ids: list[str]) -> None:
        known = {c.id for c in self.connectors}
        self.store.set_enabled([i for i in ids if i in known])
        self.refresh()

    def set_credentials(self, connector_id: str, values: dict[str, str]) -> None:
        if self.get(connector_id) is None:
            raise KeyError(connector_id)
        self.store.set_credentials(connector_id, values)
        self.refresh()

    # ------------------------------------------------------------- lookups

    def get(self, connector_id: str) -> Connector | None:
        for connector in self.connectors:
            if connector.id == connector_id:
                return connector
        return None

    def require(self, connector_id: str) -> Connector:
        connector = self.get(connector_id)
        if connector is None:
            raise KeyError(f"unknown connector {connector_id!r}")
        if connector.id not in self.enabled_ids:
            raise NetworkBlocked(f"the {connector.label} connector is switched off")
        credentials = self.store.credentials(connector.id)
        if connector.needs_credentials and not connector.configured(credentials):
            missing = ", ".join(connector.missing_fields(credentials))
            raise NetworkBlocked(f"{connector.label} still needs: {missing}")
        return connector

    def describe(self) -> dict[str, Any]:
        enabled = self.enabled_ids
        return {
            "online": bool(getattr(self.config, "online", False)),
            "online_forced": bool(getattr(self.config, "online_forced", False)),
            "allowed_domains": self.gate.allowed_domains,
            "connectors": [
                {
                    **connector.describe(self.store.credentials(connector.id)),
                    "enabled": connector.id in enabled,
                }
                for connector in self.connectors
            ],
        }

    # ------------------------------------------------------------ searching

    def search(self, connector_id: str, query: str, limit: int = 12) -> list[Reference]:
        connector = self.require(connector_id)
        credentials = self.store.credentials(connector.id)
        return connector.search(query, self.gate, credentials, limit=limit)

    def import_url(self, url: str) -> Reference:
        connector = self.require("webpage")
        return connector.import_url(url, self.gate)

    def probe(self, connector_id: str) -> dict[str, Any]:
        """One cheap live call, for `run.py connectors --check`."""
        started = time.time()
        try:
            connector = self.require(connector_id)
            credentials = self.store.credentials(connector.id)
            detail = connector.probe(self.gate, credentials)
            ok = True
        except Exception as exc:
            detail = f"{type(exc).__name__}: {exc}"
            ok = False
        return {
            "connector": connector_id,
            "ok": ok,
            "detail": detail,
            "ms": int((time.time() - started) * 1000),
        }

    def fetch_image(self, reference: Reference) -> tuple[bytes, str]:
        """Download a reference's image, preferring a host we already allow."""
        candidates = [
            reference.extra.get("download_url", ""),
            reference.image_url,
            reference.thumb_url,
        ]
        user_directed = reference.source == "webpage"
        errors: list[str] = []
        for url in [c for c in candidates if c]:
            try:
                response = self.gate.image(
                    url, connector=reference.source, user_directed=user_directed
                )
                content_type = response.headers.get("content-type", "").split(";")[0]
                return response.body, content_type or "image/jpeg"
            except (NetworkBlocked, NetworkError) as exc:
                errors.append(f"{redact(url)}: {exc}")
        raise NetworkError(
            "could not download the reference image. " + " | ".join(errors[:3])
        )
