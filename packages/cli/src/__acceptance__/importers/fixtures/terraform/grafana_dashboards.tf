#####################################################################
# Dashboards                                                        #
#####################################################################
resource "grafana_dashboard" "root_dashboard" {
  for_each    = fileset("${path.module}/grafana_config", "*.json")
  config_json = file("${path.module}/grafana_config/${each.key}")
  overwrite   = true
}

resource "grafana_dashboard" "rds_dashboard" {
  for_each    = fileset("${path.module}/grafana_config/rds", "*.json")
  config_json = file("${path.module}/grafana_config/rds/${each.key}")
  folder      = grafana_folder.this["RDS"].id
  overwrite   = true
}

resource "grafana_dashboard" "cicd_dashboard" {
  for_each    = fileset("${path.module}/grafana_config/cicd", "*.json")
  config_json = file("${path.module}/grafana_config/cicd/${each.key}")
  folder      = grafana_folder.this["CI-CD"].id
  overwrite   = true
}

resource "grafana_dashboard" "k8s_dashboard" {
  for_each    = fileset("${path.module}/grafana_config/k8s", "*.json")
  config_json = file("${path.module}/grafana_config/k8s/${each.key}")
  folder      = grafana_folder.this["Kubernetes"].id
  overwrite   = true
}

resource "grafana_dashboard" "ms_dashboard" {
  for_each    = fileset("${path.module}/grafana_config/ms", "*.json")
  config_json = file("${path.module}/grafana_config/ms/${each.key}")
  folder      = grafana_folder.this["Microservices"].id
  overwrite   = true
}

resource "grafana_dashboard" "platform_dashboard" {
  for_each    = fileset("${path.module}/grafana_config/platform", "*.json")
  config_json = file("${path.module}/grafana_config/platform/${each.key}")
  folder      = grafana_folder.this["Platform"].id
  overwrite   = true
  depends_on  = [grafana_folder.this]
}

resource "grafana_dashboard" "aws_dashboard" {
  for_each    = fileset("${path.module}/grafana_config/aws", "*.json")
  config_json = file("${path.module}/grafana_config/aws/${each.key}")
  folder      = grafana_folder.this["AWS"].id
  overwrite   = true
  depends_on  = [grafana_folder.this]
}

resource "grafana_dashboard" "vendor_dashboard" {
  for_each    = fileset("${path.module}/grafana_config/vendor", "*.json")
  config_json = file("${path.module}/grafana_config/vendor/${each.key}")
  folder      = grafana_folder.this["Vendor"].id
  overwrite   = true
  depends_on  = [grafana_folder.this]
}

resource "grafana_dashboard" "bcp_dr_dashboard" {
  for_each    = fileset("${path.module}/grafana_config/bcp-dr", "*.json")
  config_json = file("${path.module}/grafana_config/bcp-dr/${each.key}")
  folder      = grafana_folder.this["BCP/DR"].id
  overwrite   = true
  depends_on  = [grafana_folder.this]
}

resource "grafana_dashboard" "service_mesh_dashboard" {
  for_each    = fileset("${path.module}/grafana_config/mesh", "*.json")
  config_json = file("${path.module}/grafana_config/mesh/${each.key}")
  folder      = grafana_folder.this["Service Mesh"].id
  overwrite   = true
  depends_on  = [grafana_folder.this]
}
