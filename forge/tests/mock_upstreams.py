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
        self.rfile.read(length)
        self.server.seen.append(("POST", self.path, dict(self.headers)))

        if path.endswith("/api/v1/access_token"):
            return self._send(REDDIT_TOKEN)
        if path.endswith("/xrpc/com.atproto.server.createSession"):
            return self._send(BLUESKY_SESSION)
        return self._send({"error": "not found"}, 404)

    def do_GET(self):
        parts = urllib.parse.urlparse(self.path)
        path, query = parts.path, urllib.parse.parse_qs(parts.query)
        self.server.seen.append(("GET", self.path, dict(self.headers)))

        if path == "/robots.txt":
            return self._send(ROBOTS_OPEN, content_type="text/plain")
        if path == "/closed/robots.txt":
            return self._send(ROBOTS_CLOSED, content_type="text/plain")
        if path == "/page.html":
            return self._send(PAGE_HTML, content_type="text/html")
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
