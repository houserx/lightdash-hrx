#####################################################################
# PA Renewal Health alerts (SWA-1657)
#
# Alerts on the pa_renewal_health_* custom CloudWatch metrics emitted by the
# pa-renewal-health-monitor CronJob (terraform-production/pa_renewal_health_monitor.tf),
# which runs the corrected Check 1/3/4 queries from SWA-1649, plus Check 2 (medication
# evaluation/fallback) stuck/missing-signal/mode_shadow rules added with thresholds agreed
# 2026-10-19/20 (SWA-1657 Check 2 branch) now that enforce mode is live. Check 2's other
# stage counts (dispatched/confirmed/not_confirmed, omitted_failed_sync) remain
# dashboard-only - see check.js's CHECK2_STAGES_SQL comment.
#
# Eight rules, matching SWA-1657's "healthy / no eligible activity / check
# failure-data unavailable" three-state requirement. Declaration order below (dynamic
# block first, then each standalone rule in file order) is Grafana UID identity - see
# the dynamic "rule" block's comment and each standalone rule's comment before adding
# or reordering anything:
#   1. Check 1 failing_count > 0        - a real data problem (failing, not just eligible=0)
#   2. Check 3 failing_count > 0        - same, for Check 3
#   3. Check 4 failing_count > 0        - same, for Check 4
#   4. Job explicitly failed             - the catch-handler's "Check=job" signal (DB
#                                          connect error, query error, etc. after startup)
#   5. Monitor did not run at all        - no_data_state=Alerting on a wide (4h, ~4x the
#                                          hourly cadence) window, for a CronJob that got
#                                          stuck/suspended/image-pull-failed before it could
#                                          emit anything, including the rule-4 failure signal
#   6. Check 2 missing signal >= 15%    - of non-ineligible renewal jobs (24h) with no
#                                          medication_discontinuation_check_mode row,
#                                          minimum 20 jobs in the window (baseline ~4%)
#   7. Check 2 stuck > 0                - dispatched with no outcome after 15m (p99 6s/max
#                                          10s latency and 0 stuck over a 90d check, so any
#                                          hit is real)
#   8. Check 2 mode_shadow > 0          - low-severity: shadow mode is 0 today now that
#                                          enforce is live, so any shadow activity again
#                                          indicates a config regression
#
# NOT alerting on the dashboard's failure-rate % for Checks 1/3/4 - that's a display-only
# derived metric; alerting on the raw failing_count avoids divide-by-zero noise when
# eligible_count=0 and naturally reports "no eligible activity" as simply no alert (failing
# is 0 whenever eligible is 0), matching the three-state distinction without extra logic.
# NOT alerting on Check 2's dispatched/enforce ratio - ~31 enforce jobs over 14 days with no
# dispatched row are expected (ineligible and data_check paths skip dispatch).
#
# severity labels (critical/low) are informational only - grafana_notification_policy.tf
# routes by team/channel alone, nothing reads severity today. Other tooling rule groups
# (envoy, k8s, auth0) use a numeric 1-4 scale with no documented meaning and no consumer
# either; not matched here since there's nothing to verify that mapping against. Add real
# severity-based routing (a mute timing or a second contact point) before relying on this
# label for anything operational.
#
# Routes to #alerts-swat via the "swat" team label (grafana_contact_points.tf /
# grafana_notification_policy.tf) - requires a new Slack incoming webhook URL added to
# the (non-Terraform-managed) grafana_slack_webhooks secret under a "swat_alerts" key
# before this will apply successfully. See that file for details.
#####################################################################

