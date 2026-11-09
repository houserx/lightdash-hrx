# ENG-1799 progress notes

The build lines ran in parallel, each with its own progress notes. They are kept per line:
`PROGRESS-engine.md`, `PROGRESS-mcp.md`, `PROGRESS-ldq.md`, `PROGRESS-viz.md`, `PROGRESS-alerting.md`.
Each one has a "Contract assumptions" section that the integration line reconciles.

## Known overlaps for the integration line (found while merging, 2026-11-09)

- `formatPrometheusDuration` is exported by both `packages/common/src/utils/timeRange.ts` (ldq) and
  `packages/common/src/alerting/durations.ts` (alerting). They differ for durations of a week or more
  (`7d` vs `1w`). The package root re-exports ldq's to resolve the clash.
- Alerting's `alerting/queryParameters.ts` builds the CONTRACTS §2 reserved time parameters (`__interval`,
  `__range`, ...) separately from ldq's `utils/timeRange.ts`. The two should agree on every value the engine sees.
