# syntax=docker/dockerfile:1

# Annotamate container image.
#
#   docker build -t annotamate .
#   docker run -d -p 8765:8765 -v /path/to/datasets:/data \
#     -v annotamate-state:/var/lib/annotamate annotamate
#
# Stages:
#   web      builds the React SPA with Node
#   build    installs the Python package (with the SPA inside) into a virtualenv
#   runtime  the final image: Python, the virtualenv and nothing else

ARG NODE_VERSION=24
ARG PYTHON_VERSION=3.13

# ---------------------------------------------------------------------------
# Stage 1: build the single-page app
# ---------------------------------------------------------------------------
# The bundle is platform independent: build it natively, even for a multi-arch image.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS web

# Vite writes the bundle to ../annotamate/server/static (relative to web/),
# so the directory layout of the repository is kept: /src/web -> /src/annotamate/server/static
WORKDIR /src/web

# Dependencies first: this layer is reused until the lock file changes.
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

COPY web/ ./
RUN npm run build \
    && test -f /src/annotamate/server/static/index.html

# ---------------------------------------------------------------------------
# Stage 2: install the Python package into a virtualenv
# ---------------------------------------------------------------------------
FROM python:${PYTHON_VERSION}-slim AS build

# Optional extras to install, for example: --build-arg ANNOTAMATE_EXTRAS=postgres
ARG ANNOTAMATE_EXTRAS=""

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_ROOT_USER_ACTION=ignore \
    PYTHONDONTWRITEBYTECODE=1

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

WORKDIR /src

# Dependencies first: install what pyproject.toml declares before copying the
# source, so code changes do not invalidate this layer.
COPY pyproject.toml ./
RUN --mount=type=cache,target=/root/.cache/pip \
    python -c "import tomllib; p = tomllib.load(open('pyproject.toml', 'rb'))['project']; extras = [e for e in '${ANNOTAMATE_EXTRAS}'.split(',') if e]; deps = list(p.get('dependencies', [])); [deps.extend(p.get('optional-dependencies', {}).get(e, [])) for e in extras]; open('/tmp/requirements.txt', 'w').write('\n'.join(deps) + '\n')" \
    && pip install -r /tmp/requirements.txt

# The package source, then the SPA built in stage 1 at the place the wheel expects it.
COPY README.md LICENSE ./
COPY annotamate/ ./annotamate/
COPY --from=web /src/annotamate/server/static/ ./annotamate/server/static/

RUN --mount=type=cache,target=/root/.cache/pip \
    if [ -n "${ANNOTAMATE_EXTRAS}" ]; then pip install ".[${ANNOTAMATE_EXTRAS}]"; else pip install .; fi

# Fail the build if the SPA did not make it into the installed package.
# Run from / so the installed copy is imported, not the source tree.
RUN cd / && python -c "import pathlib, annotamate; p = pathlib.Path(annotamate.__file__).parent / 'server' / 'static' / 'index.html'; assert 'site-packages' in str(p) and p.is_file(), f'SPA missing from the installed package: {p}'"

# ---------------------------------------------------------------------------
# Stage 3: runtime
# ---------------------------------------------------------------------------
FROM python:${PYTHON_VERSION}-slim AS runtime

LABEL org.opencontainers.image.title="Annotamate" \
      org.opencontainers.image.description="Self-hosted, multi-user image annotation server (YOLO, Pascal VOC, COCO)" \
      org.opencontainers.image.url="https://github.com/rugvedjalit/Annotamate" \
      org.opencontainers.image.source="https://github.com/rugvedjalit/Annotamate" \
      org.opencontainers.image.documentation="https://github.com/rugvedjalit/Annotamate/blob/main/docs/guides/deployment.md" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.authors="Rugved Jalit" \
      org.opencontainers.image.vendor="Rugved Jalit"

# Non-root user. Override at run time with `--user UID:GID` so that label files
# written into the dataset mount belong to the right host user.
# The state directory is world-writable (with the sticky bit) so that a named
# volume initialised from it stays usable under any `--user`.
RUN groupadd --gid 1000 annotamate \
    && useradd --uid 1000 --gid 1000 --create-home --shell /usr/sbin/nologin annotamate \
    && mkdir -p /var/lib/annotamate /data \
    && chown annotamate:annotamate /var/lib/annotamate /data \
    && chmod 1777 /var/lib/annotamate

COPY --from=build /opt/venv /opt/venv

ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    ANNOTAMATE_HOST=0.0.0.0 \
    ANNOTAMATE_PORT=8765 \
    ANNOTAMATE_DATA_DIR=/var/lib/annotamate \
    ANNOTAMATE_ROOTS=/data

USER annotamate:annotamate
WORKDIR /data

VOLUME ["/var/lib/annotamate"]
EXPOSE 8765

# Honours ANNOTAMATE_PORT and ANNOTAMATE_BASE_URL when they are overridden.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python", "-c", "import os, sys, urllib.request; base = os.environ.get('ANNOTAMATE_BASE_URL', '/').strip('/'); port = os.environ.get('ANNOTAMATE_PORT', '8765'); url = 'http://127.0.0.1:%s/%sapi/health' % (port, base + '/' if base else ''); sys.exit(0 if urllib.request.urlopen(url, timeout=4).status == 200 else 1)"]

CMD ["annotamate", "serve"]
