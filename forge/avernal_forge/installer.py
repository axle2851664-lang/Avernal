"""Fetching model weights, on purpose and only when asked.

This is the one part of Forge that downloads anything, and it never runs on
its own: it happens when you type `run.py models --install`. Generation still
never touches the network, and neither does startup.

Downloads go through the same gate as everything else - host allowlist,
redirect re-checks, size caps, audit log - so an install shows up in the
network log like any other request.
"""

from __future__ import annotations

import fnmatch
import os
import re
from pathlib import Path
from typing import Any, Callable

from .catalogue import CatalogueEntry, by_id
from .connectors.net import NetworkBlocked, NetworkError, NetworkGate, build_query

#: Hugging Face serves metadata from the site and blobs from its CDNs.
HF_DOMAINS = ("huggingface.co", "hf.co", "xethub.hf.co", "cdn-lfs.huggingface.co")
HF_BASE = "https://huggingface.co"

REPO_PATTERN = re.compile(r"^[A-Za-z0-9][\w.-]*/[\w.-]+$")

#: Weights ship in several formats; prefer safetensors and skip the duplicates.
SKIP_SUFFIXES = (".bin", ".ckpt", ".pth", ".msgpack", ".h5", ".onnx", ".onnx_data")
SKIP_PARTS = ("/onnx/", "/openvino/", "/coreml/", "/flax/", "/tf/", ".fp16.")


class InstallError(RuntimeError):
    """Raised with a message meant to be read by a person."""


def _endpoint() -> str:
    return os.environ.get("AVERNAL_FORGE_HF_BASE", HF_BASE).rstrip("/")


def make_gate(config: Any) -> NetworkGate:
    """A gate scoped to the hub, switched on only for this operation."""

    class _InstallConfig:
        online = True
        allow_private_hosts = bool(getattr(config, "allow_private_hosts", False))

    gate = NetworkGate(_InstallConfig())
    domains = set(HF_DOMAINS)
    host = _endpoint().split("://", 1)[-1].split("/")[0].split(":")[0]
    domains.add(host)
    gate.set_allowed_domains(domains)
    return gate


def token_for(config: Any) -> str:
    token = str(getattr(config, "hf_token", "") or "").strip()
    if token:
        return token
    for name in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HUGGINGFACE_TOKEN"):
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"} if token else {}


def list_repo_files(repo: str, gate: NetworkGate, token: str = "") -> list[str]:
    """Ask the hub what is in a repo. No download yet."""
    if not REPO_PATTERN.match(repo):
        raise InstallError(
            f"{repo!r} is not a repository id. Use the owner/name form, "
            "such as stabilityai/stable-diffusion-xl-base-1.0."
        )
    url = build_query(f"{_endpoint()}/api/models/{repo}", {})
    try:
        payload = gate.json(url, connector="installer", headers=_auth_headers(token),
                            user_directed=True, timeout=30.0)
    except NetworkError as exc:
        message = str(exc)
        if "401" in message or "403" in message:
            raise InstallError(
                f"{repo} refused access. If it is a gated model, accept its licence "
                f"at {HF_BASE}/{repo} and pass --hf-token (or set HF_TOKEN)."
            ) from exc
        if "404" in message:
            raise InstallError(
                f"{repo} was not found on the hub. Check the id, or browse "
                f"{HF_BASE}/models."
            ) from exc
        raise InstallError(f"could not read {repo}: {exc}") from exc

    siblings = payload.get("siblings") or []
    return [str(item.get("rfilename", "")) for item in siblings if item.get("rfilename")]


def select_files(names: list[str], patterns: tuple[str, ...]) -> list[str]:
    """Keep the files a diffusers pipeline needs, drop the duplicates."""
    wanted: list[str] = []
    for name in names:
        lowered = name.lower()
        if lowered.endswith(SKIP_SUFFIXES) or any(p in lowered for p in SKIP_PARTS):
            continue
        if any(fnmatch.fnmatch(name, pattern) for pattern in patterns):
            wanted.append(name)

    # A .safetensors file makes any same-named sibling redundant.
    stems = {n[: -len(".safetensors")] for n in wanted if n.endswith(".safetensors")}
    return sorted(
        n for n in wanted
        if n.endswith(".safetensors") or n.rsplit(".", 1)[0] not in stems
    )


def install(
    repo: str,
    target_dir: Path,
    gate: NetworkGate,
    token: str = "",
    patterns: tuple[str, ...] | None = None,
    on_event: Callable[[str, dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """Download one model into `target_dir`. Existing files are left alone."""
    notify = on_event or (lambda kind, payload: None)
    from .catalogue import DIFFUSERS_PATTERNS

    names = list_repo_files(repo, gate, token)
    chosen = select_files(names, patterns or DIFFUSERS_PATTERNS)
    if not chosen:
        raise InstallError(
            f"{repo} has no diffusers-format files. Forge loads diffusers model "
            "folders; single-file checkpoints go in the models folder directly."
        )
    if not any(name == "model_index.json" for name in chosen):
        notify("warn", {"message":
                        f"{repo} has no model_index.json; it may be an add-on "
                        "(such as a motion adapter) rather than a full pipeline."})

    target_dir = Path(target_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    notify("start", {"repo": repo, "files": len(chosen), "target": str(target_dir)})

    downloaded, skipped, total_bytes = 0, 0, 0
    for index, name in enumerate(chosen, start=1):
        destination = target_dir / name
        if destination.is_file() and destination.stat().st_size > 0:
            skipped += 1
            notify("skip", {"file": name, "index": index, "of": len(chosen)})
            continue

        url = f"{_endpoint()}/{repo}/resolve/main/{name}"
        notify("file", {"file": name, "index": index, "of": len(chosen)})
        try:
            written = gate.download(
                url, destination, connector="installer",
                headers=_auth_headers(token), timeout=120.0,
                on_progress=lambda done, total, n=name: notify(
                    "progress", {"file": n, "done": done, "total": total}),
            )
        except (NetworkBlocked, NetworkError) as exc:
            raise InstallError(f"failed downloading {name}: {exc}") from exc
        downloaded += 1
        total_bytes += written

    notify("done", {"repo": repo, "downloaded": downloaded, "skipped": skipped,
                    "bytes": total_bytes, "target": str(target_dir)})
    return {
        "repo": repo,
        "target": str(target_dir),
        "downloaded": downloaded,
        "skipped": skipped,
        "bytes": total_bytes,
    }


def resolve_target(entry: CatalogueEntry | None, repo: str, models_dir: Path) -> Path:
    name = entry.id if entry else repo.split("/")[-1]
    return Path(models_dir) / name


def install_by_name(
    name: str,
    config: Any,
    on_event: Callable[[str, dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """Install a catalogue id, or any repository id."""
    entry = by_id(name)
    repo = entry.repo if entry else name
    gate = make_gate(config)
    token = token_for(config)

    if entry and entry.gated and not token:
        raise InstallError(
            f"{entry.name} is gated. Accept its licence at {HF_BASE}/{entry.repo}, "
            "then pass --hf-token or set HF_TOKEN."
        )

    target = resolve_target(entry, repo, config.models_dir)
    result = install(
        repo, target, gate, token,
        patterns=entry.patterns if entry else None,
        on_event=on_event,
    )
    result["entry"] = entry.public() if entry else None
    result["audit"] = gate.audit_log(limit=200)
    return result
