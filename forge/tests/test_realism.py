"""Model installation and the realism presets.

The installer is exercised against a hub-shaped stub rather than the real
Hugging Face, so these run with no network. `run.py models --install` against
the live hub is what proves the repository ids are still current.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from mock_upstreams import HF_REPO_FILES, MockUpstreams  # noqa: E402

from avernal_forge import catalogue, presets  # noqa: E402
from avernal_forge.config import Config  # noqa: E402
from avernal_forge.installer import (  # noqa: E402
    InstallError,
    install_by_name,
    make_gate,
    select_files,
    token_for,
)
from avernal_forge.server import ApiError, build_request, serve  # noqa: E402


class TestCatalogue(unittest.TestCase):
    def test_every_entry_is_complete(self):
        for entry in catalogue.CATALOGUE:
            self.assertIn(entry.kind, ("image", "video"), entry.id)
            self.assertRegex(entry.repo, r"^[\w.-]+/[\w.-]+$", entry.id)
            self.assertTrue(entry.licence, entry.id)
            self.assertTrue(entry.good_for, entry.id)
            self.assertGreater(entry.approx_gb, 0, entry.id)
            self.assertGreater(entry.vram_gb, 0, entry.id)

    def test_ids_are_unique(self):
        ids = [entry.id for entry in catalogue.CATALOGUE]
        self.assertEqual(len(ids), len(set(ids)))

    def test_both_kinds_can_do_people(self):
        # The point of the catalogue is realistic output, so each kind needs at
        # least one entry that actually delivers it.
        for kind in ("image", "video"):
            entries = [e for e in catalogue.listing(kind) if e.photoreal_people]
            self.assertTrue(entries, f"no photoreal {kind} model offered")

    def test_gated_entries_say_so(self):
        for entry in catalogue.CATALOGUE:
            if entry.gated:
                self.assertIn("licence", entry.notes.lower(), entry.id)

    def test_lookup(self):
        self.assertEqual(catalogue.by_id("sdxl").kind, "image")
        self.assertIsNone(catalogue.by_id("does-not-exist"))


class TestFileSelection(unittest.TestCase):
    def test_keeps_pipeline_files_and_drops_duplicates(self):
        chosen = select_files(HF_REPO_FILES, catalogue.DIFFUSERS_PATTERNS)
        self.assertIn("model_index.json", chosen)
        self.assertIn("unet/diffusion_pytorch_model.safetensors", chosen)
        # .bin duplicates, other runtimes and docs are all skipped.
        self.assertNotIn("unet/diffusion_pytorch_model.bin", chosen)
        self.assertNotIn("onnx/unet/model.onnx", chosen)
        self.assertNotIn("README.md", chosen)

    def test_fp16_variants_are_skipped(self):
        names = ["unet/model.safetensors", "unet/model.fp16.safetensors"]
        chosen = select_files(names, ("*/*.safetensors",))
        self.assertEqual(chosen, ["unet/model.safetensors"])

    def test_an_empty_repo_selects_nothing(self):
        self.assertEqual(select_files([], catalogue.DIFFUSERS_PATTERNS), [])


class TestInstaller(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.mock = MockUpstreams()
        cls._saved = dict(os.environ)
        os.environ["AVERNAL_FORGE_HF_BASE"] = cls.mock.base
        for name in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HUGGINGFACE_TOKEN"):
            os.environ.pop(name, None)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.mock.stop()
        os.environ.clear()
        os.environ.update(cls._saved)

    def setUp(self) -> None:
        self.home = Path(tempfile.mkdtemp(prefix="forge-install-"))
        self.config = Config(home=self.home, allow_private_hosts=True, quiet=True)
        self.config.ensure_dirs()

    def tearDown(self) -> None:
        shutil.rmtree(self.home, ignore_errors=True)

    def test_installs_the_pipeline_files(self):
        result = install_by_name("some-org/demo", self.config)
        target = Path(result["target"])
        on_disk = sorted(str(p.relative_to(target))
                         for p in target.rglob("*") if p.is_file())
        self.assertIn("model_index.json", on_disk)
        self.assertIn("unet/diffusion_pytorch_model.safetensors", on_disk)
        self.assertNotIn("README.md", on_disk)
        self.assertEqual(result["downloaded"], len(on_disk))
        self.assertGreater(result["bytes"], 0)

    def test_leaves_no_partial_files_behind(self):
        result = install_by_name("some-org/demo", self.config)
        self.assertEqual(list(Path(result["target"]).rglob("*.part")), [])

    def test_reinstalling_skips_what_is_already_there(self):
        first = install_by_name("some-org/demo", self.config)
        second = install_by_name("some-org/demo", self.config)
        self.assertEqual(second["downloaded"], 0)
        self.assertEqual(second["skipped"], first["downloaded"])

    def test_the_installed_model_is_then_discoverable(self):
        install_by_name("some-org/demo", self.config)
        from avernal_forge import models as model_registry

        found = model_registry.discover(self.config.models_dir, include_hf_cache=False)
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["kind"], "diffusers")

    def test_a_gated_repo_explains_what_to_do(self):
        with self.assertRaises(InstallError) as ctx:
            install_by_name("some-org/gated-model", self.config)
        message = str(ctx.exception)
        self.assertIn("licence", message)
        self.assertIn("HF_TOKEN", message)

    def test_a_token_gets_past_the_gate(self):
        self.config.hf_token = "a-token"
        result = install_by_name("some-org/gated-model", self.config)
        self.assertGreater(result["downloaded"], 0)

    def test_a_missing_repo_says_so(self):
        with self.assertRaises(InstallError) as ctx:
            install_by_name("some-org/missing-model", self.config)
        self.assertIn("not found", str(ctx.exception))

    def test_a_malformed_id_is_refused_before_any_request(self):
        with self.assertRaises(InstallError) as ctx:
            install_by_name("not a repo id", self.config)
        self.assertIn("owner/name", str(ctx.exception))

    def test_installs_are_recorded_in_the_audit_log(self):
        result = install_by_name("some-org/demo", self.config)
        urls = [entry["url"] for entry in result["audit"]]
        self.assertTrue(any("/api/models/" in url for url in urls))
        self.assertTrue(any("/resolve/main/" in url for url in urls))

    def test_the_install_gate_reaches_only_the_hub(self):
        from avernal_forge.connectors.net import NetworkBlocked

        gate = make_gate(self.config)
        with self.assertRaises(NetworkBlocked):
            gate.json("https://example.com/anything", connector="installer")

    def test_a_token_in_config_beats_the_environment(self):
        self.config.hf_token = "from-config"
        self.assertEqual(token_for(self.config), "from-config")
        blank = Config(home=self.home)
        os.environ["HF_TOKEN"] = "from-env"
        try:
            self.assertEqual(token_for(blank), "from-env")
        finally:
            os.environ.pop("HF_TOKEN", None)


class TestPresets(unittest.TestCase):
    def test_none_changes_nothing(self):
        self.assertEqual(presets.compose("none", "a barn", "blurry"),
                         ("a barn", "blurry"))

    def test_a_preset_appends_rather_than_replaces(self):
        prompt, _ = presets.compose("portrait", "a woman reading")
        self.assertTrue(prompt.startswith("a woman reading,"))
        self.assertIn("85mm", prompt)

    def test_the_users_negative_comes_first(self):
        _, negative = presets.compose("portrait", "x", "cartoon")
        self.assertTrue(negative.startswith("cartoon,"))

    def test_presets_are_skipped_for_the_procedural_engine(self):
        self.assertEqual(presets.compose("portrait", "a woman", "", neural=False),
                         ("a woman", ""))

    def test_an_unknown_preset_falls_back_to_none(self):
        self.assertEqual(presets.compose("nonsense", "a barn", ""), ("a barn", ""))

    def test_the_people_preset_excludes_the_usual_failures(self):
        _, negative = presets.compose("portrait", "a person")
        for fault in ("extra fingers", "plastic skin", "bad anatomy"):
            self.assertIn(fault, negative)

    def test_every_preset_is_well_formed(self):
        for preset in presets.PRESETS:
            self.assertTrue(preset.label)
            self.assertTrue(preset.description)
            if preset.id != "none":
                self.assertTrue(preset.prompt_suffix or preset.negative)


class TestRealismRequests(unittest.TestCase):
    def test_style_and_detail_pass_survive_the_request(self):
        request = build_request({"prompt": "a portrait", "style": "portrait",
                                 "detail_pass": True, "detail_strength": 0.4})
        self.assertEqual(request.style, "portrait")
        self.assertTrue(request.detail_pass)
        self.assertEqual(request.detail_strength, 0.4)

    def test_the_composed_prompt_is_what_a_model_would_receive(self):
        request = build_request({"prompt": "a portrait", "style": "photo"})
        composed, negative = request.composed(neural=True)
        self.assertIn("photograph", composed)
        self.assertIn("illustration", negative)
        # The stored prompt stays as typed, so the gallery stays readable.
        self.assertEqual(request.prompt, "a portrait")

    def test_detail_strength_is_clamped(self):
        request = build_request({"prompt": "x", "detail_strength": 99,
                                 "detail_scale": 99})
        self.assertLessEqual(request.detail_strength, 0.9)
        self.assertLessEqual(request.detail_scale, 2.0)

    def test_an_unknown_style_is_refused(self):
        with self.assertRaises(ApiError):
            build_request({"prompt": "x", "style": "hyperreal-8k"})


class TestRealismApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.home = Path(tempfile.mkdtemp(prefix="forge-realism-"))
        config = Config(host="127.0.0.1", port=0, home=cls.home, quiet=True)
        cls.httpd = serve(config)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        shutil.rmtree(cls.home, ignore_errors=True)

    def api(self, path, method="GET", payload=None):
        data = json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(self.base + path, data=data, method=method)
        request.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(request, timeout=60) as response:
            body = response.read()
            return response.status, (json.loads(body) if body else None)

    def test_config_offers_the_presets(self):
        _, config = self.api("/api/config")
        ids = [preset["id"] for preset in config["presets"]]
        self.assertIn("portrait", ids)
        portrait = [p for p in config["presets"] if p["id"] == "portrait"][0]
        self.assertTrue(portrait["neural_only"])
        self.assertIn("detail_pass", portrait["suggests"])

    def test_config_reports_that_no_neural_engine_is_available(self):
        _, config = self.api("/api/config")
        neural = [e for e in config["engines"] if e["neural"]]
        self.assertTrue(neural)
        # torch is absent here, so the UI must be told plainly.
        self.assertFalse(any(engine["available"] for engine in neural))

    def test_a_styled_request_still_generates_on_the_procedural_engine(self):
        import time

        _, job = self.api("/api/generate", "POST", {
            "prompt": "a person in a field", "style": "portrait",
            "width": 64, "height": 64, "steps": 6})
        deadline = time.time() + 60
        while time.time() < deadline:
            _, job = self.api(f"/api/jobs/{job['id']}")
            if job["status"] in ("done", "error", "cancelled"):
                break
            time.sleep(0.05)
        self.assertEqual(job["status"], "done", job.get("error"))
        # The preset was recorded but not applied, so the prompt is unchanged.
        self.assertEqual(job["images"][0]["prompt"], "a person in a field")

    def test_an_unknown_style_is_a_400(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self.api("/api/generate", "POST", {"prompt": "x", "style": "nope"})
        self.assertEqual(ctx.exception.code, 400)


if __name__ == "__main__":
    unittest.main(verbosity=2)
