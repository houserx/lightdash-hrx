---
status: accepted
---

# Grafana is retired in a single Cutover, after a Shadow Run

Users move from Grafana to Lightdash on one date. We don't migrate folder by folder. Before that date, every Alert Rule runs in a Shadow Run: it is evaluated in Lightdash without notifying anyone, and its firings are compared against Grafana's. The Shadow Run is the only evidence before Cutover that paging still works. For the same reason, Grafana is scaled to zero with its Terraform intact for 30 days after Cutover, not destroyed.

## Consequences

- Cutover is blocked only by what Grafana does today:
  - Every dashboard and alert rule is migrated and verified, including the ones that exist only in Grafana's UI. A read-only inventory taken from the Grafana API finds those.
  - Logs, CloudWatch, Prometheus and Loki all work.
  - The GitHub and Sentry data reaches BigQuery, because dashboards depend on it today.
  - The branch-deploy links that `houserx/platform` posts point at Lightdash.
- Traces (Tempo, the trace waterfall Tile, links to traces) land after Cutover. So does anything else Grafana doesn't do today. A big-bang that waits on capabilities Grafana doesn't have would slip.
- Known routing bugs are fixed during migration rather than reproduced:
  - `team=Support` and pg_cron's unlabelled `team=engineering` currently fall through to #infra-alerts.
  - `slack-sec` currently receives nothing.

  The Shadow Run therefore compares against a written list of expected routing differences, not against exact parity.
