"""Video: the encoders, the animation, storage, and the API end to end.

ffmpeg is not present in every environment (it is not in this repo's CI), so
the MP4 path is covered by its refusal behaviour and the APNG path - which
needs nothing but zlib - is covered fully.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import sqlite3
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from avernal_forge import models as model_registry  # noqa: E402
from avernal_forge.config import Config  # noqa: E402
from avernal_forge.engines import EngineRegistry, GenerationRequest  # noqa: E402
from avernal_forge.engines.procedural import ProceduralEngine  # noqa: E402
from avernal_forge.png import PNG_MAGIC, read_apng_info, read_size  # noqa: E402
from avernal_forge.server import ApiError, build_request, serve  # noqa: E402
from avernal_forge.storage import Gallery, ReferenceStore  # noqa: E402
from avernal_forge.video import (  # noqa: E402
    available_formats,
    default_format,
    encode_video,
    ffmpeg_path,
)


class _NullContext:
    def progress(self, step: int, total: int, note: str = "") -> None: ...
    def check_cancel(self) -> None: ...


def rgb_frames(count: int, width: int, height: int) -> list[bytes]:
    return [
        bytes([(i * 37) % 256, 90, 160] * (width * height)) for i in range(count)
    ]


class TestApngEncoder(unittest.TestCase):
    def test_structure_matches_the_frame_count(self):
        data = encode_video(8, 8, rgb_frames(5, 8, 8), fps=12, wanted="apng")[0]
        info = read_apng_info(data)
        # The first frame rides in IDAT, so there is one fewer fdAT than fcTL.
        self.assertEqual(info["frames"], 5)
        self.assertEqual(info["fctl"], 5)
        self.assertEqual(info["fdat"], 4)
        self.assertEqual(info["plays"], 0)          # 0 means loop forever

    def test_an_apng_is_still_a_readable_png(self):
        data = encode_video(12, 6, rgb_frames(3, 12, 6), wanted="apng")[0]
        self.assertTrue(data.startswith(PNG_MAGIC))
        self.assertEqual(read_size(data), (12, 6))

    def test_metadata_is_embedded(self):
        data = encode_video(4, 4, rgb_frames(2, 4, 4), wanted="apng",
                            text={"Prompt": "a drifting field"})[0]
        self.assertIn(b"a drifting field", data)

    def test_bad_input_is_rejected(self):
        with self.assertRaises(ValueError):
            encode_video(4, 4, [], wanted="apng")
        with self.assertRaises(ValueError):
            encode_video(4, 4, [b"\x00" * 3], wanted="apng")

    def test_format_selection(self):
        self.assertIn("apng", available_formats())
        self.assertEqual("mp4" in available_formats(), bool(ffmpeg_path()))
        self.assertEqual(default_format(), "mp4" if ffmpeg_path() else "apng")
        with self.assertRaises(ValueError):
            encode_video(4, 4, rgb_frames(2, 4, 4), wanted="avi")

    @unittest.skipIf(ffmpeg_path(), "ffmpeg is installed here")
    def test_mp4_refuses_clearly_without_ffmpeg(self):
        with self.assertRaises(RuntimeError) as ctx:
            encode_video(4, 4, rgb_frames(2, 4, 4), wanted="mp4")
        self.assertIn("ffmpeg", str(ctx.exception))

    @unittest.skipUnless(ffmpeg_path(), "ffmpeg is not installed here")
    def test_mp4_is_produced_when_ffmpeg_exists(self):
        data, fmt, mime, ext = encode_video(16, 16, rgb_frames(6, 16, 16), fps=10,
                                            wanted="mp4")
        self.assertEqual((fmt, mime, ext), ("mp4", "video/mp4", ".mp4"))
        self.assertIn(b"ftyp", data[:32])

    def test_auto_falls_back_to_apng_when_ffmpeg_is_missing(self):
        data, fmt, _, _ = encode_video(8, 8, rgb_frames(3, 8, 8), wanted="auto")
        self.assertEqual(fmt, "mp4" if ffmpeg_path() else "apng")
        self.assertTrue(data)


class TestProceduralAnimation(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = ProceduralEngine()

    def request(self, **overrides):
        payload = dict(prompt="soft pastel abstract fluid swirl", width=96, height=96,
                       steps=10, seed=5, kind="video", frames=8, fps=8)
        payload.update(overrides)
        return GenerationRequest(**payload)

    def test_the_engine_advertises_video(self):
        self.assertTrue(self.engine.supports_video)
        self.assertTrue(self.engine.supports_image)

    def test_frame_count_is_honoured(self):
        frames, _ = self.engine._render_sequence(self.request(), 5, _NullContext(), 8)
        self.assertEqual(len(frames), 8)
        self.assertEqual(len({bytes(f) for f in frames}), 8)   # all different

    def test_the_first_frame_equals_the_still_for_that_seed(self):
        still, _ = self.engine._render(self.request(kind="image"), 5, _NullContext())
        frames, _ = self.engine._render_sequence(self.request(), 5, _NullContext(), 8)
        self.assertEqual(frames[0], still)

    def test_the_loop_has_no_seam(self):
        count = 8
        frames, _ = self.engine._render_sequence(self.request(), 5, _NullContext(), count)

        def distance(a: bytes, b: bytes) -> float:
            return sum(abs(a[i] - b[i]) for i in range(0, len(a), 97))

        # Including the wrap from the last frame back to the first: if the loop
        # had a seam, that step would be far larger than the others.
        steps = [distance(frames[i], frames[(i + 1) % count]) for i in range(count)]
        self.assertLess(max(steps), min(steps) * 3.0,
                        f"uneven motion across the loop: {steps}")

    def test_motion_zero_holds_still(self):
        frames, _ = self.engine._render_sequence(
            self.request(motion=0.0), 5, _NullContext(), 4)
        self.assertEqual(len({bytes(f) for f in frames}), 1)

    def test_more_motion_moves_further(self):
        def travel(motion: float) -> int:
            frames, _ = self.engine._render_sequence(
                self.request(motion=motion), 5, _NullContext(), 4)
            return sum(abs(frames[0][i] - frames[2][i])
                       for i in range(0, len(frames[0]), 97))

        self.assertGreater(travel(1.5), travel(0.4))

    def test_the_same_seed_gives_the_same_clip(self):
        first = self.engine._render_sequence(self.request(), 5, _NullContext(), 4)[0]
        second = self.engine._render_sequence(self.request(), 5, _NullContext(), 4)[0]
        self.assertEqual(first, second)

    def test_generate_emits_a_clip(self):
        media = list(self.engine.generate(self.request(), _NullContext()))[0]
        self.assertEqual(media.kind, "video")
        self.assertTrue(media.is_video)
        self.assertEqual(media.frames, 8)
        self.assertEqual(media.fps, 8)
        self.assertEqual(read_apng_info(media.data)["frames"], 8)

    def test_generate_still_emits_stills(self):
        media = list(self.engine.generate(
            self.request(kind="image"), _NullContext()))[0]
        self.assertEqual(media.kind, "image")
        self.assertEqual((media.mime, media.ext), ("image/png", ".png"))
        self.assertEqual(media.frames, 1)


class TestVideoRequestValidation(unittest.TestCase):
    def test_video_fields_are_clamped(self):
        request = build_request({"prompt": "x", "kind": "video", "frames": 10**6,
                                 "fps": 10**6, "motion": 99})
        self.assertTrue(request.is_video)
        self.assertLessEqual(request.frames, 240)
        self.assertLessEqual(request.fps, 60)
        self.assertLessEqual(request.motion, 2.0)

    def test_unknown_kind_is_rejected(self):
        with self.assertRaises(ApiError):
            build_request({"prompt": "x", "kind": "gif"})

    def test_unknown_format_is_rejected(self):
        with self.assertRaises(ApiError):
            build_request({"prompt": "x", "kind": "video", "video_format": "avi"})

    def test_video_has_a_tighter_pixel_cap_than_stills(self):
        build_request({"prompt": "x", "width": 1600, "height": 1200})   # fine as a still
        with self.assertRaises(ApiError) as ctx:
            build_request({"prompt": "x", "kind": "video",
                           "width": 1600, "height": 1200})
        self.assertIn("for video", ctx.exception.message)

    @unittest.skipIf(ffmpeg_path(), "ffmpeg is installed here")
    def test_asking_for_mp4_without_ffmpeg_explains_itself(self):
        with self.assertRaises(ApiError) as ctx:
            build_request({"prompt": "x", "kind": "video", "video_format": "mp4"})
        self.assertIn("ffmpeg", ctx.exception.message)


class TestEngineSelection(unittest.TestCase):
    def setUp(self) -> None:
        self.home = Path(tempfile.mkdtemp(prefix="forge-video-"))
        self.config = Config(home=self.home, quiet=True)
        self.config.ensure_dirs()
        self.registry = EngineRegistry(self.config)

    def tearDown(self) -> None:
        shutil.rmtree(self.home, ignore_errors=True)

    def test_video_requests_only_reach_video_capable_engines(self):
        self.assertTrue(self.registry.default(want_video=True).supports_video)

    def test_the_still_engine_is_never_picked_for_a_clip(self):
        with self.assertRaises(RuntimeError) as ctx:
            self.registry.resolve("diffusers", want_video=True)
        self.assertTrue(str(ctx.exception))

    def test_the_video_engine_is_never_picked_for_a_still(self):
        self.assertTrue(self.registry.default(want_video=False).supports_image)

    def test_video_pipelines_are_classified(self):
        for class_name in ("StableVideoDiffusionPipeline", "AnimateDiffPipeline",
                           "CogVideoXPipeline", "LTXPipeline", "WanPipeline",
                           "MochiPipeline", "HunyuanVideoPipeline"):
            self.assertEqual(model_registry.classify_pipeline(class_name), "video",
                             class_name)
        for class_name in ("StableDiffusionPipeline", "StableDiffusionXLPipeline",
                           "FluxPipeline"):
            self.assertEqual(model_registry.classify_pipeline(class_name), "image",
                             class_name)


class TestVideoStorage(unittest.TestCase):
    def setUp(self) -> None:
        self.home = Path(tempfile.mkdtemp(prefix="forge-store-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.home, ignore_errors=True)

    def test_a_pre_video_gallery_is_migrated_in_place(self):
        db = self.home / "legacy.db"
        conn = sqlite3.connect(db)
        conn.executescript(
            "CREATE TABLE images (id TEXT PRIMARY KEY, created_at REAL NOT NULL, "
            "filename TEXT NOT NULL, prompt TEXT NOT NULL DEFAULT '', "
            "negative TEXT NOT NULL DEFAULT '', engine TEXT NOT NULL DEFAULT '', "
            "model TEXT NOT NULL DEFAULT '', sampler TEXT NOT NULL DEFAULT '', "
            "width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0, "
            "steps INTEGER NOT NULL DEFAULT 0, guidance REAL NOT NULL DEFAULT 0, "
            "seed INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, "
            "favorite INTEGER NOT NULL DEFAULT 0, job_id TEXT NOT NULL DEFAULT '', "
            "extra TEXT NOT NULL DEFAULT '{}');"
            "INSERT INTO images (id, created_at, filename, prompt) "
            "VALUES ('old', 1.0, 'old.png', 'from the previous release');"
        )
        conn.commit()
        conn.close()

        gallery = Gallery(db, self.home / "out")
        record = gallery.get("old")
        self.assertEqual(record["kind"], "image")
        self.assertEqual(record["frames"], 1)
        self.assertFalse(record["is_video"])
        self.assertEqual(record["prompt"], "from the previous release")

    def test_clips_round_trip_with_their_extension(self):
        gallery = Gallery(self.home / "f.db", self.home / "out")
        clip = gallery.add(
            {"id": "c1", "prompt": "drift", "kind": "video", "mime": "video/mp4",
             "extension": ".mp4", "frames": 24, "fps": 12}, b"fake-mp4")
        self.assertTrue(clip["url"].endswith(".mp4"))
        self.assertTrue(clip["is_video"])
        self.assertEqual(gallery.get("c1")["frames"], 24)
        self.assertEqual(gallery.stats()["videos"], 1)

    def test_a_hostile_extension_cannot_escape_the_outputs_folder(self):
        gallery = Gallery(self.home / "f.db", self.home / "out")
        record = gallery.add({"id": "c2", "extension": "../../etc/passwd"}, b"x")
        self.assertEqual(record["filename"], "c2.png")

    def test_a_video_reference_is_not_saved_as_a_jpg(self):
        store = ReferenceStore(self.home / "f.db", self.home / "refs")
        # Mastodon gifv attachments are MP4s; these used to land as .jpg and
        # then refuse to play.
        clip = store.add({"source": "mastodon", "title": "loop"},
                         b"\x00\x00\x00 ftypmp42", "video/mp4")
        self.assertTrue(clip["local_url"].endswith(".mp4"))
        self.assertEqual(clip["kind"], "video")
        self.assertTrue(clip["is_video"])

        still = store.add({"source": "commons", "title": "photo"},
                          b"\x89PNG", "image/png")
        self.assertTrue(still["local_url"].endswith(".png"))
        self.assertEqual(still["kind"], "image")


class TestVideoApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.home = Path(tempfile.mkdtemp(prefix="forge-vapi-"))
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
        with urllib.request.urlopen(request, timeout=120) as response:
            body = response.read()
            return response.status, (json.loads(body) if body else None)

    def wait(self, job):
        deadline = time.time() + 180
        while time.time() < deadline:
            _, job = self.api(f"/api/jobs/{job['id']}")
            if job["status"] in ("done", "error", "cancelled"):
                return job
            time.sleep(0.05)
        self.fail("clip did not finish in time")

    def test_config_advertises_video_support(self):
        _, config = self.api("/api/config")
        self.assertTrue(config["video"]["supported"])
        self.assertIn("apng", config["video"]["formats"])
        self.assertIn("max_frames", config["limits"])

    def test_generating_a_clip_end_to_end(self):
        status, job = self.api("/api/generate", "POST", {
            "prompt": "a drifting horizon", "kind": "video",
            "width": 96, "height": 96, "steps": 8, "frames": 5, "fps": 8,
        })
        self.assertEqual(status, 202)
        self.assertEqual(job["request"]["kind"], "video")

        job = self.wait(job)
        self.assertEqual(job["status"], "done", job.get("error"))
        record = job["images"][0]
        self.assertEqual(record["kind"], "video")
        self.assertTrue(record["is_video"])
        self.assertEqual(record["frames"], 5)

        with urllib.request.urlopen(self.base + record["url"], timeout=60) as response:
            data = response.read()
        self.assertEqual(read_apng_info(data)["frames"], 5)
        self.assertEqual(read_size(data), (96, 96))

    def test_a_clip_and_a_still_can_share_a_gallery(self):
        # Generates both itself rather than relying on another test having run.
        self.wait(self.api("/api/generate", "POST", {
            "prompt": "a still frame", "width": 64, "height": 64, "steps": 6})[1])
        self.wait(self.api("/api/generate", "POST", {
            "prompt": "a moving frame", "kind": "video", "width": 64, "height": 64,
            "steps": 6, "frames": 3, "fps": 6})[1])

        _, page = self.api("/api/gallery?limit=20")
        kinds = {item["kind"] for item in page["items"]}
        self.assertIn("image", kinds)
        self.assertIn("video", kinds)
        clip = [i for i in page["items"] if i["kind"] == "video"][0]
        still = [i for i in page["items"] if i["kind"] == "image"][0]
        self.assertTrue(clip["is_video"])
        self.assertFalse(still["is_video"])

    def test_an_oversized_clip_is_refused(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self.api("/api/generate", "POST", {
                "prompt": "x", "kind": "video", "width": 2048, "height": 2048})
        self.assertEqual(ctx.exception.code, 400)

    def test_asking_a_still_engine_for_a_clip_fails_cleanly(self):
        _, job = self.api("/api/generate", "POST", {
            "prompt": "x", "kind": "video", "width": 64, "height": 64,
            "steps": 4, "frames": 3, "engine": "diffusers"})
        job = self.wait(job)
        self.assertEqual(job["status"], "error")
        self.assertTrue(job["error"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
