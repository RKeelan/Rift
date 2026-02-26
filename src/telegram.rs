use std::sync::Arc;

use teloxide::prelude::*;
use tracing::{debug, error, info};

use crate::agent::types::{ContentBlock, Message as AgentMessage, Role};
use crate::agent::{Agent, ToolExecutor};
use crate::db::Database;

const MAX_MESSAGE_LEN: usize = 4096;
const TOKEN_BUDGET: i64 = 100_000;

const SYSTEM_PROMPT: &str = "\
You are Imp, a personal AI assistant on Telegram. \
Be helpful, concise, and conversational. \
You have access to tools for scheduling tasks and fetching web content.";

/// Newtype to distinguish the owner's chat ID from other `ChatId` values in the DI container.
#[derive(Clone, Copy)]
struct OwnerChatId(ChatId);

/// Split text into chunks that fit within Telegram's message length limit.
/// Prefers splitting at paragraph boundaries, then line boundaries, then word boundaries.
pub fn split_message(text: &str) -> Vec<&str> {
    if text.len() <= MAX_MESSAGE_LEN {
        return vec![text];
    }

    let mut chunks = Vec::new();
    let mut remaining = text;

    while !remaining.is_empty() {
        if remaining.len() <= MAX_MESSAGE_LEN {
            chunks.push(remaining);
            break;
        }

        // Find the largest byte offset <= MAX_MESSAGE_LEN that sits on a char boundary.
        let mut window_end = MAX_MESSAGE_LEN;
        while window_end > 0 && !remaining.is_char_boundary(window_end) {
            window_end -= 1;
        }

        let search = &remaining[..window_end];
        let split_at = search
            .rfind("\n\n")
            .or_else(|| search.rfind('\n'))
            .or_else(|| search.rfind(' '))
            .unwrap_or(window_end);

        if split_at == 0 {
            chunks.push(remaining);
            break;
        }

        chunks.push(&remaining[..split_at]);
        remaining = remaining[split_at..].trim_start();
    }

    chunks
}

/// Start the Telegram bot and block until shutdown.
pub async fn run(
    bot: Bot,
    owner_chat_id: i64,
    db: Arc<Database>,
    agent: Arc<dyn Agent>,
    tool_executor: Arc<dyn ToolExecutor>,
) {
    info!("starting Telegram bot");

    let handler = Update::filter_message().endpoint(handle_message);

    Dispatcher::builder(bot, handler)
        .dependencies(teloxide::dptree::deps![
            OwnerChatId(ChatId(owner_chat_id)),
            db,
            agent,
            tool_executor
        ])
        .default_handler(|_| async {})
        .build()
        .dispatch()
        .await;
}

