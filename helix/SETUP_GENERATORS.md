# AI Image & Video Generator Setup

This guide will help you set up the completely local AI image and video generator powered by Stable Diffusion.

## Requirements

- Python 3.11+
- ~15GB free disk space (for model downloads)
- GPU recommended (CUDA 11.8+ for faster generation, ~6-8GB VRAM)

## Step 1: Install Python Dependencies

```bash
pip install -r requirements.txt
```

This installs:
- **diffusers**: Hugging Face model inference pipeline
- **torch**: PyTorch for GPU/CPU computation
- **transformers**: Model loading and tokenization
- **pillow**: Image processing
- **opencv-python**: Video processing
- **imageio**: GIF animation export

**Initial Setup**: The first time you generate an image or video, the models will download automatically (~5GB). This may take 5-15 minutes depending on your internet connection.

## Step 2: Start the Server

```bash
npm run server
```

The Express server will start on `http://localhost:3000`.

## Step 3: Generate Images

### Generate an image from a text prompt:

```bash
curl -X POST http://localhost:3000/generate/image \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "a beautiful sunset over mountains",
    "steps": 20,
    "guidance": 7.5,
    "seed": 42
  }'
```

**Parameters**:
- `prompt` (required): Text description of the image
- `steps` (optional, default: 20): Inference steps (higher = better quality, slower)
- `guidance` (optional, default: 7.5): Guidance scale (higher = more prompt adherence)
- `seed` (optional): Random seed for reproducibility

**Response**:
```json
{
  "success": true,
  "path": "generated_images/image_42.png",
  "filename": "image_42.png",
  "prompt": "a beautiful sunset over mountains",
  "seed": 42,
  "device": "cuda"
}
```

Generated images are saved to `generated_images/` directory.

## Step 4: Generate Videos

### Generate an animated video from a text prompt:

```bash
curl -X POST http://localhost:3000/generate/video \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "a camera panning over a beautiful landscape",
    "frames": 8,
    "steps": 25,
    "seed": 42
  }'
```

**Parameters**:
- `prompt` (required): Text description of the animation
- `frames` (optional, default: 8): Number of frames in video (higher = smoother, slower)
- `steps` (optional, default: 25): Inference steps per frame
- `seed` (optional): Random seed for reproducibility

**Response**:
```json
{
  "success": true,
  "path": "generated_videos/video_42.gif",
  "filename": "video_42.gif",
  "prompt": "a camera panning over a beautiful landscape",
  "frames": 8,
  "seed": 42,
  "device": "cuda"
}
```

Generated videos are saved as GIF animations in `generated_videos/` directory.

## Performance Tips

### CPU Mode (Slower)
- Generation takes 2-5 minutes per image
- Not recommended for video generation

### GPU Mode (Faster)
- Image generation: 30-60 seconds per image
- Video generation: 2-5 minutes for 8 frames
- Requires CUDA-capable GPU with 6GB+ VRAM

### Optimization Options
1. **Reduce quality for speed**:
   - Lower `steps` (minimum 10) for faster generation
   - Reduce `guidance` (5.0-7.5 range) for less control

2. **Increase quality for detail**:
   - Increase `steps` (up to 50) for higher quality
   - Increase `guidance` (7.5-15) for better prompt adherence

## Troubleshooting

### "Cannot find module 'torch'"
Ensure Python dependencies are installed:
```bash
pip install -r requirements.txt
```

### "CUDA out of memory"
- Reduce image/video size (edit `height` and `width` in Python scripts)
- Lower `num_inference_steps` in your request
- Generate on CPU (slower but works on all devices)

### "Model download failed"
Check your internet connection. Models are cached after first download.

## Supported Models

Currently configured for:
- **Image**: Stable Diffusion v1.5 (runwayml/stable-diffusion-v1-5)
- **Video**: AnimateDiff with Stable Diffusion v1.5

Future enhancements:
- Stable Diffusion XL (higher quality, slower)
- SDXL Turbo (fast generation, lower quality)
- Custom fine-tuned models
