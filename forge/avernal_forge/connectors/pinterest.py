"""Pinterest, through the official v5 API.

An honest limitation up front: Pinterest's public API exposes *your own* pins
and boards, not a site-wide search. Scraping the site to work around that
breaks its terms of service, so Forge does not. Searching here filters the
pins you already saved.

Create an app at https://developers.pinterest.com/apps/ and paste an access
token with the `pins:read` and `boards:read` scopes.
"""

from __future__ import annotations

from .base import Connector, CredentialField, Reference
from .net import NetworkGate, build_query


class PinterestConnector(Connector):
    id = "pinterest"
    label = "Pinterest (your own pins)"
    description = (
        "Reads the pins and boards on your own account through Pinterest's "
        "official API, and filters them by your search terms."
    )
    domains = ("api.pinterest.com", "pinimg.com", "pinterest.com")
    docs_url = "https://developers.pinterest.com/docs/api/v5/"
    note = (
        "Pinterest's API has no site-wide search: only your own pins and boards "
        "are reachable. Scraping the site instead would breach its terms."
    )
    credential_fields = (
        CredentialField("access_token", "Access token", secret=True, required=True,
                        placeholder="needs pins:read"),
        CredentialField("board_id", "Limit to board (optional)", secret=False,
                        required=False),
    )

    def search(self, query, gate: NetworkGate, credentials, limit: int = 12):
        token = credentials.get("access_token", "")
        base = self.base_url("https://api.pinterest.com")
        board = (credentials.get("board_id") or "").strip()
        path = f"/v5/boards/{board}/pins" if board else "/v5/pins"

        payload = gate.json(
            build_query(base + path, {"page_size": max(1, min(limit * 4, 100))}),
            connector=self.id,
            headers={"Authorization": f"Bearer {token}"},
        )

        needles = [word for word in (query or "").lower().split() if word]
        results: list[Reference] = []
        for pin in payload.get("items", []):
            title = pin.get("title") or pin.get("alt_text") or ""
            description = pin.get("description") or ""
            haystack = f"{title} {description}".lower()
            if needles and not any(word in haystack for word in needles):
                continue

            image, width, height = self._best_image(pin)
            results.append(Reference(
                id=f"pinterest:{pin.get('id', '')}",
                source=self.id,
                title=self._clean(title, 300) or "Pin",
                summary=self._clean(description, 600),
                page_url=f"https://www.pinterest.com/pin/{pin.get('id', '')}/",
                image_url=image,
                thumb_url=image,
                license="your saved pin; original rights belong to its creator",
                author=pin.get("board_owner", {}).get("username", "") if isinstance(
                    pin.get("board_owner"), dict) else "",
                width=width,
                height=height,
                extra={"board_id": pin.get("board_id", ""), "link": pin.get("link", "")},
            ))
            if len(results) >= limit:
                break
        return results

    @staticmethod
    def _best_image(pin: dict) -> tuple[str, int, int]:
        images = ((pin.get("media") or {}).get("images") or {})
        if not isinstance(images, dict):
            return "", 0, 0
        # Pick the widest variant Pinterest offered for this pin.
        best, best_width = None, -1
        for variant in images.values():
            if isinstance(variant, dict) and variant.get("url"):
                width = int(variant.get("width") or 0)
                if width > best_width:
                    best, best_width = variant, width
        if not best:
            return "", 0, 0
        return best.get("url", ""), int(best.get("width") or 0), int(best.get("height") or 0)

    def probe(self, gate: NetworkGate, credentials) -> str:
        found = self.search("", gate, credentials, limit=1)
        return f"ok ({len(found)} pin(s) visible)"
