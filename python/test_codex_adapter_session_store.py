from __future__ import annotations

import json

from copilot.codex_adapter.session_store import (
    CodexAdapterSessionStore,
    CodexRuntimeSessionRecord,
)


def make_record(session_id: str, *, tool_fingerprint: str = "fp-1") -> CodexRuntimeSessionRecord:
    return CodexRuntimeSessionRecord(
        sdkSessionId=session_id,
        runtime="codex",
        runtimeSessionId=f"runtime-{session_id}",
        codexThreadId=f"thread-{session_id}",
        cwd=f"/tmp/{session_id}",
        toolFingerprint=tool_fingerprint,
        createdAt="2026-06-12T00:00:00Z",
        updatedAt="2026-06-12T00:00:00Z",
        model="gpt-5.4",
        reasoningEffort="high",
        codexHomeIdentity="isolated-home",
    )


def test_session_store_loads_only_valid_codex_records(tmp_path):
    store_path = tmp_path / "sessions.json"
    store_path.write_text(
        json.dumps(
            {
                "version": 1,
                "records": [
                    make_record("valid-1").__dict__,
                    {"sdkSessionId": "missing-fields"},
                    {"runtime": "copilot", "sdkSessionId": "wrong-runtime"},
                ],
            }
        )
    )

    store = CodexAdapterSessionStore(str(store_path))

    assert store.get("valid-1") == make_record("valid-1")
    assert store.get("missing-fields") is None
    assert store.get("wrong-runtime") is None


def test_session_store_upsert_flushes_sorted_payload(tmp_path):
    store_path = tmp_path / "sessions.json"
    store = CodexAdapterSessionStore(str(store_path))

    store.upsert(make_record("session-b", tool_fingerprint="fp-b"))
    store.upsert(make_record("session-a", tool_fingerprint="fp-a"))

    payload = json.loads(store_path.read_text())
    assert [record["sdkSessionId"] for record in payload["records"]] == [
        "session-a",
        "session-b",
    ]
    assert payload["records"][0]["toolFingerprint"] == "fp-a"
    assert payload["records"][1]["toolFingerprint"] == "fp-b"
    assert payload["records"][0]["reasoningEffort"] == "high"


def test_session_store_delete_removes_record_and_flushes(tmp_path):
    store_path = tmp_path / "sessions.json"
    store = CodexAdapterSessionStore(str(store_path))
    store.upsert(make_record("session-a"))
    store.upsert(make_record("session-b"))

    store.delete("session-a")

    payload = json.loads(store_path.read_text())
    assert payload["records"] == [make_record("session-b").__dict__]
    assert store.get("session-a") is None
    assert store.get("session-b") == make_record("session-b")
