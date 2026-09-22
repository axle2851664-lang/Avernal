"""The diffusers engines, driven against fake torch and diffusers.

These are the code paths a machine without a GPU cannot otherwise reach - and
the ones where a rename silently broke image generation. The fakes implement
only what the engines touch, so the engines' own logic runs for real.

What this proves: the wiring holds. What it cannot prove: that the imagery is
any good. Only real weights show that.
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

import fake_torch  # noqa: E402

from avernal_forge.config import Config  # noqa: E402
from avernal_forge.engines.base import GenerationRequest  # noqa: E402
from avernal_forge.png import PNG_MAGIC, read_apng_info, read_size  # noqa: E402


class _NullContext:
    def __init__(self) -> None:
        self.steps: list[tuple[int, int, str]] = []

    def progress(self, step: int, total: int, note: str = "") -> None:
        self.steps.append((step, total, note))

    def check_cancel(self) -> None: ...


class EngineTestCase(unittest.TestCase):
    #: "image" for an SD-style folder, "video" for a video pipeline.
    media = "image"
    pipeline_class = "StableDiffusionXLPipeline"

    def setUp(self) -> None:
        self.saved = fake_torch.install()
        self.home = Path(tempfile.mkdtemp(prefix="forge-engine-"))
        self.config = Config(home=self.home, quiet=True)
        self.config.ensure_dirs()
        folder = self.config.models_dir / "test-model"
        folder.mkdir(parents=True)
        (folder / "model_index.json").write_text(
            json.dumps({"_class_name": self.pipeline_class})
        )

    def tearDown(self) -> None:
        fake_torch.restore(self.saved)
        shutil.rmtree(self.home, ignore_errors=True)


class TestStableDiffusionEngine(EngineTestCase):
    def engine(self):
        from avernal_forge.engines.diffusers_engine import DiffusersEngine

        return DiffusersEngine(self.config)

    def request(self, **overrides):
        payload = dict(prompt="a portrait of a person", width=64, height=64,
                       steps=4, seed=7)
        payload.update(overrides)
        return GenerationRequest(**payload)

    def test_it_reports_itself_available_and_finds_the_model(self):
        engine = self.engine()
        self.assertTrue(engine.available())
        self.assertEqual(engine.unavailable_reason(), "")
        self.assertEqual([m["id"] for m in engine.models()], ["folder:test-model"])

    def test_it_actually_produces_a_png(self):
        # The regression that started this: the engine yielded its media with a
        # field name that no longer existed, so every render raised TypeError.
        media = list(self.engine().generate(self.request(), _NullContext()))[0]
        self.assertEqual(media.kind, "image")
        self.assertEqual(media.mime, "image/png")
        self.assertEqual(media.ext, ".png")
        self.assertTrue(media.data.startswith(PNG_MAGIC))
        self.assertEqual(read_size(media.data), (64, 64))
        self.assertEqual(media.seed, 7)

    def test_a_batch_walks_the_seed(self):
        media = list(self.engine().generate(self.request(batch=3), _NullContext()))
        self.assertEqual([m.seed for m in media], [7, 8, 9])

    def test_progress_reaches_the_context(self):
        ctx = _NullContext()
        list(self.engine().generate(self.request(steps=5), ctx))
        self.assertTrue(any(note == "sampling" for _, _, note in ctx.steps))

    def test_the_preset_is_what_reaches_the_pipeline(self):
        from fake_torch import FakePipeline

        list(self.engine().generate(
            self.request(style="portrait", negative="cartoon"), _NullContext()))
        call = FakePipeline.last_call
        self.assertIn("85mm", call["prompt"])
        self.assertTrue(call["prompt"].startswith("a portrait of a person,"))
        self.assertTrue(call["negative_prompt"].startswith("cartoon,"))
        self.assertIn("extra fingers", call["negative_prompt"])

    def test_size_and_steps_reach_the_pipeline(self):
        from fake_torch import FakePipeline

        list(self.engine().generate(
            self.request(width=128, height=96, steps=9, guidance=6.5),
            _NullContext()))
        call = FakePipeline.last_call
        self.assertEqual((call["width"], call["height"]), (128, 96))
        self.assertEqual(call["num_inference_steps"], 9)
        self.assertEqual(call["guidance_scale"], 6.5)

    def test_the_detail_pass_runs_and_is_recorded(self):
        media = list(self.engine().generate(
            self.request(detail_pass=True, detail_scale=1.5), _NullContext()))[0]
        self.assertTrue(media.meta["detail_pass"])
        self.assertEqual(media.meta["note"], "")
        # The second pass renders larger, and that is the size that comes back.
        self.assertEqual(read_size(media.data), (96, 96))

    def test_img2img_uses_the_starting_image_and_skips_the_detail_pass(self):
        from fake_torch import FakePipeline

        png = list(self.engine().generate(self.request(), _NullContext()))[0].data
        # Decoding a starting image genuinely needs Pillow, which real
        # diffusers installs alongside itself.
        fake_torch.restore(self.saved)
        self.saved = fake_torch.install(with_pil=True)
        media = list(self.engine().generate(
            self.request(init_image=png, strength=0.4, detail_pass=True),
            _NullContext()))[0]
        self.assertEqual(media.meta["mode"], "img2img")
        self.assertFalse(media.meta["detail_pass"])
        self.assertEqual(FakePipeline.last_call["strength"], 0.4)

    def test_a_filtered_result_is_explained_rather_than_returned_blank(self):
        from avernal_forge.engines import diffusers_engine

        engine = self.engine()
        # Take it from __dict__ so the staticmethod descriptor itself is
        # restored; putting back the plain function would rebind it as an
        # instance method and break every test that ran afterwards.
        original = diffusers_engine.DiffusersEngine.__dict__["_was_filtered"]
        diffusers_engine.DiffusersEngine._was_filtered = staticmethod(lambda r: True)
        try:
            with self.assertRaises(RuntimeError) as ctx:
                list(engine.generate(self.request(), _NullContext()))
            self.assertIn("safety checker", str(ctx.exception))
        finally:
            diffusers_engine.DiffusersEngine._was_filtered = original

        # And the restore must actually hold for the next caller.
        media = list(engine.generate(self.request(), _NullContext()))[0]
        self.assertTrue(media.data.startswith(PNG_MAGIC))

    def test_an_unknown_model_name_says_what_was_found(self):
        with self.assertRaises(RuntimeError) as ctx:
            list(self.engine().generate(
                self.request(model="no-such-model"), _NullContext()))
        self.assertIn("folder:test-model", str(ctx.exception))

    def test_metadata_is_embedded_in_the_file(self):
        media = list(self.engine().generate(self.request(), _NullContext()))[0]
        self.assertIn(b"Avernal Forge", media.data)


class TestVideoDiffusionEngine(EngineTestCase):
    media = "video"
    pipeline_class = "AnimateDiffPipeline"

    def engine(self):
        from avernal_forge.engines.diffusers_video import DiffusersVideoEngine

        return DiffusersVideoEngine(self.config)

    def request(self, **overrides):
        payload = dict(prompt="a drifting coastline", width=64, height=64,
                       steps=4, seed=3, kind="video", frames=5, fps=8)
        payload.update(overrides)
        return GenerationRequest(**payload)

    def test_it_finds_only_video_weights(self):
        engine = self.engine()
        self.assertTrue(engine.available())
        self.assertEqual([m["media"] for m in engine.models()], ["video"])

    def test_the_still_engine_ignores_video_weights(self):
        from avernal_forge.engines.diffusers_engine import DiffusersEngine

        self.assertEqual(DiffusersEngine(self.config).models(), [])

    def test_it_produces_a_playable_clip(self):
        media = list(self.engine().generate(self.request(), _NullContext()))[0]
        self.assertEqual(media.kind, "video")
        self.assertEqual(media.frames, 5)
        self.assertEqual(media.fps, 8)
        # No ffmpeg here, so it must fall back to animated PNG rather than fail.
        self.assertEqual(read_apng_info(media.data)["frames"], 5)

    def test_frame_count_reaches_the_pipeline(self):
        from fake_torch import FakePipeline

        list(self.engine().generate(self.request(frames=7), _NullContext()))
        self.assertEqual(FakePipeline.last_call["num_frames"], 7)

    def test_the_preset_reaches_the_video_pipeline_too(self):
        from fake_torch import FakePipeline

        list(self.engine().generate(self.request(style="cinematic"), _NullContext()))
        self.assertIn("cinematic", FakePipeline.last_call["prompt"])

    def test_metadata_records_how_it_was_made(self):
        media = list(self.engine().generate(self.request(), _NullContext()))[0]
        self.assertEqual(media.meta["mode"], "text-to-video")
        self.assertEqual(media.meta["pipeline"], "AnimateDiffPipeline")
        self.assertEqual(media.meta["style"], "none")


class TestRegistryWithWeightsPresent(EngineTestCase):
    def test_a_still_request_picks_the_still_engine(self):
        from avernal_forge.engines import EngineRegistry

        registry = EngineRegistry(self.config)
        self.assertEqual(registry.default().id, "diffusers")

    def test_a_clip_request_picks_a_video_capable_engine(self):
        from avernal_forge.engines import EngineRegistry

        registry = EngineRegistry(self.config)
        engine = registry.default(want_video=True)
        self.assertTrue(engine.supports_video)
        # With only image weights installed, that is the procedural engine.
        self.assertEqual(engine.id, "procedural")


if __name__ == "__main__":
    unittest.main(verbosity=2)
