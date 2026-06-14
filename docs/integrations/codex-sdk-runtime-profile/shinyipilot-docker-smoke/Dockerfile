FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_CACHE_DIR=/runtime/uv-cache \
    UV_LINK_MODE=copy \
    PATH="/root/.local/bin:/workspace/shinyipilot/.venv/bin:${PATH}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        nodejs \
        npm \
        sqlite3 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
    && npm install -g @openai/codex

WORKDIR /workspace/shinyipilot

COPY python /workspace/python
COPY shinyipilot /workspace/shinyipilot
COPY container-smoke.sh /usr/local/bin/shinyipilot-codex-smoke
COPY container-behavior-sweep.py /usr/local/bin/shinyipilot-codex-behavior-sweep
COPY container-production-line.sh /usr/local/bin/shinyipilot-codex-production-line
COPY container-line-shadow-preflight.py /usr/local/bin/shinyipilot-line-shadow-preflight

RUN chmod +x /usr/local/bin/shinyipilot-codex-smoke \
    && chmod +x /usr/local/bin/shinyipilot-codex-behavior-sweep \
    && chmod +x /usr/local/bin/shinyipilot-codex-production-line \
    && chmod +x /usr/local/bin/shinyipilot-line-shadow-preflight \
    && uv sync --locked --project /workspace/shinyipilot \
    && uv pip install --python /workspace/shinyipilot/.venv/bin/python \
        --editable /workspace/python

ENTRYPOINT ["/usr/local/bin/shinyipilot-codex-smoke"]
