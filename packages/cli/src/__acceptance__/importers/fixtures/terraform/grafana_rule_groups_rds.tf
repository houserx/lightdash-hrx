#####################################################################
# The rule group for  RDS/Database alerts                           #
#####################################################################

# pg_cron rule group - Duration (hard-coded for now) and Failures
variable "pg_cron_duration_threshold" {
  type        = number
  description = "The threshold in milliseconds for pg_cron job duration to trigger an alert."
  default     = 20000
}

resource "grafana_rule_group" "pg_cron_rule_group" {
  name             = "pg_cron"
  folder_uid       = "bednciwfspeyod"
  interval_seconds = 60

  # Ensure pg_cron jobs are running in a reasonable duration
  rule {
    name      = "pg_cron Job Duration"
    condition = "C"

    data {
      ref_id = "A"

      relative_time_range {
        from = 3600
        to   = 0
      }

      datasource_uid = "eel791mz5ayv4f"
      model          = "{\"datasource\":{\"type\":\"grafana-postgresql-datasource\",\"uid\":\"eel791mz5ayv4f\"},\"editorMode\":\"code\",\"format\":\"time_series\",\"intervalMs\":60000,\"maxDataPoints\":43200,\"rawQuery\":true,\"rawSql\":\"SELECT \\n    job.jobname as job_name,\\n    start_time as time,\\n    EXTRACT(EPOCH FROM (end_time - start_time)) * 1000 AS duration_ms\\nFROM \\n    cron.job_run_details\\nINNER JOIN \\n    cron.job ON job.jobid = job_run_details.jobid\\nWHERE $__timeFilter(start_time) \\nORDER BY 2\\nLIMIT 60\",\"refId\":\"A\",\"sql\":{\"columns\":[{\"parameters\":[],\"type\":\"function\"}],\"groupBy\":[{\"property\":{\"type\":\"string\"},\"type\":\"groupBy\"}],\"limit\":50}}"
    }
    data {
      ref_id = "B"

      relative_time_range {
        from = 0
        to   = 0
      }

      datasource_uid = "__expr__"
      model          = "{\"conditions\":[{\"evaluator\":{\"params\":[],\"type\":\"gt\"},\"operator\":{\"type\":\"and\"},\"query\":{\"params\":[\"B\"]},\"reducer\":{\"params\":[],\"type\":\"last\"},\"type\":\"query\"}],\"datasource\":{\"type\":\"__expr__\",\"uid\":\"__expr__\"},\"expression\":\"A\",\"intervalMs\":1000,\"maxDataPoints\":43200,\"reducer\":\"last\",\"refId\":\"B\",\"type\":\"reduce\"}"
    }
    data {
      ref_id = "C"

      relative_time_range {
        from = 0
        to   = 0
      }

      datasource_uid = "__expr__"
      model          = "{\"conditions\":[{\"evaluator\":{\"params\":[${var.pg_cron_duration_threshold}],\"type\":\"gt\"},\"operator\":{\"type\":\"and\"},\"query\":{\"params\":[\"C\"]},\"reducer\":{\"params\":[],\"type\":\"last\"},\"type\":\"query\"}],\"datasource\":{\"type\":\"__expr__\",\"uid\":\"__expr__\"},\"expression\":\"B\",\"intervalMs\":1000,\"maxDataPoints\":43200,\"refId\":\"C\",\"type\":\"threshold\"}"
    }

    no_data_state  = "KeepLast"
    exec_err_state = "Error"
    for            = "1m"
    annotations = {
      __dashboardUid__ = "eekoqbfs0apkwe"
      __panelId__      = "1"
      summary          = "pg_cron job(s)' duration is above the configured threshold (${var.pg_cron_duration_threshold / 1000}s)!"
    }
    labels = {
      app         = "platform"
      environment = "prod"
      team        = "engineering"
    }
    is_paused = false
  }
  rule {
    name      = "pg_cron Job Failures"
    condition = "C"

    data {
      ref_id = "A"

      relative_time_range {
        from = 3600
        to   = 0
      }

      datasource_uid = "eel791mz5ayv4f"
      model          = "{\"datasource\":{\"type\":\"grafana-postgresql-datasource\",\"uid\":\"eel791mz5ayv4f\"},\"editorMode\":\"code\",\"format\":\"time_series\",\"intervalMs\":60000,\"maxDataPoints\":43200,\"rawQuery\":true,\"rawSql\":\"SELECT \\n    job.jobname as job_name,\\n    start_time as time,\\n    COALESCE(\\n        CASE \\n            WHEN status = 'succeeded' THEN 0\\n            WHEN status = 'running' THEN 0\\n            ELSE 1\\n        END, 0\\n    ) AS error\\nFROM \\n    cron.job_run_details\\nLEFT JOIN \\n    cron.job ON job.jobid = job_run_details.jobid\\nWHERE $__timeFilter(start_time) \\nORDER BY 2\\nLIMIT 60\",\"refId\":\"A\",\"sql\":{\"columns\":[{\"parameters\":[],\"type\":\"function\"}],\"groupBy\":[{\"property\":{\"type\":\"string\"},\"type\":\"groupBy\"}],\"limit\":50}}"
    }
    data {
      ref_id = "B"

      relative_time_range {
        from = 0
        to   = 0
      }

      datasource_uid = "__expr__"
      model          = "{\"conditions\":[{\"evaluator\":{\"params\":[],\"type\":\"gt\"},\"operator\":{\"type\":\"and\"},\"query\":{\"params\":[\"B\"]},\"reducer\":{\"params\":[],\"type\":\"last\"},\"type\":\"query\"}],\"datasource\":{\"type\":\"__expr__\",\"uid\":\"__expr__\"},\"expression\":\"A\",\"intervalMs\":1000,\"maxDataPoints\":43200,\"reducer\":\"last\",\"refId\":\"B\",\"settings\":{\"mode\":\"dropNN\"},\"type\":\"reduce\"}"
    }
    data {
      ref_id = "C"

      relative_time_range {
        from = 0
        to   = 0
      }

      datasource_uid = "__expr__"
      model          = "{\"conditions\":[{\"evaluator\":{\"params\":[0],\"type\":\"gt\"},\"operator\":{\"type\":\"and\"},\"query\":{\"params\":[\"C\"]},\"reducer\":{\"params\":[],\"type\":\"last\"},\"type\":\"query\"}],\"datasource\":{\"type\":\"__expr__\",\"uid\":\"__expr__\"},\"expression\":\"B\",\"intervalMs\":1000,\"maxDataPoints\":43200,\"refId\":\"C\",\"type\":\"threshold\"}"
    }

    no_data_state  = "NoData"
    exec_err_state = "Error"
    for            = "1m"
    annotations = {
      __dashboardUid__ = "eekoqbfs0apkwe"
      __panelId__      = "2"
      summary          = "pg_cron job(s) have failed!"
    }
    labels = {
      app         = "platform"
      environment = "prod"
      team        = "engineering"
    }
    is_paused = false
  }
}

