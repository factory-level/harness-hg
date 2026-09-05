# The Nexus UI host image (#845): python + fastapi + uvicorn + git, nothing
# else. standalone.py serves the plugin router and the committed dist; the
# chart's initContainer and sync sidecar need git for the GitOps clone.
# The plugin code and the UI bundles are NOT baked in - the chart mounts
# them (plugin files from chart/files, bundles from the nexus-ui-dist
# ConfigMap), so this image changes only when a runtime dependency does.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir "fastapi>=0.110" "uvicorn>=0.29" "pyyaml>=6" "pyjwt[crypto]>=2.8"
WORKDIR /app
EXPOSE 8080
