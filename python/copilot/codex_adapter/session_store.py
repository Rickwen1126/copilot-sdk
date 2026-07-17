"""Durable SDK-session to Codex-thread mapping store."""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass
class CodexRuntimeSessionRecord:
    sdkSessionId: str
    runtime: str
    runtimeSessionId: str
    codexThreadId: str
    cwd: str
    toolFingerprint: str
    createdAt: str
    updatedAt: str
    model: str | None = None
    reasoningEffort: str | None = None
    codexHomeIdentity: str | None = None
    # Opaque per-tool metadata bags (v1.0.7 Tool.metadata), keyed by tool
    # name. Additive optional field: records written without it still parse.
    toolMetadata: dict[str, dict] | None = None


def _parse_record(value: object) -> CodexRuntimeSessionRecord | None:
    if not isinstance(value, dict):
        return None
    required = [
        "sdkSessionId",
        "runtimeSessionId",
        "codexThreadId",
        "cwd",
        "toolFingerprint",
        "createdAt",
        "updatedAt",
    ]
    if value.get("runtime") != "codex" or not all(
        isinstance(value.get(key), str) for key in required
    ):
        return None
    return CodexRuntimeSessionRecord(
        sdkSessionId=value["sdkSessionId"],
        runtime="codex",
        runtimeSessionId=value["runtimeSessionId"],
        codexThreadId=value["codexThreadId"],
        cwd=value["cwd"],
        model=value.get("model") if isinstance(value.get("model"), str) else None,
        reasoningEffort=(
            value.get("reasoningEffort")
            if isinstance(value.get("reasoningEffort"), str)
            or value.get("reasoningEffort") is None
            else None
        ),
        toolFingerprint=value["toolFingerprint"],
        codexHomeIdentity=value.get("codexHomeIdentity")
        if isinstance(value.get("codexHomeIdentity"), str)
        else None,
        toolMetadata=value.get("toolMetadata")
        if isinstance(value.get("toolMetadata"), dict)
        else None,
        createdAt=value["createdAt"],
        updatedAt=value["updatedAt"],
    )


class CodexAdapterSessionStore:
    def __init__(self, file_path: str | None = None):
        self.file_path = Path(file_path) if file_path else None
        self.records: dict[str, CodexRuntimeSessionRecord] = {}
        self._load()

    def get(self, session_id: str) -> CodexRuntimeSessionRecord | None:
        return self.records.get(session_id)

    def upsert(self, record: CodexRuntimeSessionRecord) -> None:
        self.records[record.sdkSessionId] = record
        self._flush()

    def delete(self, session_id: str) -> None:
        self.records.pop(session_id, None)
        self._flush()

    def _load(self) -> None:
        if not self.file_path or not self.file_path.exists():
            return
        payload = json.loads(self.file_path.read_text())
        values = payload.get("records") if isinstance(payload, dict) else []
        self.records = {
            record.sdkSessionId: record
            for record in (_parse_record(item) for item in values)
            if record is not None
        }

    def _flush(self) -> None:
        if not self.file_path:
            return
        self.file_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": 1,
            "records": [
                asdict(record)
                for record in sorted(self.records.values(), key=lambda item: item.sdkSessionId)
            ],
        }
        tmp_path = self.file_path.with_name(f"{self.file_path.name}.{os.getpid()}.tmp")
        tmp_path.write_text(json.dumps(payload, indent=2) + "\n")
        tmp_path.replace(self.file_path)
