"""What a connector is, and what it hands back."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any

from .net import NetworkGate


@dataclass
class Reference:
    """One piece of live material: an image, an article, a listing, a post."""

    id: str
    source: str
    title: str = ""
    summary: str = ""
    page_url: str = ""
    image_url: str = ""
    thumb_url: str = ""
    license: str = ""
    author: str = ""
    tags: list[str] = field(default_factory=list)
    width: int = 0
    height: int = 0
    #: "image" or "video" - video only when the URL is a file a browser can play.
    kind: str = "image"
    extra: dict[str, Any] = field(default_factory=dict)

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "source": self.source,
            "title": self.title,
            "summary": self.summary,
            "page_url": self.page_url,
            "image_url": self.image_url,
            "thumb_url": self.thumb_url or self.image_url,
            "license": self.license,
            "author": self.author,
            "tags": self.tags,
            "width": self.width,
            "height": self.height,
            "kind": self.kind,
            "is_video": self.kind == "video",
            "extra": self.extra,
        }

    def prompt_terms(self, limit: int = 12) -> list[str]:
        """Words worth pasting into a prompt, in descending usefulness."""
        terms: list[str] = []
        for candidate in [self.title, *self.tags]:
            cleaned = " ".join(str(candidate).split()).strip(" ,.;:")
            if cleaned and cleaned.lower() not in {t.lower() for t in terms}:
                terms.append(cleaned)
            if len(terms) >= limit:
                break
        return terms


@dataclass
class CredentialField:
    name: str
    label: str
    secret: bool = True
    required: bool = True
    placeholder: str = ""


class Connector:
    """Base class. Subclasses map one upstream API onto `Reference`s."""

    id: str = "base"
    label: str = "Connector"
    description: str = ""
    #: Hosts this connector may reach. Added to the gate's allowlist when enabled.
    domains: tuple[str, ...] = ()
    credential_fields: tuple[CredentialField, ...] = ()
    #: Where the user goes to obtain credentials, or to read the access policy.
    docs_url: str = ""
    #: Set when an upstream offers no legitimate public access; shown in the UI.
    note: str = ""
    provides_images: bool = True
    provides_text: bool = False

    def __init__(self, config: Any) -> None:
        self.config = config

    @property
    def needs_credentials(self) -> bool:
        """Optional fields (a language, an optional token) do not count."""
        return any(field.required for field in self.credential_fields)

    def configured(self, credentials: dict[str, str]) -> bool:
        return all(
            credentials.get(field.name)
            for field in self.credential_fields
            if field.required
        )

    def missing_fields(self, credentials: dict[str, str]) -> list[str]:
        return [
            field.name
            for field in self.credential_fields
            if field.required and not credentials.get(field.name)
        ]

    def describe(self, credentials: dict[str, str]) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "description": self.description,
            "domains": list(self.domains),
            "docs_url": self.docs_url,
            "note": self.note,
            "needs_credentials": self.needs_credentials,
            "configured": self.configured(credentials),
            "missing": self.missing_fields(credentials),
            "provides_images": self.provides_images,
            "provides_text": self.provides_text,
            "credential_fields": [
                {
                    "name": f.name,
                    "label": f.label,
                    "secret": f.secret,
                    "required": f.required,
                    "placeholder": f.placeholder,
                }
                for f in self.credential_fields
            ],
        }

    # -- subclass API -------------------------------------------------------

    def search(
        self,
        query: str,
        gate: NetworkGate,
        credentials: dict[str, str],
        limit: int = 12,
    ) -> list[Reference]:
        raise NotImplementedError

    def download(
        self,
        reference: Reference,
        gate: NetworkGate,
        credentials: dict[str, str],
    ) -> tuple[bytes, str] | None:
        """Fetch a reference's bytes when there is no plain URL to GET.

        Mail attachments arrive inside an API response rather than at an
        address, so those connectors override this. Returning None means
        "use the URL", which is what every other connector does.
        """
        return None

    def probe(self, gate: NetworkGate, credentials: dict[str, str]) -> str:
        """A cheap live call used by `run.py connectors --check`."""
        found = self.search("test", gate, credentials, limit=1)
        return f"ok ({len(found)} result(s))"

    # -- helpers for subclasses --------------------------------------------

    def extra_domains(self, credentials: dict[str, str]) -> tuple[str, ...]:
        """Hosts that depend on the user's settings, such as a Mastodon
        instance or an MLS endpoint. Merged into the allowlist when enabled."""
        return ()

    def base_url(self, default: str, key: str = "") -> str:
        """Overridable endpoint - lets tests point at a local stub, and lets
        users aim a connector at their own instance.

        `key` distinguishes connectors that talk to more than one host, such as
        Reddit's separate token and API endpoints.
        """
        suffix = f"{key.upper()}_" if key else ""
        override = os.environ.get(f"AVERNAL_FORGE_{self.id.upper()}_{suffix}BASE")
        return (override or default).rstrip("/")

    @staticmethod
    def _clean(text: Any, limit: int = 600) -> str:
        if not text:
            return ""
        collapsed = " ".join(str(text).split())
        return collapsed[:limit]
