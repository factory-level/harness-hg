# The wiki image (#664, ADR 0167): the mkdocs manual built AT the platform
# revision it documents, served by nginx. Build context is the REPO ROOT
# (build.sh enforces it) because the site build needs _docs/wiki, the
# generators' outputs already committed, and git history for the derived
# version.
FROM python:3.12-slim AS build
RUN pip install --no-cache-dir uv && apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN uv sync --group docs --frozen \
 && uv run --group docs mkdocs build --strict -f _docs/mkdocs.yml \
 && python3 infra/scripts/derive-version.py --print > _docs/site/version.txt

FROM nginx:1.27-alpine
COPY --from=build /src/_docs/site /usr/share/nginx/html
# /version answers the served platform version (the acceptance probe).
RUN printf 'server { listen 8080; root /usr/share/nginx/html; location = /version { default_type text/plain; try_files /version.txt =404; } location / { try_files $uri $uri/ /index.html; } }\n' > /etc/nginx/conf.d/default.conf \
 && sed -i 's/listen       80;/listen 8080;/' /etc/nginx/conf.d/default.conf 2>/dev/null; true
EXPOSE 8080
