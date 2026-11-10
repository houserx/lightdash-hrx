locals {
  folders = ["Platform", "AWS", "Vendor", "CI-CD", "Kubernetes", "Microservices", "RDS", "BCP/DR", "Service Mesh"]
}

resource "grafana_folder" "this" {
  for_each = toset(local.folders)
  title    = each.key
}

# For now, permission these individually in case they may vary.
# Leave 'Viewer' out as a work-around to lack of OSS Grafana having proper
# roles and permissioning. Anyone who should have access to *actually* view
# can be added as an editor instead, since logging in via GAuth automatically assigns Viewer.
resource "grafana_folder_permission" "cicd_folder_permission" {
  folder_uid = grafana_folder.this["CI-CD"].uid
  permissions {
    role       = "Editor"
    permission = "Edit"
  }
  permissions {
    role       = "Viewer"
    permission = "View"
  }
}

resource "grafana_folder_permission" "k8s_folder_permission" {
  folder_uid = grafana_folder.this["Kubernetes"].uid
  permissions {
    role       = "Editor"
    permission = "Edit"
  }
  permissions {
    role       = "Viewer"
    permission = "View"
  }
}

resource "grafana_folder_permission" "ms_folder_permission" {
  folder_uid = grafana_folder.this["Microservices"].uid
  permissions {
    role       = "Editor"
    permission = "Edit"
  }
}

resource "grafana_folder_permission" "rds_folder_permission" {
  folder_uid = grafana_folder.this["RDS"].uid
  permissions {
    role       = "Editor"
    permission = "Edit"
  }
  permissions {
    role       = "Viewer"
    permission = "View"
  }
}

# Envoy Gateway (ingress/mesh data plane) + SPIRE (workload identity) dashboards.
resource "grafana_folder_permission" "service_mesh_folder_permission" {
  folder_uid = grafana_folder.this["Service Mesh"].uid
  permissions {
    role       = "Editor"
    permission = "Edit"
  }
  permissions {
    role       = "Viewer"
    permission = "View"
  }
}
