"""The command line, exercised as a subprocess.

These exist because a rename broke `run.py generate` and nothing caught it:
every other surface had tests, the CLI did not. Running the real entry point
in a real subprocess is the only way to be sure the wiring holds.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from avernal_forge.png import PNG_MAGIC, read_apng_info, read_size  # noqa: E402


class CliTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.home = Path(tempfile.mkdtemp(prefix="forge-cli-"))
        self.out = Path(tempfile.mkdtemp(prefix="forge-cli-out-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.home, ignore_errors=True)
        shutil.rmtree(self.out, ignore_errors=True)

    def run_cli(self, *args: str, env: dict | None = None, timeout: int = 180):
        merged = dict(os.environ)
        merged.pop("AVERNAL_FORGE_HOME", None)
        if env:
            merged.update(env)
        return subprocess.run(
            [sys.executable, "run.py", *args, "--home", str(self.home)],
            cwd=ROOT, capture_output=True, text=True, timeout=timeout, env=merged,
        )


class TestGenerate(CliTestCase):
    def test_generates_a_still(self):
        target = self.out / "still.png"
        result = self.run_cli("generate", "a crimson horizon", "--size", "96x96",
                              "--steps", "8", "--seed", "1", "-o", str(target),
                              "--quiet")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(target.is_file())
        data = target.read_bytes()
        self.assertTrue(data.startswith(PNG_MAGIC))
        self.assertEqual(read_size(data), (96, 96))
        self.assertIn(str(target), result.stdout)

    def test_generates_a_clip(self):
        result = self.run_cli("generate", "a drifting horizon", "--video",
                              "--frames", "4", "--fps", "6", "--size", "64x64",
                              "--steps", "6", "--seed", "2", "--quiet")
        self.assertEqual(result.returncode, 0, result.stderr)
        written = Path(result.stdout.strip().splitlines()[-1])
        self.assertTrue(written.is_file())
        self.assertEqual(read_apng_info(written.read_bytes())["frames"], 4)

    def test_batch_writes_numbered_files(self):
        target = self.out / "batch.png"
        result = self.run_cli("generate", "twin moons", "-n", "2", "--size", "64x64",
                              "--steps", "6", "-o", str(target), "--quiet")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.out / "batch-1.png").is_file())
        self.assertTrue((self.out / "batch-2.png").is_file())

    def test_the_same_seed_gives_the_same_bytes(self):
        first, second = self.out / "a.png", self.out / "b.png"
        for target in (first, second):
            self.run_cli("generate", "reproducible", "--size", "64x64", "--steps",
                         "6", "--seed", "99", "-o", str(target), "--quiet")
        self.assertEqual(first.read_bytes(), second.read_bytes())

    def test_a_look_preset_is_accepted(self):
        target = self.out / "styled.png"
        result = self.run_cli("generate", "a person", "--style", "portrait",
                              "--size", "64x64", "--steps", "6", "-o", str(target),
                              "--quiet")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(target.is_file())

    def test_an_unknown_look_fails_rather_than_being_ignored(self):
        result = self.run_cli("generate", "x", "--style", "not-a-preset",
                              "--size", "64x64", "--steps", "4", "--quiet")
        self.assertNotEqual(result.returncode, 0)

    def test_output_lands_in_the_home_folder_by_default(self):
        result = self.run_cli("generate", "no explicit output", "--size", "64x64",
                              "--steps", "6", "--quiet")
        self.assertEqual(result.returncode, 0, result.stderr)
        written = Path(result.stdout.strip().splitlines()[-1])
        self.assertTrue(written.is_file())
        self.assertIn("outputs", str(written))


class TestModelsCommand(CliTestCase):
    def test_lists_and_says_what_is_missing(self):
        result = self.run_cli("models")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Procedural", result.stdout)
        # With no weights it must say so, and say what to do about it.
        self.assertIn("cannot draw people", result.stdout)
        self.assertIn("--install", result.stdout)

    def test_catalogue_lists_installable_models(self):
        result = self.run_cli("models", "--catalogue")
        self.assertEqual(result.returncode, 0, result.stderr)
        for expected in ("sdxl", "svd", "VRAM", "licence"):
            self.assertIn(expected, result.stdout)

    def test_install_against_a_stub_hub(self):
        from mock_upstreams import MockUpstreams

        mock = MockUpstreams()
        try:
            result = self.run_cli(
                "models", "--install", "some-org/demo", "--allow-private-hosts",
                env={"AVERNAL_FORGE_HF_BASE": mock.base},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("Done.", result.stdout)
            installed = self.home / "models" / "demo" / "model_index.json"
            self.assertTrue(installed.is_file())

            # And it is then visible to the listing.
            listing = self.run_cli("models")
            self.assertIn("demo", listing.stdout)
        finally:
            mock.stop()

    def test_a_bad_repo_id_exits_non_zero(self):
        result = self.run_cli("models", "--install", "not a repo id")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("owner/name", result.stderr)


class TestConnectorsCommand(CliTestCase):
    def test_lists_connectors_and_their_state(self):
        result = self.run_cli("connectors")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Live connectors are OFF", result.stdout)
        for connector in ("wikipedia", "reddit", "pinterest", "reso"):
            self.assertIn(connector, result.stdout)
        # The promise the whole app rests on, restated where it matters.
        self.assertIn("Generation never uses the network", result.stdout)

    def test_check_refuses_while_offline(self):
        result = self.run_cli("connectors", "--check")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--online", result.stdout)

    def test_check_probes_when_online(self):
        from mock_upstreams import MockUpstreams

        mock = MockUpstreams()
        try:
            (self.home).mkdir(parents=True, exist_ok=True)
            (self.home / "connectors.json").write_text(
                '{"online": true, "enabled": ["wikipedia"], '
                '"extra_domains": ["127.0.0.1"], "credentials": {}}'
            )
            result = self.run_cli(
                "connectors", "--check", "--online", "--allow-private-hosts",
                env={"AVERNAL_FORGE_WIKIPEDIA_BASE": f"{mock.base}/w/api.php"},
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("[ok", result.stdout)
        finally:
            mock.stop()


class TestTopLevel(CliTestCase):
    def test_version(self):
        result = self.run_cli("--version")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Avernal Forge", result.stdout)

    def test_help_lists_every_command(self):
        result = self.run_cli("--help")
        self.assertEqual(result.returncode, 0)
        for command in ("serve", "generate", "models", "connectors"):
            self.assertIn(command, result.stdout)

    def test_an_unknown_flag_fails_loudly(self):
        result = self.run_cli("generate", "x", "--not-a-flag")
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
