//! AWS service mocks over `MockServer`: DynamoDB + S3 (the audit store), CloudWatch
//! `GetMetricData`, CloudWatch Logs Insights, and STS `AssumeRole`.
//!
//! Requests are decoded from whichever protocol the SDK speaks: Smithy RPC v2 CBOR
//! (`/service/<Svc>/operation/<Op>`), AWS JSON 1.0/1.1 (`X-Amz-Target: <Svc>.<Op>`), or the AWS
//! query protocol (form-encoded `Action=<Op>`). Replies are encoded in the same protocol. Within
//! a JSON value, `{"$timestamp": <epoch seconds>}` marks a timestamp (CBOR tag 1, a JSON number,
//! or ISO-8601 in XML).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use serde_json::{Map, Value, json};

use super::mock_http::{MockServer, Recorded, Reply};

pub const AUDIT_TABLE: &str = "db-query-portal-executions";
pub const AUDIT_BUCKET: &str = "db-query-portal-audit";

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Proto {
    Cbor,
    Json(&'static str),
    Query,
}

#[derive(Clone, Debug)]
pub struct AwsCall {
    pub service: String,
    pub operation: String,
    pub input: Value,
    pub proto: Proto,
    pub request: Recorded,
}

/// Decodes an AWS RPC-style request. Returns None for REST-style calls (S3).
pub fn decode(r: &Recorded) -> Option<AwsCall> {
    if let Some(rest) = r.path.strip_prefix("/service/") {
        let mut it = rest.split('/');
        let service = it.next()?.to_string();
        let _ = it.next();
        let operation = it.next()?.to_string();
        let input = if r.body.is_empty() {
            json!({})
        } else {
            let v: ciborium::Value =
                ciborium::de::from_reader(r.body.as_slice()).expect("CBOR request body");
            cbor_to_json(&v)
        };
        return Some(AwsCall {
            service,
            operation,
            input,
            proto: Proto::Cbor,
            request: r.clone(),
        });
    }
    if let Some(target) = r.header("x-amz-target") {
        let (service, operation) = target.split_once('.')?;
        let ct = r.header("content-type").unwrap_or("");
        let proto = if ct.contains("1.1") {
            Proto::Json("application/x-amz-json-1.1")
        } else {
            Proto::Json("application/x-amz-json-1.0")
        };
        let input = if r.body.is_empty() {
            json!({})
        } else {
            r.json()
        };
        return Some(AwsCall {
            service: service.into(),
            operation: operation.into(),
            input,
            proto,
            request: r.clone(),
        });
    }
    let form = r.form();
    if let Some((_, action)) = form.iter().find(|(k, _)| k == "Action") {
        let mut m = Map::new();
        for (k, v) in &form {
            m.insert(k.clone(), json!(v));
        }
        return Some(AwsCall {
            service: String::new(),
            operation: action.clone(),
            input: Value::Object(m),
            proto: Proto::Query,
            request: r.clone(),
        });
    }
    None
}

pub fn cbor_to_json(v: &ciborium::Value) -> Value {
    use ciborium::Value as C;
    match v {
        C::Integer(i) => {
            let n: i128 = (*i).into();
            json!(n as i64)
        }
        C::Float(f) => json!(f),
        C::Bool(b) => json!(b),
        C::Null => Value::Null,
        C::Text(s) => json!(s),
        C::Bytes(b) => json!(base64::engine::general_purpose::STANDARD.encode(b)),
        C::Array(a) => Value::Array(a.iter().map(cbor_to_json).collect()),
        C::Map(m) => {
            let mut o = Map::new();
            for (k, v) in m {
                let key = match k {
                    C::Text(s) => s.clone(),
                    other => format!("{other:?}"),
                };
                o.insert(key, cbor_to_json(v));
            }
            Value::Object(o)
        }
        C::Tag(_, inner) => cbor_to_json(inner),
        _ => Value::Null,
    }
}

pub fn json_to_cbor(v: &Value) -> ciborium::Value {
    use ciborium::Value as C;
    match v {
        Value::Null => C::Null,
        Value::Bool(b) => C::Bool(*b),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                C::Integer(i.into())
            } else {
                C::Float(n.as_f64().unwrap())
            }
        }
        Value::String(s) => C::Text(s.clone()),
        Value::Array(a) => C::Array(a.iter().map(json_to_cbor).collect()),
        Value::Object(o) => {
            if let Some(ts) = o.get("$timestamp") {
                return C::Tag(1, Box::new(C::Float(ts.as_f64().unwrap())));
            }
            C::Map(
                o.iter()
                    .map(|(k, v)| (C::Text(k.clone()), json_to_cbor(v)))
                    .collect(),
            )
        }
    }
}

