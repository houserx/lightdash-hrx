---
status: accepted
---

# Alert Rules are evaluated in Lightdash

HouseRx's ~82 Grafana alert rules span Prometheus, CloudWatch, Loki and Postgres. They route through one notification tree to Slack and incident.io. We evaluate Alert Rules inside Lightdash, through the same Federation Engine that serves dashboards. We don't push them down to each source's own tooling. This keeps one permission model and one routing tree. It also gives the AI agents a single place to read alert state from. Lightdash's existing scheduler "Alerts" are not extended, because they run at most hourly, read only the first row, and keep no state.

## Considered Options

- **Each source's own tooling:** Prometheus/Loki rulers plus Alertmanager, and CloudWatch Alarms. Rejected. Alertmanager isn't deployed today and the Loki ruler is off, so this means building from scratch. It also splits routing three ways and leaves the Postgres rules with no home.
- **Mixed:** Prometheus rules go to the ruler and the rest to Lightdash. Rejected because it keeps two routing trees.

## Consequences

- Lightdash becomes paging infrastructure, and it runs in GCP while every Telemetry Source is in AWS. So the design adds:
  - a second VPN tunnel (the GCP↔AWS Palo Alto link has only one tunnel today);
  - a paging rule that fires when a source is unreachable or returns no data;
  - an external heartbeat to incident.io, so that the evaluator going silent itself pages.
- The six CloudWatch alarms and the synthetic canaries that live outside Grafana today stay. They are a backstop that doesn't depend on Lightdash.
