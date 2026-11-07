"""Snapshot the request param keys the Codex app-server accepts.

The adapter talks to `codex app-server` with `experimentalApi: true`, so the
snapshot uses the experimental schema. Regenerate whenever the Codex pin moves:

    python scripts/snapshot_codex_app_server_params.py --codex /path/to/codex

The output is a fixture for test_codex_adapter_app_server_contract.py. Unknown
request keys are silently dropped by the app-server, so this snapshot is the
only thing that catches a renamed field (e.g. turn/start `effort`).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

PARAMS = {
    "thread/start": "ThreadStartParams",
    "thread/resume": "ThreadResumeParams",
    "turn/start": "TurnStartParams",
}
DEFAULT_OUT = Path(__file__).resolve().parent.parent / "test_fixtures"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--codex", default="codex", help="codex binary to snapshot")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    version = (
        subprocess.run([args.codex, "--version"], check=True, capture_output=True, text=True)
        .stdout.strip()
        .split()[-1]
    )
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(
            [args.codex, "app-server", "generate-json-schema", "--experimental", "--out", tmp],
            check=True,
            capture_output=True,
        )
        methods = {}
        for method, name in PARAMS.items():
            schema = json.loads((Path(tmp) / "v2" / f"{name}.json").read_text())
            methods[method] = sorted(schema["properties"])
    payload = {
        "codexVersion": version,
        "source": "codex app-server generate-json-schema --experimental (v2 *Params properties)",
        "methods": methods,
    }
    args.out_dir.mkdir(parents=True, exist_ok=True)
    out = args.out_dir / f"codex_app_server_params_{version}.json"
    out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(out)


if __name__ == "__main__":
    main()
