# CI/CD Grafana Dashboards

This directory contains Grafana dashboard JSON files for CI/CD monitoring and observability.

## Dashboards

### branch-deployments-kpis.json
**Branch Deployment Metrics Dashboard**

Tracks key performance indicators for branch deployment process:
- **Successful/Failed Deployments per Hour** - Hourly deployment trends
- **Component Breakdown** - Client, server, and database deployment success/failure rates
- **Success Rate (24h)** - Overall deployment health percentage with color thresholds
- **Deployments by Environment** - Distribution across staging
- **Total Deployments** - Running counts by component

**Data Source:** CloudWatch Staging (`BranchDeployments` namespace)

**Metrics Published From:**
- `platform/.github/workflows/test.branch-deploy.yml`
- `platform/.github/actions/publish-branch-deploy-metrics/`

**Related Infrastructure:**
- CloudWatch metrics: `ComponentDeployment` with dimensions: `Environment`, `StepName`, `Status`
- Grafana datasource: `cloudwatch-staging` (configured in `grafana_data_sources.tf`)

### pr-metrics-platform.json / pr-metrics-micro-services.json
**PR Metrics Dashboards**

One dashboard per repo (not a shared dashboard with per-repo rows) — everything about
that repo's PR health and velocity in one place, complementary to
`cicd-houserx-github-summary.json`, not a replacement:
- **Open / Draft PRs** - current counts
- **Stale / Critical Stale PRs** - open, non-draft PRs with no activity for 3+ / 4+ days
  (thresholds match the ones already used on `cicd-houserx-github-summary.json`'s PR-age panels)
- **Currently Failing PRs / Failure Rate** - PRs whose latest commit's check rollup is
  `FAILURE`/`ERROR`
- **Avg / P50 / P90 PR Age** - percentile age alongside the average, so a handful of very
  old PRs don't get hidden by the mean
- **Merged (24h) / Avg + Median Time to Merge** - rolling 24h window, recomputed fresh
  each run
- **30-day trend panels** - open/stale counts, failure rate, age distribution, merge
  count, and time-to-merge over time — the thing the live GitHub-datasource dashboard
  can't do: history beyond a live snapshot

**Data Source:** CloudWatch Tooling (`HouseRX/PRMetrics` namespace)

**Metrics Published From:** `pr_metrics_tracker.tf` / `lambda_packages/pr_metrics_tracker/`
(EventBridge-scheduled Lambda, `rate(5 minutes)`, auth via the `autobot` GitHub App)

**Related Infrastructure:**
- CloudWatch metrics: `OpenPullRequests`, `DraftPullRequests`, `StalePullRequests`,
  `CriticalStalePullRequests`, `CurrentlyFailingPullRequests`, `PullRequestFailureRate`,
  `AveragePullRequestAgeSeconds`, `PullRequestAgeP50Seconds`, `PullRequestAgeP90Seconds`,
  `MergedPullRequests`, `AverageTimeToMergeSeconds`, `MedianTimeToMergeSeconds` — all
  dimensioned by `Repository`
- Grafana datasource: `cloudwatch-tooling` (configured in `grafana_data_sources.tf`)
- To onboard another repo: add it to `local.pr_metrics_repos` in `pr_metrics_tracker.tf`
  and add `pr-metrics-<repo>.json` here (copy an existing one, swap the `Repository`
  dimension and `uid`) — no Lambda code changes needed

### cicd-houserx-github-summary.json
**GitHub CI/CD Summary Dashboard**

High-level overview of GitHub Actions workflow execution across the organization.

**Data Source:** GitHub datasource

### cicd-houserx-github-workflows.json
**GitHub Workflows Detail Dashboard**

Detailed view of individual GitHub Actions workflow runs, success rates, and timing.

**Data Source:** GitHub datasource

## Adding New Dashboards

1. Export dashboard JSON from Grafana UI or create new JSON file
2. Place JSON file in this directory
3. Terraform will automatically pick it up via `fileset()` in `grafana_dashboards.tf`
4. Apply terraform: `cd terraform-tooling && terraform apply`

## Dashboard Placement

All dashboards in this directory will be placed in the **CI-CD** folder in Grafana, as configured by:
```hcl
resource "grafana_dashboard" "cicd_dashboard" {
  for_each    = fileset("${path.module}/grafana_config/cicd", "*.json")
  config_json = file("${path.module}/grafana_config/cicd/${each.key}")
  folder      = grafana_folder.this["CI-CD"].id
  overwrite   = true
}
```
