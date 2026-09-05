# Security

## Reporting a vulnerability

Do not open a public issue. Use GitHub's private reporting:
**https://github.com/factory-level/harness-hg/security/advisories/new**

Include what you found, how to reproduce it, and what you think the impact is. You will get
an acknowledgement within seven days and a fix or a plan within thirty.

## What is in scope

- The `hg` CLI, the emitter, the charts, the Pulumi bootstrap and the Nexus UI in this
  repository.
- The destination-repository scaffold under `infra/gitops-template/`.

Out of scope: the harnesses themselves (Eve is upstream software), Argo CD, Helm, the External
Secrets Operator, and any environment you run. Report those to their own projects.

## What the platform guarantees

The [Security](https://factory-level.github.io/harness-hg/docs/platform/security/) page lists
the properties you can rely on and the ones you cannot. Read it before you report something
the page already says is not provided.
