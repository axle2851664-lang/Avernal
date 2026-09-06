#!/usr/bin/env python3
import json
import sys
from pathlib import Path
from diffusers import AnimateDiffPipeline, MotionAdapter, DDIMScheduler
from diffusers.utils import export_to_gif
import torch

output_dir = Path("generated_videos")
output_dir.mkdir(exist_ok=True)

device = "cuda" if torch.cuda.is_available() else "cpu"
dtype = torch.float16 if torch.cuda.is_available() else torch.float32

try:
    prompt = sys.argv[1] if len(sys.argv) > 1 else "a camera panning over a beautiful landscape"
    num_frames = int(sys.argv[2]) if len(sys.argv) > 2 else 8
    num_inference_steps = int(sys.argv[3]) if len(sys.argv) > 3 else 25
    seed = int(sys.argv[4]) if len(sys.argv) > 4 else 42

    motion_adapter = MotionAdapter.from_pretrained(
        "guoyww/animatediff-motion-adapter-v1-5-2",
        torch_dtype=dtype
    )

    model_id = "runwayml/stable-diffusion-v1-5"
    pipe = AnimateDiffPipeline.from_pretrained(
        model_id,
        motion_adapter=motion_adapter,
        torch_dtype=dtype,
    )
    pipe.scheduler = DDIMScheduler(
        num_train_timesteps=1000,
        beta_start=0.00085,
        beta_end=0.012,
        beta_schedule="linear",
        steps_offset=1,
    )
    pipe = pipe.to(device)

    generator = torch.Generator(device).manual_seed(seed)

    frames = pipe(
        prompt=prompt,
        num_frames=num_frames,
        num_inference_steps=num_inference_steps,
        generator=generator,
        height=512,
        width=512,
    ).frames[0]

    filename = f"video_{seed}.gif"
    video_path = output_dir / filename
    export_to_gif(frames, str(video_path))

    result = {
        "success": True,
        "path": str(video_path),
        "filename": filename,
        "prompt": prompt,
        "frames": num_frames,
        "seed": seed,
        "device": device
    }
    print(json.dumps(result))

except Exception as e:
    result = {
        "success": False,
        "error": str(e)
    }
    print(json.dumps(result), file=sys.stderr)
    sys.exit(1)
