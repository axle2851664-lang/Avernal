"""The one place in Forge that is allowed to touch the network.

Every connector goes through this gate, which is closed by default. The rules
it enforces are the reason live data can be added to a local-first app without
quietly turning it into a cloud app:

* networking is off until the user turns it on;
* only hosts belonging to an enabled connector can be reached;
* redirects are re-checked, so a 302 cannot walk us off the allowlist;
* private and link-local addresses are refused (no poking at cloud metadata);
* responses are size- and time-capped;
* every attempt is recorded, with credentials redacted, so the user can audit
  exactly what left the machine.

Generation itself never comes through here. Prompts and generated images are
never sent anywhere.
"""

from __future__ import annotations

import ipaddress
import json
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Iterable

from .. import __version__

USER_AGENT = (
    f"AvernalForge/{__version__} (local image studio; "
    "https://github.com/axle2851664-lang/Avernal)"
)

DEFAULT_TIMEOUT = 15.0
DEFAULT_MAX_BYTES = 8 * 1024 * 1024
IMAGE_MAX_BYTES = 24 * 1024 * 1024
MAX_REDIRECTS = 4
AUDIT_LOG_SIZE = 250

#: Query parameters and headers that must never reach the audit log.
SECRET_KEYS = {
    "access_token", "token", "api_key", "apikey", "key", "client_secret",
    "secret", "password", "auth", "signature", "sig", "refresh_token",
}
SECRET_HEADERS = {"authorization", "cookie", "x-api-key", "proxy-authorization"}


class NetworkBlocked(RuntimeError):
    """Raised when a request is refused before it is made."""


class NetworkError(RuntimeError):
    """Raised when a permitted request fails."""


@dataclass
class Response:
    url: str
    status: int
    body: bytes
    headers: dict[str, str] = field(default_factory=dict)

    def json(self) -> Any:
        try:
            return json.loads(self.body.decode("utf-8", "replace"))
        except ValueError as exc:
            raise NetworkError(f"expected JSON from {self.url}: {exc}") from exc

    def text(self, limit: int | None = None) -> str:
        raw = self.body[:limit] if limit else self.body
        return raw.decode("utf-8", "replace")


def redact(url: str) -> str:
    """Strip secrets out of a URL so it is safe to log or show."""
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return "<unparseable url>"
    if not parts.query:
        return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
    pairs = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
    cleaned = [
        (key, "***" if key.lower() in SECRET_KEYS else value) for key, value in pairs
    ]
    return urllib.parse.urlunsplit(
        (parts.scheme, parts.netloc, parts.path,
         urllib.parse.urlencode(cleaned, safe="*"), "")
    )


def host_matches(host: str, domains: Iterable[str]) -> bool:
    """`en.wikipedia.org` matches the domain `wikipedia.org`."""
    host = (host or "").lower().strip(".")
    for domain in domains:
        domain = domain.lower().strip(".")
        if not domain:
            continue
        if host == domain or host.endswith("." + domain):
            return True
    return False


