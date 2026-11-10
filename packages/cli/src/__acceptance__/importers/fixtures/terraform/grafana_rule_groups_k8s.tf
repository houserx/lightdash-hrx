#####################################################################
# The rule group where the Kubernetes Pod Alerts are organized in   #
#####################################################################

locals {
  k8s_rule_group_environments = ["prod", "tooling", "staging"]
}

#####################################################################
# IR-3093: the weekly orphaned PlatformEnvironment database sweep   #
# (houserx/k8s-cluster-management clusters/staging/values/          #
# orphan-db-sweep.yaml, README "Orphaned databases"). A CronJob in  #
# its own namespace, so these series are its own. Appended to the   #
# staging pod_monitoring group only (dynamic block at its end).     #
#####################################################################
locals {
  orphan_db_sweep_rules = [
    {
      key  = "orphans_found"
      name = "Orphaned PlatformEnvironment databases (staging-anon)"
      # The sweep exits 3 when it finds orphans; the Job does not retry
      # (backoffLimit 0), so any failed Job is a finding or a broken run.
      # Also covers a Job whose pod never completed (unpullable image,
      # unschedulable past activeDeadlineSeconds).
      expr      = "max(kube_job_failed{namespace=\"platform-environment-sweep\",condition=\"true\"})"
      threshold = 0
      for       = "5m"
      # Absence is normal: kube-state-metrics only reports Jobs that exist,
      # and finished Jobs are deleted after 6 days. The not-run rule below
      # covers a sweep that stopped running.
      no_data_state = "OK"
      is_paused     = false
      summary       = "The weekly orphaned-database sweep on staging-anon failed: it found orphaned PlatformEnvironment databases or roles, or the run itself failed."
      description   = "kubectl -n platform-environment-sweep logs job/<failed job> lists one ORPHAN line per finding. Removing one is a recorded human action: follow the runbook (README, Orphaned databases). Low urgency: nothing is broken until someone recreates that environment."
    },
    {
      key  = "not_run"
      name = "Orphan sweep has not run (staging-anon)"
      # Schedule is weekly (Mondays 14:00 UTC); 8 days allows one late run.
      expr      = "time() - max(kube_cronjob_status_last_schedule_time{namespace=\"platform-environment-sweep\"})"
      threshold = 8 * 86400
      # Rides out a kube-state-metrics restart briefly dropping the series.
      for = "1h"
      # No series means the CronJob was never applied, was deleted, or has
      # never been scheduled: all count as not running.
      no_data_state = "Alerting"
      # PAUSED until the CronJob has completed its first *scheduled* run.
      # kube-state-metrics omits last_schedule_time until the controller
      # schedules a run (a manual `kubectl create job --from=cronjob` does not
      # set it), so this fires from apply until then, and k8s-cluster-
      # management#15 cannot merge before these rules exist. Set false once
      # kube_cronjob_status_last_schedule_time{namespace="platform-environment-sweep"}
      # shows in staging's Prometheus.
      is_paused   = true
      summary     = "The weekly orphaned-database sweep on staging-anon has not been scheduled in over 8 days, or its CronJob is missing."
      description = "Check kubectl -n platform-environment-sweep get cronjob platform-environment-db-sweep (missing, suspended, or never scheduled) and the Flux Kustomization that applies it."
    },
  ]
}

