"""SQLite-backed gallery.

Every image the app produces is written to disk as a PNG and indexed here, so
the gallery survives restarts and stays browsable/searchable offline. One
connection per call keeps this safe across the worker and HTTP threads.
"""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
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
    kind          TEXT NOT NULL DEFAULT 'image',
    mime          TEXT NOT NULL DEFAULT 'image/png',
    frames        INTEGER NOT NULL DEFAULT 1,
    fps           REAL NOT NULL DEFAULT 0,
    extra         TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_images_created ON images (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_images_favorite ON images (favorite, created_at DESC);
"""

_COLUMNS = (
    "id, created_at, filename, prompt, negative, engine, model, sampler, "
    "width, height, steps, guidance, seed, duration_ms, favorite, job_id, "
    "kind, mime, frames, fps, extra"
)

#: Columns added after the first release, back-filled on open so an existing
#: gallery keeps working rather than erroring on startup.
_MIGRATIONS = {
    "kind": "TEXT NOT NULL DEFAULT 'image'",
    "mime": "TEXT NOT NULL DEFAULT 'image/png'",
    "frames": "INTEGER NOT NULL DEFAULT 1",
    "fps": "REAL NOT NULL DEFAULT 0",
}


class Gallery:
    def __init__(self, db_path: Path, outputs_dir: Path) -> None:
        self.db_path = Path(db_path)
        self.outputs_dir = Path(outputs_dir)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.outputs_dir.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(SCHEMA)
            self._migrate(conn)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    @staticmethod
    def _migrate(conn: sqlite3.Connection) -> None:
        present = {row["name"] for row in conn.execute("PRAGMA table_info(images)")}
        for column, definition in _MIGRATIONS.items():
            if column not in present:
                conn.execute(f"ALTER TABLE images ADD COLUMN {column} {definition}")

    # ------------------------------------------------------------------ write

    def add(self, record: dict[str, Any], data: bytes) -> dict[str, Any]:
        """Write the file to disk and index it. Returns the stored record."""
        extension = str(record.get("extension") or ".png")
        if not extension.startswith(".") or "/" in extension or len(extension) > 8:
            extension = ".png"
        filename = f"{record['id']}{extension}"
        (self.outputs_dir / filename).write_bytes(data)
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
            "kind": str(record.get("kind") or "image"),
            "mime": str(record.get("mime") or "image/png"),
            "frames": int(record.get("frames") or 1),
            "fps": float(record.get("fps") or 0),
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
                "COALESCE(SUM(duration_ms), 0) AS ms, "
                "COALESCE(SUM(kind = 'video'), 0) AS clips FROM images"
            ).fetchone()
        bytes_on_disk = sum(
            p.stat().st_size for p in self.outputs_dir.iterdir()
            if p.is_file() and not p.name.startswith(".")
        )
        return {
            "images": row["n"],
            "videos": row["clips"],
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
        out["kind"] = out.get("kind") or "image"
        out["is_video"] = out["kind"] == "video"
        out["url"] = f"/images/{out['filename']}"
        return out


REFERENCE_SCHEMA = """
CREATE TABLE IF NOT EXISTS references_ (
    id          TEXT PRIMARY KEY,
    created_at  REAL NOT NULL,
    source      TEXT NOT NULL DEFAULT '',
    title       TEXT NOT NULL DEFAULT '',
    summary     TEXT NOT NULL DEFAULT '',
    page_url    TEXT NOT NULL DEFAULT '',
    image_url   TEXT NOT NULL DEFAULT '',
    filename    TEXT NOT NULL DEFAULT '',
    license     TEXT NOT NULL DEFAULT '',
    author      TEXT NOT NULL DEFAULT '',
    kind        TEXT NOT NULL DEFAULT 'image',
    mime        TEXT NOT NULL DEFAULT '',
    tags        TEXT NOT NULL DEFAULT '[]',
    width       INTEGER NOT NULL DEFAULT 0,
    height      INTEGER NOT NULL DEFAULT 0,
    extra       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_refs_created ON references_ (created_at DESC);
"""

_REF_COLUMNS = (
    "id, created_at, source, title, summary, page_url, image_url, filename, "
    "license, author, kind, mime, tags, width, height, extra"
)

_REF_MIGRATIONS = {
    "kind": "TEXT NOT NULL DEFAULT 'image'",
    "mime": "TEXT NOT NULL DEFAULT ''",
}

#: Only formats a browser can render are stored, keyed to their extension.
MEDIA_EXTENSIONS = {
    "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png",
    "image/apng": ".png", "image/webp": ".webp", "image/gif": ".gif",
    "image/avif": ".avif", "image/svg+xml": ".svg",
    "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
    "video/ogg": ".ogv",
}

#: Kept under the old name for anything still importing it.
IMAGE_EXTENSIONS = MEDIA_EXTENSIONS


class ReferenceStore:
    """Live material the user pulled in, copied to disk so it stays available
    offline - and so the browser can read it same-origin for palette work."""

    def __init__(self, db_path: Path, refs_dir: Path) -> None:
        self.db_path = Path(db_path)
        self.refs_dir = Path(refs_dir)
        self.refs_dir.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(REFERENCE_SCHEMA)
            present = {r["name"] for r in conn.execute("PRAGMA table_info(references_)")}
            for column, definition in _REF_MIGRATIONS.items():
                if column not in present:
                    conn.execute(
                        f"ALTER TABLE references_ ADD COLUMN {column} {definition}"
                    )

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def add(
        self,
        record: dict[str, Any],
        image: bytes | None = None,
        content_type: str = "",
    ) -> dict[str, Any]:
        reference_id = uuid.uuid4().hex[:16]
        filename = ""
        mime = (content_type or "").split(";")[0].strip().lower()
        if image:
            # An unknown type used to fall back to .jpg, which quietly saved
            # Mastodon's gifv MP4s as images that no browser would play.
            suffix = MEDIA_EXTENSIONS.get(mime)
            if suffix is None:
                suffix = ".mp4" if mime.startswith("video/") else ".jpg"
            filename = f"{reference_id}{suffix}"
            (self.refs_dir / filename).write_bytes(image)

        row = {
            "id": reference_id,
            "created_at": time.time(),
            "source": record.get("source", ""),
            "title": record.get("title", ""),
            "summary": record.get("summary", ""),
            "page_url": record.get("page_url", ""),
            "image_url": record.get("image_url", ""),
            "filename": filename,
            "license": record.get("license", ""),
            "author": record.get("author", ""),
            "kind": "video" if mime.startswith("video/") else str(
                record.get("kind") or "image"),
            "mime": mime,
            "tags": json.dumps(record.get("tags") or [], separators=(",", ":")),
            "width": int(record.get("width") or 0),
            "height": int(record.get("height") or 0),
            "extra": json.dumps(record.get("extra") or {}, separators=(",", ":")),
        }
        placeholders = ", ".join(f":{c.strip()}" for c in _REF_COLUMNS.split(","))
        with self._connect() as conn:
            conn.execute(
                f"INSERT INTO references_ ({_REF_COLUMNS}) VALUES ({placeholders})", row
            )
        return self._public(row)

    def get(self, reference_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                f"SELECT {_REF_COLUMNS} FROM references_ WHERE id = ?", (reference_id,)
            ).fetchone()
        return self._public(dict(row)) if row else None

    def path_for(self, reference_id: str) -> Path | None:
        record = self.get(reference_id)
        if not record or not record["filename"]:
            return None
        path = self.refs_dir / record["filename"]
        return path if path.is_file() else None

    def list(self, limit: int = 60, offset: int = 0) -> dict[str, Any]:
        limit = max(1, min(int(limit), 500))
        with self._connect() as conn:
            total = conn.execute("SELECT COUNT(*) FROM references_").fetchone()[0]
            rows = conn.execute(
                f"SELECT {_REF_COLUMNS} FROM references_ "
                "ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (limit, max(0, int(offset))),
            ).fetchall()
        return {
            "total": total,
            "items": [self._public(dict(row)) for row in rows],
        }

    def delete(self, reference_id: str) -> bool:
        record = self.get(reference_id)
        if record is None:
            return False
        with self._connect() as conn:
            conn.execute("DELETE FROM references_ WHERE id = ?", (reference_id,))
        if record["filename"]:
            try:
                (self.refs_dir / record["filename"]).unlink()
            except FileNotFoundError:
                pass
        return True

    @staticmethod
    def _public(row: dict[str, Any]) -> dict[str, Any]:
        out = dict(row)
        for key in ("tags", "extra"):
            try:
                out[key] = json.loads(out.get(key) or ("[]" if key == "tags" else "{}"))
            except (TypeError, ValueError):
                out[key] = [] if key == "tags" else {}
        out["kind"] = out.get("kind") or "image"
        out["is_video"] = out["kind"] == "video"
        out["local_url"] = f"/refs/{out['filename']}" if out["filename"] else ""
        return out
