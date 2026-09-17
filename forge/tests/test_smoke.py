"""End-to-end tests against a live Forge server.

Runs with the standard library only: `python3 tests/test_smoke.py`
(or `python3 -m unittest discover tests`).
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from avernal_forge.config import Config  # noqa: E402
from avernal_forge.engines import GenerationRequest  # noqa: E402
from avernal_forge.engines.procedural import ProceduralEngine  # noqa: E402
from avernal_forge.png import PNG_MAGIC, encode_png, read_size  # noqa: E402
from avernal_forge.server import build_request, serve, ApiError  # noqa: E402


class _NullContext:
    def progress(self, step: int, total: int, note: str = "") -> None: ...
    def check_cancel(self) -> None: ...


def request_json(url: str, method: str = "GET", payload=None, headers=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    with urllib.request.urlopen(req, timeout=60) as response:
        body = response.read()
        return response.status, (json.loads(body) if body else None)


def request_raw(url: str):
    with urllib.request.urlopen(url, timeout=60) as response:
        return response.status, response.read()


class ServerTestCase(unittest.TestCase):
    """Boots one server for the whole class on an OS-assigned port."""

    api_key = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.home = Path(tempfile.mkdtemp(prefix="forge-test-"))
        config = Config(host="127.0.0.1", port=0, home=cls.home, quiet=True)
        if cls.api_key:
            config.api_key = cls.api_key
        cls.httpd = serve(config)
        cls.port = cls.httpd.server_address[1]
        cls.base = f"http://127.0.0.1:{cls.port}"
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        for _ in range(100):
            try:
                request_json(f"{cls.base}/api/health")
                break
            except Exception:
                time.sleep(0.05)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        shutil.rmtree(cls.home, ignore_errors=True)

    def generate(self, **overrides):
        payload = {"prompt": "a crimson horizon", "width": 128, "height": 128, "steps": 8}
        payload.update(overrides)
        status, job = request_json(f"{self.base}/api/generate", "POST", payload)
        self.assertEqual(status, 202)
        deadline = time.time() + 90
        while time.time() < deadline:
            _, job = request_json(f"{self.base}/api/jobs/{job['id']}")
            if job["status"] in ("done", "error", "cancelled"):
                return job
            time.sleep(0.05)
        self.fail("job did not finish in time")


class TestHealthAndConfig(ServerTestCase):
    def test_health_reports_local_only(self):
        status, body = request_json(f"{self.base}/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "ok")
        self.assertTrue(body["local_only"])
        self.assertIn("engine", body)

    def test_config_exposes_engines_and_limits(self):
        _, body = request_json(f"{self.base}/api/config")
        engine_ids = {engine["id"] for engine in body["engines"]}
        self.assertIn("procedural", engine_ids)
        self.assertIn("diffusers", engine_ids)
        self.assertTrue(any(model["id"] == "procedural" for model in body["models"]))
        self.assertGreater(len(body["samplers"]), 1)
        self.assertIn("max_pixels", body["limits"])

    def test_studio_page_is_served(self):
        status, body = request_raw(f"{self.base}/")
        self.assertEqual(status, 200)
        self.assertIn(b"Avernal", body)
        for asset in ("/style.css", "/app.js"):
            self.assertEqual(request_raw(self.base + asset)[0], 200)


class TestGeneration(ServerTestCase):
    def test_generate_writes_a_real_png(self):
        job = self.generate(seed=4)
        self.assertEqual(job["status"], "done", job.get("error"))
        self.assertEqual(len(job["images"]), 1)
        record = job["images"][0]
        self.assertEqual(record["seed"], 4)

        status, data = request_raw(self.base + record["url"])
        self.assertEqual(status, 200)
        self.assertTrue(data.startswith(PNG_MAGIC))
        self.assertEqual(read_size(data), (128, 128))
        self.assertIn(b"Avernal Forge", data)  # metadata is embedded

    def test_batch_walks_the_seed(self):
        job = self.generate(batch=3, seed=100)
        self.assertEqual(job["status"], "done")
        self.assertEqual([i["seed"] for i in job["images"]], [100, 101, 102])

    def test_same_seed_is_reproducible(self):
        first = self.generate(seed=777, prompt="reproducible ocean")
        second = self.generate(seed=777, prompt="reproducible ocean")
        a = request_raw(self.base + first["images"][0]["url"])[1]
        b = request_raw(self.base + second["images"][0]["url"])[1]
        self.assertEqual(a, b)

    def test_unavailable_engine_fails_cleanly(self):
        status, job = request_json(
            f"{self.base}/api/generate", "POST",
            {"prompt": "x", "width": 64, "height": 64, "steps": 4, "engine": "diffusers"},
        )
        self.assertEqual(status, 202)
        deadline = time.time() + 30
        while time.time() < deadline:
            _, job = request_json(f"{self.base}/api/jobs/{job['id']}")
            if job["status"] in ("done", "error", "cancelled"):
                break
            time.sleep(0.05)
        # torch is absent in CI, so this must be a clean error, never a crash.
        if job["status"] == "error":
            self.assertIn("diffusers", job["error"].lower())
        else:
            self.assertEqual(job["status"], "done")

    def test_cancel_stops_a_queued_job(self):
        _, job = request_json(
            f"{self.base}/api/generate", "POST",
            {"prompt": "big slow render", "width": 1024, "height": 1024,
             "steps": 40, "batch": 4},
        )
        status, body = request_json(f"{self.base}/api/jobs/{job['id']}/cancel", "POST")
        self.assertEqual(status, 200)
        self.assertEqual(body["cancelled"], job["id"])
        deadline = time.time() + 60
        while time.time() < deadline:
            _, current = request_json(f"{self.base}/api/jobs/{job['id']}")
            if current["status"] in ("done", "error", "cancelled"):
                break
            time.sleep(0.05)
        self.assertEqual(current["status"], "cancelled")


class TestGallery(ServerTestCase):
    def test_gallery_lists_searches_favourites_and_deletes(self):
        job = self.generate(prompt="a singular lighthouse beacon", seed=12)
        image_id = job["images"][0]["id"]

        _, page = request_json(f"{self.base}/api/gallery?limit=10")
        self.assertGreaterEqual(page["total"], 1)

        _, hits = request_json(f"{self.base}/api/gallery?q=lighthouse")
        self.assertTrue(any(item["id"] == image_id for item in hits["items"]))

        _, misses = request_json(f"{self.base}/api/gallery?q=zzz-no-such-prompt")
        self.assertEqual(misses["total"], 0)

        _, updated = request_json(
            f"{self.base}/api/gallery/{image_id}/favorite", "POST", {"favorite": True}
        )
        self.assertTrue(updated["favorite"])
        _, favourites = request_json(f"{self.base}/api/gallery?favorites=1")
        self.assertTrue(any(item["id"] == image_id for item in favourites["items"]))

        _, deleted = request_json(f"{self.base}/api/gallery/{image_id}", "DELETE")
        self.assertEqual(deleted["deleted"], image_id)
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            request_json(f"{self.base}/api/gallery/{image_id}")
        self.assertEqual(ctx.exception.code, 404)


class TestProviderApi(ServerTestCase):
    """Forge is the provider: these are the endpoints other tools call."""

    def test_openai_images_generations_b64(self):
        status, body = request_json(
            f"{self.base}/v1/images/generations", "POST",
            {"prompt": "a quiet harbour at dusk", "size": "128x128", "steps": 6},
        )
        self.assertEqual(status, 200)
        self.assertIn("created", body)
        self.assertEqual(len(body["data"]), 1)
        import base64

        png = base64.b64decode(body["data"][0]["b64_json"])
        self.assertTrue(png.startswith(PNG_MAGIC))
        self.assertEqual(read_size(png), (128, 128))

    def test_openai_images_generations_url_and_n(self):
        _, body = request_json(
            f"{self.base}/v1/images/generations", "POST",
            {"prompt": "twin moons", "size": "128x128", "steps": 6, "n": 2,
             "response_format": "url"},
        )
        self.assertEqual(len(body["data"]), 2)
        for entry in body["data"]:
            self.assertTrue(entry["url"].startswith("http://"))
            self.assertEqual(request_raw(entry["url"])[0], 200)

    def test_openai_models_listing(self):
        _, body = request_json(f"{self.base}/v1/models")
        self.assertEqual(body["object"], "list")
        self.assertTrue(any(m["id"] == "procedural" for m in body["data"]))
        self.assertTrue(all(m["owned_by"] == "avernal-forge" for m in body["data"]))


class TestValidationAndSafety(ServerTestCase):
    def _expect_status(self, url, method, payload, code):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            request_json(url, method, payload)
        self.assertEqual(ctx.exception.code, code)
        return json.loads(ctx.exception.read())

    def test_missing_prompt_is_rejected(self):
        body = self._expect_status(f"{self.base}/api/generate", "POST", {}, 400)
        self.assertIn("prompt", body["error"]["message"])

    def test_oversized_request_is_rejected(self):
        body = self._expect_status(
            f"{self.base}/v1/images/generations", "POST",
            {"prompt": "x", "size": "4096x4096"}, 400)
        self.assertIn("pixel limit", body["error"]["message"])

    def test_large_but_allowed_sizes_pass_validation(self):
        request = build_request({"prompt": "wide panorama", "size": "4096x2048"})
        self.assertEqual((request.width, request.height), (4096, 2048))

    def test_unknown_routes_and_records_are_404(self):
        for url in (f"{self.base}/api/nope", f"{self.base}/api/gallery/does-not-exist"):
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                request_json(url)
            self.assertEqual(ctx.exception.code, 404)

    def test_path_traversal_is_blocked(self):
        for attempt in ("/images/..%2f..%2f..%2fetc%2fpasswd", "/images/../forge.db"):
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                request_raw(self.base + attempt)
            self.assertEqual(ctx.exception.code, 404)

    def test_cors_is_off_unless_asked_for(self):
        with urllib.request.urlopen(f"{self.base}/api/health", timeout=30) as response:
            self.assertIsNone(response.headers.get("Access-Control-Allow-Origin"))


class TestApiKeyEnforcement(ServerTestCase):
    api_key = "s3cret-local-key"

    def test_requests_without_the_key_are_rejected(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            request_json(f"{self.base}/api/config")
        self.assertEqual(ctx.exception.code, 401)

    def test_health_stays_open_for_readiness_checks(self):
        self.assertEqual(request_json(f"{self.base}/api/health")[0], 200)

    def test_bearer_token_is_accepted(self):
        status, _ = request_json(
            f"{self.base}/api/config", headers={"Authorization": f"Bearer {self.api_key}"}
        )
        self.assertEqual(status, 200)

    def test_query_key_is_accepted_for_the_event_stream(self):
        status, _ = request_raw(f"{self.base}/api/models?key={self.api_key}")
        self.assertEqual(status, 200)


class TestUnits(unittest.TestCase):
    """Pieces worth testing without a server in front of them."""

    def test_png_round_trip(self):
        data = encode_png(3, 2, bytes(18), {"Prompt": "hello"})
        self.assertTrue(data.startswith(PNG_MAGIC))
        self.assertEqual(read_size(data), (3, 2))
        self.assertIn(b"Prompt", data)

    def test_png_rejects_wrong_buffer_size(self):
        with self.assertRaises(ValueError):
            encode_png(4, 4, bytes(10))

    def test_request_clamping(self):
        request = build_request(
            {"prompt": "x", "size": "1023x600", "steps": 9999, "guidance": 900, "n": 99}
        )
        self.assertEqual(request.width % 8, 0)
        self.assertLessEqual(request.steps, 150)
        self.assertLessEqual(request.batch, 8)
        self.assertLessEqual(request.guidance, 30)

    def test_blank_prompt_raises(self):
        with self.assertRaises(ApiError):
            build_request({"prompt": "   "})

    def test_prompt_steers_the_procedural_composition(self):
        engine = ProceduralEngine()
        styles = {}
        for prompt, expected in [
            ("a wide mountain landscape", "horizon"),
            ("deep space nebula", "cosmic"),
            ("geometric city grid", "bands"),
            ("a close portrait", "radial"),
        ]:
            request = GenerationRequest(prompt=prompt, width=64, height=64, steps=4, seed=1)
            _, meta = engine._render(request, 1, _NullContext())
            styles[prompt] = meta["style"]
            self.assertEqual(meta["style"], expected, f"{prompt} -> {meta['style']}")
        self.assertEqual(len(set(styles.values())), 4)

    def test_colour_words_drive_the_palette(self):
        engine = ProceduralEngine()
        request = GenerationRequest(prompt="emerald green forest", width=64, height=64,
                                    steps=4, seed=2)
        _, meta = engine._render(request, 2, _NullContext())
        mid = meta["palette"][2]
        red, green, blue = (int(mid[i:i + 2], 16) for i in (1, 3, 5))
        self.assertGreater(green, red, f"expected a green-dominant palette, got {mid}")
        self.assertGreater(green, blue, f"expected a green-dominant palette, got {mid}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
