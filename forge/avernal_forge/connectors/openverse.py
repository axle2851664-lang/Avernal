"""Openverse - openly licensed image search across Flickr, museums and more.

Works without a key. A token raises the rate limits, so one is accepted but
never required.
"""

from __future__ import annotations

from .base import Connector, CredentialField, Reference
from .net import NetworkGate, build_query


class OpenverseConnector(Connector):
    id = "openverse"
    label = "Openverse"
    description = (
        "Several hundred million openly licensed images, each with its licence "
        "and creator. No account needed."
    )
    domains = ("openverse.org",)
    docs_url = "https://api.openverse.org/v1/"
    credential_fields = (
        CredentialField("token", "Bearer token (optional)", secret=True,
                        required=False, placeholder="raises rate limits"),
    )

    def endpoint(self, credentials: dict[str, str]) -> str:
        return self.base_url("https://api.openverse.org")

    def search(self, query, gate: NetworkGate, credentials, limit: int = 12):
        headers = {}
        token = (credentials.get("token") or "").strip()
        if token:
            headers["Authorization"] = f"Bearer {token}"

        base = self.endpoint(credentials)
        payload = gate.json(
            build_query(f"{base}/v1/images/", {
                "q": query,
                "page_size": max(1, min(limit, 40)),
                "mature": "false",
            }),
            connector=self.id,
            headers=headers,
        )
        results: list[Reference] = []
        for item in payload.get("results", []):
            identifier = item.get("id", "")
            licence = " ".join(
                part for part in (item.get("license", ""), item.get("license_version", ""))
                if part
            ).upper()
            tags = [
                tag.get("name", "") for tag in (item.get("tags") or [])
                if isinstance(tag, dict) and tag.get("name")
            ]
            # Openverse results live on third-party hosts that are deliberately
            # not on our allowlist. Its own proxied thumbnail is, so that is
            # what Forge downloads when the reference is saved.
            proxied = f"{base}/v1/images/{identifier}/thumb/" if identifier else ""
            results.append(Reference(
                id=f"openverse:{identifier}",
                source=self.id,
                title=item.get("title", "") or "Untitled",
                summary=self._clean(item.get("description") or "", 400),
                page_url=item.get("foreign_landing_url", "") or item.get("url", ""),
                image_url=item.get("url", ""),
                thumb_url=proxied or item.get("thumbnail", ""),
                license=licence,
                author=item.get("creator", ""),
                tags=tags[:16],
                width=item.get("width", 0) or 0,
                height=item.get("height", 0) or 0,
                extra={"download_url": proxied, "provider": item.get("provider", "")},
            ))
        return results
