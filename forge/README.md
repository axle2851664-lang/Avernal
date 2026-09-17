# Avernal Forge

Image generation that runs entirely on your own machine — and serves its own
API, so other tools can use **Forge** as their image provider instead of a
hosted service.

No API keys. No accounts. No outbound requests. The server never contacts a
model hub, a telemetry endpoint, or anything else: if a model is not already on
your disk, Forge will not fetch it for you.

![The Forge studio](docs/studio.png)

---

## Quick start

```bash
python3 run.py
```

That is the whole setup. Open <http://127.0.0.1:8787> and generate. Forge needs
**nothing but Python 3.10+** — no pip install, no virtualenv, no Node, no
network. The server, the gallery database, the PNG encoder and the built-in
renderer are all standard library.

Generated images land in `~/.avernal-forge/outputs`, indexed in a SQLite
gallery beside them.

---

## Two engines

| Engine | Needs | What it is |
| --- | --- | --- |
| **Procedural** (built in) | nothing | A prompt-conditioned renderer. Reads your prompt for colour, mood and composition cues and paints layered domain-warped noise fields through a derived palette. |
| **Stable Diffusion** (optional) | `torch` + `diffusers` + weights on disk | Real SD 1.x / 2.x / SDXL inference, loaded from local files only. |

The procedural engine is **not a neural model and never pretends to be one**.
It exists so the app works the moment you clone it, and so there is always a
renderer when no weights are installed. It is deterministic: the same prompt and
seed always produce the same image, and prompts genuinely steer the result —
`emerald forest` is green, `crimson sunset` is warm, `geometric city grid`
composes as architecture, `cosmic nebula` gets stars.

### Turning on real Stable Diffusion

```bash
pip install -r requirements-local-models.txt          # torch, diffusers, …
cp -r /path/to/stable-diffusion-model ~/.avernal-forge/models/
python3 run.py models                                 # confirm it was found
python3 run.py
```

Forge prefers **diffusers-format folders** (a directory containing
`model_index.json`) because those load cleanly offline. Single-file
`.safetensors` / `.ckpt` checkpoints also work, but they need their pipeline
config available locally too — pass `--sd-config /path/to/config-folder` if
loading one fails.

Models already in your Hugging Face cache are picked up automatically. Nothing
is ever downloaded: every load passes `local_files_only=True`.

Forge picks CUDA, then MPS, then CPU. Override with `--device`, and add
`--offload` if VRAM is tight.

---

## Forge as your image provider

The server speaks an OpenAI-compatible images API, so existing clients work
against it unchanged:

```bash
curl -X POST http://127.0.0.1:8787/v1/images/generations \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "a crimson desert horizon", "size": "512x512", "n": 1}'
```

```python
from openai import OpenAI

# Any api_key value works: Forge is local and unauthenticated by default.
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="local")
image = client.images.generate(prompt="a crimson desert horizon", size="512x512")
```

`response_format` accepts `b64_json` (default) or `url`. Extra fields —
`steps`, `guidance`, `seed`, `sampler`, `negative`, `engine` — are honoured when
present and ignored by clients that do not send them.

---

## API reference

### Native API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness, active engine, device, queue depth |
| `GET` | `/api/config` | Engines, models, samplers, limits, defaults, stats |
| `GET` | `/api/models` | Models found on this machine |
| `POST` | `/api/generate` | Queue a job → `202` with the job record |
| `GET` | `/api/jobs` · `/api/jobs/{id}` | Job status and progress |
| `POST` | `/api/jobs/{id}/cancel` | Cancel a queued or running job |
| `GET` | `/api/events` | Server-sent events: live progress and finished images |
| `GET` | `/api/gallery` | Paged gallery — `limit`, `offset`, `q`, `favorites` |
| `GET` | `/api/gallery/{id}` | One image record |
| `POST` | `/api/gallery/{id}/favorite` | Star or unstar |
| `DELETE` | `/api/gallery/{id}` | Delete the record and the file on disk |
| `GET` | `/images/{file}` | The generated PNGs |

### Provider API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/images/generations` | OpenAI-compatible, blocks until the image is ready |
| `GET` | `/v1/models` | OpenAI-compatible model listing |

Generation parameters and their limits: `prompt` (required), `negative`,
`width`/`height` (64–4096, rounded to a multiple of 8, max 8.4M pixels total),
`steps` (1–150), `guidance` (0–30), `batch`/`n` (1–8), `seed` (−1 for random),
`sampler`, `model`, `engine`, plus `init_image` + `strength` for img2img on the
diffusers engine.

Every PNG carries its own recipe as embedded metadata, so an image dragged out
of the outputs folder still knows the prompt, seed and settings that made it.

---

## Command line

```bash
python3 run.py                                  # start the studio (default)
python3 run.py serve --port 9000 --open         # pick a port, open a browser
python3 run.py generate "a quiet harbour at dusk" -o harbour.png
python3 run.py generate "twin moons" -n 4 --size 768x512 --steps 30 --seed 42
python3 run.py models                           # what weights are on this machine
```

Useful `serve` flags:

| Flag | Effect |
| --- | --- |
| `--host` / `--port` | Bind address (defaults to `127.0.0.1`, local only) |
| `--engine` | `auto`, `diffusers` or `procedural` |
| `--model` | Model id, name or path to prefer |
| `--device` | `auto`, `cuda`, `mps`, `cpu` |
| `--models` | Extra folder to scan for weights |
| `--workers` | Concurrent renders (keep at 1 for a single GPU) |
| `--api-key` | Require a bearer token on API requests |
| `--cors` | Allow cross-origin browser calls (off by default) |
| `--offload` | Enable model CPU offload to save VRAM |

---

## Staying local

- Forge binds to `127.0.0.1` by default: nothing outside your machine can reach it.
- CORS is **off** unless you pass `--cors`, so a web page you happen to be
  visiting cannot drive your Forge instance.
- Model loading is `local_files_only=True` on every path.
- There is no telemetry, no update check and no analytics.

If you bind to a LAN address, set `--api-key` as well — the server warns you at
startup when you do not. The studio prompts for that key and stores it in the
browser; the event stream accepts it as a `?key=` parameter because
`EventSource` cannot send headers.

---

## Layout

```
forge/
├── run.py                       zero-install launcher
├── avernal_forge/
│   ├── __main__.py              CLI: serve / generate / models
│   ├── config.py                paths and generation limits
│   ├── server.py                HTTP server, REST + OpenAI-compatible API
│   ├── jobs.py                  queue, progress, cancellation, event bus
│   ├── storage.py               SQLite gallery
│   ├── models.py                local weight discovery (no network)
│   ├── png.py                   PNG encoder with embedded metadata
│   └── engines/
│       ├── base.py              engine contract
│       ├── procedural.py        built-in renderer, zero dependencies
│       └── diffusers_engine.py  local Stable Diffusion / SDXL
├── web/                         the studio UI (no build step, no CDN)
└── tests/test_smoke.py          end-to-end tests
```

## Tests

```bash
python3 tests/test_smoke.py
```

28 tests covering generation, batching, reproducibility, cancellation, the
gallery, the provider API, request validation, path-traversal protection and
API-key enforcement — all against a live server, with no dependencies.
