"""Point Forge at a JSON API it has never heard of.

Every other connector knows one service's response shape. This one is told
the shape instead: a base URL, a search path, an optional auth header, and
where in the response the useful fields live. That makes it the way to
connect an in-house service - Helix, an asset library, a DAM - without
waiting for a bespoke connector.

Where a field mapping is left blank, the common names are tried, so many APIs
work with nothing but a URL.
"""

from __future__ import annotations

import re
import urllib.parse
from typing import Any

from .base import Connector, CredentialField, Reference
from .net import NetworkGate

#: Field names worth trying when no explicit mapping was given.
GUESSES: dict[str, tuple[str, ...]] = {
    "title": ("title", "name", "label", "headline", "caption", "filename"),
    "summary": ("description", "summary", "text", "snippet", "abstract", "body"),
    "image": ("image_url", "imageUrl", "image", "url", "src", "media_url",
              "file", "asset_url", "download_url", "original"),
    "thumb": ("thumbnail", "thumb", "thumb_url", "thumbnailUrl", "preview",
              "preview_url", "small"),
    "page": ("page_url", "permalink", "link", "href", "web_url", "detail_url"),
    "author": ("author", "creator", "owner", "user", "uploader", "by"),
    "license": ("license", "licence", "rights", "usage"),
}

#: Keys that commonly hold the list of results.
LIST_KEYS = ("results", "items", "data", "hits", "records", "objects",
             "assets", "entries", "docs", "content")

_HOST = re.compile(r"^[a-z0-9.-]+$")


def dig(value: Any, path: str) -> Any:
    """Follow a dotted path, tolerating numeric indices and missing keys."""
    if not path:
        return None
    current = value
    for part in path.split("."):
        if isinstance(current, dict):
            current = current.get(part)
        elif isinstance(current, list) and part.isdigit():
            index = int(part)
            current = current[index] if index < len(current) else None
        else:
            return None
        if current is None:
            return None
    return current


def first_present(item: dict[str, Any], explicit: str, kind: str) -> str:
    """An explicit mapping wins; otherwise try the usual names."""
    if explicit:
        found = dig(item, explicit)
        return "" if found is None else str(found)
    for candidate in GUESSES.get(kind, ()):
        found = item.get(candidate)
        if isinstance(found, (str, int, float)) and str(found).strip():
            return str(found)
        # One level down covers shapes like {"image": {"url": ...}}.
        if isinstance(found, dict):
            for inner in ("url", "href", "src"):
                if isinstance(found.get(inner), str):
                    return found[inner]
    return ""


def _qualifies(value: Any) -> bool:
    """A list of objects, or an empty list, is a plausible result set."""
    return isinstance(value, list) and (not value or isinstance(value[0], dict))


def find_results(payload: Any, depth: int = 0) -> list[dict[str, Any]] | None:
    """Locate the list of records without being told where it is.

    Returns None when no list was found anywhere, which is different from
    finding an empty one: the first means the mapping is wrong and the caller
    should say so, the second means the search simply matched nothing.
    """
    if _qualifies(payload):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict) or depth > 4:
        return None

    # The usual names first, then anything else, so a conventional response is
    # read the conventional way.
    for key in LIST_KEYS:
        if key in payload:
            found = find_results(payload[key], depth + 1)
            if found is not None:
                return found
    for key, value in payload.items():
        if key in LIST_KEYS:
            continue
        found = find_results(value, depth + 1)
        if found is not None:
            return found
    return None


