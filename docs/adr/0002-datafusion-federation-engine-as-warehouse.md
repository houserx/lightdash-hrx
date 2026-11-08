---
status: accepted
---

# A DataFusion Federation Engine is a Lightdash warehouse type

Telemetry Sources are queried through a separate Rust service built on Apache DataFusion, called the Federation Engine. Lightdash registers it as a dedicated Operations Project's warehouse: Postgres credentials with `flavor: 'federation'`, not a new warehouse type. A new type would force edits under `ee/`, which Q14 forbids, and would touch about 137 type switches (amended 2026-11-08, CONTRACTS §4.1). Each source (Prometheus, Loki, CloudWatch, Tempo) is a table function that takes the source's own query language, e.g. `promql('rate(x[5m])', …)`. The engine also federates BigQuery, so telemetry and business data can be joined in one query. The semantic layer and the AI agents then work over telemetry with no special path.

## Considered Options

- **A new chart source type beside dbt Explore and SQL, not a warehouse.** Rejected. Telemetry would get no semantic layer, no joins with business data, and no AI access.
- **Moving the main business project onto the engine.** Rejected. Every business query would run through a new engine.
- **Embedding DataFusion in the Node process (napi-rs).** Rejected. It puts Rust in the Lightdash build, and the engine can't sit next to the AWS sources.
- **Translating SQL into PromQL.** Rejected as too hard to do well, and slow for rates and histograms. Native query strings inside SQL are passed down to the source whole.

## Consequences

- The engine runs in AWS on the tooling EKS cluster. Lightdash on GKE reaches it over the Palo Alto VPN, so there is one cross-cloud hop instead of one per source.
- Lightdash talks to it over the Postgres wire protocol, using a client that inherits the Postgres client but replaces its catalog queries. The engine therefore has to emulate:
  - the extended protocol and cursors;
  - `SET` statements;
  - `version()`;
  - built-in type OIDs;
  - `information_schema`.

  It does not have to emulate the full `pg_catalog`.
- Time series come back in a fixed long shape: `timestamp`, `value`, `labels` map. Semantic models promote labels to dimensions.
- The Operations Project's semantic layer is native Lightdash YAML in git, so no dbt adapter is needed.
- The engine enforces Restricted Telemetry itself, because SQL can reach any table function.
- A warehouse connection is a single credential, so the engine learns who is asking from a signed identity block. Our client subclass appends it, carrying `user_uuid`, the relevant Lightdash user attributes, and the agent flag. Unsigned tags are ignored. AI agents cannot read Restricted Telemetry.
- BigQuery federation is limited to an allowlisted dataset of aggregated, PHI-free marts curated in dbt. The engine never gets broad read access through its service account, which would bypass the business project's access controls. Its GCP credential comes from workload identity federation trusting the engine's AWS IAM role, so no key is stored in AWS.
- Telemetry queries go through Lightdash's existing async query path. Relative time ranges are resolved to absolute timestamps before the cache key is computed, so results never go stale. The v1 latency target is ~5 s p95. A fast path that bypasses async/S3 is deferred until latency has been measured, because it would mean patching `AsyncQueryService`, upstream's most-changed file.
- Data Engineering owns and operates the engine. To Lightdash it is a warehouse. Because the engine is on the alerting path, engine failures page Data Engineering's incident.io escalation. This includes the heartbeat and no-data rules from ADR 0001. Infra stays responsible for the VPN tunnel and the Telemetry Sources themselves.
