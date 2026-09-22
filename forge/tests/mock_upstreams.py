"""A stand-in for the upstream APIs, serving their real response shapes.

Live calls to Wikipedia, Reddit and the rest cannot run in every environment
(this repo's CI has no egress at all), so the connectors are exercised against
recorded response shapes instead. That covers the parsing and the gating; use
`python3 run.py connectors --check` to verify the live endpoints themselves.
"""

from __future__ import annotations

import json
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

WIKIPEDIA_SEARCH = {
    "query": {"search": [{"pageid": 9202, "title": "Eiffel Tower"},
                         {"pageid": 4321, "title": "Gustave Eiffel"}]}
}
WIKIPEDIA_DETAIL = {
    "query": {"pages": [
        {"pageid": 9202, "title": "Eiffel Tower",
         "extract": "The Eiffel Tower is a wrought-iron lattice tower.",
         "fullurl": "https://en.wikipedia.org/wiki/Eiffel_Tower",
         "thumbnail": {"source": "https://upload.wikimedia.org/thumb.jpg",
                       "width": 640, "height": 960},
         "original": {"source": "https://upload.wikimedia.org/full.jpg",
                      "width": 2000, "height": 3000}},
        {"pageid": 4321, "title": "Gustave Eiffel",
         "extract": "French civil engineer.",
         "fullurl": "https://en.wikipedia.org/wiki/Gustave_Eiffel"},
    ]}
}
COMMONS = {
    "query": {"pages": [{
        "pageid": 55, "title": "File:Red barn.jpg",
        "imageinfo": [{
            "url": "https://upload.wikimedia.org/red-barn.jpg",
            "thumburl": "https://upload.wikimedia.org/red-barn-640.jpg",
            "descriptionurl": "https://commons.wikimedia.org/wiki/File:Red_barn.jpg",
            "width": 4000, "height": 3000,
            "extmetadata": {
                "LicenseShortName": {"value": "CC BY-SA 4.0"},
                "Artist": {"value": '<a href="/wiki/User:Jo">Jo &amp; Co</a>'},
                "ImageDescription": {"value": "<p>A <b>red</b> barn at dusk.</p>"},
            },
        }],
    }]}
}
OPENVERSE = {
    "results": [{
        "id": "abc-123", "title": "Forest path", "url": "https://live.staticflickr.com/x.jpg",
        "thumbnail": "https://api.openverse.org/v1/images/abc-123/thumb/",
        "foreign_landing_url": "https://flickr.com/photos/x",
        "license": "by-sa", "license_version": "4.0", "creator": "A Photographer",
        "width": 1600, "height": 1200, "provider": "flickr",
        "tags": [{"name": "forest"}, {"name": "path"}],
    }]
}
REDDIT_TOKEN = {"access_token": "mock-token", "expires_in": 3600}
REDDIT_SEARCH = {
    "data": {"children": [{"data": {
        "id": "t3abc", "title": "Sunset over the ridge", "selftext": "shot last night",
        "permalink": "/r/EarthPorn/comments/t3abc/sunset/", "subreddit": "EarthPorn",
        "author": "someone", "score": 412, "over_18": False,
        "preview": {"images": [{"source": {
            "url": "https://preview.redd.it/x.jpg?width=1080&amp;crop=smart",
            "width": 1080, "height": 720}}]},
    }}, {"data": {
        "id": "t3vid", "title": "Waves at the harbour wall", "selftext": "",
        "permalink": "/r/EarthPorn/comments/t3vid/waves/", "subreddit": "EarthPorn",
        "author": "someone", "thumbnail": "https://b.thumbs.redditmedia.com/t.jpg",
        "is_video": True,
        "media": {"reddit_video": {
            "fallback_url": "https://v.redd.it/abc/DASH_720.mp4?source=fallback",
            "duration": 12}},
    }}]}
}
PINTEREST = {
    "items": [
        {"id": "p1", "title": "Barn conversion", "description": "timber and glass",
         "board_id": "b1", "link": "https://example.org/barn",
         "media": {"images": {"150x150": {"url": "https://i.pinimg.com/150.jpg",
                                          "width": 150, "height": 150},
                              "1200x": {"url": "https://i.pinimg.com/1200.jpg",
                                        "width": 1200, "height": 800}}}},
        {"id": "p2", "title": "Kitchen tiles", "description": "blue zellige",
         "board_id": "b1", "media": {"images": {}}},
    ]
}
MASTODON = [{
    "id": "109", "content": "<p>Morning fog over the <b>valley</b></p>",
    "url": "https://mastodon.social/@someone/109",
    "account": {"acct": "someone", "display_name": "Someone"},
    "tags": [{"name": "fog"}],
    "media_attachments": [{"type": "image", "url": "https://files.mastodon/full.jpg",
                           "preview_url": "https://files.mastodon/small.jpg",
                           "description": "fog in a valley",
                           "meta": {"original": {"width": 1920, "height": 1080}}}],
}, {
    "id": "110", "content": "<p>A looping clip</p>",
    "url": "https://mastodon.social/@someone/110",
    "account": {"acct": "someone"},
    "tags": [],
    "media_attachments": [{"type": "gifv", "url": "https://files.mastodon/loop.mp4",
                           "preview_url": "https://files.mastodon/loop.jpg",
                           "description": "a looping clip",
                           "meta": {"original": {"width": 640, "height": 480}}}],
}]
BLUESKY_SESSION = {"accessJwt": "mock-jwt", "did": "did:plc:x"}
BLUESKY_SEARCH = {
    "posts": [{
        "uri": "at://did:plc:x/app.bsky.feed.post/3k4abc",
        "author": {"handle": "someone.bsky.social"},
        "record": {"text": "Storm light on the coast"},
        "likeCount": 12,
        "embed": {"images": [{"fullsize": "https://cdn.bsky.app/full.jpg",
                              "thumb": "https://cdn.bsky.app/thumb.jpg",
                              "alt": "storm clouds"}]},
    }]
}
RESO = {
    "value": [{
        "ListingKey": "MLS123", "UnparsedAddress": "12 Rowan Lane", "City": "Ashford",
        "StateOrProvince": "OR", "ListPrice": 489000, "BedroomsTotal": 3,
        "BathroomsTotalInteger": 2, "LivingArea": 1840,
        "PublicRemarks": "Cedar-clad home backing onto woodland.",
        "ListOfficeName": "Rowan Realty",
        "Media": [{"MediaURL": "https://cdn.mls.example/2.jpg", "Order": 2},
                  {"MediaURL": "https://cdn.mls.example/1.jpg", "Order": 1}],
    }]
}

