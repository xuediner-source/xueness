# Xueness Web UI — stdlib only, no third-party packages.
FROM python:3.12-slim

WORKDIR /app

# Git panel needs the git binary (read-only status/diff/log against the
# session workspace; the API never runs mutating git subcommands).
# deb.debian.org is unreliable from some networks (README's Docker notes):
# point apt at the TUNA mirror for this install layer only.
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

# Only the package + static UI; never bake state, demo output, or secrets.
COPY xueness/ ./xueness/
COPY webapp/dist/ ./webapp/dist/

# Non-root runtime + persistent data dir.
RUN useradd --create-home --uid 10001 appuser \
    && mkdir -p /data/state /data/web-runs \
    && chown -R appuser:appuser /app /data

USER appuser

EXPOSE 8137

VOLUME ["/data"]

# Loopback self-check; no curl dependency (stdlib only).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python3 -c "import urllib.request,sys; sys.exit(0 if b'\"ok\": true' in urllib.request.urlopen('http://127.0.0.1:8137/api/health', timeout=4).read() else 1)"

# NOTE: 0.0.0.0 here is container-local only (single net namespace).
# Reachability from the host is decided by the port publish mapping, which
# compose pins to 127.0.0.1. Direct `docker run` must pass
# -e XUENESS_ALLOW_REMOTE=1 -p 127.0.0.1:8137:8137 or startup refuses.
CMD ["python3", "-m", "xueness.web", "--host", "0.0.0.0", "--port", "8137", "--state", "/data/state", "--web-runs", "/data/web-runs"]
