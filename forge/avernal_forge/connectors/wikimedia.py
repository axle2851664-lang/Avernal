"""Wikipedia and Wikimedia Commons.

Both run the MediaWiki API, which is open, documented and needs no key. Commons
in particular is a very large library of freely licensed images, and every
result carries its licence and attribution.
"""

from __future__ import annotations

import re

from .base import Connector, CredentialField, Reference
from .htmlmeta import strip_tags
from .net import NetworkGate, build_query

_LANG = re.compile(r"^[a-z]{2,8}(-[a-z0-9]{2,8})*$")


def _language(credentials: dict[str, str]) -> str:
    lang = (credentials.get("language") or "en").strip().lower()
    return lang if _LANG.match(lang) else "en"


class WikipediaConnector(Connector):
    id = "wikipedia"
    label = "Wikipedia"
    description = (
        "Article summaries and lead images. Open API, no account needed - good "
        "for grounding a prompt in what something actually looks like."
    )
    domains = ("wikipedia.org", "wikimedia.org")
    docs_url = "https://www.mediawiki.org/wiki/API:Main_page"
    credential_fields = (
        CredentialField("language", "Language code", secret=False,
                        required=False, placeholder="en"),
    )
    provides_text = True

    def endpoint(self, credentials: dict[str, str]) -> str:
        return self.base_url(f"https://{_language(credentials)}.wikipedia.org/w/api.php")

    def search(self, query, gate: NetworkGate, credentials, limit: int = 12):
        api = self.endpoint(credentials)
        found = gate.json(
            build_query(api, {
                "action": "query", "format": "json", "formatversion": "2",
                "list": "search", "srsearch": query, "srlimit": max(1, min(limit, 30)),
            }),
            connector=self.id,
        )
        pages = [hit["pageid"] for hit in found.get("query", {}).get("search", [])]
        if not pages:
            return []

        detail = gate.json(
            build_query(api, {
                "action": "query", "format": "json", "formatversion": "2",
                "pageids": "|".join(str(p) for p in pages),
                "prop": "extracts|pageimages|info",
                "exintro": "1", "explaintext": "1",
                "piprop": "thumbnail|original", "pithumbsize": "640",
                "inprop": "url",
            }),
            connector=self.id,
        )

        by_id = {page["pageid"]: page for page in detail.get("query", {}).get("pages", [])}
        results: list[Reference] = []
        for page_id in pages:                      # preserve relevance order
            page = by_id.get(page_id)
            if not page:
                continue
            thumb = (page.get("thumbnail") or {}).get("source", "")
            original = (page.get("original") or {}).get("source", "")
            results.append(Reference(
                id=f"wikipedia:{page_id}",
                source=self.id,
                title=page.get("title", ""),
                summary=self._clean(page.get("extract"), 800),
                page_url=page.get("fullurl", ""),
                image_url=original or thumb,
                thumb_url=thumb,
                license="CC BY-SA (article text)" if not thumb else "see file page",
                width=(page.get("original") or {}).get("width", 0),
                height=(page.get("original") or {}).get("height", 0),
                extra={"pageid": page_id, "language": _language(credentials)},
            ))
        return results


class CommonsConnector(Connector):
    id = "commons"
    label = "Wikimedia Commons"
    description = (
        "Freely licensed photographs and artwork, with attribution attached. "
        "Open API, no account needed."
    )
    domains = ("wikimedia.org",)
    docs_url = "https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia"

    def endpoint(self, credentials: dict[str, str]) -> str:
        return self.base_url("https://commons.wikimedia.org/w/api.php")

    def search(self, query, gate: NetworkGate, credentials, limit: int = 12):
        payload = gate.json(
            build_query(self.endpoint(credentials), {
                "action": "query", "format": "json", "formatversion": "2",
                "generator": "search",
                "gsrsearch": f"filetype:bitmap {query}",
                "gsrnamespace": "6",                # the File: namespace
                "gsrlimit": max(1, min(limit, 30)),
                "prop": "imageinfo",
                "iiprop": "url|size|extmetadata",
                "iiurlwidth": "640",
            }),
            connector=self.id,
        )
        results: list[Reference] = []
        for page in payload.get("query", {}).get("pages", []):
            info = (page.get("imageinfo") or [{}])[0]
            meta = info.get("extmetadata") or {}

            def field(name: str) -> str:
                return strip_tags((meta.get(name) or {}).get("value", ""))

            title = page.get("title", "").removeprefix("File:")
            results.append(Reference(
                id=f"commons:{page.get('pageid')}",
                source=self.id,
                title=title,
                summary=field("ImageDescription")[:600],
                page_url=info.get("descriptionurl", ""),
                image_url=info.get("url", ""),
                thumb_url=info.get("thumburl", "") or info.get("url", ""),
                license=field("LicenseShortName") or field("License"),
                author=field("Artist"),
                width=info.get("width", 0),
                height=info.get("height", 0),
                extra={"credit": field("Credit")},
            ))
        return results