locals {
  pa_renewal_health_alert_rules = [
    {
      key            = "check1_failing"
      name           = "PA Renewal Health - Check 1 Medication Sync Coverage Failing"
      metric_name    = "pa_renewal_health_failing"
      dimensions     = { Check = "check1_medication_sync_coverage" }
      statistic      = "Maximum"
      comparator     = "gt"
      threshold      = 0
      window_seconds = 7200 # 2x the hourly cadence - slack for CronJob start jitter/a slow run, not a real gap
      no_data_state  = "OK" # the separate "Monitor Did Not Run" rule (4h window) already covers true staleness
      for            = "0m" # config state, not an async event - any gap is immediately actionable per Greg's comment
      summary        = "Check 1 (medication-sync coverage): one or more PA-orchestration-active practices with a supported EHR have medication sync disabled. See the PA Renewal Health dashboard (Platform folder) and the CronJob's CloudWatch Logs (pa-renewal-health namespace) for the specific practice ids."
      description    = "Pull the specific practice ids from the CronJob's pod logs (namespace pa-renewal-health, filter on check=check1_medication_sync_coverage and failing_rows) or CloudWatch Logs Insights. Query definition: SWA-1649 (Greg Murphy, 2026-09-24)."
    },
    {
      key            = "check3_failing"
      name           = "PA Renewal Health - Check 3 Submission Attachments Failing"
      metric_name    = "pa_renewal_health_failing"
      dimensions     = { Check = "check3_submission_attachments" }
      statistic      = "Maximum"
      comparator     = "gt"
      threshold      = 0
      window_seconds = 7200
      no_data_state  = "OK"
      for            = "0m" # any gap is immediately actionable per Greg's comment, not a timing artifact
      summary        = "Check 3 (submission attachments): one or more branch-confidence renewal PAs had a document fetched but no real attachment in the last run. See the PA Renewal Health dashboard (Platform folder) and the CronJob's CloudWatch Logs (pa-renewal-health namespace) for the specific PA ids."
      description    = "Pull the specific PA/practice ids from the CronJob's pod logs (namespace pa-renewal-health, filter on check=check3_submission_attachments and failing_rows) or CloudWatch Logs Insights. Query definition: SWA-1649 (Greg Murphy, corrected 2026-09-25)."
    },
    {
      key            = "check4_failing"
      name           = "PA Renewal Health - Check 4 Submission Status Audit Trail Failing"
      metric_name    = "pa_renewal_health_failing"
      dimensions     = { Check = "check4_submission_status_audit_trail" }
      statistic      = "Maximum"
      comparator     = "gt"
      threshold      = 0
      window_seconds = 7200
      no_data_state  = "OK"
      for            = "0m"
      summary        = "Check 4 (submission status/audit trail): one or more branch-confidence renewal PAs that submitted a clinical answer are missing a genuinely automated \"Submitted via: Smart PA\" note in the last run. See the PA Renewal Health dashboard (Platform folder) and the CronJob's CloudWatch Logs (pa-renewal-health namespace) for the specific PA ids."
      description    = "Pull the specific PA/practice ids from the CronJob's pod logs (namespace pa-renewal-health, filter on check=check4_submission_status_audit_trail and failing_rows) or CloudWatch Logs Insights. Query definition: SWA-1649 (Greg Murphy, corrected 2026-09-25), clinical-round filter added in SWA-1931."
    },
    {
      key            = "job_failed"
      name           = "PA Renewal Health - Monitor Job Failed"
      metric_name    = "pa_renewal_health_last_run_success"
      dimensions     = { Check = "job" }
      statistic      = "Maximum"
      comparator     = "lt"
      threshold      = 1
      window_seconds = 3600     # unchanged - job-level signal, not a failing-count rule
      no_data_state  = "NoData" # kept sensitive to its own window; scope was the failing-count rules only
      for            = "0m"
      summary        = "The pa-renewal-health-monitor job reported a failure - either the whole CronJob crashed before any check could run (e.g. a DB connect error), or one or more individual checks threw a query error this cycle. Check the job's pod logs (namespace pa-renewal-health) and Sentry (project platform) for which."
      description    = "Check the pod logs (namespace pa-renewal-health) for which check(s) failed and why, and Sentry (project platform, environment production) for the stack trace. If only one check failed, the others may still have reported fine this cycle - check the dashboard's freshness panel per-check."
    },
  ]
}

