"""Reddit, through the official OAuth API.

Create an app at https://www.reddit.com/prefs/apps of type "script" or "web
app", then paste its client id and secret. Forge uses the application-only
(client credentials) grant, so it reads public listings and never acts as you.
"""

from __future__ import annotations

import base64
import html
import threading
import time
import urllib.parse

from .base import Connector, CredentialField, Reference
from .net import NetworkGate, build_query

TOKEN_URL = "https://www.reddit.com/api/v1/access_token"


class RedditConnector(Connector):
    id = "reddit"
    label = "Reddit"
    description = (
        "Search public posts and pull their images. Uses Reddit's official "
        "OAuth API with your own app credentials."
    )
    domains = ("reddit.com", "redd.it", "redditmedia.com", "redditstatic.com")
    docs_url = "https://www.reddit.com/prefs/apps"
    credential_fields = (
        CredentialField("client_id", "Client ID", secret=True, required=True),
        CredentialField("client_secret", "Client secret", secret=True, required=True),
        CredentialField("subreddit", "Limit to subreddit (optional)", secret=False,
                        required=False, placeholder="e.g. EarthPorn"),
    )

    def __init__(self, config) -> None:
        super().__init__(config)
        self._lock = threading.Lock()
        self._token = ""
        self._token_expires = 0.0

    def _access_token(self, gate: NetworkGate, credentials: dict[str, str]) -> str:
        with self._lock:
            if self._token and time.time() < self._token_expires - 60:
                return self._token

        pair = f"{credentials.get('client_id', '')}:{credentials.get('client_secret', '')}"
        basic = base64.b64encode(pair.encode()).decode()
        payload = gate.request(
            self.base_url(TOKEN_URL, key="token"),
            connector=self.id,
            method="POST",
            headers={
                "Authorization": f"Basic {basic}",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            data=urllib.parse.urlencode({"grant_type": "client_credentials"}).encode(),
            timeout=15.0,
        ).json()

        token = payload.get("access_token", "")
        if not token:
            raise RuntimeError(
                "Reddit did not return an access token. Check the client id and "
                "secret, and that the app type is 'script' or 'web app'."
            )
        with self._lock:
            self._token = token
            self._token_expires = time.time() + float(payload.get("expires_in", 3600))
        return token

    def search(self, query, gate: NetworkGate, credentials, limit: int = 12):
        token = self._access_token(gate, credentials)
        subreddit = (credentials.get("subreddit") or "").strip().strip("/")
        if subreddit.lower().startswith("r/"):
            subreddit = subreddit[2:]

        api = self.base_url("https://oauth.reddit.com")
        path = f"/r/{urllib.parse.quote(subreddit)}/search" if subreddit else "/search"
        params = {
            "q": query, "limit": max(1, min(limit, 50)), "type": "link",
            "sort": "relevance", "raw_json": "1",
        }
        if subreddit:
            params["restrict_sr"] = "1"

        payload = gate.json(
            build_query(api + path, params),
            connector=self.id,
            headers={"Authorization": f"Bearer {token}"},
        )

        results: list[Reference] = []
        for child in payload.get("data", {}).get("children", []):
            post = child.get("data") or {}
            image, width, height = self._best_image(post)
            clip, thumb = self._best_video(post)
            results.append(Reference(
                id=f"reddit:{post.get('id', '')}",
                source=self.id,
                title=self._clean(post.get("title"), 300),
                summary=self._clean(post.get("selftext"), 600),
                page_url="https://www.reddit.com" + post.get("permalink", ""),
                image_url=clip or image,
                thumb_url=thumb or image,
                kind="video" if clip else "image",
                license="posted by the author; check before reusing",
                author="u/" + str(post.get("author", "")),
                tags=[str(post.get("subreddit", ""))] if post.get("subreddit") else [],
                width=width,
                height=height,
                extra={"score": post.get("score", 0), "nsfw": bool(post.get("over_18"))},
            ))
        return results

    @staticmethod
    def _best_video(post: dict) -> tuple[str, str]:
        """Reddit-hosted video, when it offers a plain MP4 fallback.

        The fallback stream is video-only (Reddit serves audio separately via
        DASH), which is fine for reference material.
        """
        media = post.get("media") or post.get("secure_media") or {}
        video = (media or {}).get("reddit_video") or {}
        url = html.unescape(video.get("fallback_url", "") or "")
        if not url:
            return "", ""
        thumbnail = post.get("thumbnail", "")
        if not thumbnail.startswith("http"):
            thumbnail = ""
        return url.split("?")[0], thumbnail

    @staticmethod
    def _best_image(post: dict) -> tuple[str, int, int]:
        preview = (post.get("preview") or {}).get("images") or []
        if preview:
            source = preview[0].get("source") or {}
            url = html.unescape(source.get("url", ""))
            if url:
                return url, source.get("width", 0), source.get("height", 0)
        url = post.get("url_overridden_by_dest") or post.get("url") or ""
        if url.lower().endswith((".jpg", ".jpeg", ".png", ".webp", ".gif")):
            return url, 0, 0
        return "", 0, 0
