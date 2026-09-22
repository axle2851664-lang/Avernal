"""Gmail, read-only, through the official API.

This exists to pull image and video attachments out of your own mailbox and
use them as reference material - a photo someone sent you, a scan, a mockup.

It is the most privacy-significant connector in Forge, so it is deliberately
narrow:

* the scope requested is `gmail.readonly` - Forge cannot send, delete or alter
  anything;
* searches are constrained to messages with attachments;
* only the filename, sender, subject and date of a matching message are read
  into a reference - message bodies are never stored;
* an attachment is downloaded only when you explicitly attach that reference;
* nothing is uploaded anywhere: attachments are copied to your own disk.

Signing in happens at the command line, not in the studio, because OAuth needs
a browser and a local port:

    python3 run.py connectors --login gmail
"""

from __future__ import annotations

import base64
import threading
import time
import urllib.parse
from typing import Any

from .base import Connector, CredentialField, Reference
from .net import NetworkGate, build_query
from .oauth import OAuthEndpoints, refresh_access_token

API_BASE = "https://gmail.googleapis.com"

ENDPOINTS = OAuthEndpoints(
    auth_url="https://accounts.google.com/o/oauth2/v2/auth",
    token_url="https://oauth2.googleapis.com/token",
    #: Read-only. Forge has no reason to want more and does not ask for it.
    scopes=("https://www.googleapis.com/auth/gmail.readonly",),
)

#: Attachment types worth offering as reference material.
USABLE_PREFIXES = ("image/", "video/")


class GmailConnector(Connector):
    id = "gmail"
    label = "Gmail (your own attachments)"
    description = (
        "Finds image and video attachments in your own mailbox and uses them "
        "as references. Read-only, and attachments are downloaded only when "
        "you attach one."
    )
    domains = ("googleapis.com", "google.com", "accounts.google.com")
    docs_url = "https://console.cloud.google.com/apis/credentials"
    note = (
        "Sign in from the terminal: python3 run.py connectors --login gmail. "
        "Read-only access; message bodies are never stored."
    )
    credential_fields = (
        CredentialField("client_id", "OAuth client ID", secret=True, required=True,
                        placeholder="from a Desktop app OAuth client"),
        CredentialField("client_secret", "OAuth client secret", secret=True,
                        required=True),
        CredentialField("refresh_token", "Refresh token", secret=True, required=True,
                        placeholder="set by --login gmail"),
    )
    provides_text = True

    def __init__(self, config: Any) -> None:
        super().__init__(config)
        self._lock = threading.Lock()
        self._access_token = ""
        self._expires_at = 0.0

    # -------------------------------------------------------------- auth

    def endpoints(self) -> OAuthEndpoints:
        return ENDPOINTS

    def base(self) -> str:
        return self.base_url(API_BASE)

    def _token(self, gate: NetworkGate, credentials: dict[str, str]) -> str:
        with self._lock:
            if self._access_token and time.time() < self._expires_at - 60:
                return self._access_token

        token, lifetime = refresh_access_token(
            self.endpoints(),
            credentials.get("client_id", ""),
            credentials.get("client_secret", ""),
            credentials.get("refresh_token", ""),
            gate,
            connector=self.id,
        )
        with self._lock:
            self._access_token = token
            self._expires_at = time.time() + lifetime
        return token

    def _headers(self, gate: NetworkGate, credentials: dict[str, str]) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token(gate, credentials)}"}

    # ------------------------------------------------------------ parsing

    @staticmethod
    def _header(payload: dict[str, Any], name: str) -> str:
        for header in payload.get("headers") or []:
            if str(header.get("name", "")).lower() == name.lower():
                return str(header.get("value", ""))
        return ""

    @classmethod
    def _attachments(cls, part: dict[str, Any]) -> list[dict[str, Any]]:
        """Walk the MIME tree; attachments can sit at any depth."""
        found: list[dict[str, Any]] = []
        mime = str(part.get("mimeType", ""))
        body = part.get("body") or {}
        filename = str(part.get("filename", ""))

        if filename and body.get("attachmentId") and mime.startswith(USABLE_PREFIXES):
            found.append({
                "filename": filename,
                "mime": mime,
                "attachment_id": body["attachmentId"],
                "size": int(body.get("size") or 0),
            })
        for child in part.get("parts") or []:
            found.extend(cls._attachments(child))
        return found

    # ---------------------------------------------------------- searching

    def search(self, query, gate: NetworkGate, credentials, limit: int = 12):
        headers = self._headers(gate, credentials)
        base = self.base()

        # The point of this connector is attachments, so the search is scoped
        # to them rather than reading through the whole mailbox.
        terms = (query or "").strip()
        if "has:attachment" not in terms:
            terms = f"{terms} has:attachment".strip()

        listing = gate.json(
            build_query(f"{base}/gmail/v1/users/me/messages", {
                "q": terms,
                "maxResults": max(1, min(limit, 25)),
            }),
            connector=self.id,
            headers=headers,
        )

        results: list[Reference] = []
        for stub in listing.get("messages") or []:
            message_id = stub.get("id")
            if not message_id:
                continue
            message = gate.json(
                build_query(f"{base}/gmail/v1/users/me/messages/{message_id}",
                            {"format": "full"}),
                connector=self.id,
                headers=headers,
            )
            payload = message.get("payload") or {}
            subject = self._header(payload, "Subject") or "(no subject)"
            sender = self._header(payload, "From")

            for attachment in self._attachments(payload):
                results.append(Reference(
                    id=f"gmail:{message_id}:{attachment['attachment_id']}",
                    source=self.id,
                    title=attachment["filename"] or subject,
                    # The subject and snippet are context, not content: the
                    # message body itself is never read into a reference.
                    summary=self._clean(subject, 300),
                    page_url=f"https://mail.google.com/mail/u/0/#all/{message_id}",
                    image_url="",        # bytes come from the API, not a URL
                    thumb_url="",
                    license="your own mail; the sender holds any rights",
                    author=self._clean(sender, 200),
                    kind="video" if attachment["mime"].startswith("video/") else "image",
                    extra={
                        "message_id": message_id,
                        "attachment_id": attachment["attachment_id"],
                        "filename": attachment["filename"],
                        "mime": attachment["mime"],
                        "size": attachment["size"],
                    },
                ))
                if len(results) >= limit:
                    return results
        return results

    # -------------------------------------------------------- downloading

    def download(self, reference: Reference, gate: NetworkGate, credentials):
        message_id = reference.extra.get("message_id")
        attachment_id = reference.extra.get("attachment_id")
        if not message_id or not attachment_id:
            return None

        payload = gate.json(
            f"{self.base()}/gmail/v1/users/me/messages/"
            f"{urllib.parse.quote(str(message_id))}/attachments/"
            f"{urllib.parse.quote(str(attachment_id))}",
            connector=self.id,
            headers=self._headers(gate, credentials),
            max_bytes=96 * 1024 * 1024,
        )
        data = payload.get("data") or ""
        if not data:
            raise RuntimeError("that attachment came back empty")
        # Gmail uses base64url, and omits the padding.
        padded = data + "=" * (-len(data) % 4)
        raw = base64.urlsafe_b64decode(padded.encode())
        return raw, str(reference.extra.get("mime") or "application/octet-stream")

    def probe(self, gate: NetworkGate, credentials) -> str:
        profile = gate.json(
            f"{self.base()}/gmail/v1/users/me/profile",
            connector=self.id,
            headers=self._headers(gate, credentials),
        )
        address = profile.get("emailAddress", "")
        return f"ok (signed in as {address})" if address else "ok"
