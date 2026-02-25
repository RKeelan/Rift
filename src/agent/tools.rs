use std::str::FromStr;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{Duration, Utc};
use cron::Schedule;
use reqwest::Client;
use serde_json::json;

use super::types::{ContentBlock, ToolDefinition};
use super::ToolExecutor;
use crate::db::Database;
use crate::web_fetch;

/// Tool executor for Imp's built-in tools.
pub struct ImpToolExecutor {
    db: Arc<Database>,
    allowed_domains: Vec<String>,
    http_client: Client,
}

impl ImpToolExecutor {
    pub fn new(db: Arc<Database>, allowed_domains: Vec<String>) -> Self {
        let http_client = Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("failed to build HTTP client");
        Self {
            db,
            allowed_domains,
            http_client,
        }
    }

    async fn schedule_task(&self, tool_use_id: &str, input: &serde_json::Value) -> ContentBlock {
        let prompt = match input["prompt"].as_str() {
            Some(p) => p,
            None => return ContentBlock::tool_error(tool_use_id, "missing 'prompt' parameter"),
        };
        let schedule_type = match input["schedule_type"].as_str() {
            Some(t) => t,
            None => {
                return ContentBlock::tool_error(tool_use_id, "missing 'schedule_type' parameter")
            }
        };
        let schedule_value = match input["schedule_value"].as_str() {
            Some(v) => v,
            None => {
                return ContentBlock::tool_error(tool_use_id, "missing 'schedule_value' parameter")
            }
        };

        let now = Utc::now();
        let next_run = match schedule_type {
            "once" => match parse_once_schedule(schedule_value, now) {
                Ok(t) => Some(t),
                Err(e) => return ContentBlock::tool_error(tool_use_id, e),
            },
            "cron" => match parse_cron_next(schedule_value) {
                Ok(t) => Some(t),
                Err(e) => return ContentBlock::tool_error(tool_use_id, e),
            },
            other => {
                return ContentBlock::tool_error(
                    tool_use_id,
                    format!("invalid schedule_type '{other}', must be 'once' or 'cron'"),
                )
            }
        };

        let task_id = uuid::Uuid::new_v4().to_string();

        let db = self.db.clone();
        let task_id_clone = task_id.clone();
        let prompt_owned = prompt.to_string();
        let schedule_type_owned = schedule_type.to_string();
        let schedule_value_owned = schedule_value.to_string();

        let result = tokio::task::spawn_blocking(move || {
            db.create_task(
                &task_id_clone,
                &prompt_owned,
                &schedule_type_owned,
                &schedule_value_owned,
                next_run.as_ref(),
                &now,
            )
        })
        .await;

        match result {
            Ok(Ok(())) => {
                let next_str = next_run
                    .map(|t| t.to_rfc3339())
                    .unwrap_or_else(|| "not scheduled".to_string());
                ContentBlock::tool_result(
                    tool_use_id,
                    format!("Task created (id: {task_id}, next_run: {next_str})"),
                )
            }
            Ok(Err(e)) => ContentBlock::tool_error(tool_use_id, format!("database error: {e}")),
            Err(e) => ContentBlock::tool_error(tool_use_id, format!("internal error: {e}")),
        }
    }

    async fn list_tasks(&self, tool_use_id: &str) -> ContentBlock {
        let db = self.db.clone();
        let result = tokio::task::spawn_blocking(move || db.list_tasks()).await;

        match result {
            Ok(Ok(tasks)) => {
                if tasks.is_empty() {
                    return ContentBlock::tool_result(tool_use_id, "No scheduled tasks.");
                }
                let mut lines = Vec::new();
                for task in &tasks {
                    let next = task.next_run.as_deref().unwrap_or("none");
                    lines.push(format!(
                        "- [{}] {} | type: {} | schedule: {} | next_run: {} | status: {}",
                        task.id,
                        task.prompt,
                        task.schedule_type,
                        task.schedule_value,
                        next,
                        task.status
                    ));
                }
                ContentBlock::tool_result(tool_use_id, lines.join("\n"))
            }
            Ok(Err(e)) => ContentBlock::tool_error(tool_use_id, format!("database error: {e}")),
            Err(e) => ContentBlock::tool_error(tool_use_id, format!("internal error: {e}")),
        }
    }

