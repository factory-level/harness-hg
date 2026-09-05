# The eve-runtime image (ADR-149): Node + git + the platform's pinned `eve`
# CLI. It is BOTH the build toolchain the eve-agent chart's initContainer
# runs (`git clone` at spec.sha, `npm ci`, `eve build`) and the process
# image the main container serves the built Nitro output from (`eve start`).
# The agent's own source is never baked in - it arrives at boot from Git,
# the same convergence shape as the Hermes agent image.
#
# Node 24 is eve's floor (package.json engines). The official node image
# runs on pre-AVX2 CPUs (#331 applies to oven/bun, not to node).
#
# Build args come from versions.json - never hardcode a second pin
# (ADR-63; cli/tests/versions.test.ts hunts literal copies):
#   infra/images/eve-runtime/build.sh [--push] <registry-tag>
FROM node:24-bookworm-slim
ARG EVE_VERSION
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
# The platform pin. The boot script compares the project's resolved eve
# against `eve --version` and refuses a mismatch, so a persona cannot
# silently run a runtime the platform never pinned.
RUN npm install -g --no-audit --no-fund "eve@${EVE_VERSION}" \
 && eve --version
ENV EVE_VERSION=${EVE_VERSION}
# The chart runs every container as the image's `node` user (1000) with
# fsGroup 1000 on the data volume; nothing in the image is writable by it
# except the volume the chart mounts at /app.
USER 1000:1000
WORKDIR /app
