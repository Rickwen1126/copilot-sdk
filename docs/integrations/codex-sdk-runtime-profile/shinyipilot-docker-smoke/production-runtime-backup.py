#!/usr/bin/env python3
"""Create a startup backup for the ShinyiPilot production-line runtime."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


RUNNER_VERSION = "production-line-backup-v1"

DB_NAMES = ("chatpilot.db", "tasks.db", "files.db")
ASSET_NAMES = (
    "file_assets",
    "line_route_group_map.generated.json",
    "line_route_group_map.generated.md",
    "route_labels.json",
    "session_contexts",
    "unit_images.json",
    "workspace",
)
ROW_COUNT_TABLES = (
    "memory_memos",
    "memory_custom_prompts",
    "memory_reminders",
    "memory_schedules",
    "memory_observations",
    "observation_entries",
    "source_messages",
    "line_identity_registry",
    "tasks",
    "file_assets",
    "file_notes",
    "file_relations",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def count_files_and_bytes(path: Path) -> tuple[int, int]:
    if path.is_file():
        return 1, path.stat().st_size
    file_count = 0
    byte_count = 0
    for child in path.rglob("*"):
        if child.is_file():
            file_count += 1
            byte_count += child.stat().st_size
    return file_count, byte_count


def tree_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    if path.is_file():
        digest.update(path.name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(sha256_file(path).encode("ascii"))
        return digest.hexdigest()
    for child in sorted(path.rglob("*")):
        if not child.is_file():
            continue
        digest.update(str(child.relative_to(path)).encode("utf-8"))
        digest.update(b"\0")
        digest.update(sha256_file(child).encode("ascii"))
        digest.update(b"\0")
    return digest.hexdigest()


def table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (table,),
    ).fetchone()
    return row is not None


def row_counts(conn: sqlite3.Connection) -> dict[str, int]:
    counts: dict[str, int] = {}
    for table in ROW_COUNT_TABLES:
        if table_exists(conn, table):
            counts[table] = int(conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0])
    return counts


def backup_sqlite(source: Path, destination: Path) -> dict[str, Any]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    source_conn = sqlite3.connect(str(source))
    source_conn.execute("PRAGMA busy_timeout=5000")
    checkpoint = None
    try:
        checkpoint = list(source_conn.execute("PRAGMA wal_checkpoint(FULL);"))
        destination_conn = sqlite3.connect(str(destination))
        try:
            source_conn.backup(destination_conn)
        finally:
            destination_conn.close()
    finally:
        source_conn.close()

    verify_conn = sqlite3.connect(str(destination))
    try:
        integrity = str(verify_conn.execute("PRAGMA integrity_check;").fetchone()[0])
        counts = row_counts(verify_conn)
    finally:
        verify_conn.close()

    if integrity != "ok":
        raise RuntimeError(f"integrity_check failed for {destination}: {integrity}")

    for suffix in ("-wal", "-shm"):
        generated_sidecar = Path(f"{destination}{suffix}")
        if generated_sidecar.exists():
            generated_sidecar.unlink()

    sidecars = {}
    for suffix in ("-wal", "-shm"):
        sidecar = Path(f"{source}{suffix}")
        sidecars[suffix[1:]] = {
            "exists": sidecar.exists(),
            "bytes": sidecar.stat().st_size if sidecar.exists() else 0,
        }

    return {
        "name": source.name,
        "sourcePath": str(source),
        "backupPath": str(destination),
        "sourceBytes": source.stat().st_size,
        "backupBytes": destination.stat().st_size,
        "backupSha256": sha256_file(destination),
        "integrityCheck": integrity,
        "walCheckpoint": checkpoint,
        "sourceSidecars": sidecars,
        "rowCounts": counts,
    }


def copy_asset(source: Path, destination: Path) -> dict[str, Any]:
    if source.is_dir():
        shutil.copytree(source, destination, symlinks=True)
        kind = "directory"
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        kind = "file"
    files, bytes_ = count_files_and_bytes(destination)
    return {
        "name": source.name,
        "kind": kind,
        "sourcePath": str(source),
        "backupPath": str(destination),
        "fileCount": files,
        "bytes": bytes_,
        "treeSha256": tree_sha256(destination),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-dir", required=True, type=Path)
    parser.add_argument("--backup-root", required=True, type=Path)
    parser.add_argument("--artifact-dir", type=Path)
    parser.add_argument(
        "--timestamp",
        default=datetime.now().strftime("%Y%m%d-%H%M%S"),
    )
    parser.add_argument(
        "--backup-name",
        default=None,
        help="Defaults to '<timestamp>-production-line-startup'.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    runtime_dir = args.runtime_dir.expanduser().resolve()
    backup_root = args.backup_root.expanduser().resolve()
    backup_name = args.backup_name or f"{args.timestamp}-production-line-startup"
    backup_dir = backup_root / backup_name
    manifest_path = backup_dir / "manifest.json"

    if not runtime_dir.is_dir():
        raise SystemExit(f"runtime dir does not exist: {runtime_dir}")
    if backup_dir.exists() and any(backup_dir.iterdir()):
        raise SystemExit(f"backup dir already exists and is not empty: {backup_dir}")
    backup_dir.mkdir(parents=True, exist_ok=True)

    databases = []
    for name in DB_NAMES:
        source = runtime_dir / name
        if not source.exists():
            raise SystemExit(f"required SQLite DB missing: {source}")
        databases.append(backup_sqlite(source, backup_dir / name))

    assets = []
    for name in ASSET_NAMES:
        source = runtime_dir / name
        if not source.exists():
            continue
        assets.append(copy_asset(source, backup_dir / name))

    manifest: dict[str, Any] = {
        "status": "pass",
        "runnerVersion": RUNNER_VERSION,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "runtimeDir": str(runtime_dir),
        "backupDir": str(backup_dir),
        "databases": databases,
        "assets": assets,
        "notes": [
            "SQLite databases were copied with sqlite3 backup API after WAL checkpoint.",
            "Only allowlisted non-DB runtime assets were copied.",
            "Codex auth homes, uv caches, .env files, and other secret-bearing state are not part of this backup helper.",
        ],
    }
    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    if args.artifact_dir:
        artifact_dir = args.artifact_dir.expanduser().resolve()
        artifact_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(manifest_path, artifact_dir / "startup-backup-manifest.json")

    print(manifest_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
