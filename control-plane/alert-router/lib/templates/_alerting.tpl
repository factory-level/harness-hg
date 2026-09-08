{{- /*
Shared Grafana alert-delivery templates (#619).

charts/monitoring and charts/fleet-dashboard both provision Grafana alerting
through a ConfigMap labelled `grafana_alert: "1"`, and both carried their own
copy of the contact-point block, the per-rule notification_settings, and the
receivers guard. They are the same machinery; only the uid scheme, the contact
point name and the rules themselves legitimately differ.

Every define here takes an explicit dict rather than reading `.Values`, because
the two consumers' value trees are NOT the same shape - fleet-dashboard has an
`alert.enabled` master switch and a budget map, monitoring has four rule
subtrees and an `alertmanager` block. Passing what is needed keeps this chart
from knowing either.
*/ -}}

{{- /*
hermes-alerting.contactPoints - the whole `contactPoints:` block.

  uidPrefix   string  receiver uids are "<prefix>-wh". MUST be
                      stable per consumer: Grafana treats a changed uid as
                      delete+create, which resets alert state and silences.
  name        string  the contact point name every rule routes to.
  webhookUrl  string  generic JSON webhook, or "".
  discordUrl  obsolete input, rejected when non-empty.

At least one URL must be non-empty - enforce that with receiversGuard BEFORE
rendering, or you get a contact point with an empty receivers list, which
Grafana accepts and then silently drops every notification into.
*/ -}}
{{- define "hermes-alerting.contactPoints" -}}
{{- if .discordUrl }}{{ fail "Discord is roadmap-only; configure alert.webhookUrl for the Slack event router" }}{{ end -}}
deleteContactPoints:
  - orgId: 1
    uid: {{ printf "%s-dc" .uidPrefix | quote }}
contactPoints:
  - orgId: 1
    name: {{ .name | quote }}
    receivers:
      {{- with .webhookUrl }}
      - uid: {{ printf "%s-wh" $.uidPrefix | quote }}
        type: webhook
        settings:
          url: {{ . | quote }}
          httpMethod: POST
      {{- end }}
{{- end -}}

{{- /*
hermes-alerting.notificationSettings - the per-rule routing block.

  receiver  string  the contact point name.

Routing per rule rather than through Grafana's notification policy tree is
deliberate: the tree is a single global object, so two profiles editing it
would fight. A rule that carries its own receiver cannot.

The two intervals are not defaults and should not be "tidied" back to them:

  group_wait: 10s     Grafana's default is 30s, which swallowed short-lived
                      firings ENTIRELY - fired and resolved inside the wait
                      meant nothing was ever delivered.
  group_interval: 1m  Grafana's default is 5m, which delayed a NEW firing
                      that followed a recent resolve in the same group by up
                      to five minutes.
*/ -}}
{{- define "hermes-alerting.notificationSettings" -}}
notification_settings:
  receiver: {{ .receiver | quote }}
  # Send the first firing notification quickly: the default
  # 30s group_wait swallowed short-lived firings entirely
  # (fired AND resolved inside the wait -> nothing delivered).
  group_wait: 10s
  # And re-notify promptly after a state change: the default
  # 5m group_interval delays a NEW firing that follows a
  # recent resolve in the same group by up to 5 minutes.
  group_interval: 1m
{{- end -}}

{{- /*
hermes-alerting.receiversGuard - fail the render when rules would exist with
nowhere to send them.

  chart       string  the chart name, for the message.
  render      any     truthy when any rule would render. Pass the SAME
                      predicate the alerts gate uses - if the two disagree,
                      rules render past a guard that thinks they did not,
                      which is exactly how #617 happened.
  webhookUrl  string
  discordUrl  string
  remedy      string  a consumer-specific "here is how to set it" sentence.

An alert with no receiver is a silent no-op, and silent is worse than loud.
*/ -}}
{{- define "hermes-alerting.receiversGuard" -}}
{{- if .discordUrl }}{{ fail "Discord is roadmap-only; configure alert.webhookUrl for the Slack event router" }}{{ end -}}
{{- if .render -}}
{{- if not .webhookUrl -}}
{{- fail (printf "%s: alert rules are enabled but alert.webhookUrl is not set - %s, or disable the rules" .chart .remedy) -}}
{{- end -}}
{{- end -}}
{{- end -}}
