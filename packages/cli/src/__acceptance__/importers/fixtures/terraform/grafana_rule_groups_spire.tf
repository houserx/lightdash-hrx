#####################################################################
# The rule group where the SPIRE Alerts are organized in            #
#####################################################################

# TODO: replace with real runbook

# SPIRE monitoring
resource "grafana_rule_group" "spire_monitoring_rule_group" {
  for_each         = toset(local.mesh_alert_environments)
  name             = "spire_monitoring_${each.key}"
  folder_uid       = grafana_folder.this["Service Mesh"].uid
  interval_seconds = 60
  # Server availability
  rule {
    name           = "SPIRE Server Unavailable - ${each.key}"
    for            = "5m"
    condition      = "B"
    no_data_state  = "Alerting"
    exec_err_state = "Alerting"
    is_paused      = false
    annotations = {
      "__dashboardUid__" : "spire-identity",
      "__panelId__" : "1",
      "summary" : "SPIRE server is unavailable for ${each.key}.",
      "runbook_url" : "https://www.notion.so/houserx/SPIRE-Runbook"
    }
    labels = {
      "severity" : "1",
      "team" : "infra",
      "system" : "spire",
      "environment" : each.key
      "app" : "spire-server"
    }

    data {
      ref_id         = "A"
      datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
      relative_time_range {
        from = 1800
        to   = 0
      }
      model = jsonencode({
        expr          = "sum(kube_statefulset_replicas{namespace=\"spire\",statefulset=~\"spire-server.*\"}) - sum(kube_statefulset_status_replicas_ready{namespace=\"spire\",statefulset=~\"spire-server.*\"})"
        hide          = false
        instant       = true
        range         = false
        intervalMs    = 20000
        maxDataPoints = 100
        refId         = "A"
        datasource = {
          type           = local.grafana_prometheus_data_sources_env[each.key].type
          datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
        }
      })
    }

    data {
      ref_id         = "B"
      datasource_uid = "-100"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        hide          = false
        intervalMs    = 1000
        maxDataPoints = 43200
        refId         = "B"
        type          = "classic_conditions"
        datasource = {
          type = "__expr__"
          uid  = "-100"
        }
        conditions = [{
          type = "query"
          evaluator = {
            params = [0]
            type   = "gt"
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
  # Agent availability
  rule {
    name           = "SPIRE Agents Unavailable - ${each.key}"
    for            = "10m"
    condition      = "B"
    no_data_state  = "Alerting"
    exec_err_state = "Alerting"
    is_paused      = false
    annotations = {
      "__dashboardUid__" : "spire-identity",
      "__panelId__" : "3",
      "summary" : "SPIRE agents are unavailable for ${each.key}.",
      "runbook_url" : "https://www.notion.so/houserx/SPIRE-Runbook"
    }
    labels = {
      "severity" : "2",
      "team" : "infra",
      "system" : "spire",
      "environment" : each.key
      "app" : "spire-agent"
    }

    data {
      ref_id         = "A"
      datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
      relative_time_range {
        from = 1800
        to   = 0
      }
      model = jsonencode({
        expr          = "sum(kube_daemonset_status_number_unavailable{namespace=\"spire\",daemonset=~\"spire-agent.*\"})"
        hide          = false
        instant       = true
        range         = false
        intervalMs    = 20000
        maxDataPoints = 100
        refId         = "A"
        datasource = {
          type           = local.grafana_prometheus_data_sources_env[each.key].type
          datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
        }
      })
    }

    data {
      ref_id         = "B"
      datasource_uid = "-100"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        hide          = false
        intervalMs    = 1000
        maxDataPoints = 43200
        refId         = "B"
        type          = "classic_conditions"
        datasource = {
          type = "__expr__"
          uid  = "-100"
        }
        conditions = [{
          type = "query"
          evaluator = {
            params = [0]
            type   = "gt"
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
  # Bridge running retries, but clear five minutes after the last observed backoff.
  rule {
    name           = "SPIRE Pod CrashLooping - ${each.key}"
    for            = "15m"
    condition      = "B"
    no_data_state  = "OK"
    exec_err_state = "Alerting"
    is_paused      = false
    annotations = {
      "__dashboardUid__" : "spire-identity",
      "__panelId__" : "4",
      "summary" : "SPIRE pods are crashlooping for ${each.key}.",
      "runbook_url" : "https://www.notion.so/houserx/SPIRE-Runbook"
    }
    labels = {
      "severity" : "2",
      "team" : "infra",
      "system" : "spire",
      "environment" : each.key
      "app" : "spire"
    }

    data {
      ref_id         = "A"
      datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
      relative_time_range {
        from = 1800
        to   = 0
      }
      model = jsonencode({
        expr          = "sum(max_over_time(kube_pod_container_status_waiting_reason{namespace=\"spire\", reason=\"CrashLoopBackOff\"}[5m])) or vector(0)"
        instant       = true
        range         = false
        hide          = false
        intervalMs    = 20000
        maxDataPoints = 100
        refId         = "A"
        datasource = {
          type           = local.grafana_prometheus_data_sources_env[each.key].type
          datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
        }
      })
    }

    data {
      ref_id         = "B"
      datasource_uid = "-100"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        hide          = false
        intervalMs    = 1000
        maxDataPoints = 43200
        refId         = "B"
        type          = "classic_conditions"
        datasource = {
          type = "__expr__"
          uid  = "-100"
        }
        conditions = [{
          type = "query"
          evaluator = {
            params = [0]
            type   = "gt"
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
  # Controller-manager reconcile errors
  # Unpause after the staging :8082 scrape and namespace label are verified.
  rule {
    name           = "SPIRE Controller-Manager Reconcile Errors - ${each.key}"
    for            = "10m"
    condition      = "B"
    no_data_state  = "OK"
    exec_err_state = "Alerting"
    is_paused      = true
    annotations = {
      "__dashboardUid__" : "spire-identity",
      "__panelId__" : "5",
      "summary" : "SPIRE controller-manager reconcile errors detected for ${each.key}.",
      "runbook_url" : "https://www.notion.so/houserx/SPIRE-Runbook"
    }
    labels = {
      "severity" : "3",
      "team" : "infra",
      "system" : "spire",
      "environment" : each.key
      "app" : "spire-controller-manager"
    }

    data {
      ref_id         = "A"
      datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
      relative_time_range {
        from = 1800
        to   = 0
      }
      model = jsonencode({
        expr          = "sum(increase(controller_runtime_reconcile_errors_total{namespace=\"spire\"}[10m]))"
        hide          = false
        intervalMs    = 20000
        maxDataPoints = 100
        refId         = "A"
        datasource = {
          type           = local.grafana_prometheus_data_sources_env[each.key].type
          datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
        }
      })
    }

    data {
      ref_id         = "B"
      datasource_uid = "-100"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        hide          = false
        intervalMs    = 1000
        maxDataPoints = 43200
        refId         = "B"
        type          = "classic_conditions"
        datasource = {
          type = "__expr__"
          uid  = "-100"
        }
        conditions = [{
          type = "query"
          evaluator = {
            params = [0]
            type   = "gt"
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
  # SVID signing failures
  rule {
    name           = "SPIRE SVID Signing Failures - ${each.key}"
    for            = "10m"
    condition      = "B"
    no_data_state  = "OK"
    exec_err_state = "Alerting"
    # unpause after confirming metric name via verify-scrape
    is_paused = true
    annotations = {
      "__dashboardUid__" : "spire-identity",
      "__panelId__" : "9",
      "summary" : "SPIRE SVID signing failures detected for ${each.key}; confirm metric name.",
      "runbook_url" : "https://www.notion.so/houserx/SPIRE-Runbook"
    }
    labels = {
      "severity" : "2",
      "team" : "infra",
      "system" : "spire",
      "environment" : each.key
      "app" : "spire-server"
    }

    data {
      ref_id         = "A"
      datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
      relative_time_range {
        from = 1800
        to   = 0
      }
      model = jsonencode({
        expr          = "sum(rate(spire_server_svid_sign_error[5m]))"
        hide          = false
        intervalMs    = 20000
        maxDataPoints = 100
        refId         = "A"
        datasource = {
          type           = local.grafana_prometheus_data_sources_env[each.key].type
          datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
        }
      })
    }

    data {
      ref_id         = "B"
      datasource_uid = "-100"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        hide          = false
        intervalMs    = 1000
        maxDataPoints = 43200
        refId         = "B"
        type          = "classic_conditions"
        datasource = {
          type = "__expr__"
          uid  = "-100"
        }
        conditions = [{
          type = "query"
          evaluator = {
            params = [0]
            type   = "gt"
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
  # Agent SVID rotation failures
  rule {
    name           = "SPIRE Agent SVID Rotation Failures - ${each.key}"
    for            = "15m"
    condition      = "B"
    no_data_state  = "OK"
    exec_err_state = "Alerting"
    # unpause after confirming metric name via verify-scrape
    is_paused = true
    annotations = {
      "__dashboardUid__" : "spire-identity",
      "__panelId__" : "10",
      "summary" : "SPIRE agent SVID rotation failures detected for ${each.key}; confirm metric name.",
      "runbook_url" : "https://www.notion.so/houserx/SPIRE-Runbook"
    }
    labels = {
      "severity" : "3",
      "team" : "infra",
      "system" : "spire",
      "environment" : each.key
      "app" : "spire-agent"
    }

    data {
      ref_id         = "A"
      datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
      relative_time_range {
        from = 1800
        to   = 0
      }
      model = jsonencode({
        expr          = "sum(rate(spire_agent_manager_svid_rotate_error[5m]))"
        hide          = false
        intervalMs    = 20000
        maxDataPoints = 100
        refId         = "A"
        datasource = {
          type           = local.grafana_prometheus_data_sources_env[each.key].type
          datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
        }
      })
    }

    data {
      ref_id         = "B"
      datasource_uid = "-100"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        hide          = false
        intervalMs    = 1000
        maxDataPoints = 43200
        refId         = "B"
        type          = "classic_conditions"
        datasource = {
          type = "__expr__"
          uid  = "-100"
        }
        conditions = [{
          type = "query"
          evaluator = {
            params = [0]
            type   = "gt"
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
  # CA / bundle expiry
  rule {
    name           = "SPIRE CA / Bundle Expiry Approaching - ${each.key}"
    for            = "15m"
    condition      = "B"
    no_data_state  = "OK"
    exec_err_state = "Alerting"
    # unpause after confirming metric name via verify-scrape
    is_paused = true
    annotations = {
      "__dashboardUid__" : "spire-identity",
      "__panelId__" : "8",
      "summary" : "SPIRE CA / bundle expiry is approaching for ${each.key}; confirm metric name.",
      "runbook_url" : "https://www.notion.so/houserx/SPIRE-Runbook"
    }
    labels = {
      "severity" : "2",
      "team" : "infra",
      "system" : "spire",
      "environment" : each.key
      "app" : "spire-server"
    }

    data {
      ref_id         = "A"
      datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
      relative_time_range {
        from = 1800
        to   = 0
      }
      model = jsonencode({
        expr          = "sum(spire_server_ca_manager_x509_ca_ttl_seconds < bool 86400)"
        hide          = false
        intervalMs    = 20000
        maxDataPoints = 100
        refId         = "A"
        datasource = {
          type           = local.grafana_prometheus_data_sources_env[each.key].type
          datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
        }
      })
    }

    data {
      ref_id         = "B"
      datasource_uid = "-100"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        hide          = false
        intervalMs    = 1000
        maxDataPoints = 43200
        refId         = "B"
        type          = "classic_conditions"
        datasource = {
          type = "__expr__"
          uid  = "-100"
        }
        conditions = [{
          type = "query"
          evaluator = {
            params = [0]
            type   = "gt"
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
