# Xueness Web UI — the TypeScript server on Node 24 (types stripped at run time, no build step).
FROM node:24-slim

WORKDIR /app

# Git panel needs the git binary (read-only status/diff/log against the
# session workspace; the API never runs mutating git subcommands).
# deb.debian.org is unreliable from some networks (README's Docker notes):
# point apt at the TUNA mirror for this install layer only.
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

# Only the TypeScript backend + static UI; never bake state, demo output, or secrets.
COPY ts/ ./ts/
COPY webapp/dist/ ./webapp/dist/
RUN npm ci --prefix ts --omit=dev --no-audit --no-fund && npm cache clean --force

# Non-root runtime + persistent data dir.
RUN useradd --create-home --uid 10001 appuser \
    && mkdir -p /data/state /data/web-runs \
    && chown -R appuser:appuser /app /data

USER appuser

EXPOSE 8137

VOLUME ["/data"]

# Loopback self-check; no curl dependency (Node's fetch).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:8137/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>r.json()).then(b=>process.exit(b.ok===true?0:1),()=>process.exit(1))"]

# NOTE: 0.0.0.0 here is container-local only (single net namespace).
# Reachability from the host is decided by the port publish mapping, which
# compose pins to 127.0.0.1. Direct `docker run` must pass
# -e XUENESS_ALLOW_REMOTE=1 -p 127.0.0.1:8137:8137 or startup refuses.
CMD ["node", "ts/apps/server/src/main.ts", "--project-root", "/app", "--host", "0.0.0.0", "--port", "8137", "--state", "/data/state", "--web-runs", "/data/web-runs"]
