"""Connector and network-gate tests.

Every connector is driven against `mock_upstreams`, which replays each
platform's real response shape. That proves the parsing and the safety rules;
it does not prove the live endpoints still look like this, which is what
`run.py connectors --check` is for.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from mock_upstreams import MockUpstreams  # noqa: E402

from avernal_forge.config import Config  # noqa: E402
from avernal_forge.connectors import (  # noqa: E402
    ConnectorHub,
    ConnectorStore,
    NetworkBlocked,
    NetworkError,
    RobotsDisallowed,
)
from avernal_forge.connectors.net import redact  # noqa: E402

ALL_CONNECTORS = ["wikipedia", "commons", "openverse", "webpage", "reddit",
                  "pinterest", "mastodon", "bluesky", "reso"]


class ConnectorTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.mock = MockUpstreams()
        cls._saved_env = dict(os.environ)
        os.environ.update(cls.mock.env())

        cls.home = Path(tempfile.mkdtemp(prefix="forge-conn-"))
        (cls.home / "connectors.json").write_text(json.dumps({
            "online": True,
            "enabled": ALL_CONNECTORS,
            "extra_domains": ["127.0.0.1"],
            "credentials": {
                "reddit": {"client_id": "id", "client_secret": "shh"},
                "pinterest": {"access_token": "pin-token"},
                "mastodon": {"instance": "127.0.0.1"},
                "bluesky": {"identifier": "me.bsky.social", "app_password": "app-pw"},
                "reso": {"endpoint": f"{cls.mock.base}", "access_token": "mls-token"},
            },
        }))
        cls.config = Config(home=cls.home, allow_private_hosts=True, quiet=True)
        cls.config.ensure_dirs()
        cls.hub = ConnectorHub(cls.config, ConnectorStore(cls.home / "connectors.json"))

    @classmethod
    def tearDownClass(cls) -> None:
        cls.mock.stop()
        os.environ.clear()
        os.environ.update(cls._saved_env)
        shutil.rmtree(cls.home, ignore_errors=True)

    def setUp(self) -> None:
        self.hub.gate.clear_log()


class TestNetworkGate(ConnectorTestCase):
    def test_nothing_leaves_while_offline(self):
        self.hub.config.online = False
        try:
            with self.assertRaises(NetworkBlocked) as ctx:
                self.hub.search("wikipedia", "anything")
            self.assertIn("Networking is off", str(ctx.exception))
        finally:
            self.hub.config.online = True

    def test_hosts_outside_the_allowlist_are_refused(self):
        with self.assertRaises(NetworkBlocked) as ctx:
            self.hub.gate.json("https://example.com/data", connector="test")
        self.assertIn("not on the allowlist", str(ctx.exception))

    def test_a_redirect_cannot_walk_off_the_allowlist(self):
        with self.assertRaises(NetworkBlocked):
            self.hub.gate.request(f"{self.mock.base}/redirect", connector="test")

    def test_oversized_responses_are_cut_off(self):
        with self.assertRaises(NetworkError) as ctx:
            self.hub.gate.request(f"{self.mock.base}/huge", connector="test",
                                  max_bytes=1024)
        self.assertIn("cap", str(ctx.exception))

    def test_private_addresses_are_refused_by_default(self):
        strict = Config(home=self.home, allow_private_hosts=False)
        strict.online = True
        from avernal_forge.connectors.net import NetworkGate

        gate = NetworkGate(strict)
        gate.set_allowed_domains({"127.0.0.1"})
        with self.assertRaises(NetworkBlocked) as ctx:
            gate.request("https://127.0.0.1/whatever", connector="test")
        self.assertIn("non-public address", str(ctx.exception))

    def test_secrets_never_reach_the_audit_log(self):
        self.hub.search("reddit", "sunset")
        blob = json.dumps(self.hub.gate.audit_log())
        self.assertNotIn("shh", blob)
        self.assertNotIn("mock-token", blob)
        self.assertNotIn("Authorization", blob)
        self.assertTrue(any(e["connector"] == "reddit" for e in self.hub.gate.audit_log()))

    def test_every_call_is_recorded(self):
        self.hub.search("wikipedia", "eiffel tower")
        entries = self.hub.gate.audit_log()
        self.assertGreaterEqual(len(entries), 2)
        self.assertTrue(all(e["status"] == 200 for e in entries))
        self.assertTrue(all("127.0.0.1" in e["url"] for e in entries))

    def test_blocked_attempts_are_recorded_too(self):
        with self.assertRaises(NetworkBlocked):
            self.hub.gate.json("https://example.com/x", connector="test")
        self.assertEqual(self.hub.gate.audit_log()[0]["status"], "blocked")

    def test_redact_strips_tokens(self):
        cleaned = redact("https://h/x?access_token=abc&q=barn&client_secret=def")
        self.assertNotIn("abc", cleaned)
        self.assertNotIn("def", cleaned)
        self.assertIn("q=barn", cleaned)


class TestKeylessConnectors(ConnectorTestCase):
    def test_wikipedia_returns_articles_in_relevance_order(self):
        results = self.hub.search("wikipedia", "eiffel tower", limit=5)
        self.assertEqual([r.title for r in results], ["Eiffel Tower", "Gustave Eiffel"])
        first = results[0]
        self.assertIn("wrought-iron", first.summary)
        self.assertEqual(first.image_url, "https://upload.wikimedia.org/full.jpg")
        self.assertEqual(first.page_url, "https://en.wikipedia.org/wiki/Eiffel_Tower")
        self.assertEqual(first.width, 2000)

    def test_commons_flattens_html_attribution(self):
        results = self.hub.search("commons", "red barn")
        self.assertEqual(len(results), 1)
        barn = results[0]
        self.assertEqual(barn.title, "Red barn.jpg")
        self.assertEqual(barn.license, "CC BY-SA 4.0")
        self.assertEqual(barn.author, "Jo & Co")           # tags stripped, entity decoded
        self.assertEqual(barn.summary, "A red barn at dusk.")

    def test_openverse_keeps_downloads_on_its_own_host(self):
        results = self.hub.search("openverse", "forest")
        item = results[0]
        self.assertEqual(item.license, "BY-SA 4.0")
        self.assertEqual(item.tags, ["forest", "path"])
        # The full image lives on a third-party host that is not allowlisted,
        # so the download must go through Openverse's own proxied thumbnail.
        self.assertTrue(item.extra["download_url"].startswith(self.mock.base))
        self.assertIn("/thumb/", item.extra["download_url"])
        self.assertNotIn(self.mock.base, item.image_url)

    def test_webpage_import_reads_opengraph_and_resolves_relative_images(self):
        reference = self.hub.import_url(f"{self.mock.base}/page.html")
        self.assertEqual(reference.title, "A Cedar Barn Conversion")
        self.assertEqual(reference.summary, "Timber, glass and a lot of light.")
        self.assertEqual(reference.image_url, f"{self.mock.base}/media/barn.jpg")
        self.assertEqual(reference.page_url, "https://example.org/barn")
        self.assertEqual(reference.author, "Example Homes")

    def test_webpage_import_obeys_robots_disallow(self):
        connector = self.hub.get("webpage")
        os.environ["AVERNAL_FORGE_WEBPAGE_BASE"] = ""
        allowed, reason = connector.robots_allows(self.hub.gate, f"{self.mock.base}/listing")
        self.assertTrue(allowed)   # the default stub robots.txt allows everything

        # Point the check at the stub that disallows /listing.
        parser_input = f"{self.mock.base}/closed/robots.txt"
        response = self.hub.gate.request(parser_input, connector="webpage",
                                         user_directed=True)
        import urllib.robotparser

        parser = urllib.robotparser.RobotFileParser()
        parser.parse(response.text().splitlines())
        self.assertFalse(parser.can_fetch("*", "/listing"))
        self.assertTrue(parser.can_fetch("*", "/page.html"))

    def test_fetching_a_disallowed_page_raises(self):
        connector = self.hub.get("webpage")
        original = connector.robots_allows
        connector.robots_allows = lambda gate, url: (False, "stub disallows it")
        try:
            with self.assertRaises(RobotsDisallowed):
                connector.import_url(f"{self.mock.base}/listing", self.hub.gate)
        finally:
            connector.robots_allows = original


class TestCredentialedConnectors(ConnectorTestCase):
    def test_reddit_authenticates_then_searches(self):
        results = self.hub.search("reddit", "sunset")
        post = results[0]
        self.assertEqual(post.title, "Sunset over the ridge")
        self.assertEqual(post.author, "u/someone")
        self.assertEqual(post.tags, ["EarthPorn"])
        # Reddit HTML-escapes preview URLs; leaving them escaped would 404.
        self.assertIn("?width=1080&crop=smart", post.image_url)
        self.assertNotIn("&amp;", post.image_url)
        methods = [entry[0] for entry in self.mock.seen]
        self.assertIn("POST", methods)

    def test_pinterest_filters_own_pins_and_picks_the_widest_image(self):
        results = self.hub.search("pinterest", "barn")
        self.assertEqual(len(results), 1)               # "Kitchen tiles" filtered out
        pin = results[0]
        self.assertEqual(pin.title, "Barn conversion")
        self.assertEqual(pin.image_url, "https://i.pinimg.com/1200.jpg")
        self.assertEqual(pin.width, 1200)

    def test_pinterest_empty_query_returns_everything(self):
        self.assertEqual(len(self.hub.search("pinterest", "")), 2)

    def test_mastodon_strips_html_and_keeps_media(self):
        results = self.hub.search("mastodon", "fog")
        post = results[0]
        self.assertEqual(post.summary, "Morning fog over the valley")
        self.assertEqual(post.author, "@someone")
        self.assertEqual(post.image_url, "https://files.mastodon/full.jpg")
        self.assertEqual(post.width, 1920)

    def test_mastodon_rejects_an_unusable_hashtag(self):
        with self.assertRaises(RuntimeError):
            self.hub.search("mastodon", "!!!")

    def test_bluesky_creates_a_session_then_searches(self):
        results = self.hub.search("bluesky", "storm")
        post = results[0]
        self.assertEqual(post.author, "@someone.bsky.social")
        self.assertEqual(post.summary, "Storm light on the coast")
        self.assertIn("3k4abc", post.page_url)
        self.assertEqual(post.extra["alt"], "storm clouds")

    def test_reso_orders_photos_and_summarises_the_listing(self):
        results = self.hub.search("reso", "Rowan")
        listing = results[0]
        self.assertEqual(listing.title, "12 Rowan Lane, Ashford")
        self.assertEqual(listing.image_url, "https://cdn.mls.example/1.jpg")  # Order 1 first
        self.assertIn("3 bd", listing.tags)
        self.assertIn("$489,000", listing.tags)
        self.assertEqual(listing.extra["photos"], 2)

    def test_reso_escapes_quotes_in_the_odata_filter(self):
        self.hub.search("reso", "O'Brien")
        asked = [entry[1] for entry in self.mock.seen if "Property" in entry[1]][-1]
        self.assertIn("O%27%27Brien", asked)      # doubled, per OData string rules


class TestHubPolicy(ConnectorTestCase):
    def test_describe_never_leaks_credentials(self):
        blob = json.dumps(self.hub.describe())
        for secret in ("shh", "pin-token", "app-pw", "mls-token"):
            self.assertNotIn(secret, blob)

    def test_describe_reports_what_is_still_missing(self):
        store = ConnectorStore(self.home / "empty.json")
        hub = ConnectorHub(Config(home=self.home), store)
        by_id = {c["id"]: c for c in hub.describe()["connectors"]}
        self.assertFalse(by_id["reddit"]["configured"])
        self.assertIn("client_id", by_id["reddit"]["missing"])
        self.assertTrue(by_id["wikipedia"]["configured"])

    def test_unconfigured_connectors_contribute_no_domains(self):
        store = ConnectorStore(self.home / "empty2.json")
        store.set_enabled(ALL_CONNECTORS)
        hub = ConnectorHub(Config(home=self.home), store)
        self.assertNotIn("reddit.com", hub.gate.allowed_domains)
        hub.set_credentials("reddit", {"client_id": "a", "client_secret": "b"})
        self.assertIn("reddit.com", hub.gate.allowed_domains)

    def test_switching_a_connector_off_removes_its_domains(self):
        store = ConnectorStore(self.home / "empty3.json")
        hub = ConnectorHub(Config(home=self.home), store)
        self.assertIn("wikipedia.org", hub.gate.allowed_domains)
        hub.set_enabled([i for i in hub.enabled_ids if i != "wikipedia"])
        self.assertNotIn("wikipedia.org", hub.gate.allowed_domains)

    def test_zillow_is_not_offered_as_a_connector(self):
        # Zillow has no public listings API and prohibits scraping; the honest
        # route is the licensed RESO feed, which is what ships.
        ids = {c["id"] for c in self.hub.describe()["connectors"]}
        self.assertNotIn("zillow", ids)
        self.assertIn("reso", ids)
        reso = self.hub.get("reso")
        self.assertIn("Zillow", reso.note)




class TestConnectorApi(unittest.TestCase):
    """The HTTP surface: same rules, exercised through the real server."""

    @classmethod
    def setUpClass(cls) -> None:
        import threading

        from avernal_forge.server import serve

        cls.mock = MockUpstreams()
        cls._saved_env = dict(os.environ)
        os.environ.update(cls.mock.env())

        cls.home = Path(tempfile.mkdtemp(prefix="forge-api-"))
        (cls.home / "connectors.json").write_text(json.dumps({
            "online": True,
            "enabled": ALL_CONNECTORS,
            "extra_domains": ["127.0.0.1"],
            "credentials": {"reddit": {"client_id": "id", "client_secret": "shh"}},
        }))
        config = Config(host="127.0.0.1", port=0, home=cls.home,
                        allow_private_hosts=True, quiet=True)
        cls.httpd = serve(config)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.mock.stop()
        os.environ.clear()
        os.environ.update(cls._saved_env)
        shutil.rmtree(cls.home, ignore_errors=True)

    def api(self, path, method="GET", payload=None):
        import urllib.request

        data = json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(self.base + path, data=data, method=method)
        request.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read()
            return response.status, (json.loads(body) if body else None)

    def expect_error(self, path, method="GET", payload=None):
        import urllib.error

        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self.api(path, method, payload)
        return ctx.exception.code, json.loads(ctx.exception.read())

    def test_connectors_endpoint_lists_state_without_secrets(self):
        status, body = self.api("/api/connectors")
        self.assertEqual(status, 200)
        self.assertTrue(body["online"])
        self.assertNotIn("shh", json.dumps(body))
        self.assertEqual(len(body["connectors"]), len(ALL_CONNECTORS))

    def test_search_then_save_then_delete_a_reference(self):
        _, found = self.api("/api/references/search?connector=wikipedia&q=eiffel")
        self.assertEqual(found["results"][0]["title"], "Eiffel Tower")

        # Import a page whose image the stub actually serves, so the download
        # through the gate is exercised too.
        _, imported = self.api("/api/references/import", "POST",
                               {"url": f"{self.mock.base}/page.html"})
        reference = imported["results"][0]
        self.assertEqual(reference["title"], "A Cedar Barn Conversion")

        status, saved = self.api("/api/references", "POST", {"reference": reference})
        self.assertEqual(status, 201)
        self.assertTrue(saved["local_url"].startswith("/refs/"))
        self.assertIn("prompt_terms", saved)

        import urllib.request

        with urllib.request.urlopen(self.base + saved["local_url"], timeout=30) as resp:
            self.assertTrue(resp.read().startswith(b"\x89PNG"))

        _, listing = self.api("/api/references")
        self.assertGreaterEqual(listing["total"], 1)

        _, removed = self.api(f"/api/references/{saved['id']}", "DELETE")
        self.assertEqual(removed["deleted"], saved["id"])

    def test_a_saved_reference_can_seed_generation(self):
        _, imported = self.api("/api/references/import", "POST",
                               {"url": f"{self.mock.base}/page.html"})
        _, saved = self.api("/api/references", "POST",
                            {"reference": imported["results"][0]})

        status, job = self.api("/api/generate", "POST", {
            "prompt": "a barn at dusk", "width": 128, "height": 128, "steps": 6,
            "palette": ["#120c28", "#781e3c", "#dc8228", "#f5e2be"],
            "reference_id": saved["id"],
        })
        self.assertEqual(status, 202)

        import time

        deadline = time.time() + 60
        while time.time() < deadline:
            _, job = self.api(f"/api/jobs/{job['id']}")
            if job["status"] in ("done", "error", "cancelled"):
                break
            time.sleep(0.05)
        self.assertEqual(job["status"], "done", job.get("error"))
        self.assertEqual(job["images"][0]["extra"]["palette_source"], "reference")

    def test_generation_rejects_an_unknown_reference(self):
        code, body = self.expect_error("/api/generate", "POST", {
            "prompt": "x", "width": 64, "height": 64, "steps": 4,
            "reference_id": "does-not-exist",
        })
        self.assertEqual(code, 404)
        self.assertIn("reference", body["error"]["message"])

    def test_turning_networking_off_blocks_searches(self):
        self.api("/api/connectors/online", "POST", {"online": False})
        try:
            code, body = self.expect_error(
                "/api/references/search?connector=wikipedia&q=eiffel")
            self.assertEqual(code, 403)
            self.assertEqual(body["error"]["type"], "network_blocked")
        finally:
            self.api("/api/connectors/online", "POST", {"online": True})

    def test_network_log_endpoint_reports_traffic(self):
        self.api("/api/references/search?connector=commons&q=barn")
        _, log = self.api("/api/network/log?limit=20")
        self.assertTrue(log["online"])
        self.assertTrue(any(e["connector"] == "commons" for e in log["entries"]))
        self.assertNotIn("shh", json.dumps(log))

    def test_credentials_are_accepted_but_never_returned(self):
        status, body = self.api("/api/connectors/pinterest/credentials", "POST",
                                {"access_token": "brand-new-secret"})
        self.assertEqual(status, 200)
        self.assertNotIn("brand-new-secret", json.dumps(body))
        by_id = {c["id"]: c for c in body["connectors"]}
        self.assertTrue(by_id["pinterest"]["configured"])

        self.api("/api/connectors/pinterest/credentials", "DELETE")
        _, after = self.api("/api/connectors")
        self.assertFalse({c["id"]: c for c in after["connectors"]}["pinterest"]["configured"])

    def test_unknown_connector_is_a_404(self):
        code, _ = self.expect_error("/api/connectors/nope/check", "POST", {})
        self.assertEqual(code, 404)

class TestVideoReferences(ConnectorTestCase):
    """Clips only count as video when the URL is a file a browser can play."""

    def test_mastodon_gifv_is_a_clip_not_an_image(self):
        results = self.hub.search("mastodon", "fog", limit=10)
        clips = [r for r in results if r.kind == "video"]
        self.assertEqual(len(clips), 1)
        clip = clips[0]
        self.assertTrue(clip.image_url.endswith(".mp4"))
        self.assertTrue(clip.thumb_url.endswith(".jpg"))   # still preview
        self.assertEqual(clip.extra["media_type"], "gifv")

    def test_mastodon_photos_are_still_images(self):
        results = self.hub.search("mastodon", "fog", limit=10)
        self.assertEqual(results[0].kind, "image")

    def test_reddit_hosted_video_uses_the_mp4_fallback(self):
        results = self.hub.search("reddit", "waves", limit=10)
        clips = [r for r in results if r.kind == "video"]
        self.assertEqual(len(clips), 1)
        clip = clips[0]
        self.assertEqual(clip.image_url, "https://v.redd.it/abc/DASH_720.mp4")
        self.assertNotIn("?", clip.image_url)          # query stripped
        self.assertTrue(clip.thumb_url.endswith(".jpg"))

    def test_reddit_image_posts_stay_images(self):
        results = self.hub.search("reddit", "sunset", limit=10)
        self.assertEqual(results[0].kind, "image")

    def test_a_page_advertising_og_video_imports_as_a_clip(self):
        reference = self.hub.import_url(f"{self.mock.base}/video-page.html")
        self.assertEqual(reference.kind, "video")
        self.assertTrue(reference.image_url.endswith("/media/raising.mp4"))
        # The poster image is kept as the thumbnail.
        self.assertTrue(reference.thumb_url.endswith("/media/barn.jpg"))

    def test_a_page_with_only_an_image_stays_an_image(self):
        reference = self.hub.import_url(f"{self.mock.base}/page.html")
        self.assertEqual(reference.kind, "image")
        self.assertEqual(reference.extra["video_url"], "")

    def test_bluesky_records_its_playlist_without_claiming_a_playable_file(self):
        results = self.hub.search("bluesky", "storm")
        # Bluesky serves HLS, which is not a single downloadable file, so the
        # reference stays an image and the playlist is kept in extra.
        self.assertEqual(results[0].kind, "image")
        self.assertIn("video_playlist", results[0].extra)

    def test_saving_a_clip_reference_keeps_it_playable(self):
        import urllib.request

        reference = self.hub.import_url(f"{self.mock.base}/video-page.html")
        data, content_type = self.hub.fetch_media(reference)
        self.assertEqual(content_type, "video/mp4")
        self.assertIn(b"ftyp", data)


if __name__ == "__main__":
    unittest.main(verbosity=2)
