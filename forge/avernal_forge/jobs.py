"""Job queue, progress reporting and the event bus the UI listens on."""

from __future__ import annotations

import queue
import threading
import time
import traceback
import uuid
from collections import OrderedDict
from typing import Any, Callable

from .engines import Cancelled, EngineRegistry, GenerationRequest
from .storage import Gallery

QUEUED = "queued"
RUNNING = "running"
DONE = "done"
ERROR = "error"
CANCELLED = "cancelled"

#: Progress events are chatty; this is the floor between two of them.
PROGRESS_INTERVAL = 0.1
MAX_REMEMBERED_JOBS = 200


class Job:
    __slots__ = (
        "id", "request", "engine_id", "status", "step", "total", "note",
        "images", "error", "created_at", "started_at", "finished_at",
        "cancel_event", "done_event", "_last_emit",
    )

    def __init__(self, request: GenerationRequest, engine_id: str | None) -> None:
        self.id = uuid.uuid4().hex[:16]
        self.request = request
        self.engine_id = engine_id
        self.status = QUEUED
        self.step = 0
        self.total = max(1, request.steps)
        self.note = ""
        self.images: list[dict[str, Any]] = []
        self.error = ""
        self.created_at = time.time()
        self.started_at: float | None = None
        self.finished_at: float | None = None
        self.cancel_event = threading.Event()
        self.done_event = threading.Event()
        self._last_emit = 0.0

    @property
    def progress(self) -> float:
        if self.status in (DONE,):
            return 1.0
        if self.total <= 0:
            return 0.0
        return max(0.0, min(1.0, self.step / self.total))

    def public(self) -> dict[str, Any]:
        req = self.request
        return {
            "id": self.id,
            "status": self.status,
            "engine": self.engine_id,
            "progress": round(self.progress, 4),
            "step": self.step,
            "total": self.total,
            "note": self.note,
            "error": self.error,
            "images": self.images,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "request": {
                "prompt": req.prompt,
                "negative": req.negative,
                "width": req.width,
                "height": req.height,
                "steps": req.steps,
                "guidance": req.guidance,
                "seed": req.seed,
                "batch": req.batch,
                "sampler": req.sampler,
                "model": req.model,
                "kind": req.kind,
                "frames": req.frames if req.is_video else 1,
                "fps": req.fps if req.is_video else 0,
            },
        }


class _Context:
    """The JobContext handed to engines - progress in, cancellation out."""

    def __init__(self, job: Job, emit: Callable[[dict[str, Any]], None]) -> None:
        self.job = job
        self._emit = emit

    def progress(self, step: int, total: int, note: str = "") -> None:
        job = self.job
        job.step = int(step)
        job.total = max(1, int(total))
        if note:
            job.note = note
        now = time.time()
        if now - job._last_emit >= PROGRESS_INTERVAL or step >= total:
            job._last_emit = now
            self._emit({"type": "job", "job": job.public()})

    def check_cancel(self) -> None:
        if self.job.cancel_event.is_set():
            raise Cancelled()


