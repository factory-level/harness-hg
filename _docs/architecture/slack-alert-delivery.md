# Slack alert delivery

The event router and CLI post logical alerts through Slack `chat.postMessage`. Success requires
HTTP success, `ok: true`, and a nonempty message timestamp. Rate limits, missing credentials,
rejected credentials, inaccessible channels, provider failures and network failures are separate
receipt outcomes. Token values never enter receipts. Local fake-provider tests cover acceptance,
HTTP-200 API failures, mention escaping and missing credentials.

Grafana chart contact points use generic JSON webhooks. Nonempty `discordUrl` fails rendering;
Discord connection declarations fail loading and compilation. The router has no Discord inbound
route or outbound adapter. Generic webhooks receive the logical JSON message without provider
specific embeds or query parameters. Slack registrations are tagged with their provider, so an
old lifecycle registration cannot redirect Slack delivery accidentally.

Frozen versioned schemas retain historical provider enum values. Current loaders impose the
supported-provider constraint after schema validation. No schema directory was rewritten.

Router signing-secret keys follow each deployed runtime namespace, including `ag-eve-` for Eve.
The bounded retry and dead-letter policy is unchanged. Slack delivery acceptance is not a read
receipt and the CLI test message remains in the selected channel.
