"""The Gmail connector and the OAuth flow behind it.

Driven against a Gmail-shaped stub, so these run with no network and no real
mailbox. What they prove is the wiring and the privacy boundaries; signing in
to a real account is what proves the credentials work.
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from mock_upstreams import MockUpstreams  # noqa: E402

from avernal_forge.config import Config  # noqa: E402
from avernal_forge.connectors import ConnectorHub, ConnectorStore  # noqa: E402
from avernal_forge.connectors.gmail import GmailConnector  # noqa: E402
from avernal_forge.connectors.net import NetworkBlocked, NetworkGate  # noqa: E402
from avernal_forge.connectors.oauth import (  # noqa: E402
    OAuthEndpoints,
    OAuthError,
    authorise,
    refresh_access_token,
)


class GmailTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.mock = MockUpstreams()
        cls._saved = dict(os.environ)
        os.environ["AVERNAL_FORGE_GMAIL_BASE"] = cls.mock.base

    @classmethod
    def tearDownClass(cls) -> None:
        cls.mock.stop()
        os.environ.clear()
        os.environ.update(cls._saved)

    def setUp(self) -> None:
        self.home = Path(tempfile.mkdtemp(prefix="forge-gmail-"))
        (self.home / "connectors.json").write_text(json.dumps({
            "online": True,
            "enabled": ["gmail"],
            "extra_domains": ["127.0.0.1"],
            "credentials": {"gmail": {
                "client_id": "cid", "client_secret": "csecret",
                "refresh_token": "refresh-1",
            }},
        }))
        self.config = Config(home=self.home, allow_private_hosts=True, quiet=True)
        self.config.ensure_dirs()
        self.hub = ConnectorHub(self.config, ConnectorStore(self.home / "connectors.json"))
        # The token endpoint lives on the stub too.
        self.connector = self.hub.get("gmail")
        self.connector.endpoints = lambda: OAuthEndpoints(
            auth_url=f"{self.mock.base}/auth",
            token_url=f"{self.mock.base}/token",
            scopes=("https://www.googleapis.com/auth/gmail.readonly",),
        )

    def tearDown(self) -> None:
        shutil.rmtree(self.home, ignore_errors=True)


class TestScopeAndSetup(GmailTestCase):
    def test_it_asks_only_for_read_access(self):
        scopes = GmailConnector(self.config).endpoints().scopes
        self.assertEqual(scopes, ("https://www.googleapis.com/auth/gmail.readonly",))
        # Nothing that could send, delete or modify.
        for scope in scopes:
            self.assertIn("readonly", scope)
            for forbidden in ("compose", "send", "modify", "full", "settings"):
                self.assertNotIn(forbidden, scope)

    def test_it_is_off_until_signed_in(self):
        fresh = ConnectorHub(Config(home=self.home),
                             ConnectorStore(self.home / "empty.json"))
        gmail = [c for c in fresh.describe()["connectors"] if c["id"] == "gmail"][0]
        self.assertFalse(gmail["enabled"])
        self.assertFalse(gmail["configured"])
        self.assertIn("refresh_token", gmail["missing"])

    def test_it_reaches_only_google(self):
        self.assertIn("googleapis.com", self.hub.gate.allowed_domains)
        with self.assertRaises(NetworkBlocked):
            self.hub.gate.json("https://example.com/x", connector="gmail")

    def test_the_note_says_how_to_sign_in(self):
        note = self.hub.get("gmail").note
        self.assertIn("--login gmail", note)
        self.assertIn("Read-only", note)


class TestSearch(GmailTestCase):
    def test_it_finds_image_and_video_attachments(self):
        results = self.hub.search("gmail", "site photos", limit=10)
        names = [r.extra["filename"] for r in results]
        self.assertIn("barn.jpg", names)
        self.assertIn("walkthrough.mp4", names)
        # A PDF is not reference material for an image tool.
        self.assertNotIn("invoice.pdf", names)

    def test_attachments_are_found_at_any_depth(self):
        # barn.jpg sits inside a nested multipart/related.
        results = self.hub.search("gmail", "photos", limit=10)
        barn = [r for r in results if r.extra["filename"] == "barn.jpg"][0]
        self.assertEqual(barn.extra["attachment_id"], "att1")

    def test_video_attachments_are_marked_as_clips(self):
        results = self.hub.search("gmail", "photos", limit=10)
        clip = [r for r in results if r.extra["filename"] == "walkthrough.mp4"][0]
        self.assertEqual(clip.kind, "video")

    def test_the_search_is_scoped_to_attachments(self):
        self.hub.search("gmail", "holiday")
        asked = [entry for _, entry, _ in self.mock.seen if "messages?" in entry][-1]
        self.assertIn("has%3Aattachment", asked)

    def test_it_does_not_add_the_filter_twice(self):
        self.hub.search("gmail", "has:attachment barn")
        asked = [entry for _, entry, _ in self.mock.seen if "messages?" in entry][-1]
        query = urllib.parse.parse_qs(urllib.parse.urlparse(asked).query)["q"][0]
        self.assertEqual(query.count("has:attachment"), 1)

    def test_no_message_body_is_kept(self):
        results = self.hub.search("gmail", "photos", limit=10)
        for reference in results:
            blob = json.dumps(reference.public())
            # The plain-text part of the stub message is "hello", base64 "aGVsbG8".
            self.assertNotIn("aGVsbG8", blob)
            self.assertNotIn("hello", blob.lower().replace("walkthrough", ""))

    def test_the_reference_carries_subject_and_sender_only(self):
        reference = self.hub.search("gmail", "photos", limit=1)[0]
        self.assertEqual(reference.summary, "Site photos from Tuesday")
        self.assertIn("sam@example.org", reference.author)
        self.assertEqual(reference.image_url, "")   # bytes come from the API

    def test_a_message_with_no_attachments_yields_nothing(self):
        results = self.hub.search("gmail", "photos", limit=10)
        self.assertTrue(all(r.extra["message_id"] == "msg1" for r in results))


class TestDownload(GmailTestCase):
    def test_the_attachment_is_decoded_from_base64url(self):
        reference = self.hub.search("gmail", "photos", limit=1)[0]
        data, mime = self.hub.fetch_media(reference)
        self.assertEqual(mime, "image/jpeg")
        self.assertTrue(data.startswith(b"attachment:att1:"))

    def test_a_reference_with_no_attachment_ids_falls_through(self):
        from avernal_forge.connectors import Reference

        empty = Reference(id="x", source="gmail")
        self.assertIsNone(
            self.hub.get("gmail").download(empty, self.hub.gate, {})
        )

    def test_saving_a_gmail_reference_writes_a_real_file(self):
        from avernal_forge.storage import ReferenceStore

        store = ReferenceStore(self.config.db_path, self.config.refs_dir)
        reference = self.hub.search("gmail", "photos", limit=1)[0]
        data, mime = self.hub.fetch_media(reference)
        record = store.add(reference.public(), data, mime)
        self.assertTrue(record["local_url"].endswith(".jpg"))
        self.assertEqual(record["kind"], "image")


class TestTokens(GmailTestCase):
    def test_an_access_token_is_fetched_from_the_refresh_token(self):
        token, lifetime = refresh_access_token(
            self.connector.endpoints(), "cid", "csecret", "refresh-1",
            self.hub.gate, connector="gmail")
        self.assertEqual(token, "access-2")
        self.assertEqual(lifetime, 3600)

    def test_a_revoked_token_says_to_sign_in_again(self):
        with self.assertRaises(Exception) as ctx:
            refresh_access_token(self.connector.endpoints(), "cid", "csecret",
                                 "bad", self.hub.gate, connector="gmail")
        self.assertTrue(str(ctx.exception))

    def test_the_access_token_is_cached_rather_than_refetched(self):
        self.hub.search("gmail", "photos", limit=1)
        before = sum(1 for _, path, _ in self.mock.seen if path.endswith("/token"))
        self.hub.search("gmail", "photos", limit=1)
        after = sum(1 for _, path, _ in self.mock.seen if path.endswith("/token"))
        self.assertEqual(before, after, "the token should be reused, not refetched")

    def test_credentials_never_appear_in_the_audit_log(self):
        self.hub.gate.clear_log()
        self.hub.search("gmail", "photos", limit=1)
        blob = json.dumps(self.hub.gate.audit_log())
        for secret in ("csecret", "refresh-1", "access-2", "Authorization"):
            self.assertNotIn(secret, blob)

    def test_probe_reports_the_signed_in_address(self):
        result = self.hub.probe("gmail")
        self.assertTrue(result["ok"], result["detail"])
        self.assertIn("you@example.org", result["detail"])


class TestOAuthFlow(GmailTestCase):
    def endpoints(self):
        return OAuthEndpoints(auth_url=f"{self.mock.base}/auth",
                              token_url=f"{self.mock.base}/token",
                              scopes=("scope-a",))

    def _visit_redirect(self, consent_url: str, code: str = "good-code",
                        state: str | None = None) -> None:
        """Stand in for the browser: follow the redirect back to Forge."""
        query = urllib.parse.parse_qs(urllib.parse.urlparse(consent_url).query)
        redirect = query["redirect_uri"][0]
        use_state = query["state"][0] if state is None else state
        params = urllib.parse.urlencode({"code": code, "state": use_state})
        for _ in range(50):
            try:
                urllib.request.urlopen(f"{redirect}?{params}", timeout=5).read()
                return
            except Exception:
                time.sleep(0.05)

    def _run(self, **kwargs):
        captured: dict = {}

        def on_event(kind, payload):
            if kind == "consent":
                captured["url"] = payload["url"]
                threading.Thread(
                    target=self._visit_redirect,
                    args=(payload["url"],),
                    kwargs=kwargs,
                    daemon=True,
                ).start()

        tokens = authorise(self.endpoints(), "cid", "csecret", self.hub.gate,
                           connector="gmail", open_browser=False, on_event=on_event)
        return tokens, captured

    def test_a_full_round_trip_returns_a_refresh_token(self):
        tokens, captured = self._run()
        self.assertEqual(tokens["refresh_token"], "refresh-1")
        self.assertIn("redirect_uri=http%3A%2F%2F127.0.0.1", captured["url"])

    def test_the_consent_url_asks_for_offline_access(self):
        _, captured = self._run()
        query = urllib.parse.parse_qs(urllib.parse.urlparse(captured["url"]).query)
        self.assertEqual(query["access_type"], ["offline"])
        self.assertEqual(query["response_type"], ["code"])
        self.assertEqual(query["scope"], ["scope-a"])

    def test_a_mismatched_state_is_refused(self):
        # A redirect that did not come from our request must not be honoured.
        with self.assertRaises(OAuthError) as ctx:
            self._run(state="not-our-state")
        self.assertIn("did not match", str(ctx.exception))

    def test_a_rejected_code_reports_the_failure(self):
        with self.assertRaises(Exception) as ctx:
            self._run(code="wrong-code")
        self.assertTrue(str(ctx.exception))

    def test_missing_client_details_fail_before_any_request(self):
        with self.assertRaises(OAuthError):
            authorise(self.endpoints(), "", "", self.hub.gate, open_browser=False)


if __name__ == "__main__":
    unittest.main(verbosity=2)
