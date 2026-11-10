# Observability

HouseRx's extension of Lightdash to replace Grafana: live dashboards, ad-hoc querying, alerting, and traces over operational telemetry, alongside the business data Lightdash already serves. Where a term below collides with an existing Lightdash term, the Lightdash meaning wins and the observability concept gets a different name.

## Language

### Sources and data

**Telemetry Source**:
A live operational backend queried in its own language at request time, such as Prometheus, Loki, CloudWatch, or Tempo.
_Avoid_: Datasource, warehouse, connection, source (on its own)

**Signal**:
One of the three kinds of telemetry: metrics, logs, or traces.
_Avoid_: Data type, telemetry type

**Time series**:
A sequence of timestamped values identified by a set of labels, as returned by a metrics query against a Telemetry Source.
_Avoid_: Metric (reserved for Lightdash's semantic-layer metric), series (on its own)

**Federation Engine**:
The single service that queries every Telemetry Source, and BigQuery, on Lightdash's behalf and lets their results be combined.
_Avoid_: Proxy, gateway, query service

**Operations Project**:
The Lightdash project whose warehouse is the Federation Engine, holding telemetry models, dashboards, Alert Rules, and shared saved SQL for the Platform Database.
_Avoid_: Observability project, telemetry project

**Ops Mart**:
An aggregated, PHI-free warehouse table curated for use alongside telemetry. The only BigQuery data the Federation Engine may read.
_Avoid_: Business data (on its own), warehouse table

**Restricted Telemetry**:
Telemetry known to carry PHI, readable only by holders of a separate grant beyond Operations Project membership.
_Avoid_: Sensitive logs, PHI logs, private source

**Platform Database**:
HouseRx's production application Postgres, reachable through the Federation Engine for Audited Queries and Write Mode.
_Avoid_: Prod DB, target DB, platform-rds

### Audited access

**Audited Query**:
A query against the Platform Database or Restricted Telemetry that requires a description, may cite a Linear ticket, and leaves a tamper-evident audit record.
_Avoid_: Logged query, tracked query, execution

**Write Mode**:
The elevated, per-request-confirmed ability to run single-statement data changes against the Platform Database.
_Avoid_: Elevated mode, DML mode, write access

**Preview**:
A Write Mode run that executes inside a transaction which always rolls back, showing the effect without keeping it.
_Avoid_: Dry run, test run

### Using telemetry

**Investigate**:
The ad-hoc workspace for live querying of Telemetry Sources and the Platform Database, outside any saved chart or dashboard.
_Avoid_: Explore (reserved for Lightdash's model explorer), query workspace

**Tile**:
One item on a dashboard, as in Lightdash today, including tiles backed by a Telemetry Source.
_Avoid_: Panel

**Dashboard Time Range**:
The single relative or absolute window a dashboard is viewed over, applied to every Tile that has a time dimension.
_Avoid_: Time picker, date range, date zoom (Lightdash's existing granularity control)

**Managed**:
Said of a dashboard, Alert Rule, Contact Point, or Notification Route whose source of truth is git; read-only in the UI.
_Avoid_: Provisioned, as-code (as an adjective), locked

### Alerting

**Alert Rule**:
A continuously evaluated condition over a query, with state (pending, firing, resolved), that notifies when its state changes.
_Avoid_: Alert (on its own, which in Lightdash means a threshold scheduler on a chart), monitor, assertion (db-query-portal's former name for a scheduled count check)

**Contact Point**:
A named notification destination, such as a Slack channel or the incident.io webhook.
_Avoid_: Receiver, channel, destination

**Notification Route**:
A label-matching rule in the routing tree that sends an Alert Rule's notifications to a Contact Point.
_Avoid_: Notification policy, routing rule

### Migration

**Cutover**:
The single date on which users move from Grafana to Lightdash and Grafana stops being used.
_Avoid_: Migration (for the date itself), go-live, switchover

**Shadow Run**:
The period before Cutover when Alert Rules are evaluated in Lightdash without notifying anyone, so their firings can be compared with Grafana's.
_Avoid_: Dry run, parallel run, canary

### Lightdash terms kept as-is

**Explore**:
Lightdash's compiled dbt model and its query builder. Never the Grafana sense.

**Metric**:
A Lightdash semantic-layer measure defined in dbt. Never a Prometheus time series.

**Alert**:
Lightdash's existing threshold scheduler on a saved chart. Distinct from an Alert Rule.
