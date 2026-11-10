# Importer fixtures

Inputs for the ENG-1799 importer acceptance tests. Copied on 2026-11-08 by the importers line's init session.

## `grafana_config/` (32 dashboards)

A verbatim copy of `houserx/infra@bf3093da` `terraform-tooling/grafana_config/**/*.json`, with the same folder layout
(the folder decides the Grafana folder, see `terraform/grafana_dashboards.tf`).

Before copying, the files were scanned for secret-shaped values (passwords, tokens, API keys, Slack webhook URLs, long
random strings, private keys) and PHI-shaped values (emails, phone numbers, patient fields, long numeric ids in queries).
Nothing was found that needed replacing: the long strings are metric names, AWS resource names, docs links and query
text. Words like "patient" appear only in queue, endpoint and metric names. AWS account ids appear in CloudWatch log
group ARNs. They are not secrets (one is also in `docs/eng-1799/CONTRACTS.md`), so they were kept.

## `terraform/`

From the same snapshot, `terraform-tooling/`:

| File | How it was copied |
|---|---|
| `grafana_rule_groups_*.tf`, `grafana_lb_rules.tf` | verbatim (the full rule set, about 85 rules once `for_each` and `dynamic` blocks expand) |
| `grafana_notification_policy.tf`, `grafana_folders.tf`, `grafana_dashboards.tf`, `grafana_alert_message_template.tf` | verbatim |
| `grafana_contact_points.tf` | **one value replaced**: the incident.io webhook URL (it embeds the alert source id) is now `https://api.incident.io/v2/alert_events/http/test-alert-source-not-real`. Slack URLs were already references to locals, and the incident.io credentials a reference to Secrets Manager. |
| `grafana_data_sources.tf` | **sanitized**: only `type`, `name` and `uid` of each `grafana_data_source` are kept. URLs, `json_data`, secure data and the `aws_secretsmanager_*` resources (one of which holds GitHub app credentials) were removed. |
| `locals.tf` | **trimmed**: only the locals the rule groups and contact points reference (`region`, `dr_region_*`, `grafana_prometheus_data_sources_env`, `mesh_alert_environments`, the Slack webhook locals, which still read from the Secrets Manager data source, and `grafana_slack_username`). Everything else was removed. |

## `perses/`

Synthetic Perses dashboards written from the published Perses dashboard spec (`kind: Dashboard`, `metadata`, `spec`
with `display`, `duration`, `refreshInterval`, `variables`, `panels` keyed by id, and `Grid` layouts that `$ref` the
panels). Nothing was fetched. `node-overview.yaml` is YAML, `api-latency.json` is JSON.
