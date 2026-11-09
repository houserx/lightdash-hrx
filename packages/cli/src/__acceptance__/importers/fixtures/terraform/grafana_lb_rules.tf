####################################################################
# ALB Health Status Rule Group                                      #
####################################################################

locals {
  alb_rule_group_environments = ["prod", "staging"]
}

# Reference existing datasources
data "grafana_data_source" "cloudwatch_tooling" {
  name = "Cloudwatch Tooling"
}

data "grafana_data_source" "cloudwatch_production" {
  name = "Cloudwatch Production"
}

data "grafana_data_source" "cloudwatch_staging" {
  name = "Cloudwatch Staging"
}

# Define the rule group as a folder or logical grouping (if needed)
resource "grafana_folder" "alb_health_rule_groups" {
  for_each = toset(local.alb_rule_group_environments)
  title    = "${each.key} - ALB Health"
  uid      = "alb-health-${each.key}"
}

# ALB Health Rules Group - Contains all ALB-related alert rules
resource "grafana_rule_group" "alb_health_rules" {
  for_each         = toset(local.alb_rule_group_environments)
  name             = "ALB Health Rules"
  folder_uid       = grafana_folder.alb_health_rule_groups[each.key].uid
  interval_seconds = 300

  # ALB Unhealthy Host Count Alert
  rule {
    name      = "ALB Unhealthy Hosts"
    condition = "C"
    for       = "5m"

    data {
      ref_id = "A"
      relative_time_range {
        from = 1800
        to   = 0
      }
      datasource_uid = each.key == "prod" ? data.grafana_data_source.cloudwatch_production.uid : data.grafana_data_source.cloudwatch_staging.uid
      model          = "{\"dimensions\":{},\"expression\":\"\",\"id\":\"\",\"intervalMs\":1000,\"label\":\"\",\"logGroups\":[],\"matchExact\":false,\"maxDataPoints\":360,\"metricEditorMode\":0,\"metricName\":\"UnHealthyHostCount\",\"metricQueryType\":0,\"namespace\":\"AWS/ApplicationELB\",\"period\":\"300\",\"queryMode\":\"Metrics\",\"refId\":\"A\",\"region\":\"default\",\"sqlExpression\":\"\",\"statistic\":\"Average\"}"
    }

    data {
      ref_id = "B"
      relative_time_range {
        from = 0
        to   = 0
      }
      datasource_uid = "__expr__"
      model          = "{\"conditions\":[{\"evaluator\":{\"params\":[],\"type\":\"gt\"},\"operator\":{\"type\":\"and\"},\"query\":{\"params\":[\"A\"]},\"reducer\":{\"params\":[],\"type\":\"last\"},\"type\":\"query\"}],\"datasource\":{\"type\":\"__expr__\",\"uid\":\"__expr__\"},\"expression\":\"A\",\"intervalMs\":1000,\"maxDataPoints\":360,\"reducer\":\"last\",\"refId\":\"B\",\"settings\":{\"mode\":\"replaceNN\",\"replaceWithValue\":0},\"type\":\"reduce\"}"
    }

    data {
      ref_id = "C"
      relative_time_range {
        from = 0
        to   = 0
      }
      datasource_uid = "__expr__"
      model          = "{\"conditions\":[{\"evaluator\":{\"params\":[0],\"type\":\"gt\"},\"operator\":{\"type\":\"and\"},\"query\":{\"params\":[\"B\"]},\"reducer\":{\"params\":[],\"type\":\"last\"},\"type\":\"query\"}],\"datasource\":{\"type\":\"__expr__\",\"uid\":\"__expr__\"},\"expression\":\"B\",\"intervalMs\":1000,\"maxDataPoints\":360,\"refId\":\"C\",\"type\":\"threshold\"}"
    }

    no_data_state  = "NoData"
    exec_err_state = "Alerting"
    annotations = {
      description = "This indicates that one or more targets behind the load balancer in ${each.key} are failing health checks and cannot serve traffic."
      summary     = "Load Balancer Unhealthy Hosts Detected in ${each.key}"
    }
  }

  # ALB Low Healthy Host Count Alert
  rule {
    name      = "ALB Low Healthy Hosts"
    condition = "healthy_threshold"
    for       = "15m"

    data {
      ref_id = "healthy_count"
      relative_time_range {
        from = 1800
        to   = 0
      }
      datasource_uid = each.key == "prod" ? data.grafana_data_source.cloudwatch_production.uid : data.grafana_data_source.cloudwatch_staging.uid
      model          = "{\"datasource\":{\"type\":\"cloudwatch\",\"uid\":\"${each.key == "prod" ? data.grafana_data_source.cloudwatch_production.uid : data.grafana_data_source.cloudwatch_staging.uid}\"},\"dimensions\":{},\"expression\":\"\",\"id\":\"\",\"intervalMs\":1000,\"label\":\"\",\"logGroups\":[],\"matchExact\":false,\"maxDataPoints\":360,\"metricEditorMode\":0,\"metricName\":\"HealthyHostCount\",\"metricQueryType\":0,\"namespace\":\"AWS/ApplicationELB\",\"period\":\"300\",\"queryMode\":\"Metrics\",\"refId\":\"healthy_count\",\"region\":\"default\",\"sqlExpression\":\"\",\"statistic\":\"Minimum\"}"
    }

    data {
      ref_id = "healthy_reduce"
      relative_time_range {
        from = 0
        to   = 0
      }
      datasource_uid = "__expr__"
      model          = "{\"conditions\":[{\"evaluator\":{\"params\":[],\"type\":\"gt\"},\"operator\":{\"type\":\"and\"},\"query\":{\"params\":[\"healthy_count\"]},\"reducer\":{\"params\":[],\"type\":\"last\"},\"type\":\"query\"}],\"datasource\":{\"type\":\"__expr__\",\"uid\":\"__expr__\"},\"expression\":\"healthy_count\",\"intervalMs\":1000,\"maxDataPoints\":360,\"reducer\":\"min\",\"refId\":\"healthy_reduce\",\"settings\":{\"mode\":\"replaceNN\",\"replaceWithValue\":0},\"type\":\"reduce\"}"
    }

    data {
      ref_id = "healthy_threshold"
      relative_time_range {
        from = 0
        to   = 0
      }
      datasource_uid = "__expr__"
      model          = "{\"conditions\":[{\"evaluator\":{\"params\":[1],\"type\":\"lt\"},\"operator\":{\"type\":\"and\"},\"query\":{\"params\":[\"healthy_reduce\"]},\"reducer\":{\"params\":[],\"type\":\"last\"},\"type\":\"query\"}],\"datasource\":{\"type\":\"__expr__\",\"uid\":\"__expr__\"},\"expression\":\"healthy_reduce\",\"intervalMs\":1000,\"maxDataPoints\":360,\"refId\":\"healthy_threshold\",\"type\":\"threshold\"}"
    }

    no_data_state  = "NoData"
    exec_err_state = "Alerting"
    annotations = {
      description = "The number of healthy targets behind the load balancer in ${each.key} is below the minimum threshold."
      summary     = "Load Balancer Low Healthy Host Count in ${each.key}"
    }

    notification_settings {
      contact_point = "Grafana Alerts (incident.io)"
    }
  }

  # ALB Target Response Time Alert
  rule {
    name      = "ALB High Response Time"
    condition = "response_threshold"
    for       = "15m"

    data {
      ref_id = "response_time"
      relative_time_range {
        from = 1800
        to   = 0
      }
      datasource_uid = each.key == "prod" ? data.grafana_data_source.cloudwatch_production.uid : data.grafana_data_source.cloudwatch_staging.uid
      model          = "{\"datasource\":{\"type\":\"cloudwatch\",\"uid\":\"${each.key == "prod" ? data.grafana_data_source.cloudwatch_production.uid : data.grafana_data_source.cloudwatch_staging.uid}\"},\"dimensions\":{\"LoadBalancer\":[\"app/platform-lb-0-ui/*\",\"app/houserx-websocket-lb/*\",\"app/prometheus-ingress-alb/*\"]},\"expression\":\"\",\"id\":\"\",\"intervalMs\":1000,\"label\":\"\",\"logGroups\":[],\"matchExact\":false,\"maxDataPoints\":360,\"metricEditorMode\":0,\"metricName\":\"TargetResponseTime\",\"metricQueryType\":0,\"namespace\":\"AWS/ApplicationELB\",\"period\":\"300\",\"queryMode\":\"Metrics\",\"refId\":\"response_time\",\"region\":\"default\",\"sqlExpression\":\"\",\"statistic\":\"Average\"}"
    }

    data {
      ref_id = "response_reduce"
      relative_time_range {
        from = 0
        to   = 0
      }
      datasource_uid = "__expr__"
      model          = "{\"conditions\":[{\"evaluator\":{\"params\":[],\"type\":\"gt\"},\"operator\":{\"type\":\"and\"},\"query\":{\"params\":[\"response_time\"]},\"reducer\":{\"params\":[],\"type\":\"mean\"},\"type\":\"reduce\"}],\"datasource\":{\"type\":\"__expr__\",\"uid\":\"__expr__\"},\"expression\":\"response_time\",\"intervalMs\":1000,\"maxDataPoints\":360,\"reducer\":\"mean\",\"refId\":\"response_reduce\",\"settings\":{\"mode\":\"replaceNN\",\"replaceWithValue\":0},\"type\":\"reduce\"}"
    }

    data {
      ref_id = "response_threshold"
      relative_time_range {
        from = 0
        to   = 0
      }
      datasource_uid = "__expr__"
      model          = "{\"conditions\":[{\"evaluator\":{\"params\":[2],\"type\":\"gt\"},\"operator\":{\"type\":\"and\"},\"query\":{\"params\":[\"response_reduce\"]},\"reducer\":{\"params\":[],\"type\":\"last\"},\"type\":\"query\"}],\"datasource\":{\"type\":\"__expr__\",\"uid\":\"__expr__\"},\"expression\":\"response_reduce\",\"intervalMs\":1000,\"maxDataPoints\":360,\"refId\":\"response_threshold\",\"type\":\"threshold\"}"
    }

    no_data_state  = "NoData"
    exec_err_state = "Alerting"
    annotations = {
      description = "Average target response time behind the load balancer in ${each.key} has exceeded 2 seconds for an extended period."
      summary     = "Load Balancer High Response Time in ${each.key}"
    }

    notification_settings {
      contact_point = "Grafana Alerts (incident.io)"
    }
  }

  # Superset ALB High Response Time Alert
  # Created separate rule because Superset normally operates with 3-4s response times
  # due to heavy analytical queries. Using the standard 2s threshold caused false positives.
  # This rule uses a 5s threshold specifically for Superset ALBs to align with actual performance.
  rule {
    name      = "Superset ALB High Response Time"
    condition = "superset_response_threshold"
    for       = "15m"

    data {
      ref_id = "superset_response_time"
      relative_time_range {
        from = 1800
        to   = 0
      }
      datasource_uid = each.key == "prod" ? data.grafana_data_source.cloudwatch_production.uid : data.grafana_data_source.cloudwatch_staging.uid
      model          = "{\"datasource\":{\"type\":\"cloudwatch\",\"uid\":\"${each.key == "prod" ? data.grafana_data_source.cloudwatch_production.uid : data.grafana_data_source.cloudwatch_staging.uid}\"},\"dimensions\":{\"LoadBalancer\":[\"app/superset-alb/*\",\"app/superset-v2-alb/*\"]},\"expression\":\"\",\"id\":\"\",\"intervalMs\":1000,\"label\":\"\",\"logGroups\":[],\"matchExact\":false,\"maxDataPoints\":360,\"metricEditorMode\":0,\"metricName\":\"TargetResponseTime\",\"metricQueryType\":0,\"namespace\":\"AWS/ApplicationELB\",\"period\":\"300\",\"queryMode\":\"Metrics\",\"refId\":\"superset_response_time\",\"region\":\"default\",\"sqlExpression\":\"\",\"statistic\":\"Average\"}"
    }

    data {
      ref_id = "superset_response_reduce"
      relative_time_range {
        from = 0
        to   = 0
      }
      datasource_uid = "__expr__"
      model          = "{\"conditions\":[{\"evaluator\":{\"params\":[],\"type\":\"gt\"},\"operator\":{\"type\":\"and\"},\"query\":{\"params\":[\"superset_response_time\"]},\"reducer\":{\"params\":[],\"type\":\"mean\"},\"type\":\"reduce\"}],\"datasource\":{\"type\":\"__expr__\",\"uid\":\"__expr__\"},\"expression\":\"superset_response_time\",\"intervalMs\":1000,\"maxDataPoints\":360,\"reducer\":\"mean\",\"refId\":\"superset_response_reduce\",\"settings\":{\"mode\":\"replaceNN\",\"replaceWithValue\":0},\"type\":\"reduce\"}"
    }

    data {
      ref_id = "superset_response_threshold"
      relative_time_range {
        from = 0
        to   = 0
      }
      datasource_uid = "__expr__"
      model          = "{\"conditions\":[{\"evaluator\":{\"params\":[5],\"type\":\"gt\"},\"operator\":{\"type\":\"and\"},\"query\":{\"params\":[\"superset_response_reduce\"]},\"reducer\":{\"params\":[],\"type\":\"last\"},\"type\":\"query\"}],\"datasource\":{\"type\":\"__expr__\",\"uid\":\"__expr__\"},\"expression\":\"superset_response_reduce\",\"intervalMs\":1000,\"maxDataPoints\":360,\"refId\":\"superset_response_threshold\",\"type\":\"threshold\"}"
    }

    no_data_state  = "NoData"
    exec_err_state = "Alerting"
    annotations = {
      description = "Average target response time for Superset ALBs in ${each.key} has exceeded 5 seconds for an extended period."
      summary     = "Superset ALB High Response Time in ${each.key}"
    }

    notification_settings {
      contact_point = "Grafana Alerts (incident.io)"
    }
  }
}