class JobQueue:
    def __init__(
        self,
        registry: EngineRegistry,
        gallery: Gallery,
        workers: int = 1,
        on_log: Callable[[str], None] | None = None,
    ) -> None:
        self.registry = registry
        self.gallery = gallery
        self.on_log = on_log or (lambda msg: None)
        self._queue: queue.Queue[Job | None] = queue.Queue()
        self._jobs: OrderedDict[str, Job] = OrderedDict()
        self._lock = threading.Lock()
        self._subscribers: list[queue.Queue] = []
        self._stopping = False
        self._threads = [
            threading.Thread(target=self._worker, name=f"forge-worker-{i}", daemon=True)
            for i in range(max(1, workers))
        ]
        for thread in self._threads:
            thread.start()

    # ------------------------------------------------------------- pub/sub

    def subscribe(self) -> queue.Queue:
        sub: queue.Queue = queue.Queue(maxsize=256)
        with self._lock:
            self._subscribers.append(sub)
        return sub

    def unsubscribe(self, sub: queue.Queue) -> None:
        with self._lock:
            if sub in self._subscribers:
                self._subscribers.remove(sub)

    def emit(self, event: dict[str, Any]) -> None:
        with self._lock:
            subscribers = list(self._subscribers)
        for sub in subscribers:
            try:
                sub.put_nowait(event)
            except queue.Full:
                # A stalled listener must not stall generation.
                pass

    # --------------------------------------------------------------- jobs

    def submit(self, request: GenerationRequest, engine_id: str | None = None) -> Job:
        job = Job(request, engine_id)
        with self._lock:
            self._jobs[job.id] = job
            while len(self._jobs) > MAX_REMEMBERED_JOBS:
                self._jobs.popitem(last=False)
        self.emit({"type": "job", "job": job.public()})
        self._queue.put(job)
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def list(self, limit: int = 25) -> list[dict[str, Any]]:
        with self._lock:
            jobs = list(self._jobs.values())
        return [job.public() for job in reversed(jobs[-limit:])]

    def cancel(self, job_id: str) -> bool:
        job = self.get(job_id)
        if job is None or job.status in (DONE, ERROR, CANCELLED):
            return False
        job.cancel_event.set()
        if job.status == QUEUED:
            self._finish(job, CANCELLED, "cancelled before it started")
        return True

    def wait(self, job: Job, timeout: float | None = None) -> Job:
        job.done_event.wait(timeout)
        return job

    def pending(self) -> int:
        with self._lock:
            return sum(1 for j in self._jobs.values() if j.status in (QUEUED, RUNNING))

    def shutdown(self) -> None:
        self._stopping = True
        for _ in self._threads:
            self._queue.put(None)

    # ------------------------------------------------------------- worker

    def _finish(self, job: Job, status: str, error: str = "") -> None:
        job.status = status
        job.error = error
        job.finished_at = time.time()
        job.done_event.set()
        self.emit({"type": "job", "job": job.public()})

    def _worker(self) -> None:
        while not self._stopping:
            job = self._queue.get()
            if job is None:
                return
            if job.cancel_event.is_set():
                if job.status not in (CANCELLED,):
                    self._finish(job, CANCELLED, "cancelled before it started")
                continue
            self._run(job)

    def _run(self, job: Job) -> None:
        started = time.time()
        job.status = RUNNING
        job.started_at = started
        ctx = _Context(job, self.emit)
        try:
            engine = self.registry.resolve(
                job.engine_id, want_video=job.request.is_video
            )
            job.engine_id = engine.id
            self.emit({"type": "job", "job": job.public()})

            produced = 0
            for media in engine.generate(job.request, ctx):
                ctx.check_cancel()
                record = self.gallery.add(
                    {
                        "id": uuid.uuid4().hex[:16],
                        "prompt": job.request.prompt,
                        "negative": job.request.negative,
                        "engine": engine.id,
                        "model": str(media.meta.get("model") or job.request.model or engine.id),
                        "sampler": str(media.meta.get("sampler") or job.request.sampler),
                        "width": media.width,
                        "height": media.height,
                        "steps": job.request.steps,
                        "guidance": job.request.guidance,
                        "seed": media.seed,
                        "duration_ms": int(media.meta.get("render_ms", 0)),
                        "job_id": job.id,
                        "kind": media.kind,
                        "mime": media.mime,
                        "extension": media.ext,
                        "frames": media.frames,
                        "fps": media.fps,
                        "extra": media.meta,
                    },
                    media.data,
                )
                job.images.append(record)
                produced += 1
                job.step = job.total
                self.emit({"type": "image", "job_id": job.id, "image": record})
                self.emit({"type": "job", "job": job.public()})

            if job.cancel_event.is_set() and produced < job.request.batch:
                self._finish(job, CANCELLED, "cancelled")
            else:
                self._finish(job, DONE)
                self.on_log(
                    f"job {job.id} produced {produced} item(s) in "
                    f"{time.time() - started:.1f}s via {job.engine_id}"
                )
        except Cancelled:
            self._finish(job, CANCELLED, "cancelled")
        except Exception as exc:  # surfaced to the UI, logged in full locally
            self.on_log(f"job {job.id} failed: {exc}\n{traceback.format_exc()}")
            self._finish(job, ERROR, f"{type(exc).__name__}: {exc}")