async fn handle_message(
    bot: Bot,
    msg: Message,
    owner: OwnerChatId,
    db: Arc<Database>,
    agent: Arc<dyn Agent>,
    tool_executor: Arc<dyn ToolExecutor>,
) -> ResponseResult<()> {
    // Owner-only filter: silently drop messages from non-owner
    if msg.chat.id != owner.0 {
        debug!(chat_id = %msg.chat.id, "ignoring message from non-owner");
        return Ok(());
    }

    let text = match msg.text() {
        Some(t) => t.to_string(),
        None => {
            debug!("ignoring non-text message");
            return Ok(());
        }
    };

    debug!(len = text.len(), "received message from owner");

    // Store user message (run on blocking thread to avoid stalling the async runtime)
    let msg_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now();
    let token_estimate = (text.len() as i64) / 4;
    let content_json = serde_json::to_string(&vec![ContentBlock::text(&text)])
        .unwrap_or_else(|_| "[]".to_string());

    let db_store = db.clone();
    let store_result = tokio::task::spawn_blocking(move || {
        db_store.store_message(&msg_id, "user", &content_json, &now, token_estimate)
    })
    .await
    .expect("spawn_blocking panicked");

    if let Err(e) = store_result {
        error!(error = %e, "failed to store user message");
        bot.send_message(msg.chat.id, "Internal error storing message.")
            .await?;
        return Ok(());
    }

    // Load conversation context (run on blocking thread)
    let db_load = db.clone();
    let load_result = tokio::task::spawn_blocking(move || db_load.load_context(TOKEN_BUDGET))
        .await
        .expect("spawn_blocking panicked");

    let stored = match load_result {
        Ok(msgs) => msgs,
        Err(e) => {
            error!(error = %e, "failed to load context");
            bot.send_message(msg.chat.id, "Internal error loading context.")
                .await?;
            return Ok(());
        }
    };

    // Convert stored messages to agent format
    let agent_messages: Vec<AgentMessage> = stored
        .iter()
        .filter_map(|s| {
            let role = match s.role.as_str() {
                "user" => Role::User,
                "assistant" => Role::Assistant,
                _ => return None,
            };
            let content: Vec<ContentBlock> = serde_json::from_str(&s.content).ok()?;
            Some(AgentMessage { role, content })
        })
        .collect();

    // Call the agent, with filler messages on retries
    let (retry_tx, mut retry_rx) = tokio::sync::mpsc::unbounded_channel();
    let filler_bot = bot.clone();
    let filler_chat_id = msg.chat.id;
    let filler_task = tokio::spawn(async move {
        const FILLERS: &[&str] = &["Uh\u{2014}", "Um...", "That is..", "You see\u{2014}", "Hm."];
        let mut i = 0;
        while retry_rx.recv().await.is_some() {
            let filler = FILLERS[i.min(FILLERS.len() - 1)];
            let _ = filler_bot.send_message(filler_chat_id, filler).await;
            i += 1;
        }
    });

    let response = match agent
        .send(
            Some(SYSTEM_PROMPT),
            agent_messages,
            tool_executor.as_ref(),
            Some(&retry_tx),
        )
        .await
    {
        Ok(r) => r,
        Err(e) => {
            error!(error = %e, "agent error");
            bot.send_message(
                msg.chat.id,
                "Something went wrong. Check the logs for details.",
            )
            .await?;
            filler_task.abort();
            return Ok(());
        }
    };
    drop(retry_tx);
    filler_task.abort();

    info!(
        input_tokens = response.input_tokens,
        output_tokens = response.output_tokens,
        "agent response"
    );

    // Store assistant response (run on blocking thread)
    let resp_id = uuid::Uuid::new_v4().to_string();
    let resp_now = chrono::Utc::now();
    let resp_tokens = (response.text.len() as i64) / 4;
    let resp_json = serde_json::to_string(&vec![ContentBlock::text(&response.text)])
        .unwrap_or_else(|_| "[]".to_string());

    let db_resp = db.clone();
    let resp_result = tokio::task::spawn_blocking(move || {
        db_resp.store_message(&resp_id, "assistant", &resp_json, &resp_now, resp_tokens)
    })
    .await
    .expect("spawn_blocking panicked");

    if let Err(e) = resp_result {
        error!(error = %e, "failed to store assistant response");
    }

    // Send response, splitting for Telegram's length limit
    for chunk in split_message(&response.text) {
        if !chunk.is_empty() {
            bot.send_message(msg.chat.id, chunk).await?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_split_short_message() {
        let chunks = split_message("hello");
        assert_eq!(chunks, vec!["hello"]);
    }

    #[test]
    fn test_split_empty_message() {
        let chunks = split_message("");
        assert_eq!(chunks, vec![""]);
    }

    #[test]
    fn test_split_at_paragraph_boundary() {
        let first = "a".repeat(3000);
        let second = "b".repeat(3000);
        let text = format!("{first}\n\n{second}");
        let chunks = split_message(&text);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0], first);
        assert_eq!(chunks[1], second);
    }

    #[test]
    fn test_split_at_line_boundary() {
        let first = "a".repeat(3000);
        let second = "b".repeat(3000);
        let text = format!("{first}\n{second}");
        let chunks = split_message(&text);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0], first);
        assert_eq!(chunks[1], second);
    }

    #[test]
    fn test_split_at_word_boundary() {
        let first = "a".repeat(3000);
        let second = "b".repeat(3000);
        let text = format!("{first} {second}");
        let chunks = split_message(&text);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0], first);
        assert_eq!(chunks[1], second);
    }

    #[test]
    fn test_split_no_boundary() {
        let text = "a".repeat(5000);
        let chunks = split_message(&text);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].len(), MAX_MESSAGE_LEN);
        assert_eq!(chunks[1].len(), 5000 - MAX_MESSAGE_LEN);
    }

    #[test]
    fn test_split_exact_limit() {
        let text = "a".repeat(MAX_MESSAGE_LEN);
        let chunks = split_message(&text);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].len(), MAX_MESSAGE_LEN);
    }

    #[test]
    fn test_split_one_over_limit() {
        let text = "a".repeat(MAX_MESSAGE_LEN + 1);
        let chunks = split_message(&text);
        assert_eq!(chunks.len(), 2);
    }

    #[test]
    fn test_split_prefers_paragraph_over_line() {
        // Text with both \n\n and \n before the limit
        let first = "a".repeat(1000);
        let middle = "b".repeat(1000);
        let rest = "c".repeat(3000);
        let text = format!("{first}\n\n{middle}\n{rest}");
        let chunks = split_message(&text);
        // Should split at the \n after middle (closer to limit) rather than \n\n
        // Actually \n\n comes first in rfind (searches backward), so let me think...
        // rfind("\n\n") searches from the end of the 4096-byte window.
        // The \n is at position 1000+2+1000 = 2002 and the \n\n is at position 1000.
        // rfind("\n\n") finds position 1000. rfind('\n') would find position 2002.
        // Since we try \n\n first and it succeeds, split_at = 1000.
        assert_eq!(chunks[0], first);
    }

    #[test]
    fn test_split_multiple_chunks() {
        // Create text needing 3 chunks: 3 * 3000 = 9000 chars with spaces
        let part = "a".repeat(3000);
        let text = format!("{part} {part} {part}");
        let chunks = split_message(&text);
        assert!(chunks.len() >= 3);
    }

    // ── Additional edge-case tests ──────────────────────────────────

    #[test]
    fn test_split_multibyte_utf8_boundary() {
        // Place multi-byte characters right around the split boundary.
        // Each emoji is 4 bytes. Fill up to near the limit with ASCII, then
        // put emoji at the boundary so a naive byte-slice would split mid-char.
        let prefix = "x".repeat(MAX_MESSAGE_LEN - 3); // 4093 ASCII bytes
        let emoji = "\u{1F600}"; // 4-byte emoji
        let text = format!("{prefix}{emoji}{emoji}");
        let chunks = split_message(&text);
        // Must not panic and every chunk must be valid UTF-8 (Rust guarantees
        // &str is valid, so reaching here without panic proves correctness).
        assert!(chunks.len() >= 2);
        // All content must be recoverable
        let reassembled: String = chunks.join("");
        assert_eq!(reassembled, text);
    }

    #[test]
    fn test_split_only_multibyte_chars() {
        // A string made entirely of 4-byte emoji, exceeding the limit.
        let emoji = "\u{1F600}"; // 4 bytes
        let count = (MAX_MESSAGE_LEN / 4) + 10; // slightly over limit in bytes
        let text: String = emoji.repeat(count);
        assert!(text.len() > MAX_MESSAGE_LEN);
        let chunks = split_message(&text);
        assert!(chunks.len() >= 2);
        let reassembled: String = chunks.join("");
        assert_eq!(reassembled, text);
    }

    #[test]
    fn test_split_preserves_all_content() {
        // With word boundaries, trim_start removes the delimiter, but all
        // non-whitespace content must survive.
        let first = "a".repeat(2000);
        let second = "b".repeat(2000);
        let third = "c".repeat(2000);
        let text = format!("{first} {second} {third}");
        let chunks = split_message(&text);
        let reassembled: String = chunks.join(" ");
        // The original separators are single spaces which get trimmed; joining
        // with spaces restores them.
        assert_eq!(reassembled, text);
    }

    #[test]
    fn test_split_whitespace_between_chunks_is_trimmed() {
        // Multiple spaces at the split point: rfind(' ') finds the last space
        // within the window, so the first chunk includes preceding spaces.
        // The trailing whitespace on the next chunk gets trim_start'd.
        let first = "a".repeat(4000);
        let second = "b".repeat(2000);
        let text = format!("{first}     {second}");
        let chunks = split_message(&text);
        assert_eq!(chunks.len(), 2);
        // First chunk is everything up to the last space in the window.
        // With 4000 a's + 5 spaces, positions 4000-4004 are spaces.
        // Window is 4096 bytes, rfind(' ') finds position 4004.
        // So chunks[0] = "a"*4000 + "    " (4 spaces).
        assert!(chunks[0].starts_with(&first));
        // Second chunk starts with 'b' after trimming remaining whitespace.
        assert_eq!(chunks[1], second);
    }

    #[test]
    fn test_split_newline_trimming_between_chunks() {
        // When splitting at \n, the \n and any following whitespace on the
        // next chunk should be trimmed.
        let first = "a".repeat(4000);
        let second = "b".repeat(2000);
        let text = format!("{first}\n   {second}");
        let chunks = split_message(&text);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0], first);
        assert_eq!(chunks[1], second);
    }

    #[test]
    fn test_split_single_char_message() {
        let chunks = split_message("x");
        assert_eq!(chunks, vec!["x"]);
    }

    #[test]
    fn test_split_paragraph_boundary_rfind_selects_last() {
        // Two paragraph boundaries within the window: rfind should pick the one
        // closer to the end (maximizing chunk size).
        let a = "a".repeat(1000);
        let b = "b".repeat(1000);
        let c = "c".repeat(1500);
        let rest = "d".repeat(2000);
        // Layout: a(1000) \n\n b(1000) \n\n c(1500) \n\n rest(2000)
        // Total before last \n\n: 1000+2+1000+2+1500 = 3504
        // 3504 + 2 + 2000 = 5506 > 4096
        // Window is first 4096 bytes. rfind("\n\n") finds the \n\n at pos 3504.
        let text = format!("{a}\n\n{b}\n\n{c}\n\n{rest}");
        let chunks = split_message(&text);
        assert_eq!(chunks[0], format!("{a}\n\n{b}\n\n{c}"));
    }

    #[test]
    fn test_split_very_long_message() {
        // 50,000 chars split by spaces every 100 chars
        let word = "a".repeat(100);
        let words: Vec<&str> = (0..500).map(|_| word.as_str()).collect();
        let text = words.join(" ");
        let chunks = split_message(&text);

        // Verify no chunk exceeds the limit
        for (i, chunk) in chunks.iter().enumerate() {
            assert!(
                chunk.len() <= MAX_MESSAGE_LEN,
                "chunk {i} has length {} which exceeds {MAX_MESSAGE_LEN}",
                chunk.len()
            );
        }

        // Verify all content is present
        let reassembled = chunks.join(" ");
        assert_eq!(reassembled.len(), text.len());
    }

    // ── Integration test: message handling flow ─────────────────────

    use crate::agent::types::ToolDefinition;
    use crate::agent::{AgentResponse, RetryNotifier};
    use crate::db::Database;
    use async_trait::async_trait;

    /// Mock agent that returns a fixed response.
    struct MockAgent {
        response_text: String,
    }

    #[async_trait]
    impl Agent for MockAgent {
        async fn send(
            &self,
            _system: Option<&str>,
            _messages: Vec<AgentMessage>,
            _tool_executor: &dyn ToolExecutor,
            _retry_tx: Option<&RetryNotifier>,
        ) -> crate::error::Result<AgentResponse> {
            Ok(AgentResponse {
                text: self.response_text.clone(),
                input_tokens: 42,
                output_tokens: 10,
            })
        }
    }

    /// Mock tool executor with no tools.
    struct NoOpToolExecutor;

    #[async_trait]
    impl ToolExecutor for NoOpToolExecutor {
        fn tool_definitions(&self) -> Vec<ToolDefinition> {
            vec![]
        }

        async fn execute(
            &self,
            tool_use_id: &str,
            name: &str,
            _input: &serde_json::Value,
        ) -> ContentBlock {
            ContentBlock::tool_error(tool_use_id, format!("unknown tool: {name}"))
        }
    }

    /// Exercise the core message flow that handle_message performs:
    /// store user message -> load context -> convert to agent messages ->
    /// call agent -> store response -> split for sending.
    #[tokio::test]
    async fn test_message_flow_store_call_store_split() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let agent: Arc<dyn Agent> = Arc::new(MockAgent {
            response_text: "Hello from mock agent!".to_string(),
        });
        let tool_executor: Arc<dyn ToolExecutor> = Arc::new(NoOpToolExecutor);

        // Simulate what handle_message does:

        // 1. Store user message
        let user_text = "Hi there";
        let msg_id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now();
        let token_estimate = (user_text.len() as i64) / 4;
        let content_json = serde_json::to_string(&vec![ContentBlock::text(user_text)]).unwrap();
        db.store_message(&msg_id, "user", &content_json, &now, token_estimate)
            .unwrap();

        // 2. Load context
        let stored = db.load_context(TOKEN_BUDGET).unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].role, "user");

        // 3. Convert to agent messages
        let agent_messages: Vec<AgentMessage> = stored
            .iter()
            .filter_map(|s| {
                let role = match s.role.as_str() {
                    "user" => Role::User,
                    "assistant" => Role::Assistant,
                    _ => return None,
                };
                let content: Vec<ContentBlock> = serde_json::from_str(&s.content).ok()?;
                Some(AgentMessage { role, content })
            })
            .collect();
        assert_eq!(agent_messages.len(), 1);
        assert!(matches!(agent_messages[0].role, Role::User));

        // 4. Call agent
        let response = agent
            .send(
                Some(SYSTEM_PROMPT),
                agent_messages,
                tool_executor.as_ref(),
                None,
            )
            .await
            .unwrap();
        assert_eq!(response.text, "Hello from mock agent!");
        assert_eq!(response.input_tokens, 42);
        assert_eq!(response.output_tokens, 10);

        // 5. Store assistant response
        let resp_id = uuid::Uuid::new_v4().to_string();
        let resp_now = chrono::Utc::now();
        let resp_tokens = (response.text.len() as i64) / 4;
        let resp_json = serde_json::to_string(&vec![ContentBlock::text(&response.text)]).unwrap();
        db.store_message(&resp_id, "assistant", &resp_json, &resp_now, resp_tokens)
            .unwrap();

        // 6. Verify both messages are in the database
        let all = db.load_context(TOKEN_BUDGET).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].role, "user");
        assert_eq!(all[1].role, "assistant");

        // 7. Split response for sending
        let chunks = split_message(&response.text);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0], "Hello from mock agent!");
    }

    /// Verify the flow works correctly with a long agent response that requires splitting.
    #[tokio::test]
    async fn test_message_flow_with_long_response() {
        let long_response = format!("{}\n\n{}", "a".repeat(3000), "b".repeat(3000));
        let db = Arc::new(Database::open_in_memory().unwrap());
        let agent: Arc<dyn Agent> = Arc::new(MockAgent {
            response_text: long_response.clone(),
        });
        let tool_executor: Arc<dyn ToolExecutor> = Arc::new(NoOpToolExecutor);

        // Store user message
        let content_json =
            serde_json::to_string(&vec![ContentBlock::text("Tell me a long story")]).unwrap();
        let now = chrono::Utc::now();
        db.store_message("m1", "user", &content_json, &now, 10)
            .unwrap();

        // Load context and call agent
        let stored = db.load_context(TOKEN_BUDGET).unwrap();
        let agent_messages: Vec<AgentMessage> = stored
            .iter()
            .filter_map(|s| {
                let role = match s.role.as_str() {
                    "user" => Role::User,
                    "assistant" => Role::Assistant,
                    _ => return None,
                };
                let content: Vec<ContentBlock> = serde_json::from_str(&s.content).ok()?;
                Some(AgentMessage { role, content })
            })
            .collect();

        let response = agent
            .send(
                Some(SYSTEM_PROMPT),
                agent_messages,
                tool_executor.as_ref(),
                None,
            )
            .await
            .unwrap();

        // Store response
        let resp_json = serde_json::to_string(&vec![ContentBlock::text(&response.text)]).unwrap();
        db.store_message("m2", "assistant", &resp_json, &chrono::Utc::now(), 1500)
            .unwrap();

        // Split and verify
        let chunks = split_message(&response.text);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0], "a".repeat(3000));
        assert_eq!(chunks[1], "b".repeat(3000));

        // Verify DB has both messages
        let all = db.load_context(TOKEN_BUDGET).unwrap();
        assert_eq!(all.len(), 2);
    }

    /// Verify that context from multiple rounds of conversation loads correctly.
    #[tokio::test]
    async fn test_message_flow_multi_turn_context() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let agent: Arc<dyn Agent> = Arc::new(MockAgent {
            response_text: "Response 3".to_string(),
        });
        let tool_executor: Arc<dyn ToolExecutor> = Arc::new(NoOpToolExecutor);
        let now = chrono::Utc::now();

        // Simulate two prior turns already in the database
        let turns = vec![
            ("m1", "user", "Hello"),
            ("m2", "assistant", "Hi there!"),
            ("m3", "user", "How are you?"),
            ("m4", "assistant", "I'm doing well."),
        ];
        for (i, (id, role, text)) in turns.iter().enumerate() {
            let content = serde_json::to_string(&vec![ContentBlock::text(*text)]).unwrap();
            let ts = now + chrono::Duration::seconds(i as i64);
            db.store_message(id, role, &content, &ts, (text.len() as i64) / 4)
                .unwrap();
        }

        // Store the new user message (turn 3)
        let new_msg_content =
            serde_json::to_string(&vec![ContentBlock::text("What is 2+2?")]).unwrap();
        let new_ts = now + chrono::Duration::seconds(10);
        db.store_message("m5", "user", &new_msg_content, &new_ts, 3)
            .unwrap();

        // Load full context
        let stored = db.load_context(TOKEN_BUDGET).unwrap();
        assert_eq!(stored.len(), 5);

        // Convert and verify role alternation
        let agent_messages: Vec<AgentMessage> = stored
            .iter()
            .filter_map(|s| {
                let role = match s.role.as_str() {
                    "user" => Role::User,
                    "assistant" => Role::Assistant,
                    _ => return None,
                };
                let content: Vec<ContentBlock> = serde_json::from_str(&s.content).ok()?;
                Some(AgentMessage { role, content })
            })
            .collect();
        assert_eq!(agent_messages.len(), 5);
        assert!(matches!(agent_messages[0].role, Role::User));
        assert!(matches!(agent_messages[1].role, Role::Assistant));
        assert!(matches!(agent_messages[2].role, Role::User));
        assert!(matches!(agent_messages[3].role, Role::Assistant));
        assert!(matches!(agent_messages[4].role, Role::User));

        // Call agent with full context
        let response = agent
            .send(
                Some(SYSTEM_PROMPT),
                agent_messages,
                tool_executor.as_ref(),
                None,
            )
            .await
            .unwrap();
        assert_eq!(response.text, "Response 3");
    }
}
