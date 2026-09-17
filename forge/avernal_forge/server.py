"""The Forge HTTP server: web UI, REST API, and an OpenAI-compatible provider.

Built on the standard library only, so `python3 run.py` works on a machine with
nothing installed. Nothing here ever makes an outbound request.
"""

from __future__ import annotations

import base64
import json
import mimetypes
import queue
import re
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from . import __version__, config as cfg
from .engines import EngineRegistry, GenerationRequest
from .jobs import DONE, ERROR, JobQueue
from .storage import Gallery

MAX_BODY_BYTES = 48 * 1024 * 1024  # generous enough for an init image upload
SSE_PING_SECONDS = 15.0
SYNC_JOB_TIMEOUT = 900.0

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".webmanifest": "application/manifest+json",
}


class ApiError(Exception):
    def __init__(self, status: int, message: str, kind: str = "invalid_request_error"):
        super().__init__(message)
        self.status = status
        self.message = message
        self.kind = kind


# --------------------------------------------------------------- validation

def _clamp(value: Any, low: float, high: float, fallback: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if number != number:  # NaN
        return fallback
    return max(low, min(high, number))


def _parse_size(size: Any) -> tuple[int, int] | None:
    if not isinstance(size, str) or "x" not in size.lower():
        return None
    parts = re.split(r"[x×]", size.lower(), maxsplit=1)
    try:
        return int(parts[0]), int(parts[1])
    except (ValueError, IndexError):
        return None


def build_request(payload: dict[str, Any]) -> GenerationRequest:
    """Turn arbitrary JSON into a request we are willing to run."""
    prompt = payload.get("prompt") or ""
    if not isinstance(prompt, str):
        raise ApiError(400, "prompt must be a string")
    prompt = prompt.strip()
    if not prompt:
        raise ApiError(400, "prompt is required")
    if len(prompt) > cfg.MAX_PROMPT_CHARS:
        raise ApiError(400, f"prompt is longer than {cfg.MAX_PROMPT_CHARS} characters")

    width = payload.get("width")
    height = payload.get("height")
    parsed = _parse_size(payload.get("size"))
    if parsed and (width is None or height is None):
        width, height = parsed

    # Diffusion pipelines need multiples of 8; rounding beats a cryptic failure.
    width = int(_clamp(width, cfg.MIN_SIDE, cfg.MAX_SIDE, 512)) // 8 * 8
    height = int(_clamp(height, cfg.MIN_SIDE, cfg.MAX_SIDE, 512)) // 8 * 8
    width = max(cfg.MIN_SIDE, width)
    height = max(cfg.MIN_SIDE, height)
    if width * height > cfg.MAX_PIXELS:
        raise ApiError(
            400,
            f"{width}x{height} exceeds the {cfg.MAX_PIXELS:,} pixel limit",
        )

    seed = payload.get("seed", -1)
    try:
        seed = int(seed)
    except (TypeError, ValueError):
        seed = -1
    if seed < 0:
        seed = -1

    init_image = None
    raw_init = payload.get("init_image")
    if raw_init:
        if not isinstance(raw_init, str):
            raise ApiError(400, "init_image must be a base64 string")
        cleaned = raw_init.split(",", 1)[-1]
        try:
            init_image = base64.b64decode(cleaned, validate=False)
        except Exception as exc:
            raise ApiError(400, f"init_image is not valid base64: {exc}") from exc

    negative = payload.get("negative") or payload.get("negative_prompt") or ""
    model = payload.get("model")
    return GenerationRequest(
        prompt=prompt,
        negative=str(negative)[: cfg.MAX_PROMPT_CHARS],
        width=width,
        height=height,
        steps=int(_clamp(payload.get("steps"), 1, cfg.MAX_STEPS, 24)),
        guidance=round(_clamp(payload.get("guidance"), 0.0, 30.0, 7.0), 2),
        seed=seed,
        batch=int(_clamp(payload.get("batch", payload.get("n", 1)), 1, cfg.MAX_BATCH, 1)),
        sampler=str(payload.get("sampler") or "euler_a"),
        model=str(model) if model else None,
        init_image=init_image,
        strength=round(_clamp(payload.get("strength"), 0.05, 1.0, 0.6), 2),
    )


# ------------------------------------------------------------------- server

class ForgeServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, config: cfg.Config) -> None:
        self.config = config
        self.started_at = time.time()
        self.registry = EngineRegistry(config)
        self.gallery = Gallery(config.db_path, config.outputs_dir)
        self.jobs = JobQueue(
            self.registry, self.gallery, workers=config.workers, on_log=self.log
        )
        super().__init__((config.host, config.port), ForgeHandler)
        # With port 0 the OS picks the port; write it back so base_url is right.
        config.port = self.server_address[1]

    def log(self, message: str) -> None:
        if not self.config.quiet:
            print(f"[forge] {message}", flush=True)

    def shutdown(self) -> None:  # type: ignore[override]
        self.jobs.shutdown()
        super().shutdown()


