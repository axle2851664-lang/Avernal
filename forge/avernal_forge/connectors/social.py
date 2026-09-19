"""Mastodon and Bluesky - the two large social networks with open APIs.

Both are included because they can actually be read programmatically without
special approval. Instagram's Basic Display API was retired in 2024 and its
Graph API covers business accounts only; TikTok requires per-app approval; X
charges for API access. None of those can be supported honestly without your
own approved app, so Forge does not pretend to.
"""

from __future__ import annotations

import re
import urllib.parse

from .base import Connector, CredentialField, Reference
from .htmlmeta import strip_tags
from .net import NetworkGate, build_query

_HOST = re.compile(r"^[a-z0-9.-]+$")


def _host_of(value: str, default: str = "") -> str:
    value = (value or "").strip().rstrip("/")
    if not value:
        return default
    if "://" in value:
        value = urllib.parse.urlsplit(value).netloc
    value = value.split("/")[0].lower()
    return value if _HOST.match(value) else default


class MastodonConnector(Connector):
    id = "mastodon"
    label = "Mastodon"
    description = (
        "Reads a public hashtag timeline from any Mastodon instance, including "
        "the images attached to those posts. No account needed on most instances."
    )
    domains = ()
    docs_url = "https://docs.joinmastodon.org/methods/timelines/"
    credential_fields = (
        CredentialField("instance", "Instance host", secret=False, required=True,
                        placeholder="mastodon.social"),
        CredentialField("token", "Access token (optional)", secret=True, required=False,
                        placeholder="only needed for private instances"),
    )

    def extra_domains(self, credentials: dict[str, str]) -> tuple[str, ...]:
        host = _host_of(credentials.get("instance", ""))
        return (host,) if host else ()

    def search(self, query, gate: NetworkGate, credentials, limit: int = 12):
        host = _host_of(credentials.get("instance", ""))
        if not host:
            raise RuntimeError("Set a Mastodon instance host, such as mastodon.social.")

        tag = re.sub(r"[^A-Za-z0-9_]", "", (query or "").replace(" ", ""))
        if not tag:
            raise RuntimeError("Mastodon search needs a hashtag-shaped term.")

        headers = {}
        token = (credentials.get("token") or "").strip()
        if token:
            headers["Authorization"] = f"Bearer {token}"

        base = self.base_url(f"https://{host}")
        payload = gate.json(
            build_query(f"{base}/api/v1/timelines/tag/{urllib.parse.quote(tag)}",
                        {"limit": max(1, min(limit, 40)), "only_media": "true"}),
            connector=self.id,
            headers=headers,
        )

        results: list[Reference] = []
        for status in payload if isinstance(payload, list) else []:
            media = [m for m in (status.get("media_attachments") or [])
                     if m.get("type") in ("image", "gifv")]
            if not media:
                continue
            first = media[0]
            original = (first.get("meta") or {}).get("original") or {}
            account = status.get("account") or {}
            results.append(Reference(
                id=f"mastodon:{status.get('id', '')}",
                source=self.id,
                title=strip_tags(status.get("content"), 200) or f"#{tag}",
                summary=strip_tags(status.get("content"), 600),
                page_url=status.get("url", ""),
                image_url=first.get("url", ""),
                thumb_url=first.get("preview_url", "") or first.get("url", ""),
                license="posted by the author; check before reusing",
                author="@" + str(account.get("acct", "")),
                tags=[t.get("name", "") for t in (status.get("tags") or [])][:10],
                width=int(original.get("width") or 0),
                height=int(original.get("height") or 0),
                extra={"instance": host, "alt": first.get("description") or ""},
            ))
        return results


class BlueskyConnector(Connector):
    id = "bluesky"
    label = "Bluesky"
    description = (
        "Searches public posts on Bluesky and pulls their images. Sign in with "
        "an app password, not your account password."
    )
    domains = ("bsky.social", "bsky.app", "bsky.network")
    docs_url = "https://bsky.app/settings/app-passwords"
    credential_fields = (
        CredentialField("identifier", "Handle", secret=False, required=True,
                        placeholder="you.bsky.social"),
        CredentialField("app_password", "App password", secret=True, required=True,
                        placeholder="xxxx-xxxx-xxxx-xxxx"),
    )

    def __init__(self, config) -> None:
        super().__init__(config)
        self._jwt = ""

    def _session(self, gate: NetworkGate, credentials: dict[str, str]) -> str:
        if self._jwt:
            return self._jwt
        import json as _json

        base = self.base_url("https://bsky.social")
        payload = gate.request(
            f"{base}/xrpc/com.atproto.server.createSession",
            connector=self.id,
            method="POST",
            headers={"Content-Type": "application/json"},
            data=_json.dumps({
                "identifier": credentials.get("identifier", ""),
                "password": credentials.get("app_password", ""),
            }).encode(),
        ).json()
        self._jwt = payload.get("accessJwt", "")
        if not self._jwt:
            raise RuntimeError("Bluesky did not return a session; check the app password.")
        return self._jwt

    def search(self, query, gate: NetworkGate, credentials, limit: int = 12):
        jwt = self._session(gate, credentials)
        base = self.base_url("https://bsky.social")
        payload = gate.json(
            build_query(f"{base}/xrpc/app.bsky.feed.searchPosts",
                        {"q": query, "limit": max(1, min(limit, 40))}),
            connector=self.id,
            headers={"Authorization": f"Bearer {jwt}"},
        )

        results: list[Reference] = []
        for post in payload.get("posts", []):
            record = post.get("record") or {}
            author = post.get("author") or {}
            images = ((post.get("embed") or {}).get("images")) or []
            first = images[0] if images else {}
            handle = author.get("handle", "")
            uri = post.get("uri", "")
            rkey = uri.rsplit("/", 1)[-1] if uri else ""
            results.append(Reference(
                id=f"bluesky:{rkey or uri}",
                source=self.id,
                title=self._clean(record.get("text"), 200) or "Post",
                summary=self._clean(record.get("text"), 600),
                page_url=f"https://bsky.app/profile/{handle}/post/{rkey}" if rkey else "",
                image_url=first.get("fullsize", ""),
                thumb_url=first.get("thumb", "") or first.get("fullsize", ""),
                license="posted by the author; check before reusing",
                author="@" + str(handle),
                extra={"alt": first.get("alt", ""), "likes": post.get("likeCount", 0)},
            ))
        return results
