"""Runtime configuration for the Forge server."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_PORT = 8787

# Generation limits. These exist to stop a typo ("size": "40000x40000") from
# eating all of the machine's memory, not as a licensing gate.
MAX_SIDE = 4096
MIN_SIDE = 64
#: Sides may be long (panoramas are fine) but total area is what costs memory,
#: so the area cap is the limit that actually bites.
MAX_PIXELS = 2048 * 2048 * 2
MAX_BATCH = 8
MAX_STEPS = 150
MAX_PROMPT_CHARS = 4000


def _default_home() -> Path:
    env = os.environ.get("AVERNAL_FORGE_HOME")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".avernal-forge"


@dataclass
class Config:
    """Everything the server needs to know, resolved once at startup."""

    host: str = "127.0.0.1"
    port: int = DEFAULT_PORT
    home: Path = field(default_factory=_default_home)
    device: str = "auto"
    engine: str = "auto"
    model: str | None = None
    workers: int = 1
    api_key: str | None = None
    cors: bool = False
    offload: bool = False
    #: Pipeline config folder for single-file checkpoints (kept offline).
    sd_config: str | None = None
    #: Overrides the default <home>/models location when set.
    models_dir_override: Path | None = None
    #: Live connectors are off until the user turns them on. Generation itself
    #: never uses the network either way.
    online: bool = False
    #: True when --online was passed, which overrides the stored setting.
    online_forced: bool = False
    #: Permits loopback/private targets. Only for tests and self-hosted instances.
    allow_private_hosts: bool = False
    quiet: bool = False

    @property
    def outputs_dir(self) -> Path:
        return self.home / "outputs"

    @property
    def models_dir(self) -> Path:
        return self.models_dir_override or (self.home / "models")

    @property
    def refs_dir(self) -> Path:
        return self.home / "references"

    @property
    def connectors_path(self) -> Path:
        return self.home / "connectors.json"

    @property
    def db_path(self) -> Path:
        return self.home / "forge.db"

    @property
    def web_dir(self) -> Path:
        return Path(__file__).resolve().parent.parent / "web"

    def ensure_dirs(self) -> None:
        self.home.mkdir(parents=True, exist_ok=True)
        self.outputs_dir.mkdir(parents=True, exist_ok=True)
        self.models_dir.mkdir(parents=True, exist_ok=True)
        self.refs_dir.mkdir(parents=True, exist_ok=True)

    @property
    def base_url(self) -> str:
        host = "127.0.0.1" if self.host in ("0.0.0.0", "::") else self.host
        return f"http://{host}:{self.port}"
