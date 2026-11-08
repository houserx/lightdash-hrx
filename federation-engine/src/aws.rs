//! What the AWS sources (`cloudwatch`, `cloudwatch_logs`) share: the SDK configuration of a
//! source and, for `role_arn`, the credentials of the assumed role.

use std::time::Duration;

use aws_config::Region;
use engine_config::AwsSettings;

/// The default credential chain in the source's region, with the engine's connect timeout.
pub async fn shared_config(aws: &AwsSettings, connect_timeout: Duration) -> aws_config::SdkConfig {
    let timeouts = aws_config::timeout::TimeoutConfig::builder()
        .connect_timeout(connect_timeout)
        .build();
    aws_config::defaults(aws_config::BehaviorVersion::latest())
        .region(Region::new(aws.region.clone()))
        .timeout_config(timeouts)
        .load()
        .await
}

/// Credentials for `role_arn`: STS `AssumeRole` in the source's region, signed by the base
/// (default chain) credentials of `shared`, at `sts_endpoint_url` when one is set. The SDK client's
/// identity cache keeps the temporary credentials and assumes the role again before they expire.
pub async fn assume_role(
    shared: &aws_config::SdkConfig,
    role: &str,
    aws: &AwsSettings,
) -> aws_config::sts::AssumeRoleProvider {
    let mut sts = shared.to_builder();
    if let Some(url) = &aws.sts_endpoint_url {
        // Programmatic origin, or the STS client prefers AWS_ENDPOINT_URL(_STS) from the env.
        sts.set_endpoint_url(Some(url.clone()));
        sts.insert_origin("endpoint_url", aws_types::origin::Origin::shared_config());
    }
    aws_config::sts::AssumeRoleProvider::builder(role)
        .session_name("federation-engine")
        .configure(&sts.build())
        .build()
        .await
}