PAGE_HTML = b"""<html><head><title>Ignore me</title>
<meta property="og:title" content="A Cedar Barn Conversion">
<meta property="og:description" content="Timber, glass and a lot of light.">
<meta property="og:image" content="/media/barn.jpg">
<meta property="og:site_name" content="Example Homes">
<link rel="canonical" href="https://example.org/barn"></head><body></body></html>"""

#: A real four-band PNG, so tests can decode it and sample a palette.
BARN_PNG = b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00@\x00\x00\x00@\x08\x02\x00\x00\x00%\x0b\xe6\x89\x00\x00\x00\x80IDATx\x9c\xed\xcf1\r\x02Q\x14\x00\xc1/\xe0\xaa\x13@\xfdE \xecj\x84\xa1\x84\xea<\xd0#\x82b\xf2\x92MV\xc0\xce:\x8f=\xba\xc5\x0f\x02\xe8\x83\x00\xfa \x80>\x08\xa0\x0f\x02\xe8\x83\x00\xfa \x80>\xf8\x17p=\x9e\xa3\x0b\xa0\x0b\xa0\x0b\xa0\x0b\xa0\x0b\xa0\x0b\xa0\x0b\xa0\x9b\x0f\xf8\xbc\xf6\xe8\x02\xe8\x02\xe8\x02\xe8\x02\xe8\x02\xe8\x02\xe8\x02\xe8\xe6\x03\xbe\xf7{t\x01t\x01t\x01t\x01t\x01t\x01t\x01t\xe3\x01?r\xbc\xcd-\xc2\xae6\x9e\x00\x00\x00\x00IEND\xaeB`\x82'

VIDEO_PAGE_HTML = b"""<html><head><title>Clip</title>
<meta property="og:title" content="A Timber Frame Raising">
<meta property="og:video" content="/media/raising.mp4">
<meta property="og:video:type" content="video/mp4">
<meta property="og:image" content="/media/barn.jpg"></head><body></body></html>"""

#: A Hugging-Face-shaped repo, so the installer can be exercised offline.
HF_REPO_FILES = [
    "model_index.json",
    "unet/config.json",
    "unet/diffusion_pytorch_model.safetensors",
    "unet/diffusion_pytorch_model.bin",          # duplicate format, skipped
    "vae/config.json",
    "vae/diffusion_pytorch_model.safetensors",
    "text_encoder/config.json",
    "text_encoder/model.safetensors",
    "tokenizer/vocab.json",
    "tokenizer/merges.txt",
    "onnx/unet/model.onnx",                       # other runtime, skipped
    "README.md",                                  # not a pipeline file
]

