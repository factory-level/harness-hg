# Managed application credential generation

This provider owns stable 32-byte credentials in encrypted Pulumi state. Hg team
integration outputs feed the separate application-secret bootstrap channel. It
creates no namespace or workload and can run before bootstrap provisioning.

Configure a mapping of DNS-label output names to base64 or base64url encodings.
Generated resources are protected: changing/removing credentials requires an
explicit rotation/recovery procedure, not routine reconciliation. This provider
does not create application users or API roles. No outputs belong in Git or chat.

The factory-workshops configuration uses the existing managed KMS provider. Hg
runs this integration in its provision phase and captures outputs in memory.