    async fn cancel_task(&self, tool_use_id: &str, input: &serde_json::Value) -> ContentBlock {
        let task_id = match input["task_id"].as_str() {
            Some(id) => id.to_string(),
            None => return ContentBlock::tool_error(tool_use_id, "missing 'task_id' parameter"),
        };

        let db = self.db.clone();
        let tid = task_id.clone();
        let result = tokio::task::spawn_blocking(move || -> crate::error::Result<bool> {
            let task = db.get_task(&tid)?;
            match task {
                Some(_) => {
                    db.delete_task(&tid)?;
                    Ok(true)
                }
                None => Ok(false),
            }
        })
        .await;

        match result {
            Ok(Ok(true)) => {
                ContentBlock::tool_result(tool_use_id, format!("Task {task_id} cancelled."))
            }
            Ok(Ok(false)) => {
                ContentBlock::tool_error(tool_use_id, format!("no task found with id '{task_id}'"))
            }
            Ok(Err(e)) => ContentBlock::tool_error(tool_use_id, format!("database error: {e}")),
            Err(e) => ContentBlock::tool_error(tool_use_id, format!("internal error: {e}")),
        }
    }

    async fn web_fetch(&self, tool_use_id: &str, input: &serde_json::Value) -> ContentBlock {
        let url = match input["url"].as_str() {
            Some(u) => u,
            None => return ContentBlock::tool_error(tool_use_id, "missing 'url' parameter"),
        };

        match web_fetch::fetch_url(&self.http_client, url, &self.allowed_domains).await {
            Ok(text) => ContentBlock::tool_result(tool_use_id, text),
            Err(e) => ContentBlock::tool_error(tool_use_id, format!("{e}")),
        }
    }
}

/// Parse a "once" schedule value into a future DateTime.
///
/// Accepts:
/// - "in N minute(s)/hour(s)/day(s)" patterns
/// - ISO 8601 datetime strings
fn parse_once_schedule(
    value: &str,
    now: chrono::DateTime<Utc>,
) -> Result<chrono::DateTime<Utc>, String> {
    // Try "in N unit" pattern
    let trimmed = value.trim().to_lowercase();
    if let Some(rest) = trimmed.strip_prefix("in ") {
        let parts: Vec<&str> = rest.split_whitespace().collect();
        if parts.len() == 2 {
            if let Ok(n) = parts[0].parse::<i64>() {
                if n <= 0 {
                    return Err(format!("duration must be positive, got {n}"));
                }
                let unit = parts[1].trim_end_matches('s');
                let duration = match unit {
                    "minute" => Some(Duration::minutes(n)),
                    "hour" => Some(Duration::hours(n)),
                    "day" => Some(Duration::days(n)),
                    "second" => Some(Duration::seconds(n)),
                    _ => None,
                };
                if let Some(d) = duration {
                    return Ok(now + d);
                }
            }
        }
    }

    // Try ISO 8601
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|_| {
            format!(
                "cannot parse schedule_value '{value}'. \
                 Use 'in N minutes/hours/days' or an ISO 8601 datetime."
            )
        })
}

