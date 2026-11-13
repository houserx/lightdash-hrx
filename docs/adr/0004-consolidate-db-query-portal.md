---
status: accepted
---

# db-query-portal is consolidated into Lightdash as part of this project

db-query-portal is the audited SQL portal support staff use to query the production platform database. It is folded into this project now, not after Cutover, so HouseRx ends up with one audited place to query production data instead of two. The platform database becomes a source in the Federation Engine, and Investigate becomes where support staff run queries. Our MCP server exposes the same audited tools to Claude Code and to Lightdash agents. The portal's UI is retired. Write mode comes over as well. Greg Murphy and Daniel Ladd, the portal's maintainers, review the design.

## Consequences

- The portal's HITRUST controls apply to every Audited Query, whichever way it arrives (Investigate, an agent, or MCP). An Audited Query is any query against the platform database or Restricted Telemetry. The controls are:
  - a required description;
  - an optional Linear ticket, validated against Linear;
  - a tamper-evident, write-once audit record.

  Ordinary dashboards and metrics are not audited per query.
- The portal's Auth0 roles (read, write, explain) become Okta-backed Lightdash groups and user attributes. These feed the signed identity block (ADR 0002). All support staff have Okta accounts.
- Lightdash and the engine stop being strictly read-only. Write Mode against the production platform database is a deliberate exception. It keeps the portal's defences:
  - a separate elevated database role;
  - a confirmation on each request;
  - single-statement DML only, with DDL always blocked;
  - Preview, a dry run that always rolls back.
- The portal's Assertions are scheduled count-threshold checks on the platform database. They become Alert Rules (ADR 0001).
- The engine never plans Write Mode statements through DataFusion. Instead it:
  - checks the statement with the portal's guard, ported into the engine as the authoritative check;
  - requires a `write` claim in the signed identity block plus a one-time confirmation token for that request;
  - then passes the statement verbatim to the Platform Database over a separate elevated pool. Preview takes the same path inside a transaction that always rolls back.

  DML planning in DataFusion was rejected because its UPDATE/DELETE support is thin.
- Write Mode and Preview get their own route, from new Lightdash code to a write endpoint on the engine. The request carries the statement, the confirmation token and the signed identity, and bypasses the async query path. That path is unsafe for writes:
  - the SQL Runner strips comments and appends `LIMIT`;
  - it runs a separate column-discovery query first, so a write would execute twice;
  - its results cache is keyed on the SQL text;
  - it has no way to carry a per-click confirmation token.
- Reading the Platform Database requires a `platform_read` claim, mapped from the portal's read role. The engine enforces it in the same way it enforces Restricted Telemetry. Write Mode keeps its separate `write` claim.
- Queries no person runs, such as Alert Rule evaluation and scheduled deliveries, run under a named system identity and are audited under it. For these, the Audited Query description is set once on the Alert Rule or Tile, required at save time, instead of once per query. Ad-hoc queries from Investigate and MCP still need a description each time.
- AI (Lightdash agents, our MCP server, Claude Code) may run a Preview but never commit. Every commit needs a human's confirmation in Investigate.
- Audit records stay in the portal's existing store: DynamoDB plus S3 Object Lock, with the HMAC cross-check. The engine writes them, because every path passes through it. This keeps the controls documented in the portal's `SECURITY.md` valid rather than having to re-prove them.
- The portal's other features move over:
  - saved scripts become shared saved SQL in the Operations Project;
  - execution history becomes an audit browser over that store;
  - the explain-only role becomes a scope;
  - the data assistant, its memory and the plan advisor become tools on our MCP server.
- Retiring the portal is its own milestone, gated on feature parity and sign-off from Greg and Dan. It does not block Grafana's Cutover (ADR 0003).
