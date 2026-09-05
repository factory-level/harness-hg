# control-plane/external-secrets/

**Purpose.** Secret transport: values reach workloads and never enter Git.

**Chart / machinery.** installed by the bootstrap Pulumi program (ESO chart pin in versions.json).

**Signals.** the ClusterSecretStore is the root object; agentSecrets ride it. Coverage is inventoried per component in #662.
