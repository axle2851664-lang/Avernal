"""Import a reference from any page the user pastes.

This is the general answer to "can it pull from site X". The user supplies the
URL, so the request is theirs rather than something Forge went looking for -
but it still only happens when robots.txt permits it, and it is still logged.

Sites that disallow automated access in robots.txt are refused, and the app
says which site refused and why. Zillow is one of them: it disallows crawling
of listing pages and has no public listings API, so licensed MLS/RESO access
(see `reso.py`) is the route that actually exists.
"""

from __future__ import annotations

import urllib.parse
import urllib.robotparser

from .base import Connector, Reference
from .htmlmeta import MetaParser
from .net import USER_AGENT, NetworkBlocked, NetworkError, NetworkGate

HTML_MAX_BYTES = 3 * 1024 * 1024


class RobotsDisallowed(NetworkBlocked):
    """The target site asks automated clients not to fetch this path."""


class WebPageConnector(Connector):
    id = "webpage"
    label = "Web page (paste a URL)"
    description = (
        "Pull the title, description and preview image from any page you paste. "
        "Honours robots.txt, so sites that disallow automated access are skipped."
    )
    domains = ()          # user-directed: the pasted host is the target
    docs_url = "https://www.rfc-editor.org/rfc/rfc9309.html"
    provides_text = True
    note = (
        "Works only where the site permits automated access. Zillow, Pinterest "
        "and Instagram disallow it in robots.txt - use their official APIs instead."
    )

    # ---------------------------------------------------------------- robots

    def robots_allows(self, gate: NetworkGate, url: str) -> tuple[bool, str]:
        parts = urllib.parse.urlsplit(url)
        robots_url = f"{parts.scheme}://{parts.netloc}/robots.txt"
        try:
            response = gate.request(
                robots_url, connector=self.id, user_directed=True,
                max_bytes=512 * 1024, timeout=8.0, allow_error_status=True,
            )
        except NetworkError:
            return True, "robots.txt unreachable; treated as allowed"

        # RFC 9309: 4xx means unrestricted, 5xx means assume disallowed, and a
        # 401/403 on robots.txt itself means the site is gating automation.
        if response.status in (401, 403):
            return False, f"robots.txt returned {response.status} (access restricted)"
        if 500 <= response.status < 600:
            return False, f"robots.txt returned {response.status}; assuming disallowed"
        if response.status >= 400:
            return True, "no robots.txt; treated as allowed"

        parser = urllib.robotparser.RobotFileParser()
        parser.parse(response.text(512 * 1024).splitlines())
        if parser.can_fetch(USER_AGENT, url) or parser.can_fetch("*", url):
            return True, "allowed by robots.txt"
        return False, f"{parts.netloc} disallows automated access to this path"

    # ---------------------------------------------------------------- import

    def import_url(self, url: str, gate: NetworkGate) -> Reference:
        url = (url or "").strip()
        if not url.startswith(("http://", "https://")):
            url = "https://" + url.lstrip("/")

        allowed, reason = self.robots_allows(gate, url)
        if not allowed:
            raise RobotsDisallowed(
                f"{reason}. Forge will not fetch pages a site asks automated "
                "clients to leave alone."
            )

        response = gate.request(
            url, connector=self.id, user_directed=True,
            max_bytes=HTML_MAX_BYTES, timeout=20.0,
            headers={"Accept": "text/html,application/xhtml+xml"},
        )
        parser = MetaParser()
        try:
            parser.feed(response.text(HTML_MAX_BYTES))
        except Exception:
            pass                                   # malformed HTML is still usable

        final = response.url or url
        image = parser.best_image()
        if image:
            image = urllib.parse.urljoin(final, image)

        host = urllib.parse.urlsplit(final).netloc
        return Reference(
            id=f"webpage:{abs(hash(final)) & 0xFFFFFFFF:08x}",
            source=self.id,
            title=parser.best_title() or host,
            summary=self._clean(parser.best_description(), 800),
            page_url=parser.canonical or final,
            image_url=image,
            thumb_url=image,
            license="unknown - check the source before reusing",
            author=parser.meta.get("og:site_name", "") or host,
            extra={"host": host, "robots": reason},
        )

    def search(self, query, gate: NetworkGate, credentials, limit: int = 12):
        """`query` is the URL here - this connector imports rather than searches."""
        return [self.import_url(query, gate)]

    def probe(self, gate: NetworkGate, credentials) -> str:
        return "ready (paste a URL to import)"
