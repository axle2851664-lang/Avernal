"""Just enough HTML handling for attribution strings and page previews."""

from __future__ import annotations

import html
import re
from html.parser import HTMLParser

_TAG = re.compile(r"<[^>]+>")


def strip_tags(value: str | None, limit: int = 300) -> str:
    """Wiki attribution fields arrive as HTML snippets; flatten them."""
    if not value:
        return ""
    text = _TAG.sub(" ", str(value))
    return " ".join(html.unescape(text).split())[:limit]


class MetaParser(HTMLParser):
    """Collects OpenGraph / Twitter-card metadata and the document title."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.title = ""
        self.canonical = ""
        self.images: list[str] = []
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {key.lower(): (value or "") for key, value in attrs}
        if tag == "title":
            self._in_title = True
        elif tag == "meta":
            name = (values.get("property") or values.get("name") or "").lower()
            content = values.get("content", "").strip()
            if name and content and name not in self.meta:
                self.meta[name] = content
            if name in ("og:image", "og:image:url", "twitter:image") and content:
                if content not in self.images:
                    self.images.append(content)
        elif tag == "link":
            if "canonical" in values.get("rel", "").lower():
                self.canonical = values.get("href", "").strip()
        elif tag == "img" and len(self.images) < 12:
            src = values.get("src", "").strip()
            if src.startswith(("http://", "https://")) and src not in self.images:
                self.images.append(src)

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._in_title and len(self.title) < 300:
            self.title += data

    def best_title(self) -> str:
        for key in ("og:title", "twitter:title"):
            if self.meta.get(key):
                return " ".join(self.meta[key].split())
        return " ".join(self.title.split())

    def best_description(self) -> str:
        for key in ("og:description", "twitter:description", "description"):
            if self.meta.get(key):
                return " ".join(self.meta[key].split())
        return ""

    def best_image(self) -> str:
        return self.images[0] if self.images else ""
