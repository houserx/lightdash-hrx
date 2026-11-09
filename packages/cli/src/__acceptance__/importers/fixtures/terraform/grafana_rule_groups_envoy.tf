#####################################################################
# The rule group where the Envoy Gateway Alerts are organized in    #
#####################################################################

# TODO: replace with real runbook

# Envoy Gateway monitoring
resource "grafana_rule_group" "envoy_monitoring_rule_group" {
  for_each         = toset(local.mesh_alert_environments)
  name             = "envoy_monitoring_${each.key}"
  folder_uid       = grafana_folder.this["Service Mesh"].uid
  interval_seconds = 60
  # Control plane availability
  rule {
    name           = "Envoy Gateway Control Plane Unavailable - ${each.key}"
    for            = "5m"
    condition      = "B"
    no_data_state  = "Alerting"
    exec_err_state = "Alerting"
    is_paused      = false
    annotations = {
      "__dashboardUid__" : "envoy-gateway-mesh",
      "__panelId__" : "1",
      "summary" : "Envoy Gateway control plane is unavailable for ${each.key}.",
      "runbook_url" : "https://www.notion.so/houserx/Envoy-Gateway-Runbook"
    }
    labels = {
      "severity" : "1",
      "team" : "infra",
      "system" : "envoy-gateway",
      "environment" : each.key
      "app" : "envoy-gateway"
    }

    data {
      ref_id         = "A"
      datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
      relative_time_range {
        from = 1800
        to   = 0
      }
      model = jsonencode({
        expr          = "sum(kube_deployment_status_replicas_unavailable{namespace=\"envoy-gateway-system\", deployment=\"envoy-gateway\"})"
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
  # Proxy fleet availability
  rule {
    name           = "Envoy Proxy Fleet Unavailable - ${each.key}"
    for            = "5m"
    condition      = "B"
    no_data_state  = "Alerting"
    exec_err_state = "Alerting"
    is_paused      = false
    annotations = {
      "__dashboardUid__" : "envoy-gateway-mesh",
      "__panelId__" : "7",
      "summary" : "Envoy Gateway proxy fleet has unavailable replicas for ${each.key}.",
      "runbook_url" : "https://www.notion.so/houserx/Envoy-Gateway-Runbook"
    }
    labels = {
      "severity" : "2",
      "team" : "infra",
      "system" : "envoy-gateway",
      "environment" : each.key
      "app" : "envoy-gateway"
    }

    data {
      ref_id         = "A"
      datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
      relative_time_range {
        from = 1800
        to   = 0
      }
      model = jsonencode({
        expr          = "sum(kube_deployment_status_replicas_unavailable{namespace=\"envoy-gateway-system\", deployment=~\"envoy-envoy-gateway-system-.*\"})"
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
  # Downstream 5xx ratio
  rule {
    name           = "Envoy High 5xx Ratio - ${each.key}"
    for            = "10m"
    condition      = "B"
    no_data_state  = "OK"
    exec_err_state = "Alerting"
    is_paused      = false
    annotations = {
      "__dashboardUid__" : "envoy-gateway-mesh",
      "__panelId__" : "3",
      "summary" : "Envoy Gateway downstream 5xx ratio is elevated for ${each.key}.",
      "runbook_url" : "https://www.notion.so/houserx/Envoy-Gateway-Runbook"
    }
    labels = {
      "severity" : "2",
      "team" : "infra",
      "system" : "envoy-gateway",
      "environment" : each.key
      "app" : "envoy-gateway"
    }

    data {
      ref_id         = "A"
      datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
      relative_time_range {
        from = 1800
        to   = 0
      }
      model = jsonencode({
        expr          = "100 * sum(rate(envoy_http_downstream_rq_xx{envoy_response_code_class=\"5\",envoy_http_conn_manager_prefix!~\"eg-stats-http|admin\"}[5m])) / (sum(rate(envoy_http_downstream_rq_total{envoy_http_conn_manager_prefix!~\"eg-stats-http|admin\"}[5m])) > 0)"
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
            params = [5]
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
  # Upstream p99 latency
  rule {
    name           = "Envoy Elevated Upstream p99 Latency - ${each.key}"
    for            = "10m"
    condition      = "B"
    no_data_state  = "OK"
    exec_err_state = "Alerting"
    is_paused      = false
    annotations = {
      "__dashboardUid__" : "envoy-gateway-mesh",
      "__panelId__" : "6",
      "summary" : "Envoy Gateway upstream p99 latency is elevated for ${each.key}.",
      "runbook_url" : "https://www.notion.so/houserx/Envoy-Gateway-Runbook"
    }
    labels = {
      "severity" : "3",
      "team" : "infra",
      "system" : "envoy-gateway",
      "environment" : each.key
      "app" : "envoy-gateway"
    }

    data {
      ref_id         = "A"
      datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
      relative_time_range {
        from = 1800
        to   = 0
      }
      model = jsonencode({
        expr          = "histogram_quantile(0.99, sum by (le) (rate(envoy_cluster_upstream_rq_time_bucket{envoy_cluster_name!=\"prometheus_stats\"}[5m])))"
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
            params = [1000]
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
  # Control plane proxy connection state
  rule {
    name           = "Envoy Control Plane Disconnected From Proxies - ${each.key}"
    for            = "10m"
    condition      = "B"
    no_data_state  = "OK"
    exec_err_state = "Alerting"
    is_paused      = false
    annotations = {
      "__dashboardUid__" : "envoy-gateway-mesh",
      "__panelId__" : "8",
      "summary" : "Envoy Gateway control plane is disconnected from one or more proxies for ${each.key}.",
      "runbook_url" : "https://www.notion.so/houserx/Envoy-Gateway-Runbook"
    }
    labels = {
      "severity" : "2",
      "team" : "infra",
      "system" : "envoy-gateway",
      "environment" : each.key
      "app" : "envoy-gateway"
    }

    data {
      ref_id         = "A"
      datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
      relative_time_range {
        from = 1800
        to   = 0
      }
      model = jsonencode({
        expr          = "sum(envoy_control_plane_connected_state == bool 0)"
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
  # xDS transport failures and rejected configurations
  rule {
    name           = "Envoy xDS Config Update Failures - ${each.key}"
    for            = "1m"
    condition      = "B"
    no_data_state  = "OK"
    exec_err_state = "Alerting"
    is_paused      = false
    annotations = {
      "__dashboardUid__" : "envoy-gateway-mesh",
      "__panelId__" : "8",
      "summary" : "Envoy Gateway xDS config update failures or rejections detected for ${each.key}.",
      "runbook_url" : "https://www.notion.so/houserx/Envoy-Gateway-Runbook"
    }
    labels = {
      "severity" : "3",
      "team" : "infra",
      "system" : "envoy-gateway",
      "environment" : each.key
      "app" : "envoy-gateway"
    }

    # One query per metric family (CDS, LDS), and within each family one
    # term PER EXACT METRIC NAME summed with "+" rather than a __name__=~
    # regex alternation. Envoy exports the failure and rejected counters for
    # a family side by side with identical labels, so *any* multi-name
    # __name__=~ selector inside rate()/increase() — even scoped to a single
    # family — trips a "vector cannot contain metrics with the same
    # labelset" query error the moment both series exist (which they always
    # do; Envoy exports these as 0 when unused, not absent). Each term is
    # independently defaulted with "or vector(0)" so a metric that has never
    # been scraped doesn't turn the whole sum into no-data.
    data {
      ref_id         = "A"
      datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
      relative_time_range {
        from = 1800
        to   = 0
      }
      model = jsonencode({
        expr          = "(sum(increase(envoy_cluster_manager_cds_update_failure[10m])) or vector(0)) + (sum(increase(envoy_cluster_manager_cds_update_rejected[10m])) or vector(0))"
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
      ref_id         = "C"
      datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
      relative_time_range {
        from = 1800
        to   = 0
      }
      model = jsonencode({
        expr          = "(sum(increase(envoy_listener_manager_lds_update_failure[10m])) or vector(0)) + (sum(increase(envoy_listener_manager_lds_update_rejected[10m])) or vector(0))"
        hide          = false
        intervalMs    = 20000
        maxDataPoints = 100
        refId         = "C"
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
        conditions = [
          {
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
          },
          {
            type = "query"
            evaluator = {
              params = [0]
              type   = "gt"
            }
            operator = {
              type = "or"
            }
            query = {
              params = ["C"]
            }
            reducer = {
              params = []
              type   = "last"
            }
          }
        ]
      })
    }
  }
  # Upstream/downstream TLS connection and certificate-verification errors
  rule {
    name           = "Envoy TLS Connection Errors - ${each.key}"
    for            = "10m"
    condition      = "B"
    no_data_state  = "OK"
    exec_err_state = "Alerting"
    is_paused      = false
    annotations = {
      "__dashboardUid__" : "envoy-gateway-mesh",
      "__panelId__" : "9",
      "summary" : "Envoy Gateway TLS connection or certificate-verification errors detected for ${each.key}.",
      "runbook_url" : "https://www.notion.so/houserx/Envoy-Gateway-Runbook"
    }
    labels = {
      "severity" : "3",
      "team" : "infra",
      "system" : "envoy-gateway",
      "environment" : each.key
      "app" : "envoy-gateway"
    }

    # One query per metric family (cluster, listener), one term per exact
    # metric name — see the detailed comment on the xDS Config Update
    # Failures rule above for why a __name__=~ alternation still breaks even
    # scoped to a single family.
    data {
      ref_id         = "A"
      datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
      relative_time_range {
        from = 1800
        to   = 0
      }
      model = jsonencode({
        expr          = "(sum(rate(envoy_cluster_ssl_connection_error[5m])) or vector(0)) + (sum(rate(envoy_cluster_ssl_fail_verify_cert_hash[5m])) or vector(0)) + (sum(rate(envoy_cluster_ssl_fail_verify_san[5m])) or vector(0)) + (sum(rate(envoy_cluster_ssl_fail_verify_error[5m])) or vector(0)) + (sum(rate(envoy_cluster_ssl_fail_verify_no_cert[5m])) or vector(0))"
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
      ref_id         = "C"
      datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
      relative_time_range {
        from = 1800
        to   = 0
      }
      model = jsonencode({
        expr          = "(sum(rate(envoy_listener_ssl_connection_error[5m])) or vector(0)) + (sum(rate(envoy_listener_ssl_fail_verify_cert_hash[5m])) or vector(0)) + (sum(rate(envoy_listener_ssl_fail_verify_san[5m])) or vector(0)) + (sum(rate(envoy_listener_ssl_fail_verify_error[5m])) or vector(0)) + (sum(rate(envoy_listener_ssl_fail_verify_no_cert[5m])) or vector(0))"
        hide          = false
        intervalMs    = 20000
        maxDataPoints = 100
        refId         = "C"
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
        conditions = [
          {
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
          },
          {
            type = "query"
            evaluator = {
              params = [0]
              type   = "gt"
            }
            operator = {
              type = "or"
            }
            query = {
              params = ["C"]
            }
            reducer = {
              params = []
              type   = "last"
            }
          }
        ]
      })
    }
  }
}
