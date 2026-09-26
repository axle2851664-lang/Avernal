"""The configurable connector: pointing Forge at an API it does not know.

This is how an in-house service gets connected without a bespoke connector, so
the tests cover both the easy case (ordinary field names, nothing configured)
and the awkward one (everything mapped by hand).
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from mock_upstreams import MockUpstreams  # noqa: E402

from avernal_forge.config import Config  # noqa: E402
from avernal_forge.connectors import ConnectorHub, ConnectorStore  # noqa: E402
from avernal_forge.connectors.net import NetworkBlocked  # noqa: E402


class CustomApiTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.mock = MockUpstreams()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.mock.stop()

    def hub(self, **credentials) -> ConnectorHub:
        self.home = Path(tempfile.mkdtemp(prefix="forge-custom-"))
        settings = {
            "online": True,
            "enabled": ["custom"],
            "extra_domains": ["127.0.0.1"],
            "credentials": {"custom": credentials},
        }
        (self.home / "connectors.json").write_text(json.dumps(settings))
        config = Config(home=self.home, allow_private_hosts=True, quiet=True)
        config.ensure_dirs()
        return ConnectorHub(config, ConnectorStore(self.home / "connectors.json"))

    def tearDown(self) -> None:
        shutil.rmtree(getattr(self, "home", "/nonexistent"), ignore_errors=True)


class TestOrdinaryShape(CustomApiTestCase):
    def setUp(self) -> None:
        self.forge = self.hub(
            service_name="Helix",
            base_url=self.mock.base,
            search_path="/helix/search?q={query}&limit={limit}",
            auth_header_name="X-Helix-Key",
            auth_header_value="secret-key",
        )

    def test_it_works_with_no_field_mapping_at_all(self):
        results = self.forge.search("custom", "ridge")
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0].title, "Ridge at dawn")
        self.assertEqual(results[0].image_url, "https://cdn.example.org/a1.jpg")
        self.assertEqual(results[0].page_url, "https://helix.example.org/a/a1")
        self.assertEqual(results[0].author, "Sam")
        self.assertEqual(results[0].summary, "shot on location")

    def test_a_video_url_is_recognised(self):
        results = self.forge.search("custom", "ridge")
        self.assertEqual(results[1].kind, "video")

    def test_the_configured_name_is_what_the_studio_shows(self):
        described = [c for c in self.forge.describe()["connectors"]
                     if c["id"] == "custom"][0]
        self.assertEqual(described["label"], "Helix")

    def test_the_host_is_added_to_the_allowlist(self):
        self.assertIn("127.0.0.1", self.forge.gate.allowed_domains)

    def test_placeholders_are_substituted(self):
        self.forge.search("a ridge & a valley", limit=5) if False else None
        self.forge.search("custom", "a ridge & a valley", limit=5)
        asked = [p for _, p, _ in self.mock.seen if "/helix/search" in p][-1]
        self.assertIn("q=a%20ridge%20%26%20a%20valley", asked)
        self.assertIn("limit=5", asked)

    def test_the_auth_header_is_sent(self):
        self.forge.search("custom", "ridge")
        headers = [h for _, p, h in self.mock.seen if "/helix/search" in p][-1]
        self.assertEqual(headers.get("X-Helix-Key"), "secret-key")

    def test_the_key_never_reaches_the_audit_log(self):
        self.forge.gate.clear_log()
        self.forge.search("custom", "ridge")
        self.assertNotIn("secret-key", json.dumps(self.forge.gate.audit_log()))

    def test_probe_reports_the_service_name(self):
        result = self.forge.probe("custom")
        self.assertTrue(result["ok"], result["detail"])
        self.assertIn("Helix", result["detail"])


class TestAwkwardShape(CustomApiTestCase):
    def test_everything_can_be_mapped_by_hand(self):
        forge = self.hub(
            service_name="Helix",
            base_url=self.mock.base,
            search_path="/helix/awkward",
            results_path="payload.records",
            title_field="heading",
            image_field="media.large",
        )
        results = forge.search("custom", "anything")
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].title, "Odd shape")
        self.assertEqual(results[0].image_url, "https://cdn.example.org/z9.jpg")

    def test_a_nested_list_is_found_without_being_told(self):
        forge = self.hub(base_url=self.mock.base, search_path="/helix/awkward")
        results = forge.search("custom", "anything")
        self.assertEqual(len(results), 1)

    def test_a_response_with_no_list_says_what_to_do(self):
        forge = self.hub(base_url=self.mock.base, search_path="/helix/not-a-list")
        with self.assertRaises(RuntimeError) as ctx:
            forge.search("custom", "anything")
        self.assertIn("Path to results", str(ctx.exception))

    def test_a_wrong_key_is_rejected_by_the_service(self):
        forge = self.hub(
            base_url=self.mock.base, search_path="/helix/search?q={query}",
            auth_header_name="X-Helix-Key", auth_header_value="wrong")
        with self.assertRaises(Exception) as ctx:
            forge.search("custom", "ridge")
        self.assertIn("401", str(ctx.exception))


class TestGuards(CustomApiTestCase):
    def test_it_is_unconfigured_until_a_url_is_given(self):
        forge = self.hub()
        described = [c for c in forge.describe()["connectors"]
                     if c["id"] == "custom"][0]
        self.assertFalse(described["configured"])
        self.assertIn("base_url", described["missing"])

    def test_a_url_without_a_scheme_is_refused(self):
        forge = self.hub(base_url="helix.example.org", search_path="/x")
        with self.assertRaises(RuntimeError) as ctx:
            forge.search("custom", "anything")
        self.assertIn("https://", str(ctx.exception))

    def test_only_the_configured_host_becomes_reachable(self):
        forge = self.hub(base_url="https://helix.example.org", search_path="/x")
        self.assertIn("helix.example.org", forge.gate.allowed_domains)
        with self.assertRaises(NetworkBlocked):
            forge.gate.json("https://somewhere-else.example/x", connector="custom")




class TestSetupCommands(CustomApiTestCase):
    """`--set` and `--inspect`: the path from "I have an API" to a connector."""

    def run_cli(self, *args: str):
        import os
        import subprocess
        import sys as _sys

        return subprocess.run(
            [_sys.executable, "run.py", *args, "--home", str(self.home),
             "--allow-private-hosts"],
            cwd=ROOT, capture_output=True, text=True, timeout=120,
            env=dict(os.environ),
        )

    def setUp(self) -> None:
        self.forge = self.hub()          # creates self.home with nothing set

    def test_set_with_no_values_lists_what_is_needed(self):
        result = self.run_cli("connectors", "--set", "custom")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("base_url", result.stdout)
        self.assertIn("required", result.stdout)

    def test_set_configures_and_enables_the_connector(self):
        result = self.run_cli(
            "connectors", "--set", "custom",
            "service_name=Helix", f"base_url={self.mock.base}",
            "search_path=/helix/search?q={query}",
            "auth_header_name=X-Helix-Key", "auth_header_value=secret-key")
        self.assertEqual(result.returncode, 0, result.stderr)
        # Named connectors report under their own name.
        self.assertIn("Helix", result.stdout)
        self.assertIn("configured and switched on", result.stdout)

        listing = self.run_cli("connectors")
        self.assertIn("custom", listing.stdout)

    def test_secrets_are_never_echoed_back(self):
        result = self.run_cli(
            "connectors", "--set", "custom", f"base_url={self.mock.base}",
            "search_path=/helix/search", "auth_header_value=secret-key")
        self.assertNotIn("secret-key", result.stdout)
        self.assertIn("auth_header_value  set", result.stdout)

    def test_an_unknown_field_is_refused(self):
        result = self.run_cli("connectors", "--set", "custom", "nonsense=1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no field", result.stderr)

    def test_a_malformed_pair_is_refused(self):
        result = self.run_cli("connectors", "--set", "custom", "just-a-word")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("key=value", result.stderr)

    def test_inspect_reports_a_readable_api_needs_no_mapping(self):
        result = self.run_cli(
            "connectors", "--inspect", f"{self.mock.base}/helix/search",
            "--header", "X-Helix-Key: secret-key")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Found 2 record(s)", result.stdout)
        self.assertIn("Ridge at dawn", result.stdout)
        self.assertIn("Nothing to map by hand", result.stdout)

    def test_inspect_names_the_fields_it_could_not_find(self):
        result = self.run_cli(
            "connectors", "--inspect", f"{self.mock.base}/helix/awkward")
        self.assertEqual(result.returncode, 0, result.stderr)
        # This shape hides its image under media.large.
        self.assertIn("Set these by hand", result.stdout)
        self.assertIn("image", result.stdout)

    def test_inspect_explains_a_response_with_no_records(self):
        result = self.run_cli(
            "connectors", "--inspect", f"{self.mock.base}/helix/not-a-list")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("No list of records", result.stdout)
        self.assertIn("Path to results", result.stdout)

    def test_inspect_reaches_only_the_host_it_was_given(self):
        result = self.run_cli("connectors", "--inspect",
                              f"{self.mock.base}/helix/search")
        # No key supplied, so the service refuses - but it was reached.
        self.assertIn("401", result.stderr + result.stdout)

    def test_a_malformed_header_is_refused(self):
        result = self.run_cli("connectors", "--inspect",
                              f"{self.mock.base}/helix/search", "--header", "oops")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("NAME:VALUE", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