#####################################################################
# Platform RDS CPU/storage/latency/connections health                #
#####################################################################
locals {
  platform_rds_health_environments = {
    production = {
      title                  = "Production"
      db_instance_identifier = "houserx-platform-db-production-10-25"
      datasource_uid         = grafana_data_source.cloudwatch-production.uid
      region                 = local.region
      environment_label      = "prod"
      # Order is load-bearing: see the dynamic "rule" block below. Append only.
      metrics = [
        {
          key         = "connections"
          title       = "High DB Connections"
          metric_name = "DatabaseConnections"
          statistic   = "Average"
          comparator  = "gt"
          threshold   = 1600 # 80% of the explicit max_connections=2000 (terraform-production/platform_rds.tf)
          for         = "5m"
          summary     = "Production platform RDS connections have exceeded 1600 (80% of the configured max_connections=2000)."
        },
        {
          key         = "cpu"
          title       = "High CPU Utilization"
          metric_name = "CPUUtilization"
          statistic   = "Average"
          comparator  = "gt"
          threshold   = 85
          for         = "10m"
          summary     = "Production platform RDS (houserx-platform-db-production-10-25) CPU utilization has been above 85% for 10+ minutes."
        },
        {
          key         = "read_latency"
          title       = "High Read Latency"
          metric_name = "ReadLatency"
          statistic   = "Average"
          comparator  = "gt"
          threshold   = 0.02 # 20ms
          for         = "10m"
          summary     = "Production platform RDS read latency has been above 20ms for 10+ minutes - a likely cause of slow environments."
        },
        {
          key         = "storage"
          title       = "Low Free Storage Space"
          metric_name = "FreeStorageSpace"
          statistic   = "Average"
          comparator  = "lt"
          threshold   = 322122547200 # 300 GiB - 10% of the 3000 GiB max_allocated_storage autoscaling ceiling
          for         = "1m"
          summary     = "Production platform RDS free storage has dropped below 300 GiB (10% of the 3000 GiB max_allocated_storage autoscaling ceiling) - limited headroom left before autoscaling can no longer help."
        },
        {
          key         = "write_latency"
          title       = "High Write Latency"
          metric_name = "WriteLatency"
          statistic   = "Average"
          comparator  = "gt"
          threshold   = 0.02 # 20ms
          for         = "10m"
          summary     = "Production platform RDS write latency has been above 20ms for 10+ minutes - a likely cause of slow environments."
        },
      ]
    }

    staging = {
      title                  = "Staging Anon"
      db_instance_identifier = "houserx-platform-rds-staging-anon"
      datasource_uid         = grafana_data_source.cloudwatch-staging.uid
      region                 = local.region
      environment_label      = "staging"
      # Order is load-bearing: see the dynamic "rule" block below. Append only.
      metrics = [
        {
          key         = "connections"
          title       = "High DB Connections"
          metric_name = "DatabaseConnections"
          statistic   = "Average"
          comparator  = "gt"
          threshold   = 4000 # 80% of the default max_connections formula cap (5000) for db.m6g.4xlarge - no explicit override is set
          for         = "5m"
          summary     = "Staging platform RDS connections have exceeded 4000 (80% of the default max_connections ceiling)."
        },
        {
          key         = "cpu"
          title       = "High CPU Utilization"
          metric_name = "CPUUtilization"
          statistic   = "Average"
          comparator  = "gt"
          threshold   = 85
          for         = "10m"
          summary     = "Staging platform RDS (houserx-platform-rds-staging-anon) CPU utilization has been above 85% for 10+ minutes."
        },
        {
          key         = "read_latency"
          title       = "High Read Latency"
          metric_name = "ReadLatency"
          statistic   = "Average"
          comparator  = "gt"
          threshold   = 0.02 # 20ms
          for         = "10m"
          summary     = "Staging platform RDS read latency has been above 20ms for 10+ minutes - a likely cause of slow branch-deployment environments."
        },
        {
          key         = "storage"
          title       = "Low Free Storage Space"
          metric_name = "FreeStorageSpace"
          statistic   = "Average"
          comparator  = "lt"
          threshold   = 858993459200 # 800 GiB - 10% of the 8000 GiB max_allocated_storage autoscaling ceiling
          for         = "1m"
          summary     = "Staging platform RDS free storage has dropped below 800 GiB (10% of the 8000 GiB max_allocated_storage autoscaling ceiling) - limited headroom left before autoscaling can no longer help."
        },
        {
          key         = "write_latency"
          title       = "High Write Latency"
          metric_name = "WriteLatency"
          statistic   = "Average"
          comparator  = "gt"
          threshold   = 0.02 # 20ms
          for         = "10m"
          summary     = "Staging platform RDS write latency has been above 20ms for 10+ minutes - a likely cause of slow branch-deployment environments."
        },
        {
          # The only cross-region metric here: the DR replica lives in us-east-1
          # while everything else above is us-east-2.
          #
          # outside_range rather than gt because RDS publishes -1 in this metric
          # family when it cannot determine lag, and a gt comparison sits at OK
          # on a negative - which is the condition this rule exists to catch.
          # Fires below 0 or above the upper bound.
          #
          # That upper bound is 2h, not the 60s you would pick from first
          # principles. Tonic staging-data generation drives lag to 4124s
          # routinely and 1.7h at peak, then recovers on its own; at 60s this
          # pages on every run and gets muted, which is how the CloudWatch alarm
          # it replaces ended up notifying nobody. The catastrophic end - WAL
          # filling the primary - is already covered by the storage rule above.
          # This is here for lag that does not come back.
          key                    = "replica_lag"
          title                  = "Cross-Region Replica Lag"
          metric_name            = "ReplicaLag"
          db_instance_identifier = "houserx-platform-rds-staging-anon-replica"
          region                 = "us-east-1"
          statistic              = "Maximum"
          comparator             = "outside_range"
          threshold              = 7200
          evaluator_params       = tolist([0, 7200])
          for                    = "30m"
          summary                = "Staging anon RDS cross-region replica (houserx-platform-rds-staging-anon-replica, us-east-1) has been more than 2h behind for 30 minutes, or RDS cannot determine its lag. Tonic runs spike lag and recover; this means it is not recovering. Check OldestReplicationSlotLag on the primary for WAL accumulation (IR-1067)."
        },
      ]
    }
  }
}

