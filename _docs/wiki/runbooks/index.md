# Runbooks

**What this page tells you:** which procedure you want, and the order they go in.

Every runbook has one outcome, exact steps, and **ends in a proof**: a command whose output
shows the thing works. Google sign-in is the one exception; its check is a person in a
browser, and it says so.

## Standing an environment up, in order

1. [Google Cloud setup](google-cloud.md): state bucket, backup sink, identities
2. [Credentials](credentials.md): what you must hold, and when
3. [Install a destination server](install.md): bare host to running environment
4. [Cloudflare Tunnel setup](cloudflare-tunnel.md): reachability
5. [Google sign-in at the edge](google-sso.md): who may reach it
6. [Alert destinations](alert-destinations.md): where alarms go

Steps 1 to 3 are required. Steps 4 to 6 are required before anyone else uses the
environment. A tunnel with no access policy is a public URL.

## Connecting agents to people

| Runbook | For |
|---|---|
| [Slack apps](slack-apps.md) | an agent's Slack presence: app, credentials, channel, events |

## Operating it

| Runbook | For |
|---|---|
| [Recovery](recovery.md) | rebuilding an environment on a clean server from a backup |
| [The destructive test](destructive-test.md) | proving recovery works by destroying something |
| [Workspace bindings](workspace-bindings.md) | attaching, migrating and rotating repository mounts |

## Two rules

**Credentials come first.** Secrets are never in a backup. Place them before the thing that
needs them.

**A proof that could not run is not a pass.** It reads `unknown`. The exit code counts only
failures, so read the finding list.

If a cycle needed a step not written here, the runbook is wrong. Fix it, then run it again.
