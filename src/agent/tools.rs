use async_trait::async_trait;
use serde_json::json;

use super::types::{ContentBlock, ToolDefinition};
use super::ToolExecutor;

/// Tool executor for Imp's built-in tools.
/// Actual tool implementations are wired in Step 5; this provides
/// the tool definitions and dispatches calls.
pub struct ImpToolExecutor;

impl ImpToolExecutor {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl ToolExecutor for ImpToolExecutor {
    fn tool_definitions(&self) -> Vec<ToolDefinition> {
        vec![
            ToolDefinition {
                name: "schedule_task".to_string(),
                description: "Schedule a new task to run once or on a recurring cron schedule."
                    .to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "prompt": {
                            "type": "string",
                            "description": "The instruction to execute when the task runs."
                        },
                        "schedule_type": {
                            "type": "string",
                            "enum": ["once", "cron"],
                            "description": "Whether this is a one-time or recurring task."
                        },
                        "schedule_value": {
                            "type": "string",
                            "description": "For 'once': a natural-language time like 'in 5 minutes' or an ISO 8601 datetime. For 'cron': a cron expression like '0 9 * * *'."
                        }
                    },
                    "required": ["prompt", "schedule_type", "schedule_value"]
                }),
            },
            ToolDefinition {
                name: "list_tasks".to_string(),
                description: "List all scheduled tasks with their status and next run time."
                    .to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {}
                }),
            },
            ToolDefinition {
                name: "cancel_task".to_string(),
                description: "Cancel a scheduled task by its ID.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "task_id": {
                            "type": "string",
                            "description": "The ID of the task to cancel."
                        }
                    },
                    "required": ["task_id"]
                }),
            },
            ToolDefinition {
                name: "web_fetch".to_string(),
                description:
                    "Fetch the content of a URL and return it as plain text. Only whitelisted domains are allowed."
                        .to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "The URL to fetch."
                        }
                    },
                    "required": ["url"]
                }),
            },
        ]
    }

    async fn execute(
        &self,
        tool_use_id: &str,
        name: &str,
        input: &serde_json::Value,
    ) -> ContentBlock {
        // Stub: real implementations are wired in Step 5.
        let _ = input;
        ContentBlock::tool_error(tool_use_id, format!("tool '{name}' is not yet implemented"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tool_definitions_count() {
        let executor = ImpToolExecutor::new();
        let defs = executor.tool_definitions();
        assert_eq!(defs.len(), 4);
    }

    #[test]
    fn test_tool_definition_names() {
        let executor = ImpToolExecutor::new();
        let defs = executor.tool_definitions();
        let names: Vec<&str> = defs.iter().map(|d| d.name.as_str()).collect();
        assert!(names.contains(&"schedule_task"));
        assert!(names.contains(&"list_tasks"));
        assert!(names.contains(&"cancel_task"));
        assert!(names.contains(&"web_fetch"));
    }

    #[test]
    fn test_tool_schemas_are_valid_json() {
        let executor = ImpToolExecutor::new();
        for def in executor.tool_definitions() {
            assert_eq!(def.input_schema["type"], "object");
            assert!(def.input_schema.get("properties").is_some());
        }
    }

    #[test]
    fn test_schedule_task_schema() {
        let executor = ImpToolExecutor::new();
        let defs = executor.tool_definitions();
        let schedule = defs.iter().find(|d| d.name == "schedule_task").unwrap();
        let required = schedule.input_schema["required"].as_array().unwrap();
        assert_eq!(required.len(), 3);
    }

    #[tokio::test]
    async fn test_stub_execution_returns_error() {
        let executor = ImpToolExecutor::new();
        let result = executor
            .execute("tu_1", "schedule_task", &json!({"prompt": "test"}))
            .await;
        match result {
            ContentBlock::ToolResult {
                is_error, content, ..
            } => {
                assert_eq!(is_error, Some(true));
                assert!(content.contains("not yet implemented"));
            }
            _ => panic!("expected tool_result"),
        }
    }

    #[tokio::test]
    async fn test_unknown_tool_returns_error() {
        let executor = ImpToolExecutor::new();
        let result = executor.execute("tu_x", "nonexistent", &json!({})).await;
        match result {
            ContentBlock::ToolResult {
                is_error, content, ..
            } => {
                assert_eq!(is_error, Some(true));
                assert!(content.contains("nonexistent"));
            }
            _ => panic!("expected tool_result"),
        }
    }

    #[test]
    fn test_cancel_task_schema() {
        let executor = ImpToolExecutor::new();
        let defs = executor.tool_definitions();
        let cancel = defs.iter().find(|d| d.name == "cancel_task").unwrap();
        let required = cancel.input_schema["required"].as_array().unwrap();
        assert_eq!(required.len(), 1);
        assert_eq!(required[0], "task_id");
        assert!(cancel.input_schema["properties"].get("task_id").is_some());
    }

    #[test]
    fn test_web_fetch_schema() {
        let executor = ImpToolExecutor::new();
        let defs = executor.tool_definitions();
        let fetch = defs.iter().find(|d| d.name == "web_fetch").unwrap();
        let required = fetch.input_schema["required"].as_array().unwrap();
        assert_eq!(required.len(), 1);
        assert_eq!(required[0], "url");
        assert!(fetch.input_schema["properties"].get("url").is_some());
    }

    #[test]
    fn test_list_tasks_schema_no_required() {
        let executor = ImpToolExecutor::new();
        let defs = executor.tool_definitions();
        let list = defs.iter().find(|d| d.name == "list_tasks").unwrap();
        // list_tasks has no required fields
        assert!(list.input_schema.get("required").is_none());
    }

    #[test]
    fn test_all_tool_definitions_have_descriptions() {
        let executor = ImpToolExecutor::new();
        for def in executor.tool_definitions() {
            assert!(
                !def.description.is_empty(),
                "tool '{}' must have a description",
                def.name
            );
        }
    }

    #[test]
    fn test_schedule_task_schema_enum_values() {
        let executor = ImpToolExecutor::new();
        let defs = executor.tool_definitions();
        let schedule = defs.iter().find(|d| d.name == "schedule_task").unwrap();
        let schedule_type = &schedule.input_schema["properties"]["schedule_type"];
        let enum_values = schedule_type["enum"].as_array().unwrap();
        assert_eq!(enum_values.len(), 2);
        assert!(enum_values.contains(&json!("once")));
        assert!(enum_values.contains(&json!("cron")));
    }

    #[test]
    fn test_tool_definitions_are_valid_for_api() {
        // Verify that tool definitions serialize to the shape the Anthropic API expects:
        // { "name": string, "description": string, "input_schema": { "type": "object", ... } }
        let executor = ImpToolExecutor::new();
        for def in executor.tool_definitions() {
            let json = serde_json::to_value(&def).unwrap();
            assert!(json["name"].is_string());
            assert!(json["description"].is_string());
            assert_eq!(json["input_schema"]["type"], "object");
            assert!(json["input_schema"]["properties"].is_object());
        }
    }

    #[tokio::test]
    async fn test_each_tool_stub_returns_not_implemented() {
        let executor = ImpToolExecutor::new();
        for tool_name in ["schedule_task", "list_tasks", "cancel_task", "web_fetch"] {
            let result = executor.execute("tu_test", tool_name, &json!({})).await;
            match result {
                ContentBlock::ToolResult {
                    is_error, content, ..
                } => {
                    assert_eq!(
                        is_error,
                        Some(true),
                        "tool '{}' stub should return is_error=true",
                        tool_name
                    );
                    assert!(
                        content.contains("not yet implemented"),
                        "tool '{}' stub should mention not yet implemented",
                        tool_name
                    );
                }
                _ => panic!("expected tool_result for '{}'", tool_name),
            }
        }
    }
}