/// Replaces `{"$timestamp": s}` by epoch seconds.
pub fn json_plain(v: &Value) -> Value {
    match v {
        Value::Array(a) => Value::Array(a.iter().map(json_plain).collect()),
        Value::Object(o) => {
            if let Some(ts) = o.get("$timestamp") {
                return ts.clone();
            }
            Value::Object(o.iter().map(|(k, v)| (k.clone(), json_plain(v))).collect())
        }
        other => other.clone(),
    }
}

/// Encodes a successful reply in the caller's protocol (not for the query protocol).
pub fn reply(call: &AwsCall, out: &Value) -> Reply {
    match call.proto {
        Proto::Cbor => {
            let mut buf = vec![];
            ciborium::ser::into_writer(&json_to_cbor(out), &mut buf).unwrap();
            Reply::new(200, "application/cbor", buf).header("smithy-protocol", "rpc-v2-cbor")
        }
        Proto::Json(ct) => Reply::new(200, ct, serde_json::to_vec(&json_plain(out)).unwrap()),
        Proto::Query => panic!("query-protocol replies are built per operation"),
    }
}

/// Encodes a modelled error (`code` e.g. "AccessDeniedException"), not retried by the SDK.
pub fn error_reply(call: &AwsCall, status: u16, code: &str, message: &str) -> Reply {
    match call.proto {
        Proto::Cbor => {
            let mut buf = vec![];
            ciborium::ser::into_writer(
                &json_to_cbor(&json!({"__type": code, "message": message})),
                &mut buf,
            )
            .unwrap();
            Reply::new(status, "application/cbor", buf).header("smithy-protocol", "rpc-v2-cbor")
        }
        Proto::Json(ct) => Reply::new(
            status,
            ct,
            serde_json::to_vec(&json!({"__type": code, "message": message})).unwrap(),
        )
        .header("x-amzn-errortype", code),
        Proto::Query => Reply::new(
            status,
            "text/xml",
            format!(
                "<ErrorResponse><Error><Type>Sender</Type><Code>{code}</Code><Message>{message}</Message></Error><RequestId>mock</RequestId></ErrorResponse>"
            ),
        ),
    }
}

// ---------------------------------------------------------------------------------------------
// DynamoDB attribute values
// ---------------------------------------------------------------------------------------------

/// DynamoDB AttributeValue map -> plain JSON (N becomes a number).
pub fn unmarshal_item(item: &Value) -> Value {
    let mut o = Map::new();
    for (k, v) in item.as_object().expect("item is a map") {
        o.insert(k.clone(), unmarshal_attr(v));
    }
    Value::Object(o)
}

pub fn unmarshal_attr(v: &Value) -> Value {
    let (t, x) = v
        .as_object()
        .and_then(|o| o.iter().next())
        .expect("attribute value");
    match t.as_str() {
        "S" => x.clone(),
        "N" => {
            let s = x.as_str().unwrap();
            s.parse::<i64>()
                .map(|i| json!(i))
                .unwrap_or_else(|_| json!(s.parse::<f64>().unwrap()))
        }
        "BOOL" => x.clone(),
        "NULL" => Value::Null,
        "M" => unmarshal_item(x),
        "L" => Value::Array(x.as_array().unwrap().iter().map(unmarshal_attr).collect()),
        "SS" | "NS" => x.clone(),
        other => panic!("unsupported attribute type {other}"),
    }
}

