use std::sync::Arc;

use chrono::Utc;
use teloxide::prelude::*;
use tokio::sync::watch;
use tokio::time::{interval, Duration};
use tracing::{error, info, warn};

use crate::agent::tools::parse_cron_next;
use crate::agent::types::{ContentBlock, Message, Role};
use crate::agent::{Agent, ToolExecutor};
use crate::db::Database;
use crate::telegram::split_message;

const POLL_INTERVAL_SECS: u64 = 60;

const SYSTEM_PROMPT: &str = "\
You are Imp, a personal AI assistant. \
You are executing a scheduled task. The user set this up earlier and it has now triggered. \
Carry out the instruction below. Be helpful, concise, and conversational. \
You have access to tools for scheduling tasks and fetching web content.";

/// Start the scheduler polling loop. Runs until the shutdown receiver signals,
/// checking for due tasks every 60 seconds. Each due task is sent to the agent
/// and the response is delivered to the owner via Telegram.
pub async fn run(
    bot: Bot,
    owner_chat_id: i64,
    db: Arc<Database>,
    agent: Arc<dyn Agent>,
    tool_executor: Arc<dyn ToolExecutor>,
    mut shutdown: watch::Receiver<()>,
) {
    info!("starting scheduler (poll interval: {POLL_INTERVAL_SECS}s)");
    let chat_id = ChatId(owner_chat_id);
    let mut ticker = interval(Duration::from_secs(POLL_INTERVAL_SECS));

    loop {
        tokio::select! {
            _ = ticker.tick() => {}
            _ = shutdown.changed() => {
                info!("scheduler shutting down");
                break;
            }
        }

        let now = Utc::now();
        let db_poll = db.clone();
        let due_tasks = match tokio::task::spawn_blocking(move || db_poll.get_due_tasks(&now)).await
        {
            Ok(Ok(tasks)) => tasks,
            Ok(Err(e)) => {
                error!(error = %e, "failed to poll for due tasks");
                continue;
            }
            Err(e) => {
                error!(error = %e, "spawn_blocking panicked polling tasks");
                continue;
            }
        };

        for task in due_tasks {
            info!(task_id = %task.id, prompt = %task.prompt, "executing scheduled task");

            let run_start = Utc::now();
            let start_instant = std::time::Instant::now();

            // Build a single user message from the task prompt
            let messages = vec![Message {
                role: Role::User,
                content: vec![ContentBlock::text(&task.prompt)],
            }];

            let result = agent
                .send(Some(SYSTEM_PROMPT), messages, tool_executor.as_ref(), None)
                .await;

            let duration_ms = start_instant.elapsed().as_millis() as i64;

            match &result {
                Ok(response) => {
                    info!(
                        task_id = %task.id,
                        input_tokens = response.input_tokens,
                        output_tokens = response.output_tokens,
                        "scheduled task completed"
                    );

                    // Send the response to the owner via Telegram
                    for chunk in split_message(&response.text) {
                        if !chunk.is_empty() {
                            if let Err(e) = bot.send_message(chat_id, chunk).await {
                                error!(
                                    error = %e,
                                    task_id = %task.id,
                                    "failed to send scheduled task result"
                                );
                            }
                        }
                    }

                    // Log success
                    let db_log = db.clone();
                    let task_id = task.id.clone();
                    let response_text = response.text.clone();
                    let _ = log_task_run(
                        &db_log,
                        &task_id,
                        &run_start,
                        duration_ms,
                        "success",
                        Some(&response_text),
                        None,
                    )
                    .await;
                }
                Err(e) => {
                    error!(error = %e, task_id = %task.id, "scheduled task failed");

                    // Notify the owner of the failure
                    let error_msg = format!("Scheduled task failed: {}\nError: {e}", task.prompt);
                    if let Err(send_err) = bot.send_message(chat_id, &error_msg).await {
                        error!(error = %send_err, "failed to send error notification");
                    }

                    // Log failure
                    let db_log = db.clone();
                    let task_id = task.id.clone();
                    let err_str = e.to_string();
                    let _ = log_task_run(
                        &db_log,
                        &task_id,
                        &run_start,
                        duration_ms,
                        "error",
                        None,
                        Some(&err_str),
                    )
                    .await;
                }
            }

            // Compute next run: cron tasks get rescheduled, once tasks complete
            let next_run = if task.schedule_type == "cron" {
                match parse_cron_next(&task.schedule_value) {
                    Ok(next) => Some(next),
                    Err(e) => {
                        warn!(
                            error = %e,
                            task_id = %task.id,
                            "failed to compute next cron run; marking completed"
                        );
                        None
                    }
                }
            } else {
                None
            };

            let db_update = db.clone();
            let task_id = task.id.clone();
            match tokio::task::spawn_blocking(move || {
                db_update.update_task_after_run(&task_id, next_run.as_ref())
            })
            .await
            {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    error!(error = %e, task_id = %task.id, "failed to update task after run");
                }
                Err(e) => {
                    error!(error = %e, task_id = %task.id, "spawn_blocking panicked updating task");
                }
            }
        }
    }
}

