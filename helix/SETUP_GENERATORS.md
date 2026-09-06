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
- **accelerate**: Low-memory model loading (required by diffusers)
- **pillow**: Image processing
- **opencv-python**: Video processing
- **imageio**: GIF animation export

Versions are pinned because `diffusers` 0.28 does not work with
`huggingface_hub` 0.26 or newer. Install with the pins as written.

**Initial Setup**: The first time you generate an image or video, the models will download automatically (~5GB). This may take 5-15 minutes depending on your internet connection.

## Step 2: Start the Server

```bash
npm run server
```

This compiles the TypeScript to `dist/` and starts the Express server on
`http://localhost:3000`. Confirm it is up:

```bash
curl http://localhost:3000/health
```

If the port is taken, the server exits with a message; set `PORT` to use another.

## Step 3: Open the generator

Go to **http://localhost:3000** in a browser. The server hosts the generator UI
itself: type a prompt, pick image or video, and the result renders on the page.

Use this in preference to driving the API from a page hosted elsewhere. The UI
and the API share an origin here, so no CORS or private-network rules apply —
which removes the most common reason the buttons appear to do nothing.

### Driving it from the Helix Galaxy UI instead

The Galaxy UI is served from another origin, so the server must be told to
accept it. `https://claude.ai` is allowed by default. If your requests are
still blocked, the server console prints the exact origin it rejected and the
command to permit it:

```
Blocked cross-origin request from https://example.origin.
To allow it: ALLOWED_ORIGINS="https://example.origin" npm run server
```

Only add origins you trust. This server holds your Gmail and YouTube tokens,
and any origin on the list can call every endpoint.

## Using it from your phone

By default the server listens on `127.0.0.1`, so only the machine running it
can connect. To reach it from a phone on the same Wi-Fi:

```bash
HELIX_TOKEN=$(openssl rand -hex 24) HOST=0.0.0.0 npm run server
```

It prints a URL with the token in it. Open that on the phone once; the token is
stored in a cookie, so later visits just work. The page adapts to a phone
screen.

The token is not optional. This server can read your mail, and the server
refuses to start on a non-loopback address without one.

### Reaching it from anywhere

Do not port-forward this to the internet. Even with a token, that publishes an
inbox-reading service to the whole world, and the built-in private-network
check would reject the traffic anyway.

Use [Tailscale](https://tailscale.com) instead: install it on both the computer
and the phone, and they join a private encrypted network no matter where either
one is. Tailscale hands out addresses in `100.64.0.0/10`, which the server's
private-network check already accepts, so this works with no further changes:

```bash
HELIX_TOKEN=$(openssl rand -hex 24) HOST=0.0.0.0 npm run server
```

Then open `http://<tailscale-name>:3000/?token=...` from the phone, anywhere in
the world. Nothing is exposed publicly.

## Running it from a USB drive

Copy the whole `helix/` directory onto the drive and launch it with `./helix.sh`
(or `helix.bat` on Windows) instead of `npm run server`. The launcher anchors
every path to its own directory, so the vault, the OAuth tokens, the generated
files and the ~5GB of model weights all live on the drive and travel with it.

Without this the weights go to `~/.cache/huggingface` on whichever machine
downloaded them, and the copy is inert elsewhere until it re-downloads them.

**Node and Python are not bundled.** They must already be installed on the host
machine; the launcher checks and says so if they are missing. Bundling them
would mean shipping a separate runtime per operating system, several hundred MB
each. The first run on a new machine also installs `node_modules`, which needs a
network connection once.

Use a fast USB 3.0 drive. Model weights are read on every startup, and loading
several GB over USB 2.0 is painfully slow.

## Capturing phone messages

`POST /ingest/message` writes a message into the vault as a note:

```bash
curl -X POST http://localhost:3000/ingest/message \
  -H "Content-Type: application/json" \
  -d '{"text":"Pick up milk","from":"Mom","source":"iMessage"}'
```

`text` is required; `from` and `source` are optional and get recorded under the
message.

### On iPhone

iOS gives no app access to SMS or iMessage — Apple blocks it, and no amount of
code here changes that. The one route that does not need a jailbreak is a
**Shortcuts personal automation**:

1. Shortcuts → Automation → New → **When I get a message**
2. Add action **Get Contents of URL**
3. URL: `http://<your-tailscale-name>:3000/ingest/message?token=<HELIX_TOKEN>`
4. Method **POST**, Request Body **JSON**, with a `text` field set to the
   message's Shortcut Input
5. Turn **Run Immediately** on, and notifications off

This only fires for messages that arrive while the automation is enabled; it
cannot reach back into your existing history. Apple offers no supported way to
export past iMessages from the phone itself.

The alternative, if you have a Mac signed into the same iMessage account, is to
read its `~/Library/Messages/chat.db` and post to the same endpoint. That does
see history, but needs a Mac that stays on and Full Disk Access granted.

## Step 4: Generate Images (API)

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
  "url": "/generated_images/image_42.png",
  "filename": "image_42.png",
  "prompt": "a beautiful sunset over mountains",
  "seed": 42,
  "device": "cuda"
}
```

Generated images are saved to `generated_images/` directory.

## Step 5: Generate Videos (API)

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
  "url": "/generated_videos/video_42.gif",
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

### Nothing is listening on localhost:3000
Run `npm run server` in the foreground and read the output. It prints
`Helix server running on http://localhost:3000` once it is actually up; if it
prints an error instead, that error is the reason. `curl http://localhost:3000/health`
confirms it independently.

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
- **Image**: Stable Diffusion v1.5 (stable-diffusion-v1-5/stable-diffusion-v1-5)
- **Video**: AnimateDiff with Stable Diffusion v1.5

The original `runwayml/stable-diffusion-v1-5` repo was removed from Hugging Face;
the community-maintained mirror above replaces it.

Future enhancements:
- Stable Diffusion XL (higher quality, slower)
- SDXL Turbo (fast generation, lower quality)
- Custom fine-tuned models
