# Actions disabled — 2026-08-04, until further notice

`ci`, `live-loop` and `wiki` are `disabled_manually` at the repo level (not in these
files, so `git log` will not show it). Reason: `ci` alone burned ~8,200 billable
minutes/month — 42% of the whole factory-level org — because it fans out to ~10
sub-minute jobs per run and GitHub rounds **every job** up to a full minute.

Restore:

```bash
for w in ci live-loop wiki; do gh workflow enable "$w" --repo factory-level/harness-hg; done
```