class _GuardedRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Re-runs the allowlist check on every redirect hop."""

    def __init__(self, check) -> None:
        self._check = check

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        self._check(newurl)
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None:
            # Credentials are scoped to the host they were issued for.
            for header in list(new.headers):
                if header.lower() in SECRET_HEADERS:
                    del new.headers[header]
        return new


class NetworkGate:
    def __init__(self, config: Any) -> None:
        self.config = config
        self._lock = threading.Lock()
        self._log: deque[dict[str, Any]] = deque(maxlen=AUDIT_LOG_SIZE)
        self._domains: set[str] = set()

    # ------------------------------------------------------------- policy

    @property
    def online(self) -> bool:
        return bool(getattr(self.config, "online", False))

    def set_allowed_domains(self, domains: Iterable[str]) -> None:
        with self._lock:
            self._domains = {d.lower().strip(".") for d in domains if d}

    @property
    def allowed_domains(self) -> list[str]:
        with self._lock:
            return sorted(self._domains)

    def _allow_private(self) -> bool:
        return bool(getattr(self.config, "allow_private_hosts", False))

    def check_address(self, host: str) -> None:
        """Refuse loopback, private and link-local targets (SSRF guard)."""
        if self._allow_private():
            return
        try:
            infos = socket.getaddrinfo(host, None)
        except socket.gaierror as exc:
            raise NetworkError(f"could not resolve {host}: {exc}") from exc
        for info in infos:
            address = info[4][0]
            try:
                parsed = ipaddress.ip_address(address)
            except ValueError:
                continue
            if (parsed.is_private or parsed.is_loopback or parsed.is_link_local
                    or parsed.is_reserved or parsed.is_multicast):
                raise NetworkBlocked(
                    f"{host} resolves to the non-public address {address}; refused."
                )

    def check_url(self, url: str, user_directed: bool = False) -> urllib.parse.SplitResult:
        if not self.online:
            raise NetworkBlocked(
                "Networking is off. Enable it in the studio, or start Forge with "
                "--online, to let connectors fetch live data."
            )
        try:
            parts = urllib.parse.urlsplit(url)
        except ValueError as exc:
            raise NetworkBlocked(f"invalid URL: {exc}") from exc

        local = parts.hostname in ("127.0.0.1", "localhost", "::1")
        if parts.scheme != "https" and not (local and self._allow_private()):
            raise NetworkBlocked(f"only https URLs are allowed (got {parts.scheme!r})")
        if not parts.hostname:
            raise NetworkBlocked("URL has no host")

        # A URL the user explicitly pasted is directed by them, not chosen by a
        # connector, so it is judged on robots.txt rather than the allowlist.
        if not user_directed and not host_matches(parts.hostname, self._domains):
            raise NetworkBlocked(
                f"{parts.hostname} is not on the allowlist. Only hosts belonging to "
                "an enabled connector can be reached."
            )
        self.check_address(parts.hostname)
        return parts

    # ------------------------------------------------------------ audit log

    def record(self, entry: dict[str, Any]) -> None:
        with self._lock:
            self._log.appendleft(entry)

    def audit_log(self, limit: int = 100) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._log)[:limit]

    def clear_log(self) -> None:
        with self._lock:
            self._log.clear()

    # ------------------------------------------------------------- fetching

    def request(
        self,
        url: str,
        *,
        connector: str = "",
        method: str = "GET",
        headers: dict[str, str] | None = None,
        data: bytes | None = None,
        timeout: float = DEFAULT_TIMEOUT,
        max_bytes: int = DEFAULT_MAX_BYTES,
        user_directed: bool = False,
        allow_error_status: bool = False,
    ) -> Response:
        started = time.time()
        safe_url = redact(url)
        entry: dict[str, Any] = {
            "ts": started,
            "connector": connector or "-",
            "method": method,
            "url": safe_url,
            "user_directed": user_directed,
            "status": None,
            "bytes": 0,
            "ms": 0,
            "error": "",
        }
        try:
            self.check_url(url, user_directed=user_directed)
        except (NetworkBlocked, NetworkError) as exc:
            entry["error"] = str(exc)
            entry["status"] = "blocked"
            self.record(entry)
            raise

        merged = {"User-Agent": USER_AGENT, "Accept-Encoding": "identity"}
        merged.update(headers or {})
        request = urllib.request.Request(url, data=data, method=method, headers=merged)

        def guard(next_url: str) -> None:
            self.check_url(next_url, user_directed=user_directed)

        opener = urllib.request.build_opener(_GuardedRedirectHandler(guard))
        try:
            with opener.open(request, timeout=timeout) as response:
                body = response.read(max_bytes + 1)
                if len(body) > max_bytes:
                    raise NetworkError(
                        f"response from {safe_url} exceeded the {max_bytes} byte cap"
                    )
                entry["status"] = response.status
                entry["bytes"] = len(body)
                result = Response(
                    url=response.url,
                    status=response.status,
                    body=body,
                    headers={k.lower(): v for k, v in response.headers.items()},
                )
        except urllib.error.HTTPError as exc:
            entry["status"] = exc.code
            detail = ""
            try:
                detail = exc.read(2048).decode("utf-8", "replace")
            except Exception:
                pass
            entry["error"] = f"HTTP {exc.code}"
            entry["ms"] = int((time.time() - started) * 1000)
            self.record(entry)
            if allow_error_status:
                # Callers that must reason about the status code itself, such
                # as robots.txt handling, ask for the response rather than a raise.
                return Response(url=url, status=exc.code,
                                body=detail.encode("utf-8", "replace"),
                                headers={})
            raise NetworkError(
                f"{safe_url} returned HTTP {exc.code}"
                + (f": {detail[:300]}" if detail else "")
            ) from exc
        except (NetworkBlocked, NetworkError) as exc:
            entry["error"] = str(exc)
            self.record(entry)
            raise
        except Exception as exc:
            entry["error"] = f"{type(exc).__name__}: {exc}"
            self.record(entry)
            raise NetworkError(f"request to {safe_url} failed: {exc}") from exc

        entry["ms"] = int((time.time() - started) * 1000)
        self.record(entry)
        return result

    def json(self, url: str, **kwargs: Any) -> Any:
        headers = dict(kwargs.pop("headers", None) or {})
        headers.setdefault("Accept", "application/json")
        return self.request(url, headers=headers, **kwargs).json()

    def image(self, url: str, **kwargs: Any) -> Response:
        kwargs.setdefault("max_bytes", IMAGE_MAX_BYTES)
        headers = dict(kwargs.pop("headers", None) or {})
        headers.setdefault("Accept", "image/*")
        return self.request(url, headers=headers, **kwargs)


def build_query(base: str, params: dict[str, Any]) -> str:
    clean = {k: v for k, v in params.items() if v is not None and v != ""}
    separator = "&" if "?" in base else "?"
    return f"{base}{separator}{urllib.parse.urlencode(clean)}" if clean else base
