"""SQLite-backed gallery.

Every image the app produces is written to disk as a PNG and indexed here, so
the gallery survives restarts and stays browsable/searchable offline. One
connection per call keeps this safe across the worker and HTTP threads.
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS images (
    id            TEXT PRIMARY KEY,
    created_at    REAL NOT NULL,
    filename      TEXT NOT NULL,
    prompt        TEXT NOT NULL DEFAULT '',
    negative      TEXT NOT NULL DEFAULT '',
    engine        TEXT NOT NULL DEFAULT '',
    model         TEXT NOT NULL DEFAULT '',
    sampler       TEXT NOT NULL DEFAULT '',
    width         INTEGER NOT NULL DEFAULT 0,
    height        INTEGER NOT NULL DEFAULT 0,
    steps         INTEGER NOT NULL DEFAULT 0,
    guidance      REAL NOT NULL DEFAULT 0,
    seed          INTEGER NOT NULL DEFAULT 0,
    duration_ms   INTEGER NOT NULL DEFAULT 0,
    favorite      INTEGER NOT NULL DEFAULT 0,
    job_id        TEXT NOT NULL DEFAULT '',
    extra         TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_images_created ON images (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_images_favorite ON images (favorite, created_at DESC);
"""

_COLUMNS = (
    "id, created_at, filename, prompt, negative, engine, model, sampler, "
    "width, height, steps, guidance, seed, duration_ms, favorite, job_id, extra"
)


class Gallery:
    def __init__(self, db_path: Path, outputs_dir: Path) -> None:
        self.db_path = Path(db_path)
        self.outputs_dir = Path(outputs_dir)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.outputs_dir.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    # ------------------------------------------------------------------ write

    def add(self, record: dict[str, Any], png: bytes) -> dict[str, Any]:
        """Write the PNG to disk and index it. Returns the stored record."""
        filename = f"{record['id']}.png"
        (self.outputs_dir / filename).write_bytes(png)
        row = {
            "id": record["id"],
            "created_at": record.get("created_at") or time.time(),
            "filename": filename,
            "prompt": record.get("prompt", ""),
            "negative": record.get("negative", ""),
            "engine": record.get("engine", ""),
            "model": record.get("model", ""),
            "sampler": record.get("sampler", ""),
            "width": int(record.get("width", 0)),
            "height": int(record.get("height", 0)),
            "steps": int(record.get("steps", 0)),
            "guidance": float(record.get("guidance", 0)),
            "seed": int(record.get("seed", 0)),
            "duration_ms": int(record.get("duration_ms", 0)),
            "favorite": 0,
            "job_id": record.get("job_id", ""),
            "extra": json.dumps(record.get("extra", {}), separators=(",", ":")),
        }
        placeholders = ", ".join(f":{c.strip()}" for c in _COLUMNS.split(","))
        with self._connect() as conn:
            conn.execute(f"INSERT INTO images ({_COLUMNS}) VALUES ({placeholders})", row)
        return self._public(row)

    def set_favorite(self, image_id: str, favorite: bool) -> dict[str, Any] | None:
        with self._connect() as conn:
            cur = conn.execute(
                "UPDATE images SET favorite = ? WHERE id = ?",
                (1 if favorite else 0, image_id),
            )
            if cur.rowcount == 0:
                return None
        return self.get(image_id)

    def delete(self, image_id: str) -> bool:
        record = self.get(image_id)
        if record is None:
            return False
        with self._connect() as conn:
            conn.execute("DELETE FROM images WHERE id = ?", (image_id,))
        path = self.outputs_dir / record["filename"]
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        return True

    # ------------------------------------------------------------------- read

    def get(self, image_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                f"SELECT {_COLUMNS} FROM images WHERE id = ?", (image_id,)
            ).fetchone()
        return self._public(dict(row)) if row else None

    def list(
        self,
        limit: int = 60,
        offset: int = 0,
        query: str = "",
        favorites_only: bool = False,
    ) -> dict[str, Any]:
        limit = max(1, min(int(limit), 500))
        offset = max(0, int(offset))
        where, params = [], []
        if query:
            where.append("(prompt LIKE ? OR model LIKE ? OR engine LIKE ?)")
            like = f"%{query}%"
            params += [like, like, like]
        if favorites_only:
            where.append("favorite = 1")
        clause = f"WHERE {' AND '.join(where)}" if where else ""
        with self._connect() as conn:
            total = conn.execute(
                f"SELECT COUNT(*) FROM images {clause}", params
            ).fetchone()[0]
            rows = conn.execute(
                f"SELECT {_COLUMNS} FROM images {clause} "
                "ORDER BY created_at DESC LIMIT ? OFFSET ?",
                [*params, limit, offset],
            ).fetchall()
        return {
            "total": total,
            "limit": limit,
            "offset": offset,
            "items": [self._public(dict(r)) for r in rows],
        }

    def stats(self) -> dict[str, Any]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS n, COALESCE(SUM(favorite), 0) AS favs, "
                "COALESCE(SUM(duration_ms), 0) AS ms FROM images"
            ).fetchone()
        bytes_on_disk = sum(
            p.stat().st_size for p in self.outputs_dir.glob("*.png") if p.is_file()
        )
        return {
            "images": row["n"],
            "favorites": row["favs"],
            "render_seconds": round(row["ms"] / 1000.0, 1),
            "bytes_on_disk": bytes_on_disk,
        }

    # ----------------------------------------------------------------- helpers

    @staticmethod
    def _public(row: dict[str, Any]) -> dict[str, Any]:
        out = dict(row)
        try:
            out["extra"] = json.loads(out.get("extra") or "{}")
        except (TypeError, ValueError):
            out["extra"] = {}
        out["favorite"] = bool(out.get("favorite"))
        out["url"] = f"/images/{out['filename']}"
        return out