pub fn marshal_attr(v: &Value) -> Value {
    match v {
        Value::Null => json!({"NULL": true}),
        Value::Bool(b) => json!({"BOOL": b}),
        Value::Number(n) => json!({"N": n.to_string()}),
        Value::String(s) => json!({"S": s}),
        Value::Array(a) => json!({"L": a.iter().map(marshal_attr).collect::<Vec<_>>()}),
        Value::Object(o) => {
            json!({"M": o.iter().map(|(k, v)| (k.clone(), marshal_attr(v))).collect::<Map<_, _>>()})
        }
    }
}

pub fn marshal_item(v: &Value) -> Value {
    Value::Object(
        v.as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), marshal_attr(v)))
            .collect(),
    )
}

// ---------------------------------------------------------------------------------------------
// The audit store: DynamoDB `executions` table + S3 Object Lock bucket on one mock server.
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct S3Put {
    pub bucket: String,
    pub key: String,
    pub body: Vec<u8>,
    pub headers: Vec<(String, String)>,
}

impl S3Put {
    pub fn header(&self, n: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == n)
            .map(|(_, v)| v.as_str())
    }
}

#[derive(Default)]
pub struct AuditState {
    /// Items in insertion order (plain JSON).
    pub items: Vec<Value>,
    /// Raw PutItem inputs (TableName, Item, ConditionExpression, ...).
    pub put_inputs: Vec<Value>,
    /// Raw Query inputs.
    pub query_inputs: Vec<Value>,
    pub s3_puts: Vec<S3Put>,
    pub fail_dynamo: bool,
    pub fail_s3: bool,
}

pub struct AuditStore {
    pub server: MockServer,
    pub state: Arc<Mutex<AuditState>>,
}

impl AuditStore {
    pub async fn start() -> AuditStore {
        let state = Arc::new(Mutex::new(AuditState::default()));
        let st = state.clone();
        let server = MockServer::start(move |r| handle_audit(r, &st)).await;
        AuditStore { server, state }
    }
    pub fn url(&self) -> String {
        self.server.url()
    }
    pub fn items(&self) -> Vec<Value> {
        self.state.lock().unwrap().items.clone()
    }
    pub fn put_inputs(&self) -> Vec<Value> {
        self.state.lock().unwrap().put_inputs.clone()
    }
    pub fn query_inputs(&self) -> Vec<Value> {
        self.state.lock().unwrap().query_inputs.clone()
    }
    pub fn s3_puts(&self) -> Vec<S3Put> {
        self.state.lock().unwrap().s3_puts.clone()
    }
    pub fn fail_dynamo(&self, on: bool) {
        self.state.lock().unwrap().fail_dynamo = on;
    }
    pub fn fail_s3(&self, on: bool) {
        self.state.lock().unwrap().fail_s3 = on;
    }
    /// Seeds an item directly (for audit browser tests).
    pub fn seed(&self, item: Value) {
        self.state.lock().unwrap().items.push(item);
    }
}

fn handle_audit(r: &Recorded, st: &Arc<Mutex<AuditState>>) -> Reply {
    if let Some(call) = decode(r) {
        let mut s = st.lock().unwrap();
        match call.operation.as_str() {
            "PutItem" => {
                if s.fail_dynamo {
                    return error_reply(
                        &call,
                        400,
                        "AccessDeniedException",
                        "mock audit store refuses writes",
                    );
                }
                assert_eq!(
                    call.input["TableName"],
                    json!(AUDIT_TABLE),
                    "audit table name"
                );
                s.put_inputs.push(call.input.clone());
                let item = unmarshal_item(&call.input["Item"]);
                let id = item["id"].clone();
                if s.items.iter().any(|i| i["id"] == id) {
                    return error_reply(
                        &call,
                        400,
                        "ConditionalCheckFailedException",
                        "The conditional request failed",
                    );
                }
                s.items.push(item);
                reply(&call, &json!({}))
            }
            "Query" => {
                s.query_inputs.push(call.input.clone());
                let out = run_query(&s.items, &call.input);
                reply(&call, &out)
            }
            other => error_reply(
                &call,
                400,
                "UnknownOperationException",
                &format!("mock does not implement {other}"),
            ),
        }
    } else if r.method == "PUT" {
        let mut s = st.lock().unwrap();
        if s.fail_s3 {
            return Reply::new(
                403,
                "application/xml",
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Error><Code>AccessDenied</Code><Message>mock audit bucket refuses writes</Message><RequestId>mock</RequestId></Error>",
            );
        }
        let path = r.path.trim_start_matches('/');
        let (bucket, key) = path.split_once('/').unwrap_or((path, ""));
        s.s3_puts.push(S3Put {
            bucket: bucket.into(),
            key: key.into(),
            body: r.body.clone(),
            headers: r.headers.clone(),
        });
        Reply::new(200, "application/xml", "")
            .header("etag", "\"0123456789abcdef0123456789abcdef\"")
    } else {
        Reply::not_found()
    }
}

