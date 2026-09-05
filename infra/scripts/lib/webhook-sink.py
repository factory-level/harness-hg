#!/usr/bin/env python3
"""Tiny webhook sink for the smoke e2e (stdlib only, no dependencies).

Stands in for the operator's real receiver (a GitHub dispatch proxy,
Discord, ...) so the e2e can ASSERT delivery instead of eyeballing a
third-party UI: every HTTP request it receives is appended to a JSONL log
file as {"ts", "method", "path", "body"} (body parsed as JSON when
possible, raw text otherwise). smoke-local.sh greps that file for the
firing alert.

Usage: webhook-sink.py <port> <logfile>   (binds 0.0.0.0, so the docker
bridge gateway IP trick — see smoke-local.sh's header — makes it
reachable from inside k3d pods.)
"""

import json
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    log_path = None

    def _record(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8", errors="replace") if length else ""
        try:
            body = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            body = raw
        entry = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "method": self.command,
            "path": self.path,
            "body": body,
        }
        with open(self.log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok": true}')

    do_POST = _record
    do_PUT = _record
    do_GET = _record

    def log_message(self, fmt, *args):  # quiet: the JSONL file IS the log
        pass


def main():
    port, log_path = int(sys.argv[1]), sys.argv[2]
    Handler.log_path = log_path
    open(log_path, "a").close()  # exists even if nothing ever arrives
    HTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
