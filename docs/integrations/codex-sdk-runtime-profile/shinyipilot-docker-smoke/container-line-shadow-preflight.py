#!/usr/bin/env python3
"""Synthetic LINE shadow preflight for the production-line Docker lane."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import sqlite3
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml


def load_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    return data or {}


def iter_binding_entries(bindings_doc: dict[str, Any]):
    for section in ("route_bindings_manual", "route_bindings_auto"):
        value = bindings_doc.get(section) or {}
        if isinstance(value, dict):
            for route_id, entry in value.items():
                yield section, str(route_id), entry or {}
    for index, entry in enumerate(bindings_doc.get("fallback_bindings") or []):
        yield "fallback_bindings", f"fallback_bindings[{index}]", entry or {}


def select_shadow_route(bindings_doc: dict[str, Any], labels: dict[str, str]) -> dict[str, Any]:
    candidates: list[dict[str, Any]] = []
    for section, route_id, entry in iter_binding_entries(bindings_doc):
        match = entry.get("match") or {}
        platform = match.get("platform") or (
            route_id.rsplit(":", 1)[0] if route_id.startswith("line:") else ""
        )
        conversation_id = match.get("group_id") or (
            route_id.rsplit(":", 1)[1] if route_id.startswith("line:") else ""
        )
        if not platform.startswith("line:"):
            continue
        if not conversation_id.startswith(("C", "R")):
            continue
        if entry.get("ingress_policy") != "observer_capture_only":
            continue
        if entry.get("delivery_policy") != "suppress_origin_delivery":
            continue
        if not labels.get(route_id):
            continue
        candidates.append(
            {
                "section": section,
                "routeId": route_id,
                "platform": platform,
                "conversationId": conversation_id,
                "chatbot": entry.get("chatbot", ""),
                "ingressPolicy": entry.get("ingress_policy", ""),
                "deliveryPolicy": entry.get("delivery_policy", ""),
                "observationContract": entry.get("observation_contract", ""),
                "observationScope": entry.get("observation_scope", ""),
                "hasRouteLabel": True,
            }
        )
    if not candidates:
        raise RuntimeError(
            "No observer_capture_only + suppress_origin_delivery LINE route with a route label was found"
        )
    candidates.sort(
        key=lambda item: (
            item["observationScope"] != "production",
            item["observationContract"] != "ops_memory",
            item["routeId"],
        )
    )
    return candidates[0]


def sign_line_body(body: bytes, secret: str) -> str:
    digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).digest()
    return base64.b64encode(digest).decode("utf-8")


def post_json(url: str, body: bytes, signature: str) -> tuple[int, str]:
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Line-Signature": signature,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:  # type: ignore[name-defined]
        return exc.code, exc.read().decode("utf-8", errors="replace")


def get_json(url: str) -> dict[str, Any]:
    with urllib.request.urlopen(url, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def query_one(conn: sqlite3.Connection, sql: str, params: tuple[Any, ...]) -> Any:
    row = conn.execute(sql, params).fetchone()
    return row[0] if row else None


def wait_for_log(path: Path, needle: str, timeout_seconds: int = 15) -> bool:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        if path.exists() and needle in path.read_text(encoding="utf-8", errors="replace"):
            return True
        time.sleep(0.5)
    return False


def main() -> int:
    artifact_dir = Path(os.environ.get("ARTIFACT_DIR", "/artifacts"))
    runtime_dir = Path(os.environ.get("RUNTIME_DIR", "/runtime"))
    app_url = os.environ.get("APP_URL", "http://127.0.0.1:29999")
    settings_path = Path(os.environ["ROUTE_SETTINGS_PATH"])
    bindings_path = Path(os.environ["ROUTE_BINDINGS_PATH"])
    chatpilot_db = Path(os.environ.get("CHATPILOT_DB", runtime_dir / "chatpilot.db"))
    line_secret_env = os.environ.get("SHADOW_LINE_SECRET_ENV", "LINE_CHANNEL_SECRET")
    line_token_env = os.environ.get("SHADOW_LINE_TOKEN_ENV", "LINE_CHANNEL_ACCESS_TOKEN")
    line_secret = os.environ.get(line_secret_env, "")
    line_token_present = bool(os.environ.get(line_token_env, ""))

    if not line_secret:
        raise RuntimeError(f"Missing required LINE secret env: {line_secret_env}")
    if not line_token_present:
        raise RuntimeError(f"Missing required LINE token env: {line_token_env}")

    settings_doc = load_yaml(settings_path)
    bindings_doc = load_yaml(bindings_path)
    labels_path = runtime_dir / "route_labels.json"
    labels = json.loads(labels_path.read_text(encoding="utf-8")) if labels_path.exists() else {}
    route = select_shadow_route(bindings_doc, labels)

    health = get_json(f"{app_url}/health")
    if health.get("status") not in {"ok", "healthy"}:
        raise RuntimeError(f"Unexpected health payload: {health}")

    timestamp_ms = int(time.time() * 1000)
    marker = f"codex-line-shadow-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    platform_message_id = marker
    body_obj = {
        "destination": "UshadowDestination",
        "events": [
            {
                "type": "message",
                "timestamp": timestamp_ms,
                "source": {
                    "type": "group",
                    "groupId": route["conversationId"],
                    "userId": "",
                },
                "replyToken": f"shadow-reply-token-{marker}",
                "mode": "active",
                "webhookEventId": f"shadow-{marker}",
                "deliveryContext": {"isRedelivery": False},
                "message": {
                    "id": platform_message_id,
                    "type": "text",
                    "text": f"[shadow-preflight] {marker}",
                    "quoteToken": "shadow-quote-token",
                },
            }
        ],
    }
    body = json.dumps(body_obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    status_code, response_text = post_json(
        f"{app_url}/webhook/line",
        body,
        sign_line_body(body, line_secret),
    )
    if status_code != 200:
        raise RuntimeError(f"LINE webhook returned {status_code}: {response_text}")

    conn = sqlite3.connect(str(chatpilot_db))
    try:
        source_row = conn.execute(
            """
            SELECT route_id, platform_message_id, raw_text, capture_policy, retention_class
            FROM source_messages
            WHERE route_id = ? AND platform_message_id = ?
            """,
            (route["routeId"], platform_message_id),
        ).fetchone()
        route_identity_count = int(
            query_one(
                conn,
                """
                SELECT count(*) FROM line_identity_registry
                WHERE platform = ? AND identity_type = 'route' AND route_id = ?
                """,
                (route["platform"], route["routeId"]),
            )
        )
    finally:
        conn.close()

    if source_row is None:
        raise RuntimeError("Synthetic LINE message did not produce a source_messages row")
    if route_identity_count < 1:
        raise RuntimeError("Synthetic LINE message did not update line_identity_registry route row")

    routes_payload = get_json(f"{app_url}/cli/routes")
    route_view = next(
        (
            item
            for item in routes_payload.get("routes", [])
            if item.get("route_id") == route["routeId"]
        ),
        {},
    )
    ingress_ok = route_view.get("ingress_policy") == "observer_capture_only"
    delivery_ok = route_view.get("delivery_policy") == "suppress_origin_delivery"
    if not ingress_ok or not delivery_ok:
        raise RuntimeError(f"Route view policy mismatch: {route_view}")

    log_path = artifact_dir / "shinyipilot.log"
    log_needle = f"[line-ingress] {route['routeId']} handled policy=observer_capture_only"
    log_ok = wait_for_log(log_path, log_needle)
    if not log_ok:
        raise RuntimeError(f"Missing line ingress log: {log_needle}")

    adapter_channels = settings_doc.get("adapters", {}).get("line", [])
    result = {
        "status": "pass",
        "mode": "shadow",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "appUrl": app_url,
        "health": health,
        "model": os.environ.get("CODEX_ADAPTER_MODEL", ""),
        "runtimeBackend": os.environ.get("CHATPILOT_RUNTIME_BACKEND", ""),
        "lineConfig": {
            "channelCount": len(adapter_channels),
            "secretEnv": line_secret_env,
            "tokenEnv": line_token_env,
            "secretProvided": True,
            "tokenProvided": True,
        },
        "selectedRoute": route,
        "syntheticWebhook": {
            "statusCode": status_code,
            "response": json.loads(response_text),
            "platformMessageId": platform_message_id,
            "usesEmptyUserId": True,
        },
        "sqlite": {
            "database": str(chatpilot_db),
            "sourceMessage": {
                "routeId": source_row[0],
                "platformMessageId": source_row[1],
                "rawText": source_row[2],
                "capturePolicy": source_row[3],
                "retentionClass": source_row[4],
            },
            "lineIdentityRouteRows": route_identity_count,
        },
        "routeViewChecks": {
            "routeVisible": bool(route_view),
            "ingressPolicyObserverCaptureOnly": ingress_ok,
            "deliveryPolicySuppressOriginDelivery": delivery_ok,
        },
        "logChecks": {
            "lineIngressHandled": log_ok,
        },
        "secretLeakageCheck": {
            "lineSecretValueWritten": False,
            "lineTokenValueWritten": False,
        },
    }
    output_path = artifact_dir / "line-shadow-preflight-result.json"
    output_path.write_text(
        json.dumps(result, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(output_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