resource "grafana_rule_group" "platform_rds_health" {
  for_each         = local.platform_rds_health_environments
  name             = "platform_rds_health_${each.key}"
  folder_uid       = grafana_folder.this["RDS"].uid
  interval_seconds = 300

  dynamic "rule" {
    # Iterated as a list, not a map. rule blocks have no state identity and the
    # provider PUTs the whole group positionally, so a map would order these by
    # sorted key and any new key that does not sort last would shift every rule
    # below it onto a different Grafana UID, taking its silences and history
    # with it. A list appends.
    #
    # This is why the entries above are ordered connections, cpu, read_latency,
    # storage, write_latency: that is the sorted order the map produced, so the
    # live rules keep their positions across this change. Add new metrics at the
    # end and leave the existing order alone.
    #
    # Defaults are merged in rather than repeated on every metric so a metric can
    # opt out: a cross-region read replica needs its own region and identifier.
    for_each = [
      for m in each.value.metrics : merge({
        region                 = each.value.region
        db_instance_identifier = each.value.db_instance_identifier
        evaluator_params       = tolist([m.threshold])
      }, m)
    ]
    content {
      name      = "${each.value.title} RDS - ${rule.value.title}"
      condition = "C"

      data {
        ref_id = "A"
        relative_time_range {
          from = 900
          to   = 0
        }
        datasource_uid = each.value.datasource_uid
        model = jsonencode({
          dimensions = {
            DBInstanceIdentifier = rule.value.db_instance_identifier
          }
          matchExact       = true
          metricEditorMode = 0
          metricName       = rule.value.metric_name
          metricQueryType  = 0
          namespace        = "AWS/RDS"
          period           = "300"
          queryMode        = "Metrics"
          refId            = "A"
          region           = rule.value.region
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
            evaluator = { params = rule.value.evaluator_params, type = rule.value.comparator }
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

      no_data_state  = "NoData"
      exec_err_state = "Error"
      for            = rule.value.for
      annotations = {
        summary = rule.value.summary
      }
      labels = {
        team        = "infra"
        system      = "platform"
        service     = "rds"
        environment = each.value.environment_label
      }
      is_paused = false
    }
  }
}
