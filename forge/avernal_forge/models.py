"""Finding model weights that are already on this machine.

Strictly local: this walks directories, it never reaches out to a hub. If a
model is not on disk, Forge will not fetch it for you - that is the whole
point of the app.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

CHECKPOINT_SUFFIXES = (".safetensors", ".ckpt")

#: Diffusers pipeline classes that produce video. Anything with "video" in the
#: name is caught too, so newer pipelines classify correctly without an update.
VIDEO_PIPELINE_PREFIXES = (
    "animatediff", "cogvideo", "ltx", "mochi", "wan", "hunyuanvideo",
    "i2vgen", "stablevideodiffusion", "texttovideo", "zeroscope", "pyramid",
    "easyanimate", "allegro", "latte",
)


def classify_pipeline(class_name: str) -> str:
    """"video" or "image", from the pipeline class a model declares."""
    lowered = (class_name or "").lower()
    if "video" in lowered or lowered.startswith(VIDEO_PIPELINE_PREFIXES):
        return "video"
    return "image"
# Files that live inside a diffusers folder and mark it as loadable.
FOLDER_MARKERS = ("model_index.json",)


def _dir_size(path: Path, cap: int = 4000) -> int:
    total = 0
    for i, entry in enumerate(path.rglob("*")):
        if i > cap:
            break
        if entry.is_file():
            try:
                total += entry.stat().st_size
            except OSError:
                pass
    return total


def _folder_model(path: Path) -> dict[str, Any] | None:
    index = path / "model_index.json"
    if not index.is_file():
        return None
    try:
        data = json.loads(index.read_text())
    except (OSError, ValueError):
        data = {}
    cls = str(data.get("_class_name", "")) or "DiffusionPipeline"
    media = classify_pipeline(cls)
    return {
        "id": f"folder:{path.name}",
        "name": path.name,
        "engine": "diffusers-video" if media == "video" else "diffusers",
        "kind": "diffusers",
        "pipeline": cls,
        "media": media,
        "path": str(path),
        "size_bytes": _dir_size(path),
    }


def _file_model(path: Path) -> dict[str, Any]:
    try:
        size = path.stat().st_size
    except OSError:
        size = 0
    # SDXL checkpoints are roughly 6GB+; SD 1.x/2.x land near 2-5GB. This is
    # only a hint for the UI - the loader still reads the real config.
    guess = "sdxl" if size > 5_500_000_000 else "sd"
    return {
        "id": f"file:{path.name}",
        "name": path.stem,
        "engine": "diffusers",
        "kind": "checkpoint",
        "pipeline": guess,
        # A bare checkpoint carries no pipeline config, so it is treated as a
        # still-image model; video weights ship as diffusers folders.
        "media": "image",
        "path": str(path),
        "size_bytes": size,
    }


def scan_dir(root: Path) -> list[dict[str, Any]]:
    """Find models directly inside `root` (one level deep, plus its own root)."""
    found: list[dict[str, Any]] = []
    if not root.is_dir():
        return found

    own = _folder_model(root)
    if own:
        found.append(own)

    try:
        entries = sorted(root.iterdir())
    except OSError:
        return found

    for entry in entries:
        if entry.name.startswith("."):
            continue
        if entry.is_dir():
            model = _folder_model(entry)
            if model:
                found.append(model)
        elif entry.suffix.lower() in CHECKPOINT_SUFFIXES:
            found.append(_file_model(entry))
    return found


def scan_hf_cache(cache_root: Path | None = None) -> list[dict[str, Any]]:
    """Pick up models the user already downloaded into the Hugging Face cache."""
    root = cache_root or (Path.home() / ".cache" / "huggingface" / "hub")
    found: list[dict[str, Any]] = []
    if not root.is_dir():
        return found
    for repo_dir in sorted(root.glob("models--*")):
        snapshots = repo_dir / "snapshots"
        if not snapshots.is_dir():
            continue
        for snapshot in sorted(snapshots.iterdir(), reverse=True):
            model = _folder_model(snapshot)
            if model:
                repo_id = repo_dir.name[len("models--"):].replace("--", "/")
                model["id"] = f"hub:{repo_id}"
                model["name"] = repo_id
                model["kind"] = "hf-cache"
                found.append(model)
                break  # newest snapshot per repo is enough
    return found


def discover(
    models_dir: Path,
    include_hf_cache: bool = True,
    media: str | None = None,
) -> list[dict[str, Any]]:
    models = scan_dir(Path(models_dir))
    if include_hf_cache:
        known = {m["path"] for m in models}
        models += [m for m in scan_hf_cache() if m["path"] not in known]
    if media:
        models = [m for m in models if m.get("media", "image") == media]
    return models


def resolve(models: list[dict[str, Any]], wanted: str | None) -> dict[str, Any] | None:
    """Match a model by id, name or path. Falls back to the first available."""
    if not models:
        return None
    if not wanted:
        return models[0]
    for model in models:
        if wanted in (model["id"], model["name"], model["path"]):
            return model
    lowered = wanted.lower()
    for model in models:
        if lowered in model["name"].lower():
            return model
    return None