/// Parse a cron expression and return the next occurrence after now.
fn parse_cron_next(expr: &str) -> Result<chrono::DateTime<Utc>, String> {
    // The `cron` crate expects 7-field expressions (sec min hour dom mon dow year).
    // Standard 5-field cron (min hour dom mon dow) needs a "0" prefix for seconds.
    let full_expr = if expr.split_whitespace().count() == 5 {
        format!("0 {expr}")
    } else {
        expr.to_string()
    };

    let schedule = Schedule::from_str(&full_expr)
        .map_err(|e| format!("invalid cron expression '{expr}': {e}"))?;

    schedule
        .upcoming(Utc)
        .next()
        .ok_or_else(|| format!("cron expression '{expr}' has no future occurrences"))
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
        match name {
            "schedule_task" => self.schedule_task(tool_use_id, input).await,
            "list_tasks" => self.list_tasks(tool_use_id).await,
            "cancel_task" => self.cancel_task(tool_use_id, input).await,
            "web_fetch" => self.web_fetch(tool_use_id, input).await,
            _ => ContentBlock::tool_error(tool_use_id, format!("unknown tool '{name}'")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_executor() -> ImpToolExecutor {
        let db = Arc::new(Database::open_in_memory().unwrap());
        ImpToolExecutor::new(db, vec![])
    }

    #[test]
    fn test_tool_definitions_count() {
        let executor = test_executor();
        let defs = executor.tool_definitions();
        assert_eq!(defs.len(), 4);
    }

    #[test]
    fn test_tool_definition_names() {
        let executor = test_executor();
        let defs = executor.tool_definitions();
        let names: Vec<&str> = defs.iter().map(|d| d.name.as_str()).collect();
        assert!(names.contains(&"schedule_task"));
        assert!(names.contains(&"list_tasks"));
        assert!(names.contains(&"cancel_task"));
        assert!(names.contains(&"web_fetch"));
    }

    #[test]
    fn test_tool_schemas_are_valid_json() {
        let executor = test_executor();
        for def in executor.tool_definitions() {
            assert_eq!(def.input_schema["type"], "object");
            assert!(def.input_schema.get("properties").is_some());
        }
    }

    #[test]
    fn test_schedule_task_schema() {
        let executor = test_executor();
        let defs = executor.tool_definitions();
        let schedule = defs.iter().find(|d| d.name == "schedule_task").unwrap();
        let required = schedule.input_schema["required"].as_array().unwrap();
        assert_eq!(required.len(), 3);
    }

    #[test]
    fn test_cancel_task_schema() {
        let executor = test_executor();
        let defs = executor.tool_definitions();
        let cancel = defs.iter().find(|d| d.name == "cancel_task").unwrap();
        let required = cancel.input_schema["required"].as_array().unwrap();
        assert_eq!(required.len(), 1);
        assert_eq!(required[0], "task_id");
        assert!(cancel.input_schema["properties"].get("task_id").is_some());
    }

    #[test]
    fn test_web_fetch_schema() {
        let executor = test_executor();
        let defs = executor.tool_definitions();
        let fetch = defs.iter().find(|d| d.name == "web_fetch").unwrap();
        let required = fetch.input_schema["required"].as_array().unwrap();
        assert_eq!(required.len(), 1);
        assert_eq!(required[0], "url");
        assert!(fetch.input_schema["properties"].get("url").is_some());
    }

    #[test]
    fn test_list_tasks_schema_no_required() {
        let executor = test_executor();
        let defs = executor.tool_definitions();
        let list = defs.iter().find(|d| d.name == "list_tasks").unwrap();
        assert!(list.input_schema.get("required").is_none());
    }

    #[test]
    fn test_all_tool_definitions_have_descriptions() {
        let executor = test_executor();
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
        let executor = test_executor();
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
        let executor = test_executor();
        for def in executor.tool_definitions() {
            let json = serde_json::to_value(&def).unwrap();
            assert!(json["name"].is_string());
            assert!(json["description"].is_string());
            assert_eq!(json["input_schema"]["type"], "object");
            assert!(json["input_schema"]["properties"].is_object());
        }
    }

    #[tokio::test]
    async fn test_unknown_tool_returns_error() {
        let executor = test_executor();
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

    // ── schedule_task tests ──────────────────────────────────────────

    #[tokio::test]
    async fn test_schedule_task_once_in_minutes() {
        let executor = test_executor();
        let result = executor
            .execute(
                "tu_1",
                "schedule_task",
                &json!({
                    "prompt": "say hello",
                    "schedule_type": "once",
                    "schedule_value": "in 5 minutes"
                }),
            )
            .await;
        match result {
            ContentBlock::ToolResult {
                is_error, content, ..
            } => {
                assert_ne!(is_error, Some(true));
                assert!(content.contains("Task created"));
            }
            _ => panic!("expected tool_result"),
        }
    }

    #[tokio::test]
    async fn test_schedule_task_cron() {
        let executor = test_executor();
        let result = executor
            .execute(
                "tu_2",
                "schedule_task",
                &json!({
                    "prompt": "daily check",
                    "schedule_type": "cron",
                    "schedule_value": "0 9 * * *"
                }),
            )
            .await;
        match result {
            ContentBlock::ToolResult {
                is_error, content, ..
            } => {
                assert_ne!(is_error, Some(true));
                assert!(content.contains("Task created"));
            }
            _ => panic!("expected tool_result"),
        }
    }

    #[tokio::test]
    async fn test_schedule_task_invalid_cron() {
        let executor = test_executor();
        let result = executor
            .execute(
                "tu_3",
                "schedule_task",
                &json!({
                    "prompt": "broken",
                    "schedule_type": "cron",
                    "schedule_value": "not a cron"
                }),
            )
            .await;
        match result {
            ContentBlock::ToolResult {
                is_error, content, ..
            } => {
                assert_eq!(is_error, Some(true));
                assert!(content.contains("invalid cron"));
            }
            _ => panic!("expected tool_result"),
        }
    }

    #[tokio::test]
    async fn test_schedule_task_missing_prompt() {
        let executor = test_executor();
        let result = executor
            .execute(
                "tu_4",
                "schedule_task",
                &json!({"schedule_type": "once", "schedule_value": "in 5 minutes"}),
            )
            .await;
        match result {
            ContentBlock::ToolResult {
                is_error, content, ..
            } => {
                assert_eq!(is_error, Some(true));
                assert!(content.contains("prompt"));
            }
            _ => panic!("expected tool_result"),
        }
    }

    // ── list_tasks tests ─────────────────────────────────────────────

    #[tokio::test]
    async fn test_list_tasks_empty() {
        let executor = test_executor();
        let result = executor.execute("tu_5", "list_tasks", &json!({})).await;
        match result {
            ContentBlock::ToolResult {
                is_error, content, ..
            } => {
                assert_ne!(is_error, Some(true));
                assert!(content.contains("No scheduled tasks"));
            }
            _ => panic!("expected tool_result"),
        }
    }

    #[tokio::test]
    async fn test_list_tasks_after_schedule() {
        let executor = test_executor();
        // Schedule a task first
        executor
            .execute(
                "tu_6a",
                "schedule_task",
                &json!({
                    "prompt": "test task",
                    "schedule_type": "once",
                    "schedule_value": "in 1 hour"
                }),
            )
            .await;

        let result = executor.execute("tu_6b", "list_tasks", &json!({})).await;
        match result {
            ContentBlock::ToolResult {
                is_error, content, ..
            } => {
                assert_ne!(is_error, Some(true));
                assert!(content.contains("test task"));
            }
            _ => panic!("expected tool_result"),
        }
    }

    // ── cancel_task tests ────────────────────────────────────────────

    #[tokio::test]
    async fn test_cancel_nonexistent_task() {
        let executor = test_executor();
        let result = executor
            .execute("tu_7", "cancel_task", &json!({"task_id": "no-such-id"}))
            .await;
        match result {
            ContentBlock::ToolResult {
                is_error, content, ..
            } => {
                assert_eq!(is_error, Some(true));
                assert!(content.contains("no task found"));
            }
            _ => panic!("expected tool_result"),
        }
    }

    #[tokio::test]
    async fn test_cancel_existing_task() {
        let executor = test_executor();
        // Schedule a task
        let create_result = executor
            .execute(
                "tu_8a",
                "schedule_task",
                &json!({
                    "prompt": "to cancel",
                    "schedule_type": "once",
                    "schedule_value": "in 1 hour"
                }),
            )
            .await;

        // Extract the task ID from the result
        let task_id = match &create_result {
            ContentBlock::ToolResult { content, .. } => content
                .strip_prefix("Task created (id: ")
                .and_then(|s| s.split(',').next())
                .unwrap()
                .to_string(),
            _ => panic!("expected tool_result"),
        };

        let result = executor
            .execute("tu_8b", "cancel_task", &json!({"task_id": task_id}))
            .await;
        match result {
            ContentBlock::ToolResult {
                is_error, content, ..
            } => {
                assert_ne!(is_error, Some(true));
                assert!(content.contains("cancelled"));
            }
            _ => panic!("expected tool_result"),
        }
    }

    // ── parse helpers tests ──────────────────────────────────────────

    #[test]
    fn test_parse_once_in_minutes() {
        let now = Utc::now();
        let result = parse_once_schedule("in 5 minutes", now).unwrap();
        let diff = result - now;
        assert!((diff.num_seconds() - 300).abs() < 2);
    }

    #[test]
    fn test_parse_once_in_hours() {
        let now = Utc::now();
        let result = parse_once_schedule("in 2 hours", now).unwrap();
        let diff = result - now;
        assert!((diff.num_seconds() - 7200).abs() < 2);
    }

    #[test]
    fn test_parse_once_in_days() {
        let now = Utc::now();
        let result = parse_once_schedule("in 3 days", now).unwrap();
        let diff = result - now;
        assert!((diff.num_seconds() - 259200).abs() < 2);
    }

    #[test]
    fn test_parse_once_singular_unit() {
        let now = Utc::now();
        let result = parse_once_schedule("in 1 minute", now).unwrap();
        let diff = result - now;
        assert!((diff.num_seconds() - 60).abs() < 2);
    }

    #[test]
    fn test_parse_once_iso8601() {
        use chrono::Datelike;
        let now = Utc::now();
        let result = parse_once_schedule("2099-01-01T00:00:00Z", now).unwrap();
        assert!(result.year() == 2099);
    }

    #[test]
    fn test_parse_once_invalid() {
        let now = Utc::now();
        let result = parse_once_schedule("next tuesday", now);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_cron_5_field() {
        let result = parse_cron_next("0 9 * * *");
        assert!(result.is_ok());
    }

    #[test]
    fn test_parse_cron_invalid() {
        let result = parse_cron_next("not a cron");
        assert!(result.is_err());
    }

    // ── schedule_task additional tests ───────────────────────────────

    #[tokio::test]
    async fn test_schedule_task_invalid_schedule_type() {
        let executor = test_executor();
        let result = executor
            .execute(
                "tu_st",
                "schedule_task",
                &json!({
                    "prompt": "test",
                    "schedule_type": "weekly",
                    "schedule_value": "every monday"
                }),
            )
            .await;
        match result {
            ContentBlock::ToolResult {
                is_error, content, ..
            } => {
                assert_eq!(is_error, Some(true));
                assert!(content.contains("invalid schedule_type"));
                assert!(content.contains("weekly"));
            }
            _ => panic!("expected tool_result"),
        }
    }

    #[tokio::test]
    async fn test_schedule_task_missing_schedule_type() {
        let executor = test_executor();
        let result = executor
            .execute(
                "tu_mst",
                "schedule_task",
                &json!({"prompt": "test", "schedule_value": "in 5 minutes"}),
            )
            .await;
        match result {
            ContentBlock::ToolResult {
                is_error, content, ..
            } => {
                assert_eq!(is_error, Some(true));
                assert!(content.contains("schedule_type"));
            }
            _ => panic!("expected tool_result"),
        }
    }

    #[tokio::test]
    async fn test_schedule_task_missing_schedule_value() {
        let executor = test_executor();
        let result = executor
            .execute(
                "tu_msv",
                "schedule_task",
                &json!({"prompt": "test", "schedule_type": "once"}),
            )
            .await;
        match result {
            ContentBlock::ToolResult {
                is_error, content, ..
            } => {
                assert_eq!(is_error, Some(true));
                assert!(content.contains("schedule_value"));
            }
            _ => panic!("expected tool_result"),
        }
    }

    #[tokio::test]
    async fn test_schedule_task_persists_to_db() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let executor = ImpToolExecutor::new(db.clone(), vec![]);

        let result = executor
            .execute(
                "tu_persist",
                "schedule_task",
                &json!({
                    "prompt": "check persistence",
                    "schedule_type": "once",
                    "schedule_value": "in 10 minutes"
                }),
            )
            .await;

        // Extract the task ID from the result
        let task_id = match &result {
            ContentBlock::ToolResult { content, .. } => content
                .strip_prefix("Task created (id: ")
                .and_then(|s| s.split(',').next())
                .unwrap()
                .to_string(),
            _ => panic!("expected tool_result"),
        };

        // Verify the task exists in the database
        let task = db.get_task(&task_id).unwrap();
        assert!(task.is_some());
        let task = task.unwrap();
        assert_eq!(task.prompt, "check persistence");
        assert_eq!(task.schedule_type, "once");
        assert_eq!(task.status, "active");
        assert!(task.next_run.is_some());
    }

    #[tokio::test]
    async fn test_schedule_task_once_in_seconds() {
        let executor = test_executor();
        let result = executor
            .execute(
                "tu_sec",
                "schedule_task",
                &json!({
                    "prompt": "quick",
                    "schedule_type": "once",
                    "schedule_value": "in 30 seconds"
                }),
            )
            .await;
        match result {
            ContentBlock::ToolResult {
                is_error, content, ..
            } => {
                assert_ne!(is_error, Some(true));
                assert!(content.contains("Task created"));
            }
            _ => panic!("expected tool_result"),
        }
    }

    #[tokio::test]
    async fn test_schedule_task_once_invalid_natural_language() {
        let executor = test_executor();
        let result = executor
            .execute(
                "tu_inv",
                "schedule_task",
                &json!({
                    "prompt": "bad time",
                    "schedule_type": "once",
                    "schedule_value": "next tuesday"
                }),
            )
            .await;
        match result {
            ContentBlock::ToolResult {
                is_error, content, ..
            } => {
                assert_eq!(is_error, Some(true));
                assert!(content.contains("cannot parse"));
            }
            _ => panic!("expected tool_result"),
        }
    }

    // ── cancel_task DB verification ─────────────────────────────────

    #[tokio::test]
    async fn test_cancel_task_removes_from_db() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let executor = ImpToolExecutor::new(db.clone(), vec![]);

        // Create a task
        let create_result = executor
            .execute(
                "tu_cd1",
                "schedule_task",
                &json!({
                    "prompt": "to verify cancel",
                    "schedule_type": "once",
                    "schedule_value": "in 1 hour"
                }),
            )
            .await;

        let task_id = match &create_result {
            ContentBlock::ToolResult { content, .. } => content
                .strip_prefix("Task created (id: ")
                .and_then(|s| s.split(',').next())
                .unwrap()
                .to_string(),
            _ => panic!("expected tool_result"),
        };

        // Verify it exists
        assert!(db.get_task(&task_id).unwrap().is_some());

        // Cancel it
        executor
            .execute("tu_cd2", "cancel_task", &json!({"task_id": task_id}))
            .await;

        // Verify it is gone from the database
        assert!(db.get_task(&task_id).unwrap().is_none());
    }

    #[tokio::test]
    async fn test_cancel_task_missing_task_id_param() {
        let executor = test_executor();
        let result = executor
            .execute("tu_cmissing", "cancel_task", &json!({}))
            .await;
        match result {
            ContentBlock::ToolResult {
                is_error, content, ..
            } => {
                assert_eq!(is_error, Some(true));
                assert!(content.contains("task_id"));
            }
            _ => panic!("expected tool_result"),
        }
    }

    // ── list_tasks formatting tests ─────────────────────────────────

    #[tokio::test]
    async fn test_list_tasks_includes_all_fields() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let executor = ImpToolExecutor::new(db, vec![]);

        // Schedule a cron task
        executor
            .execute(
                "tu_fmt1",
                "schedule_task",
                &json!({
                    "prompt": "formatted task",
                    "schedule_type": "cron",
                    "schedule_value": "0 9 * * *"
                }),
            )
            .await;

        let result = executor.execute("tu_fmt2", "list_tasks", &json!({})).await;
        match result {
            ContentBlock::ToolResult {
                is_error, content, ..
            } => {
                assert_ne!(is_error, Some(true));
                assert!(content.contains("formatted task"));
                assert!(content.contains("type: cron"));
                assert!(content.contains("schedule: 0 9 * * *"));
                assert!(content.contains("status: active"));
                assert!(content.contains("next_run:"));
            }
            _ => panic!("expected tool_result"),
        }
    }

    #[tokio::test]
    async fn test_list_tasks_multiple_tasks() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let executor = ImpToolExecutor::new(db, vec![]);

        // Schedule two tasks
        executor
            .execute(
                "tu_m1",
                "schedule_task",
                &json!({
                    "prompt": "task one",
                    "schedule_type": "once",
                    "schedule_value": "in 1 hour"
                }),
            )
            .await;
        executor
            .execute(
                "tu_m2",
                "schedule_task",
                &json!({
                    "prompt": "task two",
                    "schedule_type": "once",
                    "schedule_value": "in 2 hours"
                }),
            )
            .await;

        let result = executor.execute("tu_m3", "list_tasks", &json!({})).await;
        match result {
            ContentBlock::ToolResult {
                is_error, content, ..
            } => {
                assert_ne!(is_error, Some(true));
                assert!(content.contains("task one"));
                assert!(content.contains("task two"));
                // Should have two lines (one per task)
                let lines: Vec<&str> = content.lines().collect();
                assert_eq!(lines.len(), 2);
            }
            _ => panic!("expected tool_result"),
        }
    }

    // ── web_fetch via tool executor ─────────────────────────────────

    #[tokio::test]
    async fn test_web_fetch_tool_missing_url() {
        let executor = test_executor();
        let result = executor
            .execute("tu_wf_missing", "web_fetch", &json!({}))
            .await;
        match result {
            ContentBlock::ToolResult {
                is_error, content, ..
            } => {
                assert_eq!(is_error, Some(true));
                assert!(content.contains("url"));
            }
            _ => panic!("expected tool_result"),
        }
    }

    #[tokio::test]
    async fn test_web_fetch_tool_invalid_url() {
        let executor = test_executor();
        let result = executor
            .execute("tu_wf_bad", "web_fetch", &json!({"url": "not-a-url"}))
            .await;
        match result {
            ContentBlock::ToolResult {
                is_error, content, ..
            } => {
                assert_eq!(is_error, Some(true));
                assert!(content.contains("invalid URL"));
            }
            _ => panic!("expected tool_result"),
        }
    }

    #[tokio::test]
    async fn test_web_fetch_tool_domain_rejected() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let executor = ImpToolExecutor::new(db, vec!["allowed.com".to_string()]);
        let result = executor
            .execute(
                "tu_wf_deny",
                "web_fetch",
                &json!({"url": "https://blocked.org/page"}),
            )
            .await;
        match result {
            ContentBlock::ToolResult {
                is_error, content, ..
            } => {
                assert_eq!(is_error, Some(true));
                assert!(content.contains("not in the allowed list"));
            }
            _ => panic!("expected tool_result"),
        }
    }

    // ── parse helpers additional tests ───────────────────────────────

    #[test]
    fn test_parse_once_in_seconds() {
        let now = Utc::now();
        let result = parse_once_schedule("in 30 seconds", now).unwrap();
        let diff = result - now;
        assert!((diff.num_seconds() - 30).abs() < 2);
    }

    #[test]
    fn test_parse_once_case_insensitive() {
        let now = Utc::now();
        let result = parse_once_schedule("In 5 Minutes", now).unwrap();
        let diff = result - now;
        assert!((diff.num_seconds() - 300).abs() < 2);
    }

    #[test]
    fn test_parse_once_with_whitespace() {
        let now = Utc::now();
        let result = parse_once_schedule("  in 5 minutes  ", now).unwrap();
        let diff = result - now;
        assert!((diff.num_seconds() - 300).abs() < 2);
    }

    #[test]
    fn test_parse_once_unknown_unit() {
        let now = Utc::now();
        let result = parse_once_schedule("in 5 weeks", now);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_once_negative_duration() {
        let now = Utc::now();
        let result = parse_once_schedule("in -5 minutes", now);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("positive"));
    }

    #[test]
    fn test_parse_once_zero_duration() {
        let now = Utc::now();
        let result = parse_once_schedule("in 0 seconds", now);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("positive"));
    }

    #[test]
    fn test_parse_cron_next_returns_future_time() {
        let result = parse_cron_next("* * * * *").unwrap();
        assert!(result > Utc::now());
    }
}
