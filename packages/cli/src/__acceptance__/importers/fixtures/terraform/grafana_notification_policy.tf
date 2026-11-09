#####################################################################
# Sets notification policies to tie alerts to contact points        #
#####################################################################

resource "grafana_notification_policy" "notification_policy" {
  group_by = ["..."] # group by all labels, i.e. no grouping
  # default contact point if no policy rules are matched
  contact_point   = grafana_contact_point.slack-infra-contact-point.name
  group_wait      = "5s"
  group_interval  = "2m"
  repeat_interval = "1h"

  # For testing alerts, NOT QA team
  policy {
    matcher {
      label = "team"
      match = "="
      value = "test"
    }
    contact_point = grafana_contact_point.slack-test-contact-point.name
    group_by      = ["..."]
    continue      = true

    group_wait      = "5s"
    group_interval  = "2m"
    repeat_interval = "1d"
  }

  # General Eng #alerts policy
  policy {
    matcher {
      label = "team"
      match = "="
      value = "engineering"
    }
    matcher {
      label = "channel"
      match = "="
      value = "#alerts"
    }
    contact_point = grafana_contact_point.slack-alert-contact-point.name
    group_by      = ["..."]
    continue      = true

    group_wait      = "5s"
    group_interval  = "1m"
    repeat_interval = "1m"
  }

  # Infra team
  policy {
    matcher {
      label = "team"
      match = "="
      value = "infra"
    }
    contact_point = grafana_contact_point.incident-io_default.name
    group_by      = ["..."]
    continue      = true

    group_wait      = "5s"
    group_interval  = "2m"
    repeat_interval = "1d"
  }

  # SWAT team - #alerts-swat (SWA-1657 PA Renewal Health)
  policy {
    matcher {
      label = "team"
      match = "="
      value = "swat"
    }
    contact_point = grafana_contact_point.slack-swat-contact-point.name
    group_by      = ["..."]
    continue      = true

    group_wait      = "5s"
    group_interval  = "2m"
    repeat_interval = "1d"
  }

  # IR-3093: orphaned PlatformEnvironment database sweep (staging). Its rules
  # carry no "team" label, because team=infra goes to incident.io, whose
  # Default Route drops "staging" titles. This sends them to #infra-alerts like
  # the root default, but repeats daily instead of hourly: a failed weekly
  # sweep stays failed for up to 6 days and is low urgency.
  policy {
    matcher {
      label = "system"
      match = "="
      value = "platform-environment-sweep"
    }
    contact_point = grafana_contact_point.slack-infra-contact-point.name
    group_by      = ["..."]

    group_wait      = "5s"
    group_interval  = "2m"
    repeat_interval = "1d"
  }
}
