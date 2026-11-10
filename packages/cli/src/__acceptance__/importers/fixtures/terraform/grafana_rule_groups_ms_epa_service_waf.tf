# Alerting on ms_epa_service_waf (terraform-production/staging's ms_epa_service_waf.tf).
# Mirrors the CloudWatch-via-Grafana pattern used for ALB metrics in grafana_lb_rules.tf.
#
# Only one rule: generic CountedRequests/BlockedRequests (Rule=ALL) volume alerts were
# tried and dropped - once managed rule groups enforce, a large blocked scanner sweep is
# the WAF working as intended, not an incident, and there's no reliable threshold to
# separate that from a real problem. CenterXPathFromUnknownSource below is precise by
# construction instead of volume-based: anything reaching it already failed to match
# ms_epa_service_waf.tf's allow rules.
#
# The WebACL dimension value below is hardcoded to the ACL's resource name rather than
# referenced - source of truth is terraform-production/ms_epa_service_waf.tf:41 and
# terraform-staging/ms_epa_service_waf.tf:43. A rename there needs a matching update
# here; nothing catches that at plan time.

locals {
  ms_epa_service_waf_environments = ["prod", "staging"]
}

resource "grafana_folder" "ms_epa_service_waf_rule_groups" {
  for_each = toset(local.ms_epa_service_waf_environments)
  title    = "${each.key} - ms-epa-service WAF"
  uid      = "ms-epa-service-waf-${each.key}"
}

resource "grafana_rule_group" "ms_epa_service_waf_rules" {
  for_each         = toset(local.ms_epa_service_waf_environments)
  name             = "ms-epa-service WAF Rules"
  folder_uid       = grafana_folder.ms_epa_service_waf_rule_groups[each.key].uid
  interval_seconds = 300

  rule {
    name      = "ms-epa-service WAF CenterX Path Unknown Source - ${each.key}"
    condition = "centerx_path_threshold"
    for       = "5m"

    data {
      ref_id = "centerx_path_sum"
      relative_time_range {
        from = 1800
        to   = 0
      }
      datasource_uid = each.key == "prod" ? data.grafana_data_source.cloudwatch_production.uid : data.grafana_data_source.cloudwatch_staging.uid
      model = jsonencode({
        datasource = {
          type = "cloudwatch"
          uid  = each.key == "prod" ? data.grafana_data_source.cloudwatch_production.uid : data.grafana_data_source.cloudwatch_staging.uid
        }
        dimensions = {
          WebACL = "ms_epa_service_waf"
          Region = "us-east-2"
          Rule   = "MsEpaService-CenterXPathUnknownSource"
        }
        namespace       = "AWS/WAFV2"
        metricName      = "CountedRequests"
        statistic       = "Sum"
        period          = "300"
        matchExact      = true
        metricQueryType = 0
        queryMode       = "Metrics"
        refId           = "centerx_path_sum"
        region          = "default"
      })
    }

    data {
      ref_id = "centerx_path_reduce"
      relative_time_range {
        from = 0
        to   = 0
      }
      datasource_uid = "__expr__"
      model = jsonencode({
        datasource = { type = "__expr__", uid = "__expr__" }
        expression = "centerx_path_sum"
        reducer    = "max"
        refId      = "centerx_path_reduce"
        type       = "reduce"
      })
    }

    data {
      ref_id = "centerx_path_threshold"
      relative_time_range {
        from = 0
        to   = 0
      }
      datasource_uid = "__expr__"
      model = jsonencode({
        conditions = [{
          evaluator = { params = [0], type = "gt" }
          operator  = { type = "and" }
          query     = { params = ["centerx_path_reduce"] }
          reducer   = { params = [], type = "max" }
          type      = "query"
        }]
        datasource = { type = "__expr__", uid = "__expr__" }
        expression = "centerx_path_reduce"
        refId      = "centerx_path_threshold"
        type       = "threshold"
      })
    }

    no_data_state  = "OK"
    exec_err_state = "Alerting"
    annotations = {
      description = "A request to /processIncomingCenterXTransaction on ms_epa_service_waf (${each.key}) came from a source that is NOT the allow-listed CenterX IP or platform's NAT gateway. Check whether CenterX added/rotated a source IP (update AllowCenterXKnownIp) or this is a targeted probe."
      summary     = "ms-epa-service WAF: unrecognized source hit the CenterX webhook path (${each.key})"
    }
    labels = each.key == "prod" ? {
      team     = "infra"
      severity = "1"
      } : {
      team     = "engineering"
      channel  = "#alerts"
      severity = "4"
    }
    is_paused = false
  }
}