class CustomApiConnector(Connector):
    id = "custom"
    label = "Custom API"
    description = (
        "Point Forge at your own JSON API. Give it a URL and, if the field "
        "names are unusual, say where the title and image live."
    )
    domains = ()
    docs_url = ""
    note = (
        "Use {query} and {limit} in the search path as placeholders. Leave the "
        "field mappings blank first - the common names are tried automatically."
    )
    credential_fields = (
        CredentialField("service_name", "Name to show", secret=False,
                        required=False, placeholder="Helix"),
        CredentialField("base_url", "Base URL", secret=False, required=True,
                        placeholder="https://helix.example.com"),
        CredentialField("search_path", "Search path", secret=False, required=True,
                        placeholder="/api/search?q={query}&limit={limit}"),
        CredentialField("auth_header_name", "Auth header name", secret=False,
                        required=False, placeholder="Authorization"),
        CredentialField("auth_header_value", "Auth header value", secret=True,
                        required=False, placeholder="Bearer ..."),
        CredentialField("results_path", "Path to results", secret=False,
                        required=False, placeholder="data.items"),
        CredentialField("title_field", "Title field", secret=False, required=False),
        CredentialField("image_field", "Image URL field", secret=False,
                        required=False),
        CredentialField("thumb_field", "Thumbnail field", secret=False,
                        required=False),
        CredentialField("page_field", "Link field", secret=False, required=False),
        CredentialField("summary_field", "Description field", secret=False,
                        required=False),
    )
    provides_text = True

    # ------------------------------------------------------------ identity

    def describe(self, credentials: dict[str, str]) -> dict[str, Any]:
        described = super().describe(credentials)
        name = (credentials.get("service_name") or "").strip()
        if name:
            described["label"] = name
            described["description"] = (
                f"Your own {name} API, connected by URL and field mapping."
            )
        return described

    def extra_domains(self, credentials: dict[str, str]) -> tuple[str, ...]:
        base = (credentials.get("base_url") or "").strip()
        if not base:
            return ()
        host = urllib.parse.urlsplit(base).netloc.split(":")[0].lower()
        return (host,) if host and _HOST.match(host) else ()

    # ------------------------------------------------------------ fetching

    def _url(self, credentials: dict[str, str], query: str, limit: int) -> str:
        base = (credentials.get("base_url") or "").strip().rstrip("/")
        path = (credentials.get("search_path") or "").strip()
        if "://" not in base:
            raise RuntimeError(
                "Set the base URL to the full address of your service, "
                "starting with https://"
            )
        if not path.startswith("/"):
            path = "/" + path
        # Substituted rather than formatted, so braces elsewhere in the path
        # (and any stray placeholder) cannot blow up.
        path = path.replace("{query}", urllib.parse.quote(query, safe=""))
        path = path.replace("{limit}", str(limit))
        return base + path

    def search(self, query, gate: NetworkGate, credentials, limit: int = 12):
        headers = {}
        name = (credentials.get("auth_header_name") or "").strip() or "Authorization"
        value = (credentials.get("auth_header_value") or "").strip()
        if value:
            headers[name] = value

        payload = gate.json(
            self._url(credentials, query or "", max(1, min(limit, 50))),
            connector=self.id,
            headers=headers,
        )

        explicit = (credentials.get("results_path") or "").strip()
        if explicit:
            records = dig(payload, explicit)
            if isinstance(records, dict):
                records = find_results(records)
            if not isinstance(records, list):
                raise RuntimeError(
                    f"Nothing list-shaped at {explicit!r} in that response. "
                    "Check 'Path to results' against what your API returns."
                )
        else:
            records = find_results(payload)
            if records is None:
                raise RuntimeError(
                    "Could not find a list of results in that response. Set "
                    "'Path to results' to where the array lives, such as "
                    "data.items."
                )

        service = (credentials.get("service_name") or "Custom API").strip()
        results: list[Reference] = []
        for index, item in enumerate(records[:limit]):
            if not isinstance(item, dict):
                continue
            image = first_present(item, credentials.get("image_field", ""), "image")
            thumb = first_present(item, credentials.get("thumb_field", ""), "thumb")
            identifier = item.get("id") or item.get("uuid") or index
            results.append(Reference(
                id=f"custom:{identifier}",
                source=self.id,
                title=first_present(item, credentials.get("title_field", ""), "title")
                or f"{service} result {index + 1}",
                summary=self._clean(
                    first_present(item, credentials.get("summary_field", ""), "summary"),
                    600),
                page_url=first_present(item, credentials.get("page_field", ""), "page"),
                image_url=image or thumb,
                thumb_url=thumb or image,
                license=first_present(item, "", "license")
                or f"from {service}; check your own terms",
                author=first_present(item, "", "author"),
                kind="video" if str(image).lower().split("?")[0].endswith(
                    (".mp4", ".webm", ".mov")) else "image",
                extra={"service": service},
            ))
        return results

    def probe(self, gate: NetworkGate, credentials) -> str:
        found = self.search("", gate, credentials, limit=1)
        service = (credentials.get("service_name") or "the API").strip()
        return f"ok ({len(found)} result(s) from {service})"
