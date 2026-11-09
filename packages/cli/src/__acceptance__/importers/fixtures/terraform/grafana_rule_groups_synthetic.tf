#####################################################################
# The rule group for Synthetic alerts                               #
#####################################################################

locals {
  synthetic_rule_group_environments = ["prod", "tooling"]
}

resource "grafana_rule_group" "synthetic_rule_groups" {
  for_each         = toset(local.synthetic_rule_group_environments)
  name             = "synthetic_${each.key}"
  folder_uid       = grafana_folder.this["AWS"].uid
  interval_seconds = 300

  # Synthetic Heartbeats - default region
  rule {
    name           = "Heartbeat - ${each.key}"
    for            = "1m"
    condition      = "threshold"
    no_data_state  = "NoData"
    exec_err_state = "Error"
    is_paused      = false
    annotations = {
      "Summary" : "AWS Cloudwatch Synthetic checks for checking if target endpoints are working in ${each.key} account."
      "Description" : "Uptime checker via synthetic check."
      "runbook_url" : ""
      "severity" : "2"
    }
    labels = {
      "team" : "infra"
      "system" : "platform"
      "environment" : each.key
    }

    data {
      ref_id         = "A"
      datasource_uid = each.key == "prod" ? grafana_data_source.cloudwatch-production.uid : grafana_data_source.cloudwatch-tooling.uid
      relative_time_range {
        from = 1800
        to   = 0
      }
      model = jsonencode({
        dimensions = {
          CanaryName = "*",
        },
        matchExact      = true
        sqlExpression   = "SELECT MAX(\"SuccessPercent\") FROM SCHEMA(CloudWatchSynthetics, CanaryName) GROUP BY CanaryName"
        statistic       = "Maximum"
        region          = local.region
        metricName      = "Failed requests"
        metricQueryType = 1
        namespace       = "CloudWatchSynthetics"
        hide            = false
        intervalMs      = 1000
        maxDataPoints   = 250
        refId           = "A"
        range           = true
        queryMode       = "Metrics"
      })
    }
    data {
      ref_id         = "threshold"
      datasource_uid = "-100"
      relative_time_range {
        from = 1800
        to   = 0
      }
      model = jsonencode({
        expression    = "A"
        hide          = false
        intervalMs    = 1000
        maxDataPoints = 43200
        refId         = "threshold"
        type          = "classic_conditions"
        settings = {
          mode             = "replaceNN"
          replaceWithValue = 0
        }
        conditions = [{
          type = "query"
          evaluator = {
            params = [100]
            type   = "lt"
          }
          operator = {
            type = "and"
          }
          query = {
            params = ["A"]
          }
          reducer = {
            params = []
            type   = "last"
          }
        }]
      })
    }
  }
  # Synthetic Heartbeats - dr region
  rule {
    name           = "Heartbeat - ${each.key} - dr"
    for            = "1m"
    condition      = "threshold"
    no_data_state  = "NoData"
    exec_err_state = "Error"
    is_paused      = true # Paused: React hydration errors in us-east-1, platform team investigating
    annotations = {
      "Summary" : "AWS Cloudwatch Synthetic checks for checking if target endpoints are working in ${each.key} account."
      "Description" : "Uptime checker via synthetic check."
      "runbook_url" : ""
      "severity" : "2"
    }
    labels = {
      "team" : "infra"
      "system" : "platform"
      "environment" : each.key
    }

    data {
      ref_id         = "A"
      datasource_uid = each.key == "prod" ? grafana_data_source.cloudwatch-production.uid : grafana_data_source.cloudwatch-tooling.uid
      relative_time_range {
        from = 1800
        to   = 0
      }
      model = jsonencode({
        dimensions = {
          CanaryName = "*",
        },
        matchExact      = true
        sqlExpression   = "SELECT MAX(\"SuccessPercent\") FROM SCHEMA(CloudWatchSynthetics, CanaryName) GROUP BY CanaryName"
        statistic       = "Maximum"
        region          = local.dr_region_us_east_1
        metricName      = "Failed requests"
        metricQueryType = 1
        namespace       = "CloudWatchSynthetics"
        hide            = false
        intervalMs      = 1000
        maxDataPoints   = 250
        refId           = "A"
        range           = true
        queryMode       = "Metrics"
      })
    }
    data {
      ref_id         = "threshold"
      datasource_uid = "-100"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        expression    = "A"
        hide          = false
        intervalMs    = 1000
        maxDataPoints = 43200
        refId         = "threshold"
        type          = "classic_conditions"
        settings = {
          mode             = "replaceNN"
          replaceWithValue = 0
        }
        conditions = [{
          type = "query"
          evaluator = {
            params = [100]
            type   = "lt"
          }
          operator = {
            type = "and"
          }
          query = {
            params = ["A"]
          }
          reducer = {
            params = []
            type   = "last"
          }
        }]
      })
    }
  }
}
