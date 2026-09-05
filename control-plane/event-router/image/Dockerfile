# The event-router image for hosts whose CPUs predate AVX2 (#331): the
# stock oven/bun image core-dumps with "Illegal instruction" on e.g.
# an older Xeon (E5-2697 v2), exactly like the host binary did before the
# bootstrap learned to pick bun's baseline build (install-pinned.sh). Same
# fix here: the pinned baseline zip from GitHub releases, verified against
# versions.json's bunBaselineSha256. The chart's default image stays
# oven/bun; an environment opts into this one via `topology emit
# --router-image` (ADR-74).
#
# Build args come from versions.json - never hardcode a second pin
# (ADR-63; cli/tests/versions.test.ts hunts literal copies):
#   infra/images/event-router/build.sh [--push] <registry-tag>
FROM debian:bookworm-slim AS fetch
ARG BUN_VERSION
ARG BUN_BASELINE_SHA256
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl python3 \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64-baseline.zip" -o /tmp/bun.zip \
 && echo "${BUN_BASELINE_SHA256}  /tmp/bun.zip" | sha256sum -c - \
 && python3 -m zipfile -e /tmp/bun.zip /tmp/bun \
 && install -m 0755 /tmp/bun/bun-linux-x64-baseline/bun /usr/local/bin/bun

FROM debian:bookworm-slim
COPY --from=fetch /usr/local/bin/bun /usr/local/bin/bun
# The chart mounts /app (code) and /config read-only and runs
# `bun /app/router.ts`; nothing else lives here.
USER 65532:65532
ENTRYPOINT ["bun"]
