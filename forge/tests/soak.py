"""Generate a great many images and clips, and check every one of them.

Single runs prove a feature works. Hundreds of concurrent runs prove it keeps
working: they are what surface races in the job queue, database locking, file
handle leaks, memory growth, and outputs that are subtly wrong rather than
absent.

    python3 tests/soak.py                      # the default sweep
    python3 tests/soak.py --images 300 --videos 60 --workers 6
    python3 tests/soak.py --quick              # a fast calibration pass

Exits non-zero if anything failed, so it can gate a release.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from avernal_forge.png import PNG_MAGIC, read_apng_info, read_size  # noqa: E402

SIZES = [(64, 64), (96, 96), (128, 128), (128, 96), (96, 128), (160, 96)]
SAMPLERS = ["euler_a", "euler", "dpmpp_2m", "unipc", "ddim", "lms", "heun"]
STYLES = ["none", "photo", "portrait", "cinematic", "documentary"]
PROMPTS = [
    "a crimson desert horizon at sunset", "deep blue cosmic nebula with stars",
    "neon cyberpunk city grid", "soft pastel abstract fluid swirl",
    "emerald forest valley in morning mist", "monochrome noir portrait",
    "a lighthouse in fog", "terracotta rooftops at noon",
    "an ice field under a low sun", "copper machinery, close detail",
]


class Server:
    """A real `run.py serve` subprocess, so resource use can be measured."""

    def __init__(self, home: Path, workers: int) -> None:
        self.home = home
        self.port = 0
        self.process = subprocess.Popen(
            [sys.executable, "run.py", "serve", "--port", "8811",
             "--home", str(home), "--workers", str(workers), "--quiet"],
            cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )
        self.port = 8811
        self.base = f"http://127.0.0.1:{self.port}"
        for _ in range(200):
            try:
                self.get("/api/health")
                return
            except Exception:
                if self.process.poll() is not None:
                    raise RuntimeError(
                        "server exited: "
                        + self.process.stderr.read().decode("utf-8", "replace")[:800]
                    )
                time.sleep(0.1)
        raise RuntimeError("server did not come up")

    # -- http ---------------------------------------------------------------

    def get(self, path: str, timeout: float = 60.0):
        with urllib.request.urlopen(self.base + path, timeout=timeout) as response:
            return json.loads(response.read())

    def post(self, path: str, payload: dict, timeout: float = 120.0):
        request = urllib.request.Request(
            self.base + path, data=json.dumps(payload).encode(), method="POST")
        request.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read()
            return json.loads(body) if body else None

    def raw(self, path: str, timeout: float = 60.0) -> bytes:
        with urllib.request.urlopen(self.base + path, timeout=timeout) as response:
            return response.read()

    # -- resources ----------------------------------------------------------

    def resources(self) -> dict[str, int]:
        pid = self.process.pid
        rss = 0
        try:
            for line in Path(f"/proc/{pid}/status").read_text().splitlines():
                if line.startswith("VmRSS:"):
                    rss = int(line.split()[1])
                    break
        except OSError:
            pass
        try:
            handles = len(list(Path(f"/proc/{pid}/fd").iterdir()))
        except OSError:
            handles = 0
        try:
            threads = int(Path(f"/proc/{pid}/status").read_text()
                          .split("Threads:")[1].split()[0])
        except (OSError, IndexError):
            threads = 0
        return {"rss_kb": rss, "handles": handles, "threads": threads}

    def stop(self) -> None:
        self.process.terminate()
        try:
            self.process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            self.process.kill()


class Report:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.ok = 0
        self.failures: list[str] = []
        self.durations: list[float] = []

    def record(self, ok: bool, detail: str = "", seconds: float = 0.0) -> None:
        with self.lock:
            if ok:
                self.ok += 1
                if seconds:
                    self.durations.append(seconds)
            else:
                self.failures.append(detail)

    def drift(self) -> tuple[float, float] | None:
        """Median duration early in the run against late in it."""
        with self.lock:
            samples = list(self.durations)
        if len(samples) < 20:
            return None
        quarter = max(5, len(samples) // 4)
        return (statistics.median(samples[:quarter]),
                statistics.median(samples[-quarter:]))

    def summary(self, label: str) -> str:
        total = self.ok + len(self.failures)
        line = f"  {label:<26} {self.ok}/{total} ok"
        if self.durations:
            line += (f"   median {statistics.median(self.durations):.2f}s"
                     f"  p95 {sorted(self.durations)[int(len(self.durations) * 0.95)]:.2f}s"
                     f"  max {max(self.durations):.2f}s")
        return line


def wait_for(server: Server, job: dict, timeout: float = 300.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = server.get(f"/api/jobs/{job['id']}")
        if job["status"] in ("done", "error", "cancelled"):
            return job
        time.sleep(0.05)
    job["status"] = "timeout"
    return job


def check_image(server: Server, record: dict, want: dict) -> str:
    data = server.raw(record["url"])
    if not data.startswith(PNG_MAGIC):
        return f"{record['id']}: not a PNG"
    width, height = read_size(data)
    if (width, height) != (want["width"], want["height"]):
        return f"{record['id']}: {width}x{height}, wanted {want['width']}x{want['height']}"
    if record["kind"] != "image":
        return f"{record['id']}: kind is {record['kind']}"
    if want.get("seed", -1) >= 0 and record["seed"] != want["seed"]:
        return f"{record['id']}: seed {record['seed']}, wanted {want['seed']}"
    return ""


def check_video(server: Server, record: dict, want: dict) -> str:
    data = server.raw(record["url"])
    if record["kind"] != "video":
        return f"{record['id']}: kind is {record['kind']}"
    info = read_apng_info(data)
    if info["frames"] != want["frames"]:
        return f"{record['id']}: {info['frames']} frames, wanted {want['frames']}"
    if info["fctl"] != info["frames"] or info["fdat"] != info["frames"] - 1:
        return f"{record['id']}: malformed APNG chunks {info}"
    width, height = read_size(data)
    if (width, height) != (want["width"], want["height"]):
        return f"{record['id']}: {width}x{height}, wanted {want['width']}x{want['height']}"
    return ""


def one_image(server: Server, rng: random.Random) -> tuple[bool, str, float]:
    width, height = rng.choice(SIZES)
    want = {
        "prompt": rng.choice(PROMPTS), "width": width, "height": height,
        "steps": rng.randint(4, 18), "guidance": round(rng.uniform(0, 14), 1),
        "seed": rng.randint(0, 2**31 - 1), "sampler": rng.choice(SAMPLERS),
        "style": rng.choice(STYLES), "batch": rng.choice([1, 1, 1, 2, 3]),
    }
    started = time.time()
    job = wait_for(server, server.post("/api/generate", want))
    elapsed = time.time() - started
    if job["status"] != "done":
        return False, f"job {job['status']}: {job.get('error', '')[:120]}", elapsed
    if len(job["images"]) != want["batch"]:
        return False, f"{len(job['images'])} images, wanted {want['batch']}", elapsed
    for index, record in enumerate(job["images"]):
        problem = check_image(server, record,
                              {**want, "seed": want["seed"] + index})
        if problem:
            return False, problem, elapsed
    return True, "", elapsed


def one_video(server: Server, rng: random.Random) -> tuple[bool, str, float]:
    width, height = rng.choice(SIZES[:4])
    want = {
        "prompt": rng.choice(PROMPTS), "kind": "video",
        "width": width, "height": height,
        "steps": rng.randint(4, 12), "frames": rng.randint(2, 10),
        "fps": rng.randint(4, 16), "motion": round(rng.uniform(0, 2), 1),
        "seed": rng.randint(0, 2**31 - 1),
    }
    started = time.time()
    job = wait_for(server, server.post("/api/generate", want))
    elapsed = time.time() - started
    if job["status"] != "done":
        return False, f"job {job['status']}: {job.get('error', '')[:120]}", elapsed
    problem = check_video(server, job["images"][0], want)
    return (not problem), problem, elapsed


def run(args: argparse.Namespace) -> int:
    home = Path(tempfile.mkdtemp(prefix="forge-soak-"))
    print(f"Soak test: {args.images} images, {args.videos} clips, "
          f"{args.workers} render worker(s), {args.concurrency} client(s)")
    print(f"Home: {home}\n")

    server = Server(home, args.workers)
    baseline = server.resources()
    print(f"  server up   rss {baseline['rss_kb'] // 1024}MB  "
          f"handles {baseline['handles']}  threads {baseline['threads']}\n")

    images, videos = Report(), Report()
    determinism, cancels, provider = Report(), Report(), Report()
    samples: list[dict[str, int]] = []
    failed = False

    try:
        start = time.time()
        with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
            # Futures complete out of order, so each one carries its own kind
            # rather than being attributed by position.
            kinds: dict[object, Report] = {}
            for index in range(args.images):
                rng = random.Random(f"image-{args.seed}-{index}")
                kinds[pool.submit(one_image, server, rng)] = images
            for index in range(args.videos):
                rng = random.Random(f"video-{args.seed}-{index}")
                kinds[pool.submit(one_video, server, rng)] = videos

            done_count = 0
            for future in as_completed(kinds):
                try:
                    ok, detail, seconds = future.result()
                except Exception as exc:
                    ok, detail, seconds = False, f"{type(exc).__name__}: {exc}", 0.0
                kinds[future].record(ok, detail, seconds)
                done_count += 1
                if done_count % max(1, (args.images + args.videos) // 20) == 0:
                    samples.append(server.resources())
                    print(f"  {done_count}/{args.images + args.videos} "
                          f"({time.time() - start:.0f}s)", flush=True)
        elapsed = time.time() - start

        # -- the same seed must give the same bytes, every time -------------
        print("\n  checking determinism...")
        for index in range(args.determinism):
            payload = {"prompt": "a repeatable field", "width": 96, "height": 96,
                       "steps": 10, "seed": 4242 + index, "sampler": "euler_a"}
            first = wait_for(server, server.post("/api/generate", payload))
            second = wait_for(server, server.post("/api/generate", payload))
            if first["status"] != "done" or second["status"] != "done":
                determinism.record(False, "a determinism job did not finish")
                continue
            a = server.raw(first["images"][0]["url"])
            b = server.raw(second["images"][0]["url"])
            determinism.record(a == b, f"seed {payload['seed']} differed")

        # -- cancellation under load ----------------------------------------
        print("  checking cancellation...")
        for _ in range(args.cancels):
            job = server.post("/api/generate", {
                "prompt": "a large slow render", "width": 512, "height": 512,
                "steps": 40, "batch": 4})
            try:
                server.post(f"/api/jobs/{job['id']}/cancel", {})
            except urllib.error.HTTPError as exc:
                cancels.record(exc.code == 409, f"cancel returned {exc.code}")
                continue
            final = wait_for(server, job, timeout=120)
            cancels.record(final["status"] == "cancelled",
                           f"ended {final['status']}")

        # -- the provider API, the surface other tools call ------------------
        print("  checking the provider API...")
        for index in range(args.provider):
            body = server.post("/v1/images/generations", {
                "prompt": f"provider check {index}", "size": "64x64",
                "steps": 6, "n": 1 + (index % 2)})
            import base64

            ok = bool(body.get("data"))
            for entry in body.get("data", []):
                png = base64.b64decode(entry["b64_json"])
                ok = ok and png.startswith(PNG_MAGIC) and read_size(png) == (64, 64)
            provider.record(ok, f"provider call {index} returned something odd")

        # -- the gallery must agree with the disk ---------------------------
        print("  checking gallery integrity...\n")
        # Page through everything: a capped listing would report the
        # remainder as orphaned files.
        indexed: set[str] = set()
        offset = 0
        while True:
            page = server.get(f"/api/gallery?limit=200&offset={offset}")
            indexed.update(item["filename"] for item in page["items"])
            offset += len(page["items"])
            if not page["items"] or offset >= page["total"]:
                listing = page
                break
        listing["total"] = page["total"]
        on_disk = {p.name for p in (home / "outputs").iterdir() if p.is_file()}
        orphans = on_disk - indexed
        missing = indexed - on_disk
        stats = server.get("/api/config")["stats"]

        final = server.resources()

        print("Results")
        print(images.summary("images"))
        print(videos.summary("clips"))
        print(determinism.summary("determinism"))
        print(cancels.summary("cancellation"))
        print(provider.summary("provider API"))
        print(f"  {'gallery rows':<26} {listing['total']} indexed, "
              f"{len(on_disk)} files on disk")
        print(f"  {'stats agree':<26} {stats['images']} reported, "
              f"{stats['videos']} clips")

        total_jobs = args.images + args.videos
        print(f"\n  throughput                 {total_jobs / elapsed:.1f} jobs/s "
              f"over {elapsed:.0f}s")
        for report, label in ((images, "image"), (videos, "clip")):
            drift = report.drift()
            if drift:
                early, late = drift
                arrow = "steady" if late <= early * 1.6 else "SLOWING"
                print(f"  {label + ' pace':<26} {early:.2f}s -> {late:.2f}s  {arrow}")
        print(f"  rss                        {baseline['rss_kb'] // 1024}MB -> "
              f"{final['rss_kb'] // 1024}MB")
        print(f"  open handles               {baseline['handles']} -> "
              f"{final['handles']}")
        print(f"  threads                    {baseline['threads']} -> "
              f"{final['threads']}")

        problems: list[str] = []
        for report, label in ((images, "image"), (videos, "clip"),
                              (determinism, "determinism"),
                              (cancels, "cancellation"), (provider, "provider")):
            problems += [f"{label}: {detail}" for detail in report.failures[:5]]
        if missing:
            problems.append(f"{len(missing)} indexed file(s) absent from disk")
        if orphans:
            problems.append(f"{len(orphans)} file(s) on disk not indexed")
        # A handle count that climbs with work is the shape of a leak.
        # A handle count that keeps climbing with work is the shape of a leak;
        # a count that rises then plateaus is just pooling.
        if samples:
            early = statistics.median([s["handles"] for s in samples[:3]])
            late = statistics.median([s["handles"] for s in samples[-3:]])
            if late > early + 30:
                problems.append(
                    f"handles climbed through the run: {early:.0f} -> {late:.0f}")
        if final["handles"] > baseline["handles"] + 120:
            problems.append(
                f"handles ended high: {baseline['handles']} -> {final['handles']}")
        growth = final["rss_kb"] - baseline["rss_kb"]
        if growth > args.rss_budget_kb:
            problems.append(f"rss grew {growth // 1024}MB")

        # Work that slows as the gallery fills points at something scanning
        # everything - an unindexed query, a directory walk per request.
        for report, label in ((images, "image"), (videos, "clip")):
            drift = report.drift()
            if drift and drift[1] > drift[0] * 2.0:
                problems.append(
                    f"{label} jobs slowed through the run: "
                    f"{drift[0]:.2f}s -> {drift[1]:.2f}s")

        if problems:
            failed = True
            print("\nFAILURES")
            for problem in problems:
                print(f"  - {problem}")
        else:
            print("\nAll checks passed.")
    finally:
        server.stop()
        if not args.keep:
            shutil.rmtree(home, ignore_errors=True)
    return 1 if failed else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--images", type=int, default=250)
    parser.add_argument("--videos", type=int, default=60)
    parser.add_argument("--workers", type=int, default=2,
                        help="render workers inside the server")
    parser.add_argument("--concurrency", type=int, default=6,
                        help="parallel clients hitting the API")
    parser.add_argument("--determinism", type=int, default=15)
    parser.add_argument("--cancels", type=int, default=10)
    parser.add_argument("--provider", type=int, default=15)
    parser.add_argument("--rss-budget-kb", type=int, default=250_000,
                        dest="rss_budget_kb")
    parser.add_argument("--seed", default="soak")
    parser.add_argument("--keep", action="store_true", help="keep the output dir")
    parser.add_argument("--quick", action="store_true",
                        help="a small calibration run")
    args = parser.parse_args()
    if args.quick:
        args.images, args.videos = 20, 6
        args.determinism, args.cancels, args.provider = 3, 2, 3
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