# Pod/Deployment monitoring
resource "grafana_rule_group" "pod_monitoring_rule_group" {
  for_each         = toset(local.k8s_rule_group_environments)
  name             = "pod_monitoring_${each.key}"
  folder_uid       = grafana_folder.this["Kubernetes"].uid
  interval_seconds = 60
  # Branch deployment replicas
  rule {
    name           = "Deployment Replicas Unavailable | Branch Deployments - ${each.key}"
    for            = "60m"
    condition      = "B"
    no_data_state  = each.key == "tooling" || each.key == "staging" || each.key == "prod" ? "OK" : "NoData"
    exec_err_state = "Alerting"
    is_paused      = false
    annotations = {
      "__dashboardUid__" : "k8s-pods-jobs",
      "__panelId__" : "20",
      "summary" : "Branch Deployment unavailable for ${each.key} K8S cluster.",
      "runbook_url" : "https://www.notion.so/houserx/k8s-07842a825eaa4d1c9840a218f1caf65b?pvs=4#502c46de330a44dfacd8200452fb8e4e"
    }
    labels = {
      "severity" : "4",
      "team" : "infra",
      "system" : "kubernetes",
      "environment" : each.key
      "app" : "branch-deployments"
    }

    data {
      ref_id         = "A"
      datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
      relative_time_range {
        from = 1800
        to   = 0
      }
      model = jsonencode({
        expr          = "sum by (namespace) (kube_deployment_status_replicas_unavailable{namespace=\"branch-deployments\"})"
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
            type   = "min"
          }
        }]
      })
    }
  }
  # Platform replicas
  rule {
    name           = "Deployment Replicas Unavailable | Platform - ${each.key}"
    for            = "5m"
    condition      = "B"
    no_data_state  = contains(["staging", "prod"], each.key) == true ? "NoData" : "OK"
    exec_err_state = "Alerting"
    is_paused      = false
    annotations = {
      "__dashboardUid__" : "k8s-pods-jobs",
      "__panelId__" : "20",
      "summary" : "Platform deployment unavailable for ${each.key} K8S cluster.",
      "runbook_url" : "https://www.notion.so/houserx/k8s-07842a825eaa4d1c9840a218f1caf65b?pvs=4#502c46de330a44dfacd8200452fb8e4e"
    }
    labels = {
      "severity" : "1"
      "team" : "infra",
      "system" : "kubernetes",
      "environment" : each.key
      "app" : "platform"
    }

    data {
      ref_id         = "A"
      datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
      relative_time_range {
        from = 1800
        to   = 0
      }
      model = jsonencode({
        expr          = "sum by (namespace) (kube_deployment_status_replicas_unavailable{namespace=\"platform\"})"
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
  # Non-BD, non-platform replicas
  rule {
    name           = "Deployment Replicas Unavailable - ${each.key}"
    for            = "5m"
    condition      = "B"
    no_data_state  = "NoData"
    exec_err_state = "Alerting"
    is_paused      = false
    annotations = {
      "__dashboardUid__" : "k8s-pods-jobs",
      "__panelId__" : "20",
      "summary" : "Deployment unavailable for ${each.key} K8S cluster (not including 'branch-deployments' or 'platform' namespaces).",
      "runbook_url" : "https://www.notion.so/houserx/k8s-07842a825eaa4d1c9840a218f1caf65b?pvs=4#502c46de330a44dfacd8200452fb8e4e"
    }
    labels = {
      "severity" : each.key == "prod" ? "1" : "4"
      "team" : "infra",
      "system" : "kubernetes",
      "environment" : each.key
    }

    data {
      ref_id         = "A"
      datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
      relative_time_range {
        from = 1800
        to   = 0
      }
      model = jsonencode({
        expr          = "sum by (namespace) (kube_deployment_status_replicas_unavailable{namespace!=\"branch-deployments\",namespace!=\"platform\"})"
        hide          = false
        intervalMs    = 20000
        maxDataPoints = 100
        refId         = "A"
        datasource = {
          type           = local.grafana_prometheus_data_sources_env[each.key].type
          datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
        }
        dimensions = {
          namespace = "*"
        }
      })
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
  }
  # Pods Failed
  rule {
    name           = "Pods Failed - ${each.key}"
    for            = "5m"
    condition      = "B"
    no_data_state  = "NoData"
    exec_err_state = "Alerting"
    is_paused      = false
    annotations = {
      "__dashboardUid__" : "k8s-pods-jobs",
      "__panelId__" : "32",
      "summary" : "Pods are failing in the K8S ${each.key} Cluster."
    }
    labels = {
      "severity" : "1",
      "team" : "infra",
      "system" : "kubernetes",
      "environment" : each.key
    }

    data {
      ref_id         = "A"
      query_type     = ""
      datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
      relative_time_range {
        from = 1800
        to   = 0
      }
      model = jsonencode({
        expr          = "sum by (namespace) (kube_pod_status_phase{namespace=~\".*\", phase=\"Failed\"})"
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
      query_type     = ""
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
  # PVC free space
  rule {
    name           = "PVC Free Space - ${each.key}"
    for            = "15m"
    condition      = "last"
    no_data_state  = "NoData"
    exec_err_state = "Alerting"
    is_paused      = false
    annotations = {
      "description" = "Check for remaining space in Persistent Volume Claims (PVC) used by pods."
      "runbook_url" = "https://www.notion.so/houserx/k8s-07842a825eaa4d1c9840a218f1caf65b#f71fef8b14cd48c6a197b93217de34f2"
      "summary"     = "Alerts if > 80% space on a PVC is in use."
    }
    labels = {
      "severity"    = "2",
      "team"        = "infra",
      "system"      = "kubernetes",
      "environment" = each.key
    }

    data {
      ref_id         = "perc_volume_used"
      query_type     = ""
      datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
      relative_time_range {
        from = 1800
        to   = 0
      }
      model = jsonencode({
        expr          = "sum by (persistentvolumeclaim, namespace) (kubelet_volume_stats_used_bytes{persistentvolumeclaim=~\".*\", namespace=~\".*\"}/kubelet_volume_stats_capacity_bytes{persistentvolumeclaim=~\".*\", namespace=~\".*\"})"
        hide          = false
        intervalMs    = 20000
        maxDataPoints = 100
        legendFormat  = "{{ persistentvolumeclaim }} ({{ namespace }})"
        refId         = "perc_volume_used"
        datasource = {
          type           = local.grafana_prometheus_data_sources_env[each.key].type
          datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
        }
      })
    }
    data {
      ref_id         = "last"
      query_type     = ""
      datasource_uid = "-100"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        hide          = false
        intervalMs    = 1000
        maxDataPoints = 43200
        refId         = "last"
        type          = "classic_conditions"
        datasource = {
          type = "__expr__"
          uid  = "-100"
        }
        conditions = [{
          type = "query"
          evaluator = {
            params = [0.8, 0]
            type   = "gt"
          }
          operator = {
            type = "and"
          }
          query = {
            params = ["perc_volume_used"]
          }
          reducer = {
            params = []
            type   = "last"
          }
        }]
      })
    }
  }

  # IR-3093: orphaned-database sweep rules, staging only (see
  # local.orphan_db_sweep_rules). Keep this the LAST block in the group: rule
  # blocks have no state identity, so anything declared before them that grows
  # or reorders shifts later rules to new Grafana UIDs. The for-expression
  # filter (not a ternary) yields an empty list for prod and tooling, whose
  # groups plan no change.
  dynamic "rule" {
    for_each = [for r in local.orphan_db_sweep_rules : r if each.key == "staging"]
    content {
      name           = rule.value.name
      for            = rule.value.for
      condition      = "C"
      no_data_state  = rule.value.no_data_state
      exec_err_state = "Error"
      is_paused      = rule.value.is_paused
      annotations = {
        "summary"     = rule.value.summary
        "description" = rule.value.description
        "runbook_url" = "https://github.com/houserx/k8s-cluster-management/blob/main/README.md#orphaned-databases-ir-2895"
      }
      # No "team" label on purpose: team=infra routes to incident.io, whose
      # Default Route drops titles containing "staging", so nobody would see
      # these. The "system" label matches the sweep's own child policy in
      # grafana_notification_policy.tf (#infra-alerts, repeated daily).
      labels = {
        "severity"    = "4"
        "owner"       = "infra"
        "system"      = "platform-environment-sweep"
        "environment" = each.key
        "check"       = rule.value.key
      }

      data {
        ref_id         = "A"
        query_type     = ""
        datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
        relative_time_range {
          from = 600
          to   = 0
        }
        model = jsonencode({
          expr          = rule.value.expr
          hide          = false
          intervalMs    = 60000
          maxDataPoints = 43200
          refId         = "A"
          datasource = {
            type = local.grafana_prometheus_data_sources_env[each.key].type
            uid  = local.grafana_prometheus_data_sources_env[each.key].uid
          }
        })
      }
      # Reduce + threshold, not classic_conditions, so each series stays its
      # own alert instance with its labels.
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
            evaluator = { params = [rule.value.threshold], type = "gt" }
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
    }
  }
}

#####################################################################
# The rule group where the Kubernetes Node Alerts are organized in  #
#####################################################################
resource "grafana_rule_group" "node_monitoring_rule_group" {
  for_each         = toset(local.k8s_rule_group_environments)
  name             = "node_monitoring_${each.key}"
  folder_uid       = grafana_folder.this["Kubernetes"].uid
  interval_seconds = 60

  rule {
    name           = "Node Memory Pressure - ${each.key}"
    for            = "5m"
    condition      = "B"
    no_data_state  = "NoData"
    exec_err_state = "Alerting"
    is_paused      = false
    annotations = {
      "description" = "Check for memory pressure on specific nodes."
      "summary"     = "At least one node has high memory pressure in the ${each.key} K8S Cluster."
    }
    labels = {
      "severity" : "1",
      "team" : "infra",
      "system" : "kubernetes",
      "environment" : each.key
    }
    data {
      ref_id         = "A"
      query_type     = ""
      datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
      relative_time_range {
        from = 600
        to   = 0
      }
      model = jsonencode({
        expr          = "sum(kube_node_status_condition{condition=\"MemoryPressure\", status=\"true\"})"
        hide          = false
        intervalMs    = 1000
        maxDataPoints = 43200
        legendFormat  = "__auto"
        refId         = "A"
        range         = true
        datasource = {
          type           = local.grafana_prometheus_data_sources_env[each.key].type
          datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
        }
      })
    }

    data {
      ref_id         = "B"
      query_type     = ""
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

  # Node Unavailable
  # Excludes nodes cluster-autoscaler is draining for scale-down: CA cordons them
  # for up to its 10m max graceful termination, which is expected churn, not an
  # outage. Nodes cordoned manually or by a stuck upgrade still alert.
  rule {
    name           = "Node(s) Unavailable - ${each.key}"
    for            = "5m"
    condition      = "B"
    no_data_state  = "OK"
    exec_err_state = "Alerting"
    is_paused      = false
    annotations = {
      "description" = "Checks for node up/down status."
      "summary"     = "Node is unavailable in the ${each.key} K8S cluster."
    }
    labels = {
      "severity" : "1",
      "team" : "infra",
      "system" : "kubernetes",
      "environment" : each.key
    }

    data {
      ref_id         = "A"
      query_type     = ""
      datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
      relative_time_range {
        from = 600
        to   = 0
      }
      model = jsonencode({
        expr          = "sum(kube_node_spec_unschedulable unless on(node) kube_node_spec_taint{key=\"ToBeDeletedByClusterAutoscaler\"})"
        hide          = false
        intervalMs    = 1000
        maxDataPoints = 43200
        legendFormat  = "__auto"
        refId         = "A"
        range         = true
        datasource = {
          type           = local.grafana_prometheus_data_sources_env[each.key].type
          datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
        }
      })
    }

    data {
      ref_id         = "B"
      query_type     = ""
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

  # Node - Disk Pressure
  rule {
    name           = "Node - Disk Pressure - ${each.key}"
    for            = "5m"
    condition      = "B"
    no_data_state  = "NoData"
    exec_err_state = "Alerting"
    is_paused      = false
    annotations = {
      "summary" = "Kubernetes node under disk pressure in ${each.key} cluster."
    }
    labels = {
      "severity" : "1",
      "team" : "infra",
      "system" : "kubernetes",
      "environment" : each.key
    }

    data {
      ref_id         = "A"
      query_type     = ""
      datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
      relative_time_range {
        from = 600
        to   = 0
      }
      model = jsonencode({
        expr          = "sum(kube_node_status_condition{condition=\"DiskPressure\", status=\"true\"})"
        hide          = false
        intervalMs    = 1000
        maxDataPoints = 43200
        legendFormat  = "__auto"
        refId         = "A"
        range         = true
        datasource = {
          type           = local.grafana_prometheus_data_sources_env[each.key].type
          datasource_uid = local.grafana_prometheus_data_sources_env[each.key].uid
        }
      })
    }

    data {
      ref_id         = "B"
      query_type     = ""
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

resource "grafana_rule_group" "platform_container_rule_group" {
  name             = "platform"
  folder_uid       = grafana_folder.this["Kubernetes"].uid
  interval_seconds = 60

  rule {
    name      = "API Container Restarts"
    condition = "B"

    data {
      ref_id = "A"

      relative_time_range {
        from = 60
        to   = 0
      }

      datasource_uid = "tmTXpZC4k"
      model          = "{\"datasource\":{\"type\":\"prometheus\",\"uid\":\"tmTXpZC4k\"},\"editorMode\":\"code\",\"expr\":\"sum by (pod) (increase(kube_pod_container_status_restarts_total{container=\\\"platform-api\\\",namespace=\\\"platform\\\"}[2m]))\",\"instant\":false,\"interval\":\"\",\"intervalMs\":60000,\"legendFormat\":\"__auto\",\"maxDataPoints\":43200,\"range\":true,\"refId\":\"A\"}"
    }
    data {
      ref_id = "B"

      relative_time_range {
        from = 600
        to   = 0
      }

      datasource_uid = "__expr__"
      model          = "{\"conditions\":[{\"evaluator\":{\"params\":[0,0],\"type\":\"gt\"},\"operator\":{\"type\":\"and\"},\"query\":{\"params\":[\"A\"]},\"reducer\":{\"params\":[],\"type\":\"sum\"},\"type\":\"query\"}],\"datasource\":{\"name\":\"Expression\",\"type\":\"__expr__\",\"uid\":\"__expr__\"},\"expression\":\"\",\"intervalMs\":1000,\"maxDataPoints\":43200,\"refId\":\"B\",\"type\":\"classic_conditions\"}"
    }

    no_data_state  = "KeepLast"
    exec_err_state = "Error"
    annotations = {
      __dashboardUid__ = "bb74e7a0-8507-4d10-a183-807ae2380210"
      __panelId__      = "3"
      description      = "Container forcefully restarted by Kubernetes. The pod was either unable to pass initial readiness checks, or failed health checks."
      runbook_url      = "https://www.notion.so/houserx/k8s-07842a825eaa4d1c9840a218f1caf65b#f995e9fd96ca46ecb372c041d1c9ea27"
      summary          = "Platform API container forcefully restarted!"
    }
    labels = {
      channel  = "#alerts"
      severity = "2"
      team     = "engineering"
    }
    is_paused = false
  }
}

# IR-1792: demo runs in the same "houserx-websocket" namespace as staging,
# on the staging cluster - hence the staging Prometheus datasource here.
resource "grafana_rule_group" "websocket_demo_container_rule_group" {
  name             = "websocket_demo"
  folder_uid       = grafana_folder.this["Kubernetes"].uid
  interval_seconds = 60

  rule {
    name      = "Websocket Demo Container Restarts"
    condition = "B"

    data {
      ref_id = "A"

      relative_time_range {
        from = 600
        to   = 0
      }

      datasource_uid = local.grafana_prometheus_data_sources_env["staging"].uid
      model = jsonencode({
        expr          = "sum by (pod) (increase(kube_pod_container_status_restarts_total{container=\"houserx-websocket-demo\",namespace=\"houserx-websocket\"}[10m]))"
        hide          = false
        intervalMs    = 60000
        maxDataPoints = 43200
        legendFormat  = "__auto"
        range         = true
        refId         = "A"
        datasource = {
          type = "prometheus"
          uid  = local.grafana_prometheus_data_sources_env["staging"].uid
        }
      })
    }
    data {
      ref_id = "B"

      relative_time_range {
        from = 600
        to   = 0
      }

      datasource_uid = "__expr__"
      model = jsonencode({
        conditions = [{
          evaluator = { params = [1, 0], type = "gt" }
          operator  = { type = "and" }
          query     = { params = ["A"] }
          reducer   = { params = [], type = "sum" }
          type      = "query"
        }]
        datasource    = { name = "Expression", type = "__expr__", uid = "__expr__" }
        expression    = ""
        intervalMs    = 1000
        maxDataPoints = 43200
        refId         = "B"
        type          = "classic_conditions"
      })
    }

    no_data_state  = "KeepLast"
    exec_err_state = "Error"
    annotations = {
      description = "houserx-websocket-demo container restarted 2+ times in the last 10 minutes. The demo pod is crash-looping - it either crashed or failed its readiness/liveness checks repeatedly, rather than a single one-off restart."
      runbook_url = "https://www.notion.so/houserx/k8s-07842a825eaa4d1c9840a218f1caf65b#f995e9fd96ca46ecb372c041d1c9ea27"
      summary     = "houserx-websocket demo container restarted!"
    }
    labels = {
      severity    = "3"
      system      = "kubernetes"
      environment = "demo"
    }

    notification_settings {
      contact_point = grafana_contact_point.slack-infra-contact-point.name
    }

    is_paused = false
  }
}

#####################################################################
# IR-1766: Platform capacity headroom - HPA replicas / ASG nodes    #
# Production only - staging/branch-deploy traffic doesn't approach  #
# these ceilings. Thresholds are 2 units of margin below each       #
# resource's real Terraform-configured max (see global_eks.tf and   #
# hpa_patch_replicas.yaml), not independently chosen numbers - keep  #
# them in sync if those maxes change.                               #
#####################################################################
resource "grafana_rule_group" "platform_capacity_headroom" {
  name             = "platform_capacity_headroom"
  folder_uid       = grafana_folder.this["Kubernetes"].uid
  interval_seconds = 60

  rule {
    name      = "Platform HPA Near Max Replicas - prod"
    condition = "B"

    data {
      ref_id     = "A"
      query_type = ""

      relative_time_range {
        from = 600
        to   = 0
      }

      datasource_uid = "tmTXpZC4k"
      model = jsonencode({
        expr          = "max(kube_horizontalpodautoscaler_status_current_replicas{horizontalpodautoscaler=\"hpa-api\", namespace=\"platform\"})"
        hide          = false
        intervalMs    = 1000
        maxDataPoints = 43200
        legendFormat  = "__auto"
        refId         = "A"
        range         = true
        datasource = {
          type = "prometheus"
          uid  = "tmTXpZC4k"
        }
      })
    }

    data {
      ref_id         = "B"
      query_type     = ""
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
            params = [25] # maxReplicas=28 (hpa_patch_replicas.yaml) minus 2 margin - two fewer replicas than the hard ceiling
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

    no_data_state  = "NoData"
    exec_err_state = "Error"
    for            = "5m"
    annotations = {
      description = "platform-api's HPA is within 2 replicas of its configured maxReplicas (28) - no more scale-out headroom left if traffic keeps climbing."
      summary     = "Platform HPA near max replicas (prod)."
    }
    labels = {
      severity    = "2"
      team        = "infra"
      system      = "platform"
      environment = "prod"
    }
    is_paused = false
  }

  rule {
    name      = "Platform Node Group Near Max Nodes - prod"
    condition = "C"

    data {
      ref_id = "A"
      relative_time_range {
        from = 900
        to   = 0
      }
      datasource_uid = grafana_data_source.cloudwatch-production.uid
      model = jsonencode({
        dimensions = {
          # Hardcoded, not looked up dynamically: terraform-tooling's aws provider is scoped to
          # the tooling account only (allowed_account_ids in versions.tf) with no cross-account
          # alias into production, so an `aws_autoscaling_groups` data source can't reach this
          # ASG from here without adding new cross-account IAM/assume-role plumbing - out of scope
          # for this change. Matches the existing convention in this file (platform_rds_health's
          # db_instance_identifier is hardcoded the same way). If this node group is ever
          # recreated (its ASG name includes a random suffix), update this value or the alert
          # will silently stop firing.
          AutoScalingGroupName = "eks-production-eks-platform-f409d8bca6824fae040d431e5c-e8d01d10-43c0-4b3d-0744-659abac83f0e"
        }
        matchExact       = true
        metricEditorMode = 0
        metricName       = "GroupInServiceInstances"
        metricQueryType  = 0
        namespace        = "AWS/AutoScaling"
        period           = "300"
        queryMode        = "Metrics"
        refId            = "A"
        region           = local.region
        statistic        = "Average"
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
          evaluator = { params = [9], type = "gt" } # fires at 10+ in-service nodes: max_size=12 (global_eks.tf) minus 2 margin
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
    # 35m, not 5m: a platform-api rolling deploy (maxSurge 50%) holds the group at 10-12 nodes for
    # up to ~25 minutes (7 -> 12 nodes, back below 10 about 23 min later on the 2026-11-05 release),
    # which would page on every release. Sustained saturation still fires.
    for = "35m"
    annotations = {
      summary = "Platform EKS node group is within 2 nodes of its max_size (12) - the cluster autoscaler will soon be unable to add capacity for hpa-api scale-out."
    }
    labels = {
      severity    = "2"
      team        = "infra"
      system      = "platform"
      environment = "prod"
    }
    is_paused = false
  }
}
