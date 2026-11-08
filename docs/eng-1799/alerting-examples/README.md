# Alerting examples: today's Grafana alerting as code

This folder ports HouseRx's Grafana alerting to Lightdash alerting code
(ENG-1799). It uses the layout that `lightdash download --alerting-only`
writes and `lightdash upload --alerting-only` reads:

```
alert-rules/<slug>.yml                       Alert Rules (examples, all in shadow mode)
contact-points/<slug>.yml                    the six Contact Points Grafana has today
notification-routes/notification-routes.yml  the Notification Route tree
```

Every file is a valid document for `validateAlertingAsCode` in
`@lightdash/common`. `packages/common/src/__acceptance__/alerting/docs.accept.ts`
(`alert-grafana-port-examples`) validates the documents and routes sample
label sets through the tree.

## Contact Points

| Slug                 | Integration     | Secret reference                 | Notes                           |
| -------------------- | --------------- | -------------------------------- | ------------------------------- |
| `incident-io`        | `incident_io`   | `incident-io-alert-source-token` | pages on-call                   |
| `slack-infra-alerts` | `slack_webhook` | `slack-infra-alerts-webhook`     | default route, #infra-alerts    |
| `slack-alerts`       | `slack_webhook` | `slack-alerts-webhook`           | #alerts, no resolve messages    |
| `slack-alerts-swat`  | `slack_webhook` | `slack-alerts-swat-webhook`      |                                 |
| `slack-sec`          | `slack_webhook` | `slack-sec-webhook`              | no route sends to it (as today) |
| `test-alerts`        | `slack_webhook` | `test-alerts-webhook`            |                                 |

Secrets are never written inline. Each one is a `{ secretRef: <name> }` that
names a Lightdash secret. Create those secrets before you upload.
`incident-io.yml` has a placeholder alert source id in its URL. Replace it
with the real alert source's URL before you upload. The Slack contact points
render with the ported Grafana templates `slack.title` and `slack.message`.

## Notification Route tree

The tree is Grafana's notification policy as it is today
(infra `grafana_notification_policy.tf`), route for route:

| Matchers                                  | Contact Point        | continue | Timers (inherited unless set) |
| ----------------------------------------- | -------------------- | -------- | ----------------------------- |
| default route                             | `slack-infra-alerts` |          | group by `...`, 5s / 2m / 1h  |
| `team = test`                             | `test-alerts`        | yes      | repeat 1d                     |
| `team = engineering`, `channel = #alerts` | `slack-alerts`       | yes      | group interval 1m, repeat 1m  |
| `team = infra`                            | `incident-io`        | yes      | repeat 1d                     |
| `team = swat`                             | `slack-alerts-swat`  | yes      | repeat 1d                     |
| `system = platform-environment-sweep`     | `slack-infra-alerts` | no       | repeat 1d                     |

Any alert that no child route matches goes to the default route,
`slack-infra-alerts`.

### Known routing bugs not fixed here

ADR 0003 says these bugs get fixed during migration. They are not fixed in
this port, because the spec doesn't say where the alerts should go:

- `team=Support` and pg_cron's unlabelled `team=engineering` still fall
  through to `slack-infra-alerts`.
- `slack-sec` still has no route, so it receives nothing.

When the owners choose destinations, add those routes. Then list the change
as an expected difference for `lightdash alerting shadow-report`.

## Alert Rules

These rules are examples of the port, not the full inventory. Each one sets
labels for one branch of the tree, and each has `shadow: true`. In shadow
mode a rule is evaluated and its would-be notifications are logged, but
nothing is sent.

| Slug                                | Query source     | Labels                                | Routed to            |
| ----------------------------------- | ---------------- | ------------------------------------- | -------------------- |
| `alb-unhealthy-hosts`               | `cloudwatch`     | `team=infra`                          | `incident-io`        |
| `pg-cron-job-failed`                | `platform_query` | `team=engineering`, `channel=#alerts` | `slack-alerts`       |
| `platform-environment-sweep-errors` | `logql_metric`   | `system=platform-environment-sweep`   | `slack-infra-alerts` |
