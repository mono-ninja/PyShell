use serde_json::Value;

use crate::manifest::model::JobEvent;

/// Try to parse a stderr line as a JSON structured event.
/// Only lines containing a `"pyshell": true` field are treated as structured
/// events (Plan.md §M5). All other JSON is shown as a normal log line.
pub fn try_parse_structured(line: &str) -> Option<Value> {
    let trimmed = line.trim();
    if !trimmed.starts_with('{') {
        return None;
    }

    let value: Value = serde_json::from_str(trimmed).ok()?;

    // Require a discriminator field so arbitrary JSON logs aren't swallowed
    if value.get("pyshell").and_then(|v| v.as_bool()) == Some(true) {
        Some(value)
    } else {
        None
    }
}

/// Convert a structured JSON event into a JobEvent::Structured.
pub fn structured_event(event: Value) -> JobEvent {
    JobEvent::Structured { event }
}