#: A Gmail message with a nested MIME tree, so attachment walking is exercised.
GMAIL_MESSAGES = {"messages": [{"id": "msg1"}, {"id": "msg2"}]}
GMAIL_MESSAGE = {
    "id": "msg1",
    "payload": {
        "headers": [
            {"name": "Subject", "value": "Site photos from Tuesday"},
            {"name": "From", "value": "Sam Rowan <sam@example.org>"},
        ],
        "mimeType": "multipart/mixed",
        "parts": [
            {"mimeType": "text/plain", "filename": "",
             "body": {"data": "aGVsbG8"}},
            {"mimeType": "multipart/related", "filename": "", "parts": [
                {"mimeType": "image/jpeg", "filename": "barn.jpg",
                 "body": {"attachmentId": "att1", "size": 4096}},
            ]},
            {"mimeType": "application/pdf", "filename": "invoice.pdf",
             "body": {"attachmentId": "att2", "size": 900}},
            {"mimeType": "video/mp4", "filename": "walkthrough.mp4",
             "body": {"attachmentId": "att3", "size": 20480}},
        ],
    },
}
GMAIL_EMPTY_MESSAGE = {
    "id": "msg2",
    "payload": {"headers": [{"name": "Subject", "value": "No pictures here"}],
                "mimeType": "text/plain", "body": {}},
}
GMAIL_PROFILE = {"emailAddress": "you@example.org", "messagesTotal": 12}

#: An in-house API with an unremarkable shape, and one with an awkward shape,
#: for the configurable connector.
CUSTOM_PLAIN = {"results": [
    {"id": "a1", "title": "Ridge at dawn", "description": "shot on location",
     "image_url": "https://cdn.example.org/a1.jpg",
     "permalink": "https://helix.example.org/a/a1", "author": "Sam"},
    {"id": "a2", "title": "Ridge at dusk",
     "image_url": "https://cdn.example.org/a2.mp4"},
]}
CUSTOM_AWKWARD = {"payload": {"records": [
    {"uuid": "z9", "heading": "Odd shape",
     "media": {"large": "https://cdn.example.org/z9.jpg"}},
]}}

