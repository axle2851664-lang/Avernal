#!/usr/bin/env python3
import json
import sys
from pathlib import Path
from diffusers import StableDiffusionPipeline
import torch

output_dir = Path(__file__).resolve().parents[2] / "generated_images"
output_dir.mkdir(parents=True, exist_ok=True)

device = "cuda" if torch.cuda.is_available() else "cpu"
dtype = torch.float16 if torch.cuda.is_available() else torch.float32

try:
    prompt = sys.argv[1] if len(sys.argv) > 1 else "a beautiful landscape"
    num_inference_steps = int(sys.argv[2]) if len(sys.argv) > 2 else 20
    guidance_scale = float(sys.argv[3]) if len(sys.argv) > 3 else 7.5
    seed = int(sys.argv[4]) if len(sys.argv) > 4 else 42

    model_id = "stable-diffusion-v1-5/stable-diffusion-v1-5"

    pipe = StableDiffusionPipeline.from_pretrained(
        model_id,
        torch_dtype=dtype,
        safety_checker=None,
    )
    pipe = pipe.to(device)

    generator = torch.Generator(device).manual_seed(seed)

    image = pipe(
        prompt,
        num_inference_steps=num_inference_steps,
        guidance_scale=guidance_scale,
        generator=generator,
        height=512,
        width=512,
    ).images[0]

    filename = f"image_{seed}.png"
    image_path = output_dir / filename
    image.save(image_path)

    result = {
        "success": True,
        "path": str(image_path),
        "filename": filename,
        "prompt": prompt,
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
