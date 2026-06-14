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

RUN chmod +x /usr/local/bin/shinyipilot-codex-smoke \
    && uv sync --locked --project /workspace/shinyipilot

ENTRYPOINT ["/usr/local/bin/shinyipilot-codex-smoke"]
