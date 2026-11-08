//! Scalar helpers over a `labels json` column (CONTRACTS §1.1 "Scalar helpers").
//!
//! `label(labels json, key text) -> text`: one label's value, or NULL. It reads like Postgres
//! `labels ->> key`: NULL when either argument is NULL, the key is absent, the value is JSON
//! `null` or `labels` is not an object; a string value comes back as is and any other value as
//! its JSON text. Text that is not JSON fails with SQLSTATE 22P02, as a cast to `json` would.
//! Filters and groupings on it run in DataFusion.
//!
//! `series_name(labels json) -> text`: the canonical `{k="v",...}` form, keys sorted and values
//! escaped as Prometheus prints them; the same text as the `series` column of `promql` rows.
//! NULL in gives NULL; JSON that is not an object gives NULL, as `label` does; text that is not
//! JSON fails with 22P02.

use std::sync::Arc;

use datafusion::arrow::array::{AsArray, StringArray};
use datafusion::arrow::compute::cast;
use datafusion::arrow::datatypes::DataType;
use datafusion::common::ScalarValue;
use datafusion::error::DataFusionError;
use datafusion::logical_expr::{ColumnarValue, ScalarUDF, Volatility, create_udf};
use serde_json::Value;

use crate::promql::series_name;
use crate::session::sqlstate;

/// `label(labels, key)`.
pub fn label_udf() -> ScalarUDF {
    create_udf(
        "label",
        vec![DataType::Utf8, DataType::Utf8],
        DataType::Utf8,
        Volatility::Immutable,
        Arc::new(|args: &[ColumnarValue]| {
            let all_scalar = args.iter().all(|a| matches!(a, ColumnarValue::Scalar(_)));
            let arrays = ColumnarValue::values_to_arrays(args)?;
            let labels = cast(&arrays[0], &DataType::Utf8)?;
            let keys = cast(&arrays[1], &DataType::Utf8)?;
            let values = labels
                .as_string::<i32>()
                .iter()
                .zip(keys.as_string::<i32>().iter())
                .map(|(labels, key)| match (labels, key) {
                    (Some(labels), Some(key)) => label(labels, key),
                    _ => Ok(None),
                })
                .collect::<Result<StringArray, _>>()?;
            if all_scalar {
                return Ok(ColumnarValue::Scalar(ScalarValue::try_from_array(&values, 0)?));
            }
            Ok(ColumnarValue::Array(Arc::new(values)))
        }),
    )
}

/// `series_name(labels)`.
pub fn series_name_udf() -> ScalarUDF {
    create_udf(
        "series_name",
        vec![DataType::Utf8],
        DataType::Utf8,
        Volatility::Immutable,
        Arc::new(|args: &[ColumnarValue]| {
            let all_scalar = matches!(args[0], ColumnarValue::Scalar(_));
            let arrays = ColumnarValue::values_to_arrays(args)?;
            let labels = cast(&arrays[0], &DataType::Utf8)?;
            let names = labels
                .as_string::<i32>()
                .iter()
                .map(|labels| labels.map(canonical).transpose().map(Option::flatten))
                .collect::<Result<StringArray, _>>()?;
            if all_scalar {
                return Ok(ColumnarValue::Scalar(ScalarValue::try_from_array(&names, 0)?));
            }
            Ok(ColumnarValue::Array(Arc::new(names)))
        }),
    )
}

/// The canonical series name of a labels JSON text; NULL when it is not an object.
fn canonical(labels: &str) -> Result<Option<String>, DataFusionError> {
    Ok(match parse(labels)? {
        Value::Object(map) => Some(series_name(&map)),
        _ => None,
    })
}

fn parse(labels: &str) -> Result<Value, DataFusionError> {
    serde_json::from_str(labels)
        .map_err(|e| sqlstate("22P02", format!("invalid input syntax for type json: {e}")))
}

/// One label's value from a labels JSON text.
fn label(labels: &str, key: &str) -> Result<Option<String>, DataFusionError> {
    let labels = parse(labels)?;
    Ok(match labels.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(other) => Some(other.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_reads_like_postgres_text_arrow() {
        let labels = r#"{"pod":"api-1","n":3,"z":null,"o":{"a":1}}"#;
        assert_eq!(label(labels, "pod").unwrap().as_deref(), Some("api-1"));
        assert_eq!(label(labels, "n").unwrap().as_deref(), Some("3"));
        assert_eq!(label(labels, "o").unwrap().as_deref(), Some(r#"{"a":1}"#));
        assert_eq!(label(labels, "z").unwrap(), None);
        assert_eq!(label(labels, "missing").unwrap(), None);
        assert_eq!(label("{}", "a").unwrap(), None);
        assert_eq!(label("[1]", "a").unwrap(), None);
        assert!(label("{not json", "a").is_err());
    }

    #[test]
    fn canonical_sorts_escapes_and_nulls_non_objects() {
        let name = canonical(r#"{"b":"2","a":"say \"hi\" \\ now\nplease"}"#).unwrap();
        assert_eq!(name.as_deref(), Some(r#"{a="say \"hi\" \\ now\nplease",b="2"}"#));
        assert_eq!(canonical("{}").unwrap().as_deref(), Some("{}"));
        assert_eq!(canonical("[1]").unwrap(), None);
        assert!(canonical("{not json").is_err());
    }
}
