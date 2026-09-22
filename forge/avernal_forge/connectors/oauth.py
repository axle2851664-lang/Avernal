"""The OAuth dance for connectors that need a signed-in account.

This runs from the command line rather than the studio, because the flow needs
two things a web form cannot give it: a browser to show the provider's consent
screen, and a local port to catch the redirect. `run.py connectors --login`
drives it.

Only the refresh token is kept. Access tokens are short-lived and are fetched
as needed, held in memory, and never written to disk.
"""

from __future__ import annotations

import secrets
import threading
import urllib.parse
import webbrowser
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

from .net import NetworkGate

#: How long to wait for someone to finish clicking through the consent screen.
CONSENT_TIMEOUT = 300.0

DONE_PAGE = b"""<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Avernal Forge</title><style>
body{background:#0b0b0b;color:#f5f5f5;font-family:system-ui,sans-serif;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
div{text-align:center}h1{color:#d62828;font-size:20px;margin:0 0 8px}
p{color:#9a9a9a;font-size:14px;margin:0}</style></head>
<body><div><h1>Connected</h1>
<p>You can close this tab and go back to the terminal.</p></div></body></html>"""

FAILED_PAGE = b"""<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Avernal Forge</title><style>
body{background:#0b0b0b;color:#f5f5f5;font-family:system-ui,sans-serif;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
div{text-align:center}h1{color:#d62828;font-size:20px;margin:0 0 8px}
p{color:#9a9a9a;font-size:14px;margin:0}</style></head>
<body><div><h1>Not connected</h1>
<p>The provider reported a problem. The terminal has the details.</p>
</div></body></html>"""


class OAuthError(RuntimeError):
    """Raised with a message meant to be read by a person."""


@dataclass
class OAuthEndpoints:
    auth_url: str
    token_url: str
    scopes: tuple[str, ...]


class _RedirectHandler(BaseHTTPRequestHandler):
    def log_message(self, *args: Any) -> None:
        return                       # the CLI prints its own progress

    def do_GET(self) -> None:  # noqa: N802
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        self.server.result = {           # type: ignore[attr-defined]
            "code": (query.get("code") or [""])[0],
            "state": (query.get("state") or [""])[0],
            "error": (query.get("error") or [""])[0],
        }
        body = FAILED_PAGE if self.server.result["error"] else DONE_PAGE  # type: ignore[attr-defined]
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def authorise(
    endpoints: OAuthEndpoints,
    client_id: str,
    client_secret: str,
    gate: NetworkGate,
    connector: str = "oauth",
    open_browser: bool = True,
    on_event: Any = None,
) -> dict[str, Any]:
    """Run the loopback flow and return the provider's token response."""
    notify = on_event or (lambda kind, payload: None)
    if not client_id or not client_secret:
        raise OAuthError("a client id and client secret are required")

    # Port 0 lets the OS choose; desktop OAuth clients may use any loopback port.
    server = HTTPServer(("127.0.0.1", 0), _RedirectHandler)
    server.result = None                 # type: ignore[attr-defined]
    redirect_uri = f"http://127.0.0.1:{server.server_address[1]}/"
    state = secrets.token_urlsafe(24)

    consent = endpoints.auth_url + "?" + urllib.parse.urlencode({
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(endpoints.scopes),
        "access_type": "offline",
        "prompt": "consent",             # force a refresh token every time
        "state": state,
    })

    notify("consent", {"url": consent, "redirect_uri": redirect_uri})
    thread = threading.Thread(target=server.handle_request, daemon=True)
    thread.start()
    if open_browser:
        try:
            webbrowser.open(consent)
        except Exception:
            pass                          # the CLI prints the URL regardless

    thread.join(timeout=CONSENT_TIMEOUT)
    server.server_close()
    result = getattr(server, "result", None)

    if result is None:
        raise OAuthError(
            "timed out waiting for the browser to come back. Re-run the command, "
            "and open the printed URL yourself if it did not open."
        )
    if result["error"]:
        raise OAuthError(f"the provider refused: {result['error']}")
    if result["state"] != state:
        # A mismatched state means the redirect did not come from the request
        # we made, so the code is not ours to use.
        raise OAuthError("the redirect did not match this request; nothing was saved")
    if not result["code"]:
        raise OAuthError("no authorisation code came back")

    notify("exchange", {})
    payload = gate.request(
        endpoints.token_url,
        connector=connector,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data=urllib.parse.urlencode({
            "code": result["code"],
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        }).encode(),
        timeout=30.0,
    ).json()

    if not payload.get("refresh_token"):
        raise OAuthError(
            "the provider returned no refresh token. Revoke Forge's access in "
            "your account settings and try again, so the consent screen is "
            "shown afresh."
        )
    return payload


def refresh_access_token(
    endpoints: OAuthEndpoints,
    client_id: str,
    client_secret: str,
    refresh_token: str,
    gate: NetworkGate,
    connector: str = "oauth",
) -> tuple[str, float]:
    """Trade the stored refresh token for a short-lived access token."""
    payload = gate.request(
        endpoints.token_url,
        connector=connector,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data=urllib.parse.urlencode({
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        }).encode(),
        timeout=30.0,
    ).json()

    token = payload.get("access_token", "")
    if not token:
        raise OAuthError(
            "could not refresh access. The saved token may have been revoked - "
            "run the login command again."
        )
    return token, float(payload.get("expires_in", 3600))
