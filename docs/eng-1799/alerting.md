# Alerting in Lightdash (ENG-1799)

Lightdash evaluates HouseRx's Alert Rules itself, through the Federation
Engine, and sends their notifications to Slack, incident.io and email. This
replaces Grafana alerting (ADR 0001). Grafana is retired in one Cutover, after
a Shadow Run (ADR 0003).

This page uses the glossary in `CONTEXT.md`. An **Alert Rule** is not a
Lightdash **Alert** (the existing threshold scheduler on a saved chart). A
**Contact Point** is not a "receiver", and a **Notification Route** is not a
"notification policy".

Worked examples, including today's six Grafana Contact Points and the
notification tree, are in [`alerting-examples/`](alerting-examples/README.md).

## Model

Everything belongs to one Lightdash project, normally the Federation project
(the project whose warehouse credentials have `flavor: 'federation'`). The API
lives under `/api/v2/projects/{projectUuid}/alerting`, and the UI is at
`/projects/{projectUuid}/alerting/rules`, `.../contact-points` and
`.../notification-routes`.

### Alert Rule

An Alert Rule is a SQL query plus a condition, evaluated on a schedule. Each
series the query returns has its own state.

| Field                   | Default  | Meaning                                                                                                                                     |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`, `description`   | required | The description must not be blank. It is the `audit.description` of every query the rule runs.                                              |
| `labels`, `annotations` | `{}`     | Labels are used for routing and grouping. Annotations are free text sent with the notification.                                             |
| `query`                 | required | SQL against the project's warehouse. `${ld.parameters.__from}`, `__to`, `__interval` and `__range` are replaced with the evaluation window. |
| `valueColumn`           | `value`  | The numeric column that the condition is checked against. All other columns except the timestamp are series labels.                         |
| `reducer`               | `last`   | How a series' values become one number.                                                                                                     |
| `condition`             | required | A threshold `{operator, threshold}`, or `{within_range \| outside_range, min, max}`.                                                        |
| `for`                   | `0s`     | How long the condition must hold before a series goes from `pending` to `firing`.                                                           |
| `keepFiringFor`         | `0s`     | How long a series stays `firing` after the condition last held.                                                                             |
| `interval`              | `1m`     | How often the rule is evaluated. The minimum is `30s`.                                                                                      |
| `timeRange`             | `10m`    | The query window that ends at the evaluation time.                                                                                          |
| `noDataState`           | `nodata` | What happens when the query returns no rows: `nodata`, `normal`, `alerting` or `keep_last`.                                                 |
| `errorState`            | `error`  | What happens when the query fails: `error`, `alerting` or `keep_last`.                                                                      |
| `paused`                | `false`  | A paused rule isn't evaluated, and its series keep their state.                                                                             |
| `shadow`                | `false`  | A shadow rule is evaluated and routed but sends nothing (see [Shadow Run](#shadow-run)).                                                    |

Write the reserved parameters bare, as in Investigate and the SQL Runner: `promql('up', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval})`. They are replaced with quoted SQL string literals exactly as Lightdash replaces them, so SQL saved from Investigate works as an Alert Rule query unchanged. Older queries that already put a reference in single quotes still work: the reference and its quotes become the same single literal.

Durations are Prometheus duration strings (`30s`, `5m`, `1h`, `1d`). Rules can
be put in a folder (a space of the project). Every change to a rule's definition
creates a new version of the rule.

**Series states.** Each series is `normal`, `pending`, `firing`, `resolved`,
`nodata` or `error`. With `for`, a series is `pending` from the first
evaluation where the condition holds, and `firing` once it has held for `for`.
With `keepFiringFor`, a `firing` series stays firing until `keepFiringFor` has
passed since the condition last held. It is then `resolved`, and `normal` on
the next evaluation. A series' labels are its query labels plus the rule's
labels (the rule wins on a clash), plus `alertname` set to the rule's name.

**No data and errors.** With `noDataState: nodata`, an empty result resolves
the existing series and adds a `DatasourceNoData` series in state `nodata`.
With `errorState: error`, a failed query does the same with a
`DatasourceError` series whose `error` annotation holds the message. Both are
notified like firing alerts. With `alerting`, the synthetic series goes
through `for` and fires instead. With `keep_last`, nothing changes. When data
comes back, the synthetic series resolves.

**State history.** Every state change is recorded, together with skipped
evaluations (`evaluation_skipped`, for example when the previous evaluation
of the rule is still running).

### Contact Point

A Contact Point is a named destination, identified by its `slug`. It has one
or more integrations: `slack_webhook`, `slack_app`, `incident_io` (an
Alertmanager v4 webhook payload), `email` or `webhook`. An integration with
`disableResolveMessage: true` gets firing notifications only.

Secrets are never stored or written inline. A secret field (the Slack webhook
`url`, the incident.io `token`, a webhook `authorization`) is a reference,
`{secretRef: <name>}`. The server reads the value from the environment
variable `ALERTING_SECRET_<NAME>`: non-alphanumerics become `_` and the name
is upper-cased, so `incident-io-alert-source-token` is read from
`ALERTING_SECRET_INCIDENT_IO_ALERT_SOURCE_TOKEN`.

"Send test notification" in the UI (`POST .../contact-points/{uuid}/test`)
sends one test message. A failed send with a 5xx or a network error is retried
with backoff. A 4xx is not retried. Every send is in the notification log.

### Notification Route

The Notification Routes are one tree per project. The root is the default
route. It must name a `contactPoint`, and it has no matchers. Each child route
has `matchers` (`label`, `operator` = `=`, `!=`, `=~` or `!~`, `value`), and
may set `contactPoint`, `groupBy`, `groupWait`, `groupInterval`,
`repeatInterval`, `continue` and child `routes`. See
[Routing semantics](#routing-semantics).

### Managed

A rule, Contact Point or route tree that was uploaded as code is **Managed**:
git is its source of truth. The UI shows "Managed in git" and is read-only.
The API refuses edits and deletes with 403, even for admins. Only another
upload changes it.

Alerting code is YAML with `version: 1` and a `type` of `alert_rule`,
`contact_point` or `notification_routes`. The CLI uses this layout:

```
alert-rules/<slug>.yml
contact-points/<slug>.yml
notification-routes/notification-routes.yml
```

- `lightdash download --alerting-only [--path dir]` writes every Alert Rule,
  Contact Point and the route tree as these files.
- `lightdash upload --alerting-only [--path dir]` validates every file
  locally first, and refuses an inlined secret, naming the file. It then
  uploads everything in one request: Contact Points, then the tree, then
  Alert Rules. The server applies the upload in one transaction, so a failure
  changes nothing. Documents are upserted by `slug`. A rule gets a new version
  only when its definition changes. Resources left out of an upload are not
  deleted.

### Permissions

| Role             | Can                                                                         |
| ---------------- | --------------------------------------------------------------------------- |
| viewer           | view rules, Contact Points, routes, state, history and the notification log |
| editor           | also create, edit and delete Alert Rules                                    |
| developer, admin | also manage Contact Points and the Notification Routes                      |

### Evaluation and the system identity

The scheduler worker runs an alerting tick every 15 seconds. Each tick queues
the rules that are due (one job per rule and interval slot), sends the
notifications that are due and calls the heartbeat URL
(`ALERTING_HEARTBEAT_URL`, method `ALERTING_HEARTBEAT_METHOD`, POST by
default). The heartbeat goes to incident.io, so a silent evaluator pages
someone. Only one worker evaluates a given rule and slot.

The evaluator queries the warehouse as the system identity
`system:alert-evaluator` (`sub = "system:alert-evaluator"`, `sys = true`,
`agent = false`). Its audit `source` is `alert_rule`, and its
`audit.description` is the rule's description. The system identity needs the
same `attrs` as a person would need for what its rules read, for example
`platform_read` for a `platform_query` rule.

**Health endpoint.** `GET /api/v1/alerting/health` needs no session, so
uptime checks can call it. It always answers HTTP 200 with
`{status: "ok", results: {status, lastCycleAt, lagSeconds}}`:

| `results.status` | Meaning                                                             |
| ---------------- | ------------------------------------------------------------------- |
| `ok`             | The last tick finished at most 60 seconds ago.                      |
| `stale`          | No tick has finished in more than 60 seconds.                       |
| `never_run`      | No tick has ever finished. `lastCycleAt` and `lagSeconds` are null. |

Agents read alert state from `GET .../alerting/state` (the firing and pending
series) and `GET .../alerting/history?rule=&since=`.

## Routing semantics

Routing follows Grafana and Alertmanager. For each series, `routeAlert(tree,
labels)` in `@lightdash/common` does this:

1. The root always matches. Its matchers, if any, are ignored.
2. Child routes are tried in order. A route matches when all of its matchers
   hold. An empty `matchers` list matches everything. A missing label counts
   as `''`. Regex matchers (`=~`, `!~`) are anchored: `team =~ front` does not
   match `frontend`.
3. When a route matches, routing goes into its children. If none of its
   children match, the route itself is used.
4. After the first matching sibling, routing stops, unless that route has
   `continue: true`. Then the next siblings are tried too, and one alert can
   go to several Contact Points.
5. When no child matches, the root (default route) is used, so every alert
   goes somewhere.

A child route inherits `contactPoint`, `groupBy`, `groupWait`,
`groupInterval` and `repeatInterval` from its parent when it doesn't set
them. The root's defaults are `groupBy: []`, `groupWait: 30s`,
`groupInterval: 5m` and `repeatInterval: 4h`.

**Grouping and timers.** Alerts on the same route with the same values of the
`groupBy` labels form one group, and a group is sent as one notification.
`groupBy: ['...']` groups by every label, so each series is its own group.
`groupBy: []` puts everything on the route in one group.

- `groupWait`: how long a new group waits before its first notification, so
  alerts that fire together go out together.
- `groupInterval`: how long after a group's last send a change to the group
  (a new or resolved alert) goes out.
- `repeatInterval`: how long after its last send an unchanged, still-firing
  group is sent again.

When an alert resolves, the groups that sent it as firing send it once as
resolved (unless the integration has `disableResolveMessage`).

## Shadow Run

The Shadow Run is the period before Cutover when every Alert Rule runs in
Lightdash with `shadow: true`. Shadow rules are evaluated, routed, grouped and
timed exactly like real ones, but nothing is sent. Each notification that
would have gone out is written to the notification log with status `shadow`
and its payload. Shadow alerts never share a group with real ones.

To run one:

1. Create the secrets (`ALERTING_SECRET_*`) for the Contact Points. Then
   upload the Contact Points, the route tree and the rules with
   `shadow: true`:

   ```sh
   lightdash upload --alerting-only --project <project uuid> --path <dir>
   ```

   `docs/eng-1799/alerting-examples` is a starting point.

2. Check that `GET /api/v1/alerting/health` reports `ok`, and that the
   rules page shows states.
3. Let both systems run. Save Grafana's alert state history for the same
   period as JSON (`GET /api/v1/rules/history` in Grafana). It is a data frame
   with the fields `time` and `line`, where `line` holds `ruleTitle`,
   `current` and `labels`.
4. Write down the expected differences. Known routing bugs are fixed during
   the migration, not reproduced (ADR 0003), so the comparison is not exact
   parity. The file is a YAML list:

   ```yaml
   - ruleName: Security group changed
     kind: missing_in_lightdash # or extra_in_lightdash
     reason: routed to slack-sec now; Grafana sent it nowhere
   ```

5. Compare:

   ```sh
   lightdash alerting shadow-report --project <project uuid> \
     --since 2026-11-01T00:00:00Z \
     --grafana-history grafana-history.json \
     --expected-differences expected.yml \
     [--json] [--fail-on-unexpected]
   ```

   This posts to `POST .../alerting/shadow-report`. Each Grafana `Alerting`
   firing is matched with the same rule's shadow firing within 5 minutes. The
   report lists the matches, `missing_in_lightdash` (Grafana fired, Lightdash
   didn't) and `extra_in_lightdash` (Lightdash fired, Grafana didn't). Each
   difference is marked expected (with its reason) or unexpected, and
   `unexpectedCount` counts the unexpected ones. With `--fail-on-unexpected`
   the command exits 1 when there are any.

6. Fix the rules, routes or the expected list, upload again, and repeat until
   `unexpectedCount` is 0.

The Shadow Run is the only evidence before Cutover that paging still works.

## Cutover

Cutover is the single date when users move from Grafana to Lightdash and
Grafana stops being used. It is not done folder by folder. This program
doesn't carry it out; this section describes what the people doing it need.

It can happen when:

- every dashboard and alert rule is migrated and verified, including the ones
  that exist only in Grafana's UI;
- logs, CloudWatch, Prometheus and Loki all work through the Federation
  Engine;
- the GitHub and Sentry data reaches BigQuery;
- the branch-deploy links that `houserx/platform` posts point at Lightdash;
- the last `lightdash alerting shadow-report` has `unexpectedCount` 0.

On the day:

1. Turn off `shadow` on every rule in git (`shadow: false`, or remove the
   field), and upload with `lightdash upload --alerting-only`. From then on,
   notifications go out for real. A shadow alert that is already firing moves
   to a real group and is sent when that group is due (after `groupWait` for
   a new group, or `groupInterval` after the group's last send).
2. Check `GET /api/v1/alerting/health` (`ok`) and the incident.io heartbeat,
   and watch the notification log for `sent` entries.
3. Turn off Grafana's notifications so nobody gets paged twice.
4. Scale Grafana to zero, keeping its Terraform, for 30 days. It is not
   destroyed, so it can come back if something was missed.

The six CloudWatch alarms and the synthetic checks that live outside Grafana
stay as a backstop that doesn't depend on Lightdash. Traces, and anything
else Grafana doesn't do today, come after Cutover.
