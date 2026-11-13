//! BigQuery bearer tokens through GCP workload identity federation from the engine's AWS identity
//! (ADR 0002: no GCP key is stored in AWS).
//!
//! 1. A `GetCallerIdentity` request to AWS STS is signed (SigV4) with the default AWS credential
//!    chain, but not sent: it is serialized as GCP's `aws4_request` subject token, with
//!    `x-goog-cloud-target-resource` set to the workload identity provider (`audience`).
//! 2. GCP STS (`sts_url`) exchanges it for a federated access token.
//! 3. IAM Credentials `generateAccessToken` (`iam_credentials_url`) turns the federated token into
//!    an access token of `service_account`, the one BigQuery calls carry.
//!
//! The service-account token is cached until shortly before its `expireTime`. One refresh runs at
//! a time, so concurrent queries never exchange twice.

use std::time::{Duration, SystemTime};

use aws_credential_types::provider::ProvideCredentials;
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, OnceCell};

/// A cached token is renewed this long before it expires.
const REFRESH_MARGIN: Duration = Duration::from_secs(300);
/// The scope the service-account token is issued for.
const BIGQUERY_SCOPE: &str = "https://www.googleapis.com/auth/bigquery";
/// The scope of the federated token (what GCP STS documents for impersonation).
const CLOUD_PLATFORM_SCOPE: &str = "https://www.googleapis.com/auth/cloud-platform";
/// Region of the signed `GetCallerIdentity` request when the AWS chain names none.
const DEFAULT_REGION: &str = "us-east-1";

/// One source's workload identity federation settings and its cached token.
#[derive(Debug)]
pub struct WorkloadIdentity {
    audience: String,
    service_account: String,
    sts_url: String,
    iam_credentials_url: String,
    aws: OnceCell<aws_config::SdkConfig>,
    cached: Mutex<Option<(String, SystemTime)>>,
}

impl WorkloadIdentity {
    pub fn new(
        audience: &str,
        service_account: &str,
        sts_url: &str,
        iam_credentials_url: &str,
    ) -> WorkloadIdentity {
        WorkloadIdentity {
            audience: audience.to_string(),
            service_account: service_account.to_string(),
            sts_url: sts_url.to_string(),
            iam_credentials_url: iam_credentials_url.to_string(),
            aws: OnceCell::new(),
            cached: Mutex::new(None),
        }
    }

    /// The service account's access token: cached, or a fresh exchange.
    pub async fn token(&self, http: &reqwest::Client) -> Result<String, String> {
        let mut cached = self.cached.lock().await;
        if let Some((token, expires)) = cached.as_ref()
            && SystemTime::now() + REFRESH_MARGIN < *expires
        {
            return Ok(token.clone());
        }
        let federated = self.federated_token(http).await?;
        let (token, expires) = self.impersonate(http, &federated).await?;
        *cached = Some((token.clone(), expires));
        Ok(token)
    }

    /// GCP STS: the signed `GetCallerIdentity` request for a federated access token.
    async fn federated_token(&self, http: &reqwest::Client) -> Result<String, String> {
        let subject = self.subject_token().await?;
        let form = [
            (
                "grant_type",
                "urn:ietf:params:oauth:grant-type:token-exchange",
            ),
            ("audience", self.audience.as_str()),
            ("scope", CLOUD_PLATFORM_SCOPE),
            (
                "requested_token_type",
                "urn:ietf:params:oauth:token-type:access_token",
            ),
            (
                "subject_token_type",
                "urn:ietf:params:aws:token-type:aws4_request",
            ),
            ("subject_token", subject.as_str()),
        ];
        let answer = send(
            "GCP STS token exchange",
            http.post(&self.sts_url).form(&form),
        )
        .await?;
        answer["access_token"]
            .as_str()
            .filter(|t| !t.is_empty())
            .map(str::to_string)
            .ok_or_else(|| "GCP STS token exchange: the answer has no access_token".to_string())
    }

