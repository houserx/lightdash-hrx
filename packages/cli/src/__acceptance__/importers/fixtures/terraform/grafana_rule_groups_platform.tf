#####################################################################
# The rule group where the Platform Feature Alerts are organized in #
#####################################################################

resource "grafana_rule_group" "dialpad_documo_rule_group" {
  name             = "dialpad_failure_group"
  folder_uid       = "osP4qAHIk"
  interval_seconds = 60

  rule {
    name      = "Dialpad Bad Webhook Requests"
    condition = "C"

    data {
      ref_id = "A"

      relative_time_range {
        from = 63469
        to   = 63195
      }

      datasource_uid = "tmTXpZC4k"
      model          = "{\"adhocFilters\":[],\"datasource\":{\"type\":\"prometheus\",\"uid\":\"tmTXpZC4k\"},\"disableTextWrap\":false,\"editorMode\":\"code\",\"expr\":\"increase(hrx_dialpad_message_webhook_bad_status_received_total[1m])\",\"fullMetaSearch\":false,\"includeNullMetadata\":true,\"instant\":false,\"interval\":\"\",\"intervalMs\":5000,\"legendFormat\":\"{{pod}}\",\"maxDataPoints\":43200,\"range\":true,\"refId\":\"A\",\"useBackend\":false}"
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
      model          = "{\"conditions\":[{\"evaluator\":{\"params\":[0],\"type\":\"gt\"},\"operator\":{\"type\":\"and\"},\"query\":{\"params\":[\"C\"]},\"reducer\":{\"params\":[],\"type\":\"last\"},\"type\":\"query\"}],\"datasource\":{\"type\":\"__expr__\",\"uid\":\"__expr__\"},\"expression\":\"B\",\"intervalMs\":1000,\"maxDataPoints\":43200,\"refId\":\"C\",\"type\":\"threshold\"}"
    }

    no_data_state  = "NoData"
    exec_err_state = "Error"
    annotations = {
      __dashboardUid__ = "cebh7zn4qu22oc"
      __panelId__      = "8"
    }

    labels = {
      environment = "prod"
      severity    = "4"
      system      = "platform"
      team        = "Support"
    }

    is_paused = true

    # notification_settings {
    #   contact_point = null
    #   group_by      = null
    #   mute_timings  = null
    # }
  }
  rule {
    name      = "Dialpad Error Logs"
    condition = "B"

    data {
      ref_id     = "A"
      query_type = "range"

      relative_time_range {
        from = 60
        to   = 0
      }

      datasource_uid = "GA4WkvzSz"
      model          = "{\"datasource\":{\"type\":\"loki\",\"uid\":\"GA4WkvzSz\"},\"editorMode\":\"builder\",\"expr\":\"count by(service_name) (rate({service_name=\\\"platform-api\\\"} |= `dialpad-webhook-error` or `dialpad-error` [$__auto]))\",\"intervalMs\":1000,\"maxDataPoints\":500,\"queryType\":\"range\",\"refId\":\"A\"}"
    }
    data {
      ref_id = "D"

      relative_time_range {
        from = 0
        to   = 0
      }

      datasource_uid = "__expr__"
      model          = "{\"conditions\":[{\"evaluator\":{\"params\":[0,0],\"type\":\"gt\"},\"operator\":{\"type\":\"and\"},\"query\":{\"params\":[]},\"reducer\":{\"params\":[],\"type\":\"avg\"},\"type\":\"query\"}],\"datasource\":{\"name\":\"Expression\",\"type\":\"__expr__\",\"uid\":\"__expr__\"},\"expression\":\"A\",\"intervalMs\":1000,\"maxDataPoints\":43200,\"reducer\":\"count\",\"refId\":\"D\",\"settings\":{\"mode\":\"replaceNN\",\"replaceWithValue\":0},\"type\":\"reduce\"}"
    }
    data {
      ref_id = "B"

      relative_time_range {
        from = 0
        to   = 0
      }

      datasource_uid = "__expr__"
      model          = "{\"conditions\":[{\"evaluator\":{\"params\":[0,0],\"type\":\"gt\"},\"operator\":{\"type\":\"and\"},\"query\":{\"params\":[]},\"reducer\":{\"params\":[],\"type\":\"avg\"},\"type\":\"query\"}],\"datasource\":{\"name\":\"Expression\",\"type\":\"__expr__\",\"uid\":\"__expr__\"},\"expression\":\"D\",\"intervalMs\":1000,\"maxDataPoints\":43200,\"refId\":\"B\",\"type\":\"threshold\"}"
    }

    no_data_state  = "OK"
    exec_err_state = "Error"
    annotations = {
      __dashboardUid__ = "eepgbzfg5g4jka"
      __panelId__      = "10"
      description      = "This alert rule monitors the platform's logs for instances of failures from the DialPad API for telephonic features."
      runbook_url      = "https://docs.google.com/document/d/1Jgc-wahcJKKJjXxxLXGN91iT_w40ubk0mejqisz8QLk/edit?tab=t.0#heading=h.ksd7zdei95t1"
      summary          = "Dialpad error has been logged in the platform."
    }
    labels = {
      environment = "prod"
      severity    = "4"
      system      = "platform"
      team        = "Support"
    }
    is_paused = true

    # notification_settings {
    #   contact_point = null
    #   group_by      = null
    #   mute_timings  = null
    # }
  }
  rule {
    name      = "Documo Error Logs"
    condition = "C"

    data {
      ref_id     = "A"
      query_type = "range"

      relative_time_range {
        from = 60
        to   = 0
      }

      datasource_uid = "GA4WkvzSz"
      model          = "{\"datasource\":{\"type\":\"loki\",\"uid\":\"GA4WkvzSz\"},\"editorMode\":\"builder\",\"expr\":\"count by(service_name) (rate({service_name=\\\"platform-api\\\"} |= `fax-webhook-error` [$__auto]))\",\"intervalMs\":1000,\"maxDataPoints\":43200,\"queryType\":\"range\",\"refId\":\"A\"}"
    }
    data {
      ref_id = "B"

      relative_time_range {
        from = 0
        to   = 0
      }

      datasource_uid = "__expr__"
      model          = "{\"conditions\":[{\"evaluator\":{\"params\":[],\"type\":\"gt\"},\"operator\":{\"type\":\"and\"},\"query\":{\"params\":[\"B\"]},\"reducer\":{\"params\":[],\"type\":\"last\"},\"type\":\"query\"}],\"datasource\":{\"type\":\"__expr__\",\"uid\":\"__expr__\"},\"expression\":\"A\",\"intervalMs\":1000,\"maxDataPoints\":43200,\"reducer\":\"count\",\"refId\":\"B\",\"settings\":{\"mode\":\"replaceNN\",\"replaceWithValue\":0},\"type\":\"reduce\"}"
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

    no_data_state  = "OK"
    exec_err_state = "Error"
    annotations = {
      __dashboardUid__ = "eepgbzfg5g4jka"
      __panelId__      = "11"
      description      = "This alert rule monitors the platform's logs for instances of failures from the Documo API for faxing features."
      runbook_url      = "https://docs.google.com/document/d/1Jgc-wahcJKKJjXxxLXGN91iT_w40ubk0mejqisz8QLk/edit?tab=t.0#heading=h.ksd7zdei95t1"
      summary          = "Documo error has been logged in the platform."
    }
    labels = {
      environment = "prod"
      severity    = "4"
      system      = "platform"
      team        = "Support"
    }
    is_paused = true

    # notification_settings {
    #   contact_point = null
    #   group_by      = null
    #   mute_timings  = null
    # }
  }
}