/// Log a task run to the database, handling spawn_blocking errors.
async fn log_task_run(
    db: &Arc<Database>,
    task_id: &str,
    run_at: &chrono::DateTime<Utc>,
    duration_ms: i64,
    status: &str,
    result: Option<&str>,
    error_msg: Option<&str>,
) {
    let db = db.clone();
    let task_id = task_id.to_string();
    let run_at = *run_at;
    let status = status.to_string();
    let result = result.map(|s| s.to_string());
    let error_msg = error_msg.map(|s| s.to_string());

    let outcome = tokio::task::spawn_blocking(move || {
        db.log_task_run(
            &task_id,
            &run_at,
            duration_ms,
            &status,
            result.as_deref(),
            error_msg.as_deref(),
        )
    })
    .await;

    match outcome {
        Ok(Err(e)) => error!(error = %e, "failed to log task run"),
        Err(e) => error!(error = %e, "spawn_blocking panicked logging task run"),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use crate::agent::tools::parse_cron_next;

    // ── compute_cron_next: valid expressions ─────────────────────────

    #[test]
    fn test_five_field_cron_returns_future_time() {
        // Standard 5-field: every hour at minute 0
        let next = parse_cron_next("0 * * * *").unwrap();
        assert!(next > Utc::now(), "next run should be in the future");
    }

    #[test]
    fn test_five_field_daily_cron() {
        // Every day at 09:00
        let next = parse_cron_next("0 9 * * *").unwrap();
        assert!(next > Utc::now());
        assert_eq!(next.format("%M").to_string(), "00");
        assert_eq!(next.format("%H").to_string(), "09");
    }

    #[test]
    fn test_five_field_every_minute() {
        // Every minute
        let next = parse_cron_next("* * * * *").unwrap();
        let now = Utc::now();
        // Should be within the next ~60 seconds
        let diff = next.signed_duration_since(now);
        assert!(diff.num_seconds() >= 0 && diff.num_seconds() <= 60);
    }

    #[test]
    fn test_five_field_specific_weekday() {
        // The cron crate uses 1=Sunday, 2=Monday, ..., 7=Saturday.
        // "30 8 * * 2" means every Monday at 08:30.
        let next = parse_cron_next("30 8 * * 2").unwrap();
        assert!(next > Utc::now());
        assert_eq!(next.format("%u").to_string(), "1"); // ISO Monday
    }

    #[test]
    fn test_six_field_with_seconds() {
        // 6-field: sec min hour dom mon dow
        let next = parse_cron_next("30 0 * * * *").unwrap();
        assert!(next > Utc::now());
        assert_eq!(next.format("%S").to_string(), "30");
    }

    #[test]
    fn test_cron_with_ranges() {
        // Weekdays (Mon-Fri) at 09:00.
        // The cron crate uses 1=Sunday, so Mon-Fri is 2-6.
        let next = parse_cron_next("0 9 * * 2-6").unwrap();
        assert!(next > Utc::now());
        let weekday: u32 = next.format("%u").to_string().parse().unwrap();
        assert!((1..=5).contains(&weekday), "should be a weekday (ISO 1-5)");
    }

    #[test]
    fn test_cron_with_step() {
        // Every 15 minutes
        let next = parse_cron_next("*/15 * * * *").unwrap();
        assert!(next > Utc::now());
        let minute: u32 = next.format("%M").to_string().parse().unwrap();
        assert!(
            minute % 15 == 0,
            "minute {minute} should be divisible by 15"
        );
    }

    #[test]
    fn test_cron_with_list() {
        // At minute 0 and 30
        let next = parse_cron_next("0,30 * * * *").unwrap();
        assert!(next > Utc::now());
        let minute: u32 = next.format("%M").to_string().parse().unwrap();
        assert!(
            minute == 0 || minute == 30,
            "minute should be 0 or 30, got {minute}"
        );
    }

    // ── compute_cron_next: consistency ───────────────────────────────

    #[test]
    fn test_successive_calls_return_same_result() {
        // Two calls in quick succession should return the same next time
        let next1 = parse_cron_next("0 12 * * *").unwrap();
        let next2 = parse_cron_next("0 12 * * *").unwrap();
        assert_eq!(next1, next2);
    }

    // ── compute_cron_next: error cases ──────────────────────────────

    #[test]
    fn test_invalid_cron_returns_error() {
        let result = parse_cron_next("not a cron");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("invalid cron expression"),
            "error should mention invalid cron: {err}"
        );
    }

    #[test]
    fn test_empty_string_returns_error() {
        let result = parse_cron_next("");
        assert!(result.is_err());
    }

    #[test]
    fn test_too_few_fields_returns_error() {
        // Only 3 fields -- not enough for a valid cron expression
        let result = parse_cron_next("* * *");
        assert!(result.is_err());
    }

    #[test]
    fn test_too_many_fields_returns_error() {
        // 8 fields -- too many
        let result = parse_cron_next("0 0 0 * * * * *");
        assert!(result.is_err());
    }

    #[test]
    fn test_invalid_minute_range_returns_error() {
        // Minute 60 is out of range (0-59)
        let result = parse_cron_next("60 * * * *");
        assert!(result.is_err());
    }

    #[test]
    fn test_invalid_hour_range_returns_error() {
        // Hour 25 is out of range (0-23)
        let result = parse_cron_next("0 25 * * *");
        assert!(result.is_err());
    }

    // ── compute_cron_next: 5-field auto-prefix ──────────────────────

    #[test]
    fn test_five_field_gets_zero_seconds_prefix() {
        // With a 5-field expression, seconds should always be 0
        let next = parse_cron_next("0 * * * *").unwrap();
        assert_eq!(next.format("%S").to_string(), "00");
    }
}