    /// IAM Credentials `generateAccessToken` for the service account, with its expiry.
    async fn impersonate(
        &self,
        http: &reqwest::Client,
        federated: &str,
    ) -> Result<(String, SystemTime), String> {
        let mut url = reqwest::Url::parse(&self.iam_credentials_url)
            .map_err(|e| format!("gcp_iam_credentials_url is not a URL: {e}"))?;
        url.path_segments_mut()
            .map_err(|()| "gcp_iam_credentials_url cannot take a path".to_string())?
            .pop_if_empty()
            .extend([
                "v1",
                "projects",
                "-",
                "serviceAccounts",
                &format!("{}:generateAccessToken", self.service_account),
            ]);
        let request = http
            .post(url)
            .bearer_auth(federated)
            .json(&json!({"scope": [BIGQUERY_SCOPE]}));
        let answer = send("generateAccessToken", request).await?;
        let token = answer["accessToken"]
            .as_str()
            .filter(|t| !t.is_empty())
            .ok_or("generateAccessToken: the answer has no accessToken")?;
        let expires = answer["expireTime"]
            .as_str()
            .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
            .ok_or("generateAccessToken: the answer has no valid expireTime")?;
        Ok((
            token.to_string(),
            SystemTime::from(expires.with_timezone(&Utc)),
        ))
    }

    /// The `aws4_request` subject token: a `GetCallerIdentity` request signed with the default AWS
    /// credential chain, serialized as JSON and percent-encoded.
    async fn subject_token(&self) -> Result<String, String> {
        let aws = self
            .aws
            .get_or_init(|| aws_config::defaults(aws_config::BehaviorVersion::latest()).load())
            .await;
        let provider = aws
            .credentials_provider()
            .ok_or("no AWS credentials provider for workload identity federation")?;
        let creds = provider.provide_credentials().await.map_err(|e| {
            format!("cannot load AWS credentials for workload identity federation: {e}")
        })?;
        let region = aws.region().map_or(DEFAULT_REGION, |r| r.as_ref());
        let request = signed_get_caller_identity(
            &AwsKey {
                id: creds.access_key_id(),
                secret: creds.secret_access_key(),
                session_token: creds.session_token(),
            },
            region,
            &self.audience,
            Utc::now(),
        );
        Ok(percent_encode(&request.to_string()))
    }
}

/// Sends one call and returns its JSON answer; a non-2xx answer is an error with its message.
async fn send(what: &str, request: reqwest::RequestBuilder) -> Result<Value, String> {
    let response = request
        .send()
        .await
        .map_err(|e| format!("{what}: unreachable: {e}"))?;
    let status = response.status();
    let body = response
        .bytes()
        .await
        .map_err(|e| format!("{what}: reading the response failed: {e}"))?;
    let answer: Value = serde_json::from_slice(&body)
        .map_err(|_| format!("{what}: HTTP {status} with a response that is not JSON"))?;
    if !status.is_success() {
        let message = answer["error_description"]
            .as_str()
            .or_else(|| answer["error"]["message"].as_str())
            .or_else(|| answer["error"].as_str())
            .unwrap_or("no error message");
        return Err(format!("{what}: HTTP {status}: {message}"));
    }
    Ok(answer)
}

struct AwsKey<'a> {
    id: &'a str,
    secret: &'a str,
    session_token: Option<&'a str>,
}

