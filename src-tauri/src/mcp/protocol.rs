//! JSON-RPC 2.0 and the MCP messages that are not tools: `initialize`, errors, tool results.

use serde_json::{json, Value};

pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;

/// Protocol versions the server speaks (it only uses what is common to all of them), newest first.
pub const SUPPORTED_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/// The version to answer `initialize` with: the client's when we speak it, else our newest.
pub fn negotiate_version(client: Option<&str>) -> &'static str {
    client
        .and_then(|c| SUPPORTED_VERSIONS.iter().find(|v| **v == c))
        .copied()
        .unwrap_or(SUPPORTED_VERSIONS[0])
}

const INSTRUCTIONS: &str = "Prometeo DataGrip gives access to the databases its user shares with agents. \
Call list_data_sources first: it lists only the data sources you may use and, for each one, whether you may read \
(list_schemas, list_tables, describe_table, run_query) and/or write (execute_statement). \
run_query accepts one read statement and runs it on a separate read-only connection with extra checks, but \
read-only is best effort: a function with side effects can still write, and on Oracle the read-only gate is \
a client-side keyword check. Do not rely on it for safety; the hard guarantee is a database user that only has \
SELECT rights. execute_statement runs exactly one statement and commits it (no BEGIN / COMMIT / ROLLBACK). \
The user sets the permissions in Prometeo DataGrip (MCP > Permissions) and sees every call in the MCP log. \
A tool error says what is missing and how to fix it.";

pub fn initialize_result(client_version: Option<&str>) -> Value {
    json!({
        "protocolVersion": negotiate_version(client_version),
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "prometeo-datagrip", "version": env!("CARGO_PKG_VERSION") },
        "instructions": INSTRUCTIONS,
    })
}

pub fn ok(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

pub fn error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// The result of `tools/call`: one text block. A tool error is a successful JSON-RPC response with `isError`
/// set; it never carries `structuredContent`.
pub fn tool_result(text: &str, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

/// One JSON-RPC message from a client.
#[derive(Debug, PartialEq)]
pub enum Incoming {
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
    },
    /// A response to a request of ours (we send none): accepted and ignored.
    Response,
    /// Not a valid message; `id` is `null` when it could not be read.
    Invalid {
        id: Value,
        message: String,
    },
}

pub fn parse(v: &Value) -> Incoming {
    let Some(obj) = v.as_object() else {
        return Incoming::Invalid {
            id: Value::Null,
            message: "A JSON-RPC message must be an object".into(),
        };
    };
    let id = obj.get("id").filter(|i| !i.is_null()).cloned();
    if obj.get("method").is_none() && (obj.contains_key("result") || obj.contains_key("error")) {
        return Incoming::Response;
    }
    let Some(method) = obj.get("method").and_then(Value::as_str) else {
        return Incoming::Invalid {
            id: id.unwrap_or(Value::Null),
            message: "Missing `method`".into(),
        };
    };
    if let Some(id) = &id {
        if !(id.is_string() || id.is_number()) {
            return Incoming::Invalid {
                id: Value::Null,
                message: "`id` must be a string or a number".into(),
            };
        }
    }
    match id {
        Some(id) => Incoming::Request {
            id,
            method: method.to_string(),
            params: obj.get("params").cloned().unwrap_or(Value::Null),
        },
        None => Incoming::Notification {
            method: method.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_negotiation() {
        assert_eq!(negotiate_version(Some("2024-11-05")), "2024-11-05");
        assert_eq!(negotiate_version(Some("2025-03-26")), "2025-03-26");
        assert_eq!(negotiate_version(Some("2025-06-18")), "2025-06-18");
        assert_eq!(negotiate_version(Some("2099-01-01")), "2025-06-18");
        assert_eq!(negotiate_version(None), "2025-06-18");
    }

    #[test]
    fn initialize_result_shape() {
        let r = initialize_result(Some("2025-03-26"));
        assert_eq!(r["protocolVersion"], "2025-03-26");
        assert_eq!(r["capabilities"]["tools"]["listChanged"], false);
        assert_eq!(r["serverInfo"]["name"], "prometeo-datagrip");
        assert!(r["instructions"]
            .as_str()
            .unwrap()
            .contains("list_data_sources"));
    }

    #[test]
    fn parses_requests_notifications_and_junk() {
        let p = parse(&json!({"jsonrpc":"2.0","id":1,"method":"ping"}));
        assert_eq!(
            p,
            Incoming::Request {
                id: json!(1),
                method: "ping".into(),
                params: Value::Null
            }
        );
        let p = parse(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}));
        assert_eq!(
            p,
            Incoming::Notification {
                method: "notifications/initialized".into()
            }
        );
        assert_eq!(parse(&json!({"id":3,"result":{}})), Incoming::Response);
        assert!(matches!(parse(&json!(5)), Incoming::Invalid { .. }));
        assert!(matches!(parse(&json!({"id":1})), Incoming::Invalid { .. }));
        assert!(matches!(
            parse(&json!({"id":{"a":1},"method":"x"})),
            Incoming::Invalid { .. }
        ));
    }

    #[test]
    fn tool_errors_have_no_structured_content() {
        let r = tool_result("nope", true);
        assert_eq!(r["isError"], true);
        assert_eq!(r["content"].as_array().unwrap().len(), 1);
        assert!(r.get("structuredContent").is_none());
    }
}
