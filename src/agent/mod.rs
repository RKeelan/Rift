pub mod anthropic;
pub mod tools;
pub mod types;

use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::error::Result;
use types::{ContentBlock, Message, ToolDefinition};

/// Sender for retry notifications. Each message carries the retry attempt
/// number (0-indexed), allowing callers to react (e.g. send filler messages).
pub type RetryNotifier = mpsc::UnboundedSender<u32>;

/// Conversational agent that sends messages and returns responses.
#[async_trait]
pub trait Agent: Send + Sync {
    /// Send a conversation (with optional tool definitions) and get a response.
    /// The implementation handles the tool-use loop internally, calling
    /// `tool_executor` for each tool invocation until the model produces a
    /// final text response or the loop cap is reached.
    ///
    /// If `retry_tx` is provided, the agent sends the attempt number on each
    /// retry of a transient API error (429/529).
    async fn send(
        &self,
        system: Option<&str>,
        messages: Vec<Message>,
        tool_executor: &dyn ToolExecutor,
        retry_tx: Option<&RetryNotifier>,
    ) -> Result<AgentResponse>;
}

/// Executes tool calls requested by the agent.
#[async_trait]
pub trait ToolExecutor: Send + Sync {
    /// Return the tool definitions the model should know about.
    fn tool_definitions(&self) -> Vec<ToolDefinition>;

    /// Execute a tool call and return the result content block.
    /// `tool_use_id` must be echoed back in the `ToolResult` so the API can
    /// match results to their corresponding `tool_use` blocks.
    async fn execute(
        &self,
        tool_use_id: &str,
        name: &str,
        input: &serde_json::Value,
    ) -> ContentBlock;
}

/// The result of an agent conversation, after all tool-use loops have resolved.
#[derive(Debug)]
pub struct AgentResponse {
    /// The final text reply from the model.
    pub text: String,
    /// Total input tokens consumed across all API calls in this conversation.
    pub input_tokens: u32,
    /// Total output tokens consumed across all API calls in this conversation.
    pub output_tokens: u32,
}