/// GCP's serialized form of a SigV4-signed `POST` to AWS STS `GetCallerIdentity`:
/// `{"url", "method", "headers": [{"key", "value"}...]}`.
fn signed_get_caller_identity(
    key: &AwsKey<'_>,
    region: &str,
    audience: &str,
    now: DateTime<Utc>,
) -> Value {
    let host = format!("sts.{region}.amazonaws.com");
    let query = "Action=GetCallerIdentity&Version=2011-06-15";
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date = now.format("%Y%m%d").to_string();
    // Lowercase names, sorted: the canonical header order.
    let mut headers: Vec<(&str, String)> =
        vec![("host", host.clone()), ("x-amz-date", amz_date.clone())];
    if let Some(token) = key.session_token {
        headers.push(("x-amz-security-token", token.to_string()));
    }
    headers.push(("x-goog-cloud-target-resource", audience.to_string()));
    let signed_headers = headers
        .iter()
        .map(|(k, _)| *k)
        .collect::<Vec<_>>()
        .join(";");
    let canonical_headers: String = headers
        .iter()
        .map(|(k, v)| format!("{k}:{}\n", v.trim()))
        .collect();
    let canonical_request = format!(
        "POST\n/\n{query}\n{canonical_headers}\n{signed_headers}\n{}",
        hex::encode(Sha256::digest(b""))
    );
    let scope = format!("{date}/{region}/sts/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        hex::encode(Sha256::digest(canonical_request.as_bytes()))
    );
    let mut signing_key = hmac(format!("AWS4{}", key.secret).as_bytes(), date.as_bytes());
    for part in [region, "sts", "aws4_request"] {
        signing_key = hmac(&signing_key, part.as_bytes());
    }
    let signature = hex::encode(hmac(&signing_key, string_to_sign.as_bytes()));
    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
        key.id
    );
    let mut out = vec![json!({"key": "Authorization", "value": authorization})];
    out.extend(
        headers
            .into_iter()
            .map(|(k, v)| json!({"key": k, "value": v})),
    );
    json!({
        "url": format!("https://{host}/?{query}"),
        "method": "POST",
        "headers": out,
    })
}

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC takes a key of any length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// RFC 3986 percent-encoding: everything but unreserved characters.
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// AWS's published SigV4 example key (docs.aws.amazon.com), not a real credential.
    const KEY: AwsKey<'static> = AwsKey {
        id: "AKIDEXAMPLE",
        secret: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        session_token: None,
    };

    fn header<'a>(request: &'a Value, name: &str) -> Option<&'a str> {
        request["headers"]
            .as_array()?
            .iter()
            .find(|h| h["key"].as_str() == Some(name))?["value"]
            .as_str()
    }

    #[test]
    fn get_caller_identity_is_signed_for_the_audience() {
        let now = DateTime::parse_from_rfc3339("2015-08-30T12:36:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let r = signed_get_caller_identity(&KEY, "us-east-2", "//iam.example/aud", now);
        assert_eq!(
            r["url"],
            "https://sts.us-east-2.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15"
        );
        assert_eq!(r["method"], "POST");
        assert_eq!(
            header(&r, "x-goog-cloud-target-resource"),
            Some("//iam.example/aud")
        );
        assert_eq!(header(&r, "x-amz-date"), Some("20150830T123600Z"));
        assert_eq!(header(&r, "host"), Some("sts.us-east-2.amazonaws.com"));
        assert_eq!(header(&r, "x-amz-security-token"), None);
        let auth = header(&r, "Authorization").unwrap();
        assert!(
            auth.starts_with(
                "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-2/sts/aws4_request, SignedHeaders=host;x-amz-date;x-goog-cloud-target-resource, Signature="
            ),
            "{auth}"
        );
        // Deterministic for the same input; a session token is signed too.
        assert_eq!(
            r,
            signed_get_caller_identity(&KEY, "us-east-2", "//iam.example/aud", now)
        );
        let with_token = AwsKey {
            session_token: Some("session"),
            ..KEY
        };
        let r = signed_get_caller_identity(&with_token, "us-east-2", "//iam.example/aud", now);
        assert_eq!(header(&r, "x-amz-security-token"), Some("session"));
        assert!(header(&r, "Authorization").unwrap().contains(
            "SignedHeaders=host;x-amz-date;x-amz-security-token;x-goog-cloud-target-resource,"
        ));
    }

    #[test]
    fn signing_key_matches_the_aws_example() {
        // docs.aws.amazon.com "Examples of how to derive a signing key for Signature Version 4".
        let mut k = hmac(b"AWS4wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", b"20120215");
        for part in ["us-east-1", "iam", "aws4_request"] {
            k = hmac(&k, part.as_bytes());
        }
        assert_eq!(
            hex::encode(k),
            "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d"
        );
    }

    #[test]
    fn percent_encoding_keeps_only_unreserved() {
        assert_eq!(percent_encode("a-b.c_d~e"), "a-b.c_d~e");
        assert_eq!(
            percent_encode("{\"k\": \"/x?y=1&z\"}"),
            "%7B%22k%22%3A%20%22%2Fx%3Fy%3D1%26z%22%7D"
        );
    }
}