ROBOTS_OPEN = b"User-agent: *\nAllow: /\n"
ROBOTS_CLOSED = b"User-agent: *\nDisallow: /private\nDisallow: /listing\n"


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # keep test output readable
        return

    def _send(self, payload, status=200, content_type="application/json"):
        body = json.dumps(payload).encode() if not isinstance(payload, bytes) else payload
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        length = int(self.headers.get("Content-Length") or 0)
        self.server.last_body = self.rfile.read(length)
        self.server.seen.append(("POST", self.path, dict(self.headers)))

        if path.endswith("/api/v1/access_token"):
            return self._send(REDDIT_TOKEN)
        if path.endswith("/token"):
            # Google-style token endpoint: an auth code yields a refresh token,
            # a refresh token yields a short-lived access token.
            body = self.server.last_body.decode("utf-8", "replace")
            if "grant_type=authorization_code" in body:
                if "code=good-code" not in body:
                    return self._send({"error": "invalid_grant"}, 400)
                return self._send({"access_token": "access-1", "expires_in": 3600,
                                   "refresh_token": "refresh-1"})
            if "grant_type=refresh_token" in body:
                if "refresh_token=bad" in body:
                    return self._send({"error": "invalid_grant"}, 400)
                return self._send({"access_token": "access-2", "expires_in": 3600})
            return self._send({"error": "unsupported_grant_type"}, 400)
        if path.endswith("/xrpc/com.atproto.server.createSession"):
            return self._send(BLUESKY_SESSION)
        return self._send({"error": "not found"}, 404)

    def do_GET(self):
        parts = urllib.parse.urlparse(self.path)
        path, query = parts.path, urllib.parse.parse_qs(parts.query)
        self.server.seen.append(("GET", self.path, dict(self.headers)))

        if path == "/robots.txt":
            return self._send(ROBOTS_OPEN, content_type="text/plain")

        # --- an in-house API, for the configurable connector ---
        if path == "/helix/search":
            if self.headers.get("X-Helix-Key") != "secret-key":
                return self._send({"error": "unauthorised"}, 401)
            return self._send(CUSTOM_PLAIN)
        if path == "/helix/awkward":
            return self._send(CUSTOM_AWKWARD)
        if path == "/helix/not-a-list":
            return self._send({"status": "ok", "count": 0})

        # --- Gmail shapes ---
        if path.startswith("/gmail/v1/users/me/"):
            if not self.headers.get("Authorization", "").startswith("Bearer "):
                return self._send({"error": {"message": "unauthorised"}}, 401)
            tail = path[len("/gmail/v1/users/me/"):]
            if tail == "profile":
                return self._send(GMAIL_PROFILE)
            if tail == "messages":
                return self._send(GMAIL_MESSAGES)
            if "/attachments/" in tail:
                import base64 as _b64
                name = tail.rsplit("/", 1)[1]
                blob = (f"attachment:{name}:".encode() + b"\x00" * 64)[:64]
                # Gmail returns base64url without padding.
                data = _b64.urlsafe_b64encode(blob).decode().rstrip("=")
                return self._send({"size": len(blob), "data": data})
            if tail.startswith("messages/"):
                which = tail.split("/")[1].split("?")[0]
                return self._send(
                    GMAIL_MESSAGE if which == "msg1" else GMAIL_EMPTY_MESSAGE)
            return self._send({"error": "no gmail stub"}, 404)

        # --- Hugging Face shapes ---
        if path.startswith("/api/models/"):
            repo = path[len("/api/models/"):]
            if "gated" in repo and not self.headers.get("Authorization"):
                return self._send({"error": "Access to model is restricted"}, 401)
            if "missing" in repo:
                return self._send({"error": "Repo not found"}, 404)
            return self._send({
                "id": repo,
                "siblings": [{"rfilename": name} for name in HF_REPO_FILES],
            })
        if "/resolve/main/" in path:
            name = path.split("/resolve/main/", 1)[1]
            if "gated" in path and not self.headers.get("Authorization"):
                return self._send({"error": "restricted"}, 401)
            # Deterministic filler, sized so progress reporting has something
            # to report.
            body = (f"weights:{name}:".encode() + b"\x00" * 5000)[:5000]
            start = 0
            rng = self.headers.get("Range", "")
            if rng.startswith("bytes="):
                try:
                    start = int(rng[len("bytes="):].split("-")[0])
                except ValueError:
                    start = 0
            if start:
                chunk = body[start:]
                self.send_response(206)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(len(chunk)))
                self.send_header("Content-Range",
                                 f"bytes {start}-{len(body) - 1}/{len(body)}")
                self.end_headers()
                self.wfile.write(chunk)
                return
            return self._send(body, content_type="application/octet-stream")
        if path == "/closed/robots.txt":
            return self._send(ROBOTS_CLOSED, content_type="text/plain")
        if path == "/page.html":
            return self._send(PAGE_HTML, content_type="text/html")
        if path == "/video-page.html":
            return self._send(VIDEO_PAGE_HTML, content_type="text/html")
        if path == "/media/raising.mp4":
            return self._send(b"\x00\x00\x00 ftypisom-fake", content_type="video/mp4")
        if path == "/media/barn.jpg":
            return self._send(BARN_PNG, content_type="image/png")
        if path == "/listing":
            return self._send(b"<html></html>", content_type="text/html")
        if path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "https://not-allowed.example/x")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path == "/huge":
            return self._send(b"x" * 40000, content_type="text/plain")

        if path.endswith("/w/api.php"):
            if "commons" in path:
                return self._send(COMMONS)
            if query.get("list") == ["search"]:
                return self._send(WIKIPEDIA_SEARCH)
            return self._send(WIKIPEDIA_DETAIL)
        if "/v1/images" in path:
            return self._send(OPENVERSE)
        if path.endswith("/search"):
            return self._send(REDDIT_SEARCH)
        if "/v5/" in path:
            return self._send(PINTEREST)
        if "/timelines/tag/" in path:
            return self._send(MASTODON)
        if path.endswith("/xrpc/app.bsky.feed.searchPosts"):
            return self._send(BLUESKY_SEARCH)
        if path.endswith("/Property"):
            return self._send(RESO)
        return self._send({"error": f"no stub for {path}"}, 404)


class MockUpstreams:
    """Starts on an ephemeral port and records every request it received."""

    def __init__(self) -> None:
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.server.seen = []
        self.server.last_body = b""
        self.port = self.server.server_address[1]
        self.base = f"http://127.0.0.1:{self.port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def seen(self):
        return self.server.seen

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def env(self) -> dict[str, str]:
        """Base-URL overrides that aim every connector at this stub."""
        return {
            "AVERNAL_FORGE_WIKIPEDIA_BASE": f"{self.base}/w/api.php",
            "AVERNAL_FORGE_COMMONS_BASE": f"{self.base}/commons/w/api.php",
            "AVERNAL_FORGE_OPENVERSE_BASE": self.base,
            "AVERNAL_FORGE_REDDIT_TOKEN_BASE": f"{self.base}/api/v1/access_token",
            "AVERNAL_FORGE_REDDIT_BASE": self.base,
            "AVERNAL_FORGE_PINTEREST_BASE": self.base,
            "AVERNAL_FORGE_MASTODON_BASE": self.base,
            "AVERNAL_FORGE_BLUESKY_BASE": self.base,
        }
