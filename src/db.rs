#![allow(dead_code)]

use std::path::Path;
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};

use crate::error::{ImpError, Result};

/// Thread-safe database handle wrapping a SQLite connection.
///
/// `rusqlite::Connection` is `!Send`, so all access goes through a `Mutex`.
/// Callers in async code should use `tokio::task::spawn_blocking` to avoid
/// blocking the runtime.
pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    /// Acquire the database connection, recovering from mutex poisoning.
    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Open (or create) the database at `path` and run schema migrations.
    pub fn open(path: &str) -> Result<Self> {
        if let Some(parent) = Path::new(path).parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                ImpError::Config(format!(
                    "cannot create database directory {}: {e}",
                    parent.display()
                ))
            })?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.create_schema()?;
        Ok(db)
    }

    /// Create an in-memory database for testing.
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.create_schema()?;
        Ok(db)
    }

    fn create_schema(&self) -> Result<()> {
        let conn = self.lock();
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                token_estimate INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);

            CREATE TABLE IF NOT EXISTS scheduled_tasks (
                id TEXT PRIMARY KEY,
                prompt TEXT NOT NULL,
                schedule_type TEXT NOT NULL,
                schedule_value TEXT NOT NULL,
                next_run TEXT,
                status TEXT NOT NULL DEFAULT 'active',
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON scheduled_tasks(next_run);
            CREATE INDEX IF NOT EXISTS idx_tasks_status ON scheduled_tasks(status);

            CREATE TABLE IF NOT EXISTS task_run_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL,
                run_at TEXT NOT NULL,
                duration_ms INTEGER NOT NULL,
                status TEXT NOT NULL,
                result TEXT,
                error TEXT,
                FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
            );
            CREATE INDEX IF NOT EXISTS idx_task_run_logs_task ON task_run_logs(task_id, run_at);
            ",
        )?;
        Ok(())
    }

    // ── Messages ──────────────────────────────────────────────────────

    /// Store a message. `content` is a JSON string preserving full content blocks.
    pub fn store_message(
        &self,
        id: &str,
        role: &str,
        content: &str,
        timestamp: &DateTime<Utc>,
        token_estimate: i64,
    ) -> Result<()> {
        let conn = self.lock();
        conn.execute(
            "INSERT OR REPLACE INTO messages (id, role, content, timestamp, token_estimate)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, role, content, timestamp.to_rfc3339(), token_estimate],
        )?;
        Ok(())
    }

    /// Load the most recent messages that fit within `token_budget`.
    /// Returns messages in chronological order (oldest first).
    pub fn load_context(&self, token_budget: i64) -> Result<Vec<StoredMessage>> {
        let conn = self.lock();
        // Fetch messages newest-first, accumulating tokens until budget exhausted.
        let mut stmt = conn.prepare(
            "SELECT id, role, content, timestamp, token_estimate
             FROM messages ORDER BY timestamp DESC LIMIT 1000",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(StoredMessage {
                id: row.get(0)?,
                role: row.get(1)?,
                content: row.get(2)?,
                timestamp: row.get(3)?,
                token_estimate: row.get(4)?,
            })
        })?;

        let mut messages = Vec::new();
        let mut total_tokens: i64 = 0;
        for row in rows {
            let msg = row?;
            total_tokens += msg.token_estimate;
            if total_tokens > token_budget && !messages.is_empty() {
                break;
            }
            messages.push(msg);
        }

        messages.reverse(); // chronological order
        Ok(messages)
    }

    /// Delete all messages.
    pub fn clear_messages(&self) -> Result<()> {
        let conn = self.lock();
        conn.execute("DELETE FROM messages", [])?;
        Ok(())
    }

    // ── Scheduled Tasks ───────────────────────────────────────────────

    /// Create a new scheduled task.
    pub fn create_task(
        &self,
        id: &str,
        prompt: &str,
        schedule_type: &str,
        schedule_value: &str,
        next_run: Option<&DateTime<Utc>>,
        created_at: &DateTime<Utc>,
    ) -> Result<()> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO scheduled_tasks (id, prompt, schedule_type, schedule_value, next_run, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6)",
            params![
                id,
                prompt,
                schedule_type,
                schedule_value,
                next_run.map(|t| t.to_rfc3339()),
                created_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    /// Get a task by ID.
    pub fn get_task(&self, id: &str) -> Result<Option<ScheduledTask>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, prompt, schedule_type, schedule_value, next_run, status, created_at
             FROM scheduled_tasks WHERE id = ?1",
        )?;
        let task = stmt
            .query_row(params![id], |row| {
                Ok(ScheduledTask {
                    id: row.get(0)?,
                    prompt: row.get(1)?,
                    schedule_type: row.get(2)?,
                    schedule_value: row.get(3)?,
                    next_run: row.get(4)?,
                    status: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })
            .optional()?;
        Ok(task)
    }

    /// List all tasks, newest first.
    pub fn list_tasks(&self) -> Result<Vec<ScheduledTask>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, prompt, schedule_type, schedule_value, next_run, status, created_at
             FROM scheduled_tasks ORDER BY created_at DESC",
        )?;
        let tasks = stmt
            .query_map([], |row| {
                Ok(ScheduledTask {
                    id: row.get(0)?,
                    prompt: row.get(1)?,
                    schedule_type: row.get(2)?,
                    schedule_value: row.get(3)?,
                    next_run: row.get(4)?,
                    status: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(tasks)
    }

    /// Get all active tasks whose next_run is at or before `now`.
    pub fn get_due_tasks(&self, now: &DateTime<Utc>) -> Result<Vec<ScheduledTask>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, prompt, schedule_type, schedule_value, next_run, status, created_at
             FROM scheduled_tasks
             WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?1
             ORDER BY next_run",
        )?;
        let tasks = stmt
            .query_map(params![now.to_rfc3339()], |row| {
                Ok(ScheduledTask {
                    id: row.get(0)?,
                    prompt: row.get(1)?,
                    schedule_type: row.get(2)?,
                    schedule_value: row.get(3)?,
                    next_run: row.get(4)?,
                    status: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(tasks)
    }

    /// Update a task's status (e.g. to "paused" or "completed").
    pub fn update_task_status(&self, id: &str, status: &str) -> Result<()> {
        let conn = self.lock();
        conn.execute(
            "UPDATE scheduled_tasks SET status = ?1 WHERE id = ?2",
            params![status, id],
        )?;
        Ok(())
    }

    /// Update a task after it runs: set next_run, and mark completed if next_run is None.
    pub fn update_task_after_run(&self, id: &str, next_run: Option<&DateTime<Utc>>) -> Result<()> {
        let conn = self.lock();
        match next_run {
            Some(nr) => {
                conn.execute(
                    "UPDATE scheduled_tasks SET next_run = ?1 WHERE id = ?2",
                    params![nr.to_rfc3339(), id],
                )?;
            }
            None => {
                conn.execute(
                    "UPDATE scheduled_tasks SET next_run = NULL, status = 'completed' WHERE id = ?1",
                    params![id],
                )?;
            }
        }
        Ok(())
    }

    /// Delete a task and its run logs.
    pub fn delete_task(&self, id: &str) -> Result<()> {
        let conn = self.lock();
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM task_run_logs WHERE task_id = ?1", params![id])?;
        tx.execute("DELETE FROM scheduled_tasks WHERE id = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    // ── Task Run Logs ─────────────────────────────────────────────────

    /// Record the result of a task execution.
    pub fn log_task_run(
        &self,
        task_id: &str,
        run_at: &DateTime<Utc>,
        duration_ms: i64,
        status: &str,
        result: Option<&str>,
        error: Option<&str>,
    ) -> Result<()> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                task_id,
                run_at.to_rfc3339(),
                duration_ms,
                status,
                result,
                error
            ],
        )?;
        Ok(())
    }
}

// ── Data types ────────────────────────────────────────────────────────

/// A message retrieved from the database.
#[derive(Debug, Clone)]
pub struct StoredMessage {
    pub id: String,
    pub role: String,
    /// JSON-encoded content blocks.
    pub content: String,
    pub timestamp: String,
    pub token_estimate: i64,
}

/// A scheduled task retrieved from the database.
#[derive(Debug, Clone)]
pub struct ScheduledTask {
    pub id: String,
    pub prompt: String,
    pub schedule_type: String,
    pub schedule_value: String,
    pub next_run: Option<String>,
    pub status: String,
    pub created_at: String,
}

// ── Tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn test_db() -> Database {
        Database::open_in_memory().unwrap()
    }

    #[test]
    fn test_store_and_load_messages() {
        let db = test_db();
        let now = Utc::now();

        db.store_message(
            "m1",
            "user",
            r#"[{"type":"text","text":"hello"}]"#,
            &now,
            10,
        )
        .unwrap();
        db.store_message(
            "m2",
            "assistant",
            r#"[{"type":"text","text":"hi there"}]"#,
            &(now + chrono::Duration::seconds(1)),
            15,
        )
        .unwrap();

        let messages = db.load_context(100).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[1].role, "assistant");
    }

    #[test]
    fn test_load_context_respects_token_budget() {
        let db = test_db();
        let now = Utc::now();

        // Three messages of 100 tokens each; budget of 250 should yield 2.
        for i in 0..3 {
            db.store_message(
                &format!("m{i}"),
                "user",
                r#"[{"type":"text","text":"msg"}]"#,
                &(now + chrono::Duration::seconds(i)),
                100,
            )
            .unwrap();
        }

        let messages = db.load_context(250).unwrap();
        assert_eq!(messages.len(), 2);
        // Should be the two most recent
        assert_eq!(messages[0].id, "m1");
        assert_eq!(messages[1].id, "m2");
    }

    #[test]
    fn test_load_context_always_includes_at_least_one() {
        let db = test_db();
        let now = Utc::now();

        db.store_message(
            "m1",
            "user",
            r#"[{"type":"text","text":"big"}]"#,
            &now,
            9999,
        )
        .unwrap();

        // Budget is smaller than the single message, but we still get it.
        let messages = db.load_context(10).unwrap();
        assert_eq!(messages.len(), 1);
    }

    #[test]
    fn test_clear_messages() {
        let db = test_db();
        let now = Utc::now();

        db.store_message("m1", "user", "[]", &now, 5).unwrap();
        db.clear_messages().unwrap();

        let messages = db.load_context(1000).unwrap();
        assert!(messages.is_empty());
    }

    #[test]
    fn test_create_and_get_task() {
        let db = test_db();
        let now = Utc::now();
        let run_at = now + chrono::Duration::hours(1);

        db.create_task("t1", "say hello", "once", "in 1 hour", Some(&run_at), &now)
            .unwrap();

        let task = db.get_task("t1").unwrap().unwrap();
        assert_eq!(task.prompt, "say hello");
        assert_eq!(task.schedule_type, "once");
        assert_eq!(task.status, "active");
    }

    #[test]
    fn test_get_nonexistent_task() {
        let db = test_db();
        let task = db.get_task("nope").unwrap();
        assert!(task.is_none());
    }

    #[test]
    fn test_list_tasks() {
        let db = test_db();
        let now = Utc::now();
        let next = now + chrono::Duration::hours(1);

        db.create_task("t1", "first", "once", "val", None, &now)
            .unwrap();
        db.create_task(
            "t2",
            "second",
            "cron",
            "0 9 * * *",
            Some(&next),
            &(now + chrono::Duration::seconds(1)),
        )
        .unwrap();

        let tasks = db.list_tasks().unwrap();
        assert_eq!(tasks.len(), 2);
        // Newest first
        assert_eq!(tasks[0].id, "t2");
    }

    #[test]
    fn test_get_due_tasks() {
        let db = test_db();
        let now = Utc::now();
        let past = now - chrono::Duration::hours(1);
        let future = now + chrono::Duration::hours(1);

        db.create_task("due", "past task", "once", "val", Some(&past), &now)
            .unwrap();
        db.create_task("not_due", "future task", "once", "val", Some(&future), &now)
            .unwrap();

        let due = db.get_due_tasks(&now).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].id, "due");
    }

    #[test]
    fn test_update_task_status() {
        let db = test_db();
        let now = Utc::now();

        db.create_task("t1", "task", "once", "val", None, &now)
            .unwrap();
        db.update_task_status("t1", "paused").unwrap();

        let task = db.get_task("t1").unwrap().unwrap();
        assert_eq!(task.status, "paused");
    }

    #[test]
    fn test_update_task_after_run_with_next_run() {
        let db = test_db();
        let now = Utc::now();
        let first_run = now + chrono::Duration::hours(1);
        let second_run = now + chrono::Duration::hours(25);

        db.create_task(
            "t1",
            "recurring",
            "cron",
            "0 9 * * *",
            Some(&first_run),
            &now,
        )
        .unwrap();
        db.update_task_after_run("t1", Some(&second_run)).unwrap();

        let task = db.get_task("t1").unwrap().unwrap();
        assert_eq!(
            task.next_run.as_deref(),
            Some(second_run.to_rfc3339().as_str())
        );
        assert_eq!(task.status, "active");
    }

    #[test]
    fn test_update_task_after_run_completes_one_shot() {
        let db = test_db();
        let now = Utc::now();
        let run_at = now + chrono::Duration::hours(1);

        db.create_task("t1", "once", "once", "val", Some(&run_at), &now)
            .unwrap();
        db.update_task_after_run("t1", None).unwrap();

        let task = db.get_task("t1").unwrap().unwrap();
        assert!(task.next_run.is_none());
        assert_eq!(task.status, "completed");
    }

    #[test]
    fn test_delete_task_cascades_to_logs() {
        let db = test_db();
        let now = Utc::now();

        db.create_task("t1", "task", "once", "val", None, &now)
            .unwrap();
        db.log_task_run("t1", &now, 42, "success", Some("done"), None)
            .unwrap();

        db.delete_task("t1").unwrap();

        assert!(db.get_task("t1").unwrap().is_none());
        // Verify logs are also gone
        let conn = db.lock();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM task_run_logs WHERE task_id = 't1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn test_log_task_run() {
        let db = test_db();
        let now = Utc::now();

        db.create_task("t1", "task", "once", "val", None, &now)
            .unwrap();
        db.log_task_run("t1", &now, 150, "success", Some("result text"), None)
            .unwrap();
        db.log_task_run(
            "t1",
            &(now + chrono::Duration::seconds(60)),
            200,
            "error",
            None,
            Some("connection refused"),
        )
        .unwrap();

        let conn = db.lock();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM task_run_logs WHERE task_id = 't1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
    }

    // ── Additional edge-case tests ────────────────────────────────────

    #[test]
    fn test_load_context_empty_database() {
        let db = test_db();
        let messages = db.load_context(1000).unwrap();
        assert!(messages.is_empty());
    }

    #[test]
    fn test_load_context_exact_budget_match() {
        let db = test_db();
        let now = Utc::now();

        // Two messages totalling exactly the budget (50 + 50 = 100).
        db.store_message("m1", "user", "[]", &now, 50).unwrap();
        db.store_message(
            "m2",
            "assistant",
            "[]",
            &(now + chrono::Duration::seconds(1)),
            50,
        )
        .unwrap();

        // Budget equals total: both messages should be returned.
        let messages = db.load_context(100).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].id, "m1");
        assert_eq!(messages[1].id, "m2");
    }

    #[test]
    fn test_load_context_budget_exceeded_by_one() {
        let db = test_db();
        let now = Utc::now();

        // Three messages: 40 + 40 + 40 = 120. Budget 99 fits only the 2 most recent.
        for i in 0..3 {
            db.store_message(
                &format!("m{i}"),
                "user",
                "[]",
                &(now + chrono::Duration::seconds(i)),
                40,
            )
            .unwrap();
        }

        let messages = db.load_context(99).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].id, "m1");
        assert_eq!(messages[1].id, "m2");
    }

    #[test]
    fn test_store_message_replace_existing() {
        let db = test_db();
        let now = Utc::now();

        db.store_message("m1", "user", "original", &now, 10)
            .unwrap();
        // INSERT OR REPLACE with the same id should update the row.
        db.store_message("m1", "user", "updated", &now, 20).unwrap();

        let messages = db.load_context(1000).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].content, "updated");
        assert_eq!(messages[0].token_estimate, 20);
    }

    #[test]
    fn test_get_due_tasks_exact_timestamp_match() {
        let db = test_db();
        let now = Utc::now();

        // Task whose next_run equals exactly `now`.
        db.create_task("exact", "right on time", "once", "val", Some(&now), &now)
            .unwrap();

        let due = db.get_due_tasks(&now).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].id, "exact");
    }

    #[test]
    fn test_get_due_tasks_excludes_paused_tasks() {
        let db = test_db();
        let now = Utc::now();
        let past = now - chrono::Duration::hours(1);

        db.create_task("paused_task", "paused", "once", "val", Some(&past), &now)
            .unwrap();
        db.update_task_status("paused_task", "paused").unwrap();

        let due = db.get_due_tasks(&now).unwrap();
        assert!(due.is_empty());
    }

    #[test]
    fn test_get_due_tasks_excludes_completed_tasks() {
        let db = test_db();
        let now = Utc::now();
        let past = now - chrono::Duration::hours(1);

        db.create_task("done_task", "completed", "once", "val", Some(&past), &now)
            .unwrap();
        db.update_task_status("done_task", "completed").unwrap();

        let due = db.get_due_tasks(&now).unwrap();
        assert!(due.is_empty());
    }

    #[test]
    fn test_get_due_tasks_excludes_null_next_run() {
        let db = test_db();
        let now = Utc::now();

        // Active task but next_run is NULL.
        db.create_task("no_run", "waiting", "cron", "0 * * * *", None, &now)
            .unwrap();

        let due = db.get_due_tasks(&now).unwrap();
        assert!(due.is_empty());
    }

    #[test]
    fn test_list_tasks_empty_database() {
        let db = test_db();
        let tasks = db.list_tasks().unwrap();
        assert!(tasks.is_empty());
    }

    #[test]
    fn test_clear_messages_idempotent() {
        let db = test_db();

        // Clearing an already-empty table should not error.
        db.clear_messages().unwrap();
        db.clear_messages().unwrap();

        let messages = db.load_context(1000).unwrap();
        assert!(messages.is_empty());
    }

    #[test]
    fn test_delete_nonexistent_task() {
        let db = test_db();

        // Deleting a task that does not exist should succeed without error.
        db.delete_task("ghost").unwrap();
    }

    #[test]
    fn test_log_task_run_with_no_result_or_error() {
        let db = test_db();
        let now = Utc::now();

        db.create_task("t1", "task", "once", "val", None, &now)
            .unwrap();
        db.log_task_run("t1", &now, 0, "skipped", None, None)
            .unwrap();

        let conn = db.lock();
        let (result, error): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT result, error FROM task_run_logs WHERE task_id = 't1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(result.is_none());
        assert!(error.is_none());
    }

    #[test]
    fn test_create_task_with_none_next_run() {
        let db = test_db();
        let now = Utc::now();

        db.create_task("t1", "no schedule yet", "once", "val", None, &now)
            .unwrap();

        let task = db.get_task("t1").unwrap().unwrap();
        assert!(task.next_run.is_none());
        assert_eq!(task.status, "active");
    }

    #[test]
    fn test_load_context_zero_budget() {
        let db = test_db();
        let now = Utc::now();

        db.store_message("m1", "user", "[]", &now, 10).unwrap();

        // Zero budget: still returns at least one message (the guarantee).
        let messages = db.load_context(0).unwrap();
        assert_eq!(messages.len(), 1);
    }

    #[test]
    fn test_load_context_chronological_order() {
        let db = test_db();
        let now = Utc::now();

        // Insert messages out of order by id but with sequential timestamps.
        db.store_message("c", "user", "[]", &now, 10).unwrap();
        db.store_message(
            "a",
            "assistant",
            "[]",
            &(now + chrono::Duration::seconds(1)),
            10,
        )
        .unwrap();
        db.store_message("b", "user", "[]", &(now + chrono::Duration::seconds(2)), 10)
            .unwrap();

        let messages = db.load_context(1000).unwrap();
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0].id, "c");
        assert_eq!(messages[1].id, "a");
        assert_eq!(messages[2].id, "b");
    }

    #[test]
    fn test_get_due_tasks_ordering() {
        let db = test_db();
        let now = Utc::now();
        let t1 = now - chrono::Duration::minutes(30);
        let t2 = now - chrono::Duration::minutes(60);

        db.create_task("later", "task1", "once", "v", Some(&t1), &now)
            .unwrap();
        db.create_task("earlier", "task2", "once", "v", Some(&t2), &now)
            .unwrap();

        let due = db.get_due_tasks(&now).unwrap();
        assert_eq!(due.len(), 2);
        // Ordered by next_run ascending: earlier first.
        assert_eq!(due[0].id, "earlier");
        assert_eq!(due[1].id, "later");
    }

    #[test]
    fn test_update_task_status_preserves_other_fields() {
        let db = test_db();
        let now = Utc::now();
        let next = now + chrono::Duration::hours(1);

        db.create_task("t1", "my prompt", "cron", "0 9 * * *", Some(&next), &now)
            .unwrap();
        db.update_task_status("t1", "paused").unwrap();

        let task = db.get_task("t1").unwrap().unwrap();
        assert_eq!(task.status, "paused");
        assert_eq!(task.prompt, "my prompt");
        assert_eq!(task.schedule_type, "cron");
        assert!(task.next_run.is_some());
    }

    #[test]
    fn test_multiple_task_run_logs_for_same_task() {
        let db = test_db();
        let now = Utc::now();

        db.create_task("t1", "task", "cron", "0 * * * *", None, &now)
            .unwrap();

        // Log five runs.
        for i in 0..5 {
            db.log_task_run(
                "t1",
                &(now + chrono::Duration::minutes(i)),
                100 + i as i64,
                "success",
                Some(&format!("run {i}")),
                None,
            )
            .unwrap();
        }

        let conn = db.lock();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM task_run_logs WHERE task_id = 't1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 5);
    }
}