Route = tuple[str, re.Pattern[str], str]


class ForgeHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"AvernalForge/{__version__}"
    sys_version = ""

    ROUTES: list[Route] = [
        ("GET", re.compile(r"^/api/health$"), "get_health"),
        ("GET", re.compile(r"^/api/config$"), "get_config"),
        ("GET", re.compile(r"^/api/models$"), "get_models"),
        ("GET", re.compile(r"^/api/gallery$"), "get_gallery"),
        ("GET", re.compile(r"^/api/gallery/(?P<image_id>[A-Za-z0-9_-]+)$"), "get_image_record"),
        ("POST", re.compile(r"^/api/gallery/(?P<image_id>[A-Za-z0-9_-]+)/favorite$"), "post_favorite"),
        ("DELETE", re.compile(r"^/api/gallery/(?P<image_id>[A-Za-z0-9_-]+)$"), "delete_image"),
        ("GET", re.compile(r"^/api/jobs$"), "get_jobs"),
        ("GET", re.compile(r"^/api/jobs/(?P<job_id>[A-Za-z0-9]+)$"), "get_job"),
        ("POST", re.compile(r"^/api/jobs/(?P<job_id>[A-Za-z0-9]+)/cancel$"), "post_cancel"),
        ("POST", re.compile(r"^/api/generate$"), "post_generate"),
        ("GET", re.compile(r"^/api/events$"), "get_events"),
        ("GET", re.compile(r"^/v1/models$"), "get_openai_models"),
        ("POST", re.compile(r"^/v1/images/generations$"), "post_openai_images"),
    ]

    # ---------------------------------------------------------------- plumbing

    @property
    def config(self) -> cfg.Config:
        return self.server.config  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:
        if not self.config.quiet:
            print(f"[forge] {self.address_string()} {fmt % args}", flush=True)

    def log_error(self, fmt: str, *args: Any) -> None:
        # Broken pipes from a closed browser tab are normal; don't shout.
        self.log_message(fmt, *args)

    def _cors_headers(self) -> None:
        if not self.config.cors:
            return
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")

    def _send(
        self,
        status: int,
        body: bytes,
        content_type: str,
        extra: dict[str, str] | None = None,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self._cors_headers()
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, data: Any, status: int = 200) -> None:
        body = json.dumps(data, default=str).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8",
                   {"Cache-Control": "no-store"})

    def send_error_json(self, status: int, message: str, kind: str) -> None:
        # Shaped like an OpenAI error so SDKs pointed at Forge report it well.
        self.send_json({"error": {"message": message, "type": kind}}, status)

    def read_json(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ApiError(400, "invalid Content-Length")
        if length > MAX_BODY_BYTES:
            raise ApiError(413, "request body too large")
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError(400, f"invalid JSON body: {exc}") from exc
        if not isinstance(data, dict):
            raise ApiError(400, "request body must be a JSON object")
        return data

    def query(self) -> dict[str, list[str]]:
        return urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)

    def query_one(self, key: str, default: str = "") -> str:
        return self.query().get(key, [default])[0]

    def _authorised(self, path: str) -> bool:
        key = self.config.api_key
        if not key or path == "/api/health":
            return True
        header = self.headers.get("Authorization", "")
        token = header[7:].strip() if header.lower().startswith("bearer ") else ""
        if not token:
            token = self.headers.get("X-Api-Key", "").strip()
        if not token:
            # EventSource cannot set headers, so the SSE stream accepts the key
            # as a query parameter. Same-machine traffic only by default.
            token = self.query_one("key", "")
        return token == key

    # ------------------------------------------------------------ dispatching

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._send(204, b"", "text/plain")

    def do_GET(self) -> None:  # noqa: N802
        self._dispatch("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._dispatch("POST")

    def do_DELETE(self) -> None:  # noqa: N802
        self._dispatch("DELETE")

    def _dispatch(self, method: str) -> None:
        path = urllib.parse.urlparse(self.path).path
        try:
            if not self._authorised(path):
                raise ApiError(401, "missing or invalid API key", "authentication_error")
            for route_method, pattern, handler_name in self.ROUTES:
                if route_method != method:
                    continue
                match = pattern.match(path)
                if match:
                    getattr(self, handler_name)(**match.groupdict())
                    return
            if method == "GET":
                self.serve_static(path)
                return
            raise ApiError(404, f"no route for {method} {path}")
        except ApiError as exc:
            self.send_error_json(exc.status, exc.message, exc.kind)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # last resort - never leak a stack trace
            self.log_message("unhandled error on %s: %s", path, exc)
            self.send_error_json(500, f"internal error: {exc}", "server_error")

    # --------------------------------------------------------------- static

    def serve_static(self, path: str) -> None:
        if path.startswith("/images/"):
            root = Path(self.config.outputs_dir)
            rel = path[len("/images/"):]
            cache = "public, max-age=31536000, immutable"
        else:
            root = Path(self.config.web_dir)
            rel = "index.html" if path in ("/", "") else path.lstrip("/")
            cache = "no-cache"

        try:
            target = (root / urllib.parse.unquote(rel)).resolve()
            root_resolved = root.resolve()
            target.relative_to(root_resolved)  # raises if it escaped the root
        except (ValueError, OSError):
            raise ApiError(404, "not found")

        if not target.is_file():
            raise ApiError(404, f"not found: {path}")

        suffix = target.suffix.lower()
        ctype = CONTENT_TYPES.get(suffix) or mimetypes.guess_type(target.name)[0] \
            or "application/octet-stream"
        self._send(200, target.read_bytes(), ctype, {"Cache-Control": cache})

    # ------------------------------------------------------------ API: meta

    def get_health(self) -> None:
        server = self.server  # type: ignore[attr-defined]
        engine = server.registry.default()
        self.send_json(
            {
                "status": "ok",
                "app": "Avernal Forge",
                "version": __version__,
                "uptime_seconds": round(time.time() - server.started_at, 1),
                "engine": engine.id,
                "device": engine.device_label(),
                "queued": server.jobs.pending(),
                "local_only": True,
            }
        )

    def get_config(self) -> None:
        server = self.server  # type: ignore[attr-defined]
        from .engines import SAMPLERS

        self.send_json(
            {
                "version": __version__,
                "engines": server.registry.describe(),
                "default_engine": server.registry.default().id,
                "models": server.registry.models(),
                "samplers": SAMPLERS,
                "limits": {
                    "min_side": cfg.MIN_SIDE,
                    "max_side": cfg.MAX_SIDE,
                    "max_pixels": cfg.MAX_PIXELS,
                    "max_batch": cfg.MAX_BATCH,
                    "max_steps": cfg.MAX_STEPS,
                },
                "defaults": {
                    "width": 512,
                    "height": 512,
                    "steps": 24,
                    "guidance": 7.0,
                    "sampler": "euler_a",
                    "batch": 1,
                },
                "paths": {
                    "home": str(self.config.home),
                    "models": str(self.config.models_dir),
                    "outputs": str(self.config.outputs_dir),
                },
                "stats": server.gallery.stats(),
            }
        )

    def get_models(self) -> None:
        server = self.server  # type: ignore[attr-defined]
        self.send_json({"models": server.registry.models()})

    # --------------------------------------------------------- API: gallery

    def get_gallery(self) -> None:
        server = self.server  # type: ignore[attr-defined]
        self.send_json(
            server.gallery.list(
                limit=int(_clamp(self.query_one("limit", "60"), 1, 500, 60)),
                offset=int(_clamp(self.query_one("offset", "0"), 0, 10**9, 0)),
                query=self.query_one("q", "")[:200],
                favorites_only=self.query_one("favorites") in ("1", "true", "yes"),
            )
        )

    def get_image_record(self, image_id: str) -> None:
        server = self.server  # type: ignore[attr-defined]
        record = server.gallery.get(image_id)
        if record is None:
            raise ApiError(404, f"no image {image_id}")
        self.send_json(record)

    def post_favorite(self, image_id: str) -> None:
        server = self.server  # type: ignore[attr-defined]
        payload = self.read_json()
        record = server.gallery.set_favorite(image_id, bool(payload.get("favorite", True)))
        if record is None:
            raise ApiError(404, f"no image {image_id}")
        self.send_json(record)

    def delete_image(self, image_id: str) -> None:
        server = self.server  # type: ignore[attr-defined]
        if not server.gallery.delete(image_id):
            raise ApiError(404, f"no image {image_id}")
        self.send_json({"deleted": image_id})

    # ------------------------------------------------------------ API: jobs

    def get_jobs(self) -> None:
        server = self.server  # type: ignore[attr-defined]
        self.send_json({"jobs": server.jobs.list(limit=25)})

    def get_job(self, job_id: str) -> None:
        server = self.server  # type: ignore[attr-defined]
        job = server.jobs.get(job_id)
        if job is None:
            raise ApiError(404, f"no job {job_id}")
        self.send_json(job.public())

    def post_cancel(self, job_id: str) -> None:
        server = self.server  # type: ignore[attr-defined]
        if not server.jobs.cancel(job_id):
            raise ApiError(409, "job is not cancellable")
        self.send_json({"cancelled": job_id})

    def post_generate(self) -> None:
        server = self.server  # type: ignore[attr-defined]
        payload = self.read_json()
        request = build_request(payload)
        engine_id = payload.get("engine")
        job = server.jobs.submit(request, engine_id if engine_id else None)
        self.send_json(job.public(), status=202)

    # ------------------------------------------------------------- API: SSE

    def get_events(self) -> None:
        server = self.server  # type: ignore[attr-defined]
        sub = server.jobs.subscribe()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self._cors_headers()
        self.end_headers()
        self.close_connection = True
        try:
            self._sse_write({"type": "hello", "version": __version__})
            for job in server.jobs.list(limit=5):
                self._sse_write({"type": "job", "job": job})
            while True:
                try:
                    event = sub.get(timeout=SSE_PING_SECONDS)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                self._sse_write(event)
        except (BrokenPipeError, ConnectionResetError, ValueError, OSError):
            pass
        finally:
            server.jobs.unsubscribe(sub)

    def _sse_write(self, event: dict[str, Any]) -> None:
        payload = json.dumps(event, default=str)
        self.wfile.write(f"data: {payload}\n\n".encode("utf-8"))
        self.wfile.flush()

    # ------------------------------------------- API: OpenAI-compatible layer

    def get_openai_models(self) -> None:
        server = self.server  # type: ignore[attr-defined]
        created = int(server.started_at)
        data = [
            {
                "id": model["id"],
                "object": "model",
                "created": created,
                "owned_by": "avernal-forge",
                "engine": model.get("engine"),
            }
            for model in server.registry.models()
        ]
        self.send_json({"object": "list", "data": data})

    def post_openai_images(self) -> None:
        """POST /v1/images/generations - the reason Forge *is* a provider.

        Point any OpenAI-compatible client at this base URL and it generates
        locally instead of calling a hosted service.
        """
        server = self.server  # type: ignore[attr-defined]
        payload = self.read_json()
        request = build_request(payload)
        job = server.jobs.submit(request, payload.get("engine") or None)
        server.jobs.wait(job, timeout=SYNC_JOB_TIMEOUT)

        if job.status == ERROR:
            raise ApiError(500, job.error or "generation failed", "server_error")
        if job.status != DONE:
            raise ApiError(504, f"generation did not finish (status: {job.status})",
                           "server_error")

        response_format = str(payload.get("response_format") or "b64_json")
        data: list[dict[str, Any]] = []
        for record in job.images:
            entry: dict[str, Any] = {"revised_prompt": record["prompt"], "seed": record["seed"]}
            if response_format == "url":
                entry["url"] = f"{self.config.base_url}{record['url']}"
            else:
                png = (Path(self.config.outputs_dir) / record["filename"]).read_bytes()
                entry["b64_json"] = base64.b64encode(png).decode("ascii")
            data.append(entry)
        self.send_json({"created": int(time.time()), "data": data})


def serve(config: cfg.Config) -> ForgeServer:
    config.ensure_dirs()
    return ForgeServer(config)