/// A small DynamoDB Query over the portal's GSIs: `byMonth` (createdAtMonth, createdAt),
/// `byTicket` (linearTicketId, createdAt), `byUser` (executedByEmail, createdAt). Supports
/// `<pk> = :v` plus an optional `createdAt BETWEEN :a AND :b | >= :a | <= :b`, a simple
/// `FilterExpression` (`a <> :v` / `a = :v`, joined by AND), ScanIndexForward, Limit,
/// ExclusiveStartKey/LastEvaluatedKey, and `Select: COUNT`.
pub fn run_query(items: &[Value], input: &Value) -> Value {
    let names: HashMap<String, String> = input
        .get("ExpressionAttributeNames")
        .and_then(|v| v.as_object())
        .map(|o| {
            o.iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
                .collect()
        })
        .unwrap_or_default();
    let values: HashMap<String, Value> = input
        .get("ExpressionAttributeValues")
        .and_then(|v| v.as_object())
        .map(|o| {
            o.iter()
                .map(|(k, v)| (k.clone(), unmarshal_attr(v)))
                .collect()
        })
        .unwrap_or_default();
    let resolve =
        |tok: &str| -> String { names.get(tok).cloned().unwrap_or_else(|| tok.to_string()) };
    let index = input
        .get("IndexName")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let pk = match index {
        "byMonth" => "createdAtMonth",
        "byTicket" => "linearTicketId",
        "byUser" => "executedByEmail",
        "" => "id",
        other => panic!("unknown index {other}"),
    };
    let kce = input["KeyConditionExpression"]
        .as_str()
        .expect("KeyConditionExpression");
    let toks: Vec<String> = kce
        .replace(['(', ')'], " ")
        .split_whitespace()
        .map(|t| t.to_string())
        .collect();
    let mut pk_val: Option<Value> = None;
    let mut lo: Option<Value> = None;
    let mut hi: Option<Value> = None;
    let mut i = 0;
    while i < toks.len() {
        let attr = resolve(&toks[i]);
        if i + 2 < toks.len() && toks.get(i + 1).map(|s| s.as_str()) == Some("=") && attr == pk {
            pk_val = values.get(&toks[i + 2]).cloned();
            i += 3;
            continue;
        }
        if attr == "createdAt" {
            match toks.get(i + 1).map(|s| s.to_ascii_uppercase()).as_deref() {
                Some("BETWEEN") => {
                    lo = values.get(&toks[i + 2]).cloned();
                    hi = values.get(&toks[i + 4]).cloned();
                    i += 5;
                    continue;
                }
                Some(">=") | Some(">") => {
                    lo = values.get(&toks[i + 2]).cloned();
                    i += 3;
                    continue;
                }
                Some("<=") | Some("<") => {
                    hi = values.get(&toks[i + 2]).cloned();
                    i += 3;
                    continue;
                }
                _ => {}
            }
        }
        i += 1;
    }
    let pk_val = pk_val.unwrap_or_else(|| {
        panic!("KeyConditionExpression {kce:?} has no `{pk} = :v` for index {index:?}")
    });
    let filters: Vec<(String, String, Value)> = input
        .get("FilterExpression")
        .and_then(|v| v.as_str())
        .map(|f| {
            f.split(" AND ")
                .filter_map(|c| {
                    let t: Vec<&str> = c.split_whitespace().collect();
                    if t.len() == 3 {
                        Some((
                            resolve(t[0]),
                            t[1].to_string(),
                            values.get(t[2]).cloned().unwrap_or(Value::Null),
                        ))
                    } else {
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    let s = |v: &Value| v.as_str().unwrap_or("").to_string();
    let mut matching: Vec<&Value> = items
        .iter()
        .filter(|it| it.get(pk) == Some(&pk_val))
        .filter(|it| lo.as_ref().is_none_or(|l| s(&it["createdAt"]) >= s(l)))
        .filter(|it| hi.as_ref().is_none_or(|h| s(&it["createdAt"]) <= s(h)))
        .collect();
    // Sort key createdAt, ties by id.
    matching
        .sort_by(|a, b| (s(&a["createdAt"]), s(&a["id"])).cmp(&(s(&b["createdAt"]), s(&b["id"]))));
    if input.get("ScanIndexForward") == Some(&json!(false)) {
        matching.reverse();
    }
    if let Some(start) = input.get("ExclusiveStartKey").filter(|v| !v.is_null()) {
        let start = unmarshal_item(start);
        if let Some(pos) = matching.iter().position(|it| it["id"] == start["id"]) {
            matching.drain(..=pos);
        }
    }
    let limit = input
        .get("Limit")
        .and_then(|v| v.as_u64())
        .map(|l| l as usize);
    let mut page = vec![];
    let mut last: Option<&Value> = None;
    let mut evaluated = 0;
    for it in &matching {
        if limit.is_some_and(|l| evaluated >= l) {
            break;
        }
        evaluated += 1;
        last = Some(it);
        let pass = filters.iter().all(|(a, op, v)| {
            let x = it.get(a).cloned().unwrap_or(Value::Null);
            match op.as_str() {
                "<>" => x != *v,
                "=" => x == *v,
                _ => true,
            }
        });
        if pass {
            page.push((*it).clone());
        }
    }
    let more = evaluated < matching.len();
    let mut out = Map::new();
    out.insert("Count".into(), json!(page.len()));
    out.insert("ScannedCount".into(), json!(evaluated));
    if input.get("Select").and_then(|v| v.as_str()) != Some("COUNT") {
        out.insert(
            "Items".into(),
            Value::Array(page.iter().map(marshal_item).collect()),
        );
    }
    if more {
        let l = last.unwrap();
        let mut key = Map::new();
        key.insert("id".into(), marshal_attr(&l["id"]));
        if pk != "id" {
            key.insert(pk.into(), marshal_attr(&l[pk]));
            key.insert("createdAt".into(), marshal_attr(&l["createdAt"]));
        }
        out.insert("LastEvaluatedKey".into(), Value::Object(key));
    }
    Value::Object(out)
}

// ---------------------------------------------------------------------------------------------
// STS AssumeRole
// ---------------------------------------------------------------------------------------------

pub const ASSUMED_KEY_ID: &str = "ASIAMOCKASSUMED00001";
pub const ASSUMED_SECRET: &str = "mock-assumed-secret-not-real";
pub const ASSUMED_SESSION_TOKEN: &str = "mock-session-token-not-real";

/// Answers STS `AssumeRole` with fixed temporary credentials (query or JSON protocol).
pub fn sts_reply(r: &Recorded) -> Option<Reply> {
    let call = decode(r)?;
    if call.operation != "AssumeRole" {
        return None;
    }
    Some(match call.proto {
        Proto::Query => Reply::new(
            200,
            "text/xml",
            format!(
                r#"<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleResult>
    <Credentials>
      <AccessKeyId>{ASSUMED_KEY_ID}</AccessKeyId>
      <SecretAccessKey>{ASSUMED_SECRET}</SecretAccessKey>
      <SessionToken>{ASSUMED_SESSION_TOKEN}</SessionToken>
      <Expiration>2099-01-01T00:00:00Z</Expiration>
    </Credentials>
    <AssumedRoleUser>
      <AssumedRoleId>AROAMOCK:engine</AssumedRoleId>
      <Arn>arn:aws:sts::000000000000:assumed-role/mock/engine</Arn>
    </AssumedRoleUser>
  </AssumeRoleResult>
  <ResponseMetadata><RequestId>mock</RequestId></ResponseMetadata>
</AssumeRoleResponse>"#
            ),
        ),
        _ => reply(
            &call,
            &json!({"Credentials": {"AccessKeyId": ASSUMED_KEY_ID, "SecretAccessKey": ASSUMED_SECRET,
                     "SessionToken": ASSUMED_SESSION_TOKEN, "Expiration": {"$timestamp": 4070908800i64}},
                    "AssumedRoleUser": {"AssumedRoleId": "AROAMOCK:engine",
                     "Arn": "arn:aws:sts::000000000000:assumed-role/mock/engine"}}),
        ),
    })
}

/// The access key id a SigV4-signed request was signed with.
pub fn sigv4_key_id(r: &Recorded) -> Option<String> {
    let auth = r.header("authorization")?;
    let i = auth.find("Credential=")? + "Credential=".len();
    Some(auth[i..].split('/').next()?.to_string())
}

/// The region in a SigV4 credential scope.
pub fn sigv4_region(r: &Recorded) -> Option<String> {
    let auth = r.header("authorization")?;
    let i = auth.find("Credential=")? + "Credential=".len();
    Some(auth[i..].split('/').nth(2)?.to_string())
}

// ---------------------------------------------------------------------------------------------
// CloudWatch GetMetricData
// ---------------------------------------------------------------------------------------------

/// One `MetricDataResult`.
#[derive(Clone, Debug)]
pub struct CwResult {
    pub id: String,
    pub label: String,
    pub timestamps: Vec<i64>,
    pub values: Vec<f64>,
}

/// Builds a GetMetricData reply. `next_token` is returned as NextToken when set.
pub fn cloudwatch_reply(call: &AwsCall, results: &[CwResult], next_token: Option<&str>) -> Reply {
    let mut out = json!({
        "MetricDataResults": results.iter().map(|r| json!({
            "Id": r.id, "Label": r.label, "StatusCode": "Complete",
            "Timestamps": r.timestamps.iter().map(|t| json!({"$timestamp": *t})).collect::<Vec<_>>(),
            "Values": r.values,
        })).collect::<Vec<_>>(),
        "Messages": [],
    });
    if let Some(t) = next_token {
        out["NextToken"] = json!(t);
    }
    if call.proto == Proto::Query {
        let mut xml = String::from(
            "<GetMetricDataResponse xmlns=\"http://monitoring.amazonaws.com/doc/2010-08-01/\"><GetMetricDataResult><MetricDataResults>",
        );
        for r in results {
            xml.push_str(&format!(
                "<member><Id>{}</Id><Label>{}</Label><StatusCode>Complete</StatusCode><Timestamps>",
                r.id, r.label
            ));
            for t in &r.timestamps {
                xml.push_str(&format!(
                    "<member>{}</member>",
                    chrono::DateTime::from_timestamp(*t, 0)
                        .unwrap()
                        .format("%Y-%m-%dT%H:%M:%SZ")
                ));
            }
            xml.push_str("</Timestamps><Values>");
            for v in &r.values {
                xml.push_str(&format!("<member>{v}</member>"));
            }
            xml.push_str("</Values></member>");
        }
        xml.push_str("</MetricDataResults><Messages/>");
        if let Some(t) = next_token {
            xml.push_str(&format!("<NextToken>{t}</NextToken>"));
        }
        xml.push_str("</GetMetricDataResult><ResponseMetadata><RequestId>mock</RequestId></ResponseMetadata></GetMetricDataResponse>");
        return Reply::new(200, "text/xml", xml);
    }
    reply(call, &out)
}

/// Epoch seconds of a decoded timestamp member (number, or ISO string from the query protocol).
pub fn ts_secs(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap(),
        Value::String(s) => s.parse::<f64>().unwrap_or_else(|_| {
            chrono::DateTime::parse_from_rfc3339(s).unwrap().timestamp() as f64
        }),
        other => panic!("not a timestamp: {other}"),
    }
}
