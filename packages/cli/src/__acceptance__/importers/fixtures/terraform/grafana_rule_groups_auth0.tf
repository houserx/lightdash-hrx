resource "grafana_rule_group" "auth0_m2m_rule_group" {
  name             = "auth0_m2m_token_alerts"
  folder_uid       = grafana_folder.this["Vendor"].uid
  interval_seconds = 3600

  rule {
    name      = "Auth0 M2M Token Daily Limit Exceeded"
    condition = "C"

    data {
      ref_id     = "A"
      query_type = "instant"

      relative_time_range {
        from = 86400
        to   = 0
      }

      datasource_uid = grafana_data_source.loki-staging.uid
      model          = "{\"datasource\":{\"type\":\"loki\",\"uid\":\"${grafana_data_source.loki-staging.uid}\"},\"editorMode\":\"code\",\"expr\":\"sum by (client_name) (count_over_time({job=\\\"auth0-logs\\\", type=\\\"seccft\\\"} [24h]))\",\"intervalMs\":1000,\"maxDataPoints\":43200,\"queryType\":\"instant\",\"refId\":\"A\"}"
    }

    data {
      ref_id = "B"

      relative_time_range {
        from = 0
        to   = 0
      }

      datasource_uid = "__expr__"
      model          = "{\"conditions\":[{\"evaluator\":{\"params\":[],\"type\":\"gt\"},\"operator\":{\"type\":\"and\"},\"query\":{\"params\":[\"A\"]},\"reducer\":{\"params\":[],\"type\":\"last\"},\"type\":\"query\"}],\"datasource\":{\"type\":\"__expr__\",\"uid\":\"__expr__\"},\"expression\":\"A\",\"intervalMs\":1000,\"maxDataPoints\":43200,\"reducer\":\"last\",\"refId\":\"B\",\"type\":\"reduce\"}"
    }

    data {
      ref_id = "C"

      relative_time_range {
        from = 0
        to   = 0
      }

      datasource_uid = "__expr__"
      model          = "{\"conditions\":[{\"evaluator\":{\"params\":[75000],\"type\":\"gt\"},\"operator\":{\"type\":\"and\"},\"query\":{\"params\":[\"C\"]},\"reducer\":{\"params\":[],\"type\":\"last\"},\"type\":\"query\"}],\"datasource\":{\"type\":\"__expr__\",\"uid\":\"__expr__\"},\"expression\":\"B\",\"intervalMs\":1000,\"maxDataPoints\":43200,\"refId\":\"C\",\"type\":\"threshold\"}"
    }

    no_data_state  = "NoData"
    exec_err_state = "Error"

    annotations = {
      description = "Auth0 M2M token exchanges for {{ $labels.client_name }} have exceeded 75,000 in the last 24 hours (current: {{ $values.B.Value }})."
      summary     = "Auth0 M2M token daily limit exceeded for {{ $labels.client_name }}"
    }

    labels = {
      environment = "staging"
      severity    = "3"
      system      = "auth0"
    }

    is_paused = false

    notification_settings {
      contact_point = grafana_contact_point.slack-infra-contact-point.name
    }
  }
}

resource "grafana_rule_group" "auth0_m2m_rule_group_production" {
  name             = "auth0_m2m_token_alerts_production"
  folder_uid       = grafana_folder.this["Vendor"].uid
  interval_seconds = 3600

  rule {
    name      = "Auth0 M2M Token Daily Limit Exceeded (Production)"
    condition = "C"

    data {
      ref_id     = "A"
      query_type = "instant"

      relative_time_range {
        from = 86400
        to   = 0
      }

      datasource_uid = grafana_data_source.loki-production.uid
      model          = "{\"datasource\":{\"type\":\"loki\",\"uid\":\"${grafana_data_source.loki-production.uid}\"},\"editorMode\":\"code\",\"expr\":\"sum by (client_name) (count_over_time({job=\\\"auth0-logs\\\", type=\\\"seccft\\\"} [24h]))\",\"intervalMs\":1000,\"maxDataPoints\":43200,\"queryType\":\"instant\",\"refId\":\"A\"}"
    }

    data {
      ref_id = "B"

      relative_time_range {
        from = 0
        to   = 0
      }

      datasource_uid = "__expr__"
      model          = "{\"conditions\":[{\"evaluator\":{\"params\":[],\"type\":\"gt\"},\"operator\":{\"type\":\"and\"},\"query\":{\"params\":[\"A\"]},\"reducer\":{\"params\":[],\"type\":\"last\"},\"type\":\"query\"}],\"datasource\":{\"type\":\"__expr__\",\"uid\":\"__expr__\"},\"expression\":\"A\",\"intervalMs\":1000,\"maxDataPoints\":43200,\"reducer\":\"last\",\"refId\":\"B\",\"type\":\"reduce\"}"
    }

    data {
      ref_id = "C"

      relative_time_range {
        from = 0
        to   = 0
      }

      datasource_uid = "__expr__"
      model          = "{\"conditions\":[{\"evaluator\":{\"params\":[75000],\"type\":\"gt\"},\"operator\":{\"type\":\"and\"},\"query\":{\"params\":[\"C\"]},\"reducer\":{\"params\":[],\"type\":\"last\"},\"type\":\"query\"}],\"datasource\":{\"type\":\"__expr__\",\"uid\":\"__expr__\"},\"expression\":\"B\",\"intervalMs\":1000,\"maxDataPoints\":43200,\"refId\":\"C\",\"type\":\"threshold\"}"
    }

    no_data_state  = "NoData"
    exec_err_state = "Error"

    annotations = {
      description = "Auth0 M2M token exchanges for {{ $labels.client_name }} have exceeded 75,000 in the last 24 hours (current: {{ $values.B.Value }})."
      summary     = "Auth0 M2M token daily limit exceeded for {{ $labels.client_name }}"
    }

    labels = {
      environment = "production"
      severity    = "3"
      system      = "auth0"
    }

    is_paused = false

    notification_settings {
      contact_point = grafana_contact_point.slack-infra-contact-point.name
    }
  }
}