resource "grafana_rule_group" "pa_renewal_health" {
  name             = "pa_renewal_health"
  folder_uid       = grafana_folder.this["Platform"].uid
  interval_seconds = 300

  dynamic "rule" {
    # Ordered list, not a map - see platform_rds_health's comment in
    # grafana_rule_groups_rds.tf for why: rule blocks have no state identity, so a
    # map would reorder on any new key and shift every later rule to a new Grafana
    # UID. Appending to THIS list only keeps ITS OWN entries' positions stable -
    # every standalone rule {} block below (declared after this dynamic block
    # expands) shifts too if this list grows. A new rule belongs here only if you
    # want it ordered immediately after job_failed; otherwise add it as its own
    # standalone rule {} block at the very end of this resource (see that section's
    # comment, below).
    for_each = local.pa_renewal_health_alert_rules
    content {
      name      = rule.value.name
      condition = "C"

      data {
        ref_id = "A"
        relative_time_range {
          from = rule.value.window_seconds
          to   = 0
        }
        datasource_uid = grafana_data_source.cloudwatch-production.uid
        model = jsonencode({
          dimensions       = rule.value.dimensions
          matchExact       = true
          metricEditorMode = 0
          metricName       = rule.value.metric_name
          metricQueryType  = 0
          namespace        = "HouseRX/Custom"
          period           = "3600"
          queryMode        = "Metrics"
          refId            = "A"
          region           = local.region
          statistic        = rule.value.statistic
        })
      }
      data {
        ref_id = "B"
        relative_time_range {
          from = 0
          to   = 0
        }
        datasource_uid = "__expr__"
        model = jsonencode({
          datasource = { type = "__expr__", uid = "__expr__" }
          expression = "A"
          reducer    = "last"
          refId      = "B"
          type       = "reduce"
        })
      }
      data {
        ref_id = "C"
        relative_time_range {
          from = 0
          to   = 0
        }
        datasource_uid = "__expr__"
        model = jsonencode({
          conditions = [{
            evaluator = { params = [rule.value.threshold], type = rule.value.comparator }
            operator  = { type = "and" }
            query     = { params = ["C"] }
            reducer   = { params = [], type = "last" }
            type      = "query"
          }]
          datasource = { type = "__expr__", uid = "__expr__" }
          expression = "B"
          refId      = "C"
          type       = "threshold"
        })
      }

      no_data_state  = rule.value.no_data_state
      exec_err_state = "Error"
      for            = rule.value.for
      annotations = {
        summary     = rule.value.summary
        description = rule.value.description
      }
      labels = {
        team        = "swat"
        system      = "platform"
        service     = "pa-renewal-health"
        environment = "prod"
        check       = rule.value.key
        severity    = "critical"
      }
      is_paused = false
    }
  }

  # Rule 4: monitor did not run at all (no CronJob execution emitted anything,
  # including rule 3's explicit failure signal - e.g. CronJob suspended, image pull
  # failure, or OOM before the process could even start). Wide 4h window (~4x the
  # hourly cadence) gives grace for one missed run before this fires; no_data_state
  # = Alerting routes it through the normal notification pipeline instead of just
  # showing a quiet "No Data" badge in the UI, so a silently-stopped monitor is
  # actually actionable, not just visible if someone happens to look.
  rule {
    name      = "PA Renewal Health - Monitor Did Not Run"
    condition = "C"

    data {
      ref_id = "A"
      relative_time_range {
        from = 14400
        to   = 0
      }
      datasource_uid = grafana_data_source.cloudwatch-production.uid
      model = jsonencode({
        # Check 3's last_run_success is the canary for "did the whole CronJob run at
        # all" - works today because check.js runs all four checks sequentially in one
        # process and emits this metric unconditionally as part of that run, so it's
        # present whenever anything ran, regardless of check1/2's own outcome. If check
        # ordering or naming in check.js ever changes, re-verify this is still a valid
        # proxy for "the job ran" rather than switching to the check3-specific signal.
        dimensions       = { Check = "check3_submission_attachments" }
        matchExact       = true
        metricEditorMode = 0
        metricName       = "pa_renewal_health_last_run_success"
        metricQueryType  = 0
        namespace        = "HouseRX/Custom"
        period           = "3600"
        queryMode        = "Metrics"
        refId            = "A"
        region           = local.region
        statistic        = "Maximum"
      })
    }
    data {
      ref_id = "B"
      relative_time_range {
        from = 0
        to   = 0
      }
      datasource_uid = "__expr__"
      model = jsonencode({
        datasource = { type = "__expr__", uid = "__expr__" }
        expression = "A"
        reducer    = "last"
        refId      = "B"
        type       = "reduce"
      })
    }
    data {
      ref_id = "C"
      relative_time_range {
        from = 0
        to   = 0
      }
      datasource_uid = "__expr__"
      model = jsonencode({
        conditions = [{
          # Always false when data exists (Maximum of a 0/1 metric is never < 0) -
          # the real trigger is no_data_state below, not this threshold.
          evaluator = { params = [0], type = "lt" }
          operator  = { type = "and" }
          query     = { params = ["C"] }
          reducer   = { params = [], type = "last" }
          type      = "query"
        }]
        datasource = { type = "__expr__", uid = "__expr__" }
        expression = "B"
        refId      = "C"
        type       = "threshold"
      })
    }

    no_data_state  = "Alerting"
    exec_err_state = "Error"
    for            = "0m"
    annotations = {
      summary     = "The pa-renewal-health-monitor CronJob has not reported in over 4 hours (expected hourly) - it may be suspended, stuck, or failing before it can emit any metric. Check the CronJob status and pod events (namespace pa-renewal-health)."
      description = "Check `kubectl get cronjob -n pa-renewal-health` and pod events for why the job stopped running (suspended, image pull failure, OOM, etc.)."
    }
    labels = {
      team        = "swat"
      system      = "platform"
      service     = "pa-renewal-health"
      environment = "prod"
      check       = "monitor_not_running"
      severity    = "critical"
    }
    is_paused = false
  }

  # Check 2 missing signal: needs a ratio of two independent metrics plus a minimum-sample-size
  # guard, which doesn't fit the single-metric/single-threshold shape the dynamic rule block
  # above uses. A: numerator (missing_signal_count), C: denominator (missing_signal_eligible),
  # both the CHECK2_MISSING_SIGNAL_SQL counts already scoped to the trailing 24h inside the
  # SQL itself, so "last" over a short window just picks up the most recent hourly emission
  # rather than re-aggregating across runs. The firing condition (G/H below) cross-multiplies
  # both checks into one flag rather than using classic_conditions, which only accepts raw
  # datasource queries as inputs - feeding it B/D (reduce/math expression outputs) made the
  # rule fail to evaluate at all.
  rule {
    name      = "PA Renewal Health - Check 2 Missing Signal"
    condition = "H"

    data {
      ref_id = "A"
      relative_time_range {
        from = 7200
        to   = 0
      }
      datasource_uid = grafana_data_source.cloudwatch-production.uid
      model = jsonencode({
        dimensions       = { Check = "check2_medication_evaluation_fallback" }
        matchExact       = true
        metricEditorMode = 0
        metricName       = "pa_renewal_health_check2_missing_signal_count"
        metricQueryType  = 0
        namespace        = "HouseRX/Custom"
        period           = "3600"
        queryMode        = "Metrics"
        refId            = "A"
        region           = local.region
        statistic        = "Maximum"
      })
    }
    data {
      ref_id = "C"
      relative_time_range {
        from = 7200
        to   = 0
      }
      datasource_uid = grafana_data_source.cloudwatch-production.uid
      model = jsonencode({
        dimensions       = { Check = "check2_medication_evaluation_fallback" }
        matchExact       = true
        metricEditorMode = 0
        metricName       = "pa_renewal_health_check2_missing_signal_eligible"
        metricQueryType  = 0
        namespace        = "HouseRX/Custom"
        period           = "3600"
        queryMode        = "Metrics"
        refId            = "C"
        region           = local.region
        statistic        = "Maximum"
      })
    }
    data {
      ref_id = "B"
      relative_time_range {
        from = 0
        to   = 0
      }
      datasource_uid = "__expr__"
      model = jsonencode({
        datasource = { type = "__expr__", uid = "__expr__" }
        expression = "A"
        reducer    = "last"
        refId      = "B"
        type       = "reduce"
      })
    }
    data {
      ref_id = "D"
      relative_time_range {
        from = 0
        to   = 0
      }
      datasource_uid = "__expr__"
      model = jsonencode({
        datasource = { type = "__expr__", uid = "__expr__" }
        expression = "C"
        reducer    = "last"
        refId      = "D"
        type       = "reduce"
      })
    }
    data {
      # Display-only percentage for the annotation template below - not part of the firing
      # condition (see G/H below for why: classic_conditions can't take expression outputs
      # as inputs, only raw datasource queries, so the actual threshold check cross-
      # multiplies instead of dividing).
      ref_id = "E"
      relative_time_range {
        from = 0
        to   = 0
      }
      datasource_uid = "__expr__"
      model = jsonencode({
        datasource = { type = "__expr__", uid = "__expr__" }
        expression = "($B/$D)*100"
        refId      = "E"
        type       = "math"
      })
    }
    data {
      # Both conditions as one cross-multiplied flag (1 when both true, else 0) - avoids
      # dividing by D (which can legitimately be 0 in a quiet window) and avoids
      # classic_conditions, which only accepts raw datasource queries as inputs, not
      # expression outputs like B/D - feeding it reduce/math refIds here previously made
      # the rule fail to evaluate at all.
      ref_id = "G"
      relative_time_range {
        from = 0
        to   = 0
      }
      datasource_uid = "__expr__"
      model = jsonencode({
        datasource = { type = "__expr__", uid = "__expr__" }
        expression = "($B * 100 >= $D * 15) * ($D >= 20)"
        refId      = "G"
        type       = "math"
      })
    }
    data {
      ref_id = "H"
      relative_time_range {
        from = 0
        to   = 0
      }
      datasource_uid = "__expr__"
      model = jsonencode({
        conditions = [{
          evaluator = { params = [0], type = "gt" }
          operator  = { type = "and" }
          query     = { params = ["H"] }
          reducer   = { params = [], type = "last" }
          type      = "query"
        }]
        datasource = { type = "__expr__", uid = "__expr__" }
        expression = "G"
        refId      = "H"
        type       = "threshold"
      })
    }

    no_data_state  = "OK" # "Monitor Did Not Run" already covers true staleness; a quiet 24h window is not itself a failure
    exec_err_state = "Error"
    for            = "0m" # baseline ~4%, so any hit at >=15% with >=20 jobs is a real regression, not noise
    annotations = {
      summary     = "Check 2 (medication evaluation/fallback): {{ $values.E }}% of non-ineligible renewal jobs in the last 24h have no medication_discontinuation_check_mode row (baseline ~4%), across {{ $values.D }} eligible jobs. See the PA Renewal Health dashboard (Platform folder) and the CronJob's CloudWatch Logs (pa-renewal-health namespace) for specifics."
      description = "Query: CHECK2_MISSING_SIGNAL_SQL in check.js - excludes job_ineligible jobs (whole-orchestration ineligibility, unrelated to the discontinuation check). Threshold agreed 2026-10-19/20."
    }
    labels = {
      team        = "swat"
      system      = "platform"
      service     = "pa-renewal-health"
      environment = "prod"
      check       = "check2_missing_signal"
      severity    = "critical"
    }
    is_paused = false
  }

  # check2_stuck and check2_mode_shadow are standalone blocks (not entries in
  # pa_renewal_health_alert_rules above), appended after every other rule in this resource
  # (dynamic-generated and standalone alike) - rule blocks have no state identity, so
  # position is Grafana UID identity here. Adding these as dynamic-list entries would
  # shift every standalone rule below the dynamic block (Monitor Did Not Run, Check 2
  # Missing Signal) by two positions, silently reassigning their Grafana UIDs/alert
  # history to these new rules instead of creating clean new ones.
  rule {
    name      = "PA Renewal Health - Check 2 Medication Discontinuation Check Stuck"
    condition = "C"

    data {
      ref_id = "A"
      relative_time_range {
        from = 7200 # 2x the hourly cadence - slack for CronJob start jitter, not a real gap
        to   = 0
      }
      datasource_uid = grafana_data_source.cloudwatch-production.uid
      model = jsonencode({
        dimensions       = { Check = "check2_medication_evaluation_fallback" }
        matchExact       = true
        metricEditorMode = 0
        metricName       = "pa_renewal_health_check2_stuck"
        metricQueryType  = 0
        namespace        = "HouseRX/Custom"
        period           = "3600"
        queryMode        = "Metrics"
        refId            = "A"
        region           = local.region
        statistic        = "Maximum"
      })
    }
    data {
      ref_id = "B"
      relative_time_range {
        from = 0
        to   = 0
      }
      datasource_uid = "__expr__"
      model = jsonencode({
        datasource = { type = "__expr__", uid = "__expr__" }
        expression = "A"
        reducer    = "last"
        refId      = "B"
        type       = "reduce"
      })
    }
    data {
      ref_id = "C"
      relative_time_range {
        from = 0
        to   = 0
      }
      datasource_uid = "__expr__"
      model = jsonencode({
        conditions = [{
          evaluator = { params = [0], type = "gt" }
          operator  = { type = "and" }
          query     = { params = ["C"] }
          reducer   = { params = [], type = "last" }
          type      = "query"
        }]
        datasource = { type = "__expr__", uid = "__expr__" }
        expression = "B"
        refId      = "C"
        type       = "threshold"
      })
    }

    no_data_state  = "OK" # "Monitor Did Not Run" already covers true staleness
    exec_err_state = "Error"
    for            = "0m" # dispatch->outcome latency is p99 6s/max 10s with 0 stuck over a 90d check - any hit is real
    annotations = {
      summary     = "Check 2 (medication evaluation/fallback): one or more jobs dispatched for AI discontinuation verification in the last 48h have no confirmed/not_confirmed outcome after 15 minutes. See the PA Renewal Health dashboard (Platform folder) and the CronJob's CloudWatch Logs (pa-renewal-health namespace) for the specific job/PA ids."
      description = "Pull the specific job/PA/practice ids from the CronJob's pod logs (namespace pa-renewal-health, filter on check=check2_medication_evaluation_fallback and stuck_rows) or CloudWatch Logs Insights. Query: CHECK2_STUCK_SQL in check.js. Threshold agreed 2026-10-19/20."
    }
    labels = {
      team        = "swat"
      system      = "platform"
      service     = "pa-renewal-health"
      environment = "prod"
      check       = "check2_stuck"
      severity    = "critical"
    }
    is_paused = false
  }

  # Alerts on pa_renewal_health_check2_mode_shadow_recent, NOT the dashboard's
  # pa_renewal_health_check2_mode_shadow - that one comes from CHECK2_STAGES_SQL's 90-day
  # renewal-PA cohort with no cutoff on the mode event's own timestamp, so it would keep
  # counting historical pre-enforce shadow-mode jobs and fire continuously for up to 90 days
  # after a regression is already fixed. _recent is bounded by the mode event's own
  # created_at (CHECK2_MODE_SHADOW_RECENT_SQL in check.js) and needs no renewal-PA join.
  rule {
    name      = "PA Renewal Health - Check 2 Shadow Mode Regression"
    condition = "C"

    data {
      ref_id = "A"
      relative_time_range {
        from = 7200
        to   = 0
      }
      datasource_uid = grafana_data_source.cloudwatch-production.uid
      model = jsonencode({
        dimensions       = { Check = "check2_medication_evaluation_fallback" }
        matchExact       = true
        metricEditorMode = 0
        metricName       = "pa_renewal_health_check2_mode_shadow_recent"
        metricQueryType  = 0
        namespace        = "HouseRX/Custom"
        period           = "3600"
        queryMode        = "Metrics"
        refId            = "A"
        region           = local.region
        statistic        = "Maximum"
      })
    }
    data {
      ref_id = "B"
      relative_time_range {
        from = 0
        to   = 0
      }
      datasource_uid = "__expr__"
      model = jsonencode({
        datasource = { type = "__expr__", uid = "__expr__" }
        expression = "A"
        reducer    = "last"
        refId      = "B"
        type       = "reduce"
      })
    }
    data {
      ref_id = "C"
      relative_time_range {
        from = 0
        to   = 0
      }
      datasource_uid = "__expr__"
      model = jsonencode({
        conditions = [{
          evaluator = { params = [0], type = "gt" }
          operator  = { type = "and" }
          query     = { params = ["C"] }
          reducer   = { params = [], type = "last" }
          type      = "query"
        }]
        datasource = { type = "__expr__", uid = "__expr__" }
        expression = "B"
        refId      = "C"
        type       = "threshold"
      })
    }

    no_data_state  = "OK"
    exec_err_state = "Error"
    for            = "0m"
    annotations = {
      summary     = "Check 2 (medication evaluation/fallback): one or more jobs ran in shadow mode. Enforce mode is live and shadow mode is expected to be 0 today - this usually indicates a feature-flag config regression (medicationDiscontinuationCheckEnforce reverted or unreadable). Low severity: shadow mode is not itself harmful, but signals the enforce rollout didn't hold."
      description = "Check the medicationDiscontinuationCheckEnforce LaunchDarkly flag's current value and recent change history. See pa-orchestration.service.ts's medicationDiscontinuationCheckMode resolution (platform repo) for how shadow vs enforce is decided."
    }
    labels = {
      team        = "swat"
      system      = "platform"
      service     = "pa-renewal-health"
      environment = "prod"
      check       = "check2_mode_shadow"
      severity    = "low"
    }
    is_paused = false
  }
}
