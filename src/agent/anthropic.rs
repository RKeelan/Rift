use async_trait::async_trait;
use tracing::{debug, warn};

use super::types::{
    ApiErrorResponse, ContentBlock, Message, MessagesRequest, MessagesResponse, Role, StopReason,
};
use super::{Agent, AgentResponse, ToolExecutor};
use crate::error::{ImpError, Result};

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2023-06-01";
const MAX_TOOL_LOOPS: usize = 10;
const MAX_TOKENS: u32 = 8192;

/// Agent backed by the Anthropic Messages API.
pub struct AnthropicAgent {
    client: reqwest::Client,
    api_key: String,
    model: String,
    api_url: String,
}

impl AnthropicAgent {
    pub fn new(api_key: String, model: String) -> Self {
        Self {
            client: reqwest::Client::new(),
            api_key,
            model,
            api_url: API_URL.to_string(),
        }
    }

    #[cfg(test)]
    fn with_api_url(api_key: String, model: String, api_url: String) -> Self {
        Self {
            client: reqwest::Client::new(),
            api_key,
            model,
            api_url,
        }
    }

    async fn call_api(&self, request: &MessagesRequest) -> Result<MessagesResponse> {
        let response = self
            .client
            .post(&self.api_url)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", API_VERSION)
            .header("content-type", "application/json")
            .json(request)
            .send()
            .await?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            let message = serde_json::from_str::<ApiErrorResponse>(&body)
                .map(|e| e.error.message)
                .unwrap_or(body);
            return Err(ImpError::AnthropicApi {
                status: status.as_u16(),
                message,
            });
        }

        let body = response.text().await?;
        let parsed: MessagesResponse = serde_json::from_str(&body)?;
        Ok(parsed)
    }
}

#[async_trait]
impl Agent for AnthropicAgent {
    async fn send(
        &self,
        system: Option<&str>,
        messages: Vec<Message>,
        tool_executor: &dyn ToolExecutor,
    ) -> Result<AgentResponse> {
        let tools = tool_executor.tool_definitions();
        let mut conversation = messages;
        let mut total_input = 0u32;
        let mut total_output = 0u32;

        for iteration in 0..MAX_TOOL_LOOPS {
            let request = MessagesRequest {
                model: self.model.clone(),
                max_tokens: MAX_TOKENS,
                system: system.map(String::from),
                messages: conversation.clone(),
                tools: tools.clone(),
            };

            debug!(iteration, "calling Anthropic Messages API");
            let response = self.call_api(&request).await?;

            total_input += response.usage.input_tokens;
            total_output += response.usage.output_tokens;

            debug!(
                stop_reason = ?response.stop_reason,
                input_tokens = response.usage.input_tokens,
                output_tokens = response.usage.output_tokens,
                "API response received"
            );

            // Collect tool-use blocks from the response.
            let tool_uses: Vec<_> = response
                .content
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::ToolUse { id, name, input } => {
                        Some((id.clone(), name.clone(), input.clone()))
                    }
                    _ => None,
                })
                .collect();

            // If the model didn't request any tools, extract the final text and return.
            if tool_uses.is_empty() || response.stop_reason != Some(StopReason::ToolUse) {
                let text = response
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("");

                return Ok(AgentResponse {
                    text,
                    input_tokens: total_input,
                    output_tokens: total_output,
                });
            }

            // Append the assistant's response (including tool_use blocks) to the conversation.
            conversation.push(Message {
                role: Role::Assistant,
                content: response.content,
            });

            // Execute each tool and collect results.
            let mut results = Vec::new();
            for (id, name, input) in &tool_uses {
                debug!(tool = %name, id = %id, "executing tool");
                let result = tool_executor.execute(id, name, input).await;
                debug!(tool = %name, "tool execution complete");
                results.push(result);
            }

            // Append tool results as a user message.
            conversation.push(Message {
                role: Role::User,
                content: results,
            });
        }

        warn!("tool-use loop reached maximum iterations ({MAX_TOOL_LOOPS})");
        Ok(AgentResponse {
            text: "I was unable to complete the request — the tool-use loop exceeded the maximum number of iterations.".to_string(),
            input_tokens: total_input,
            output_tokens: total_output,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::ToolExecutor;
    use super::*;
    use crate::agent::types::ToolDefinition;
    use serde_json::json;

    /// A no-op tool executor for testing the agent without real tools.
    struct EmptyToolExecutor;

    #[async_trait]
    impl ToolExecutor for EmptyToolExecutor {
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

    /// A mock tool executor that echoes the input back.
    struct EchoToolExecutor;

    #[async_trait]
    impl ToolExecutor for EchoToolExecutor {
        fn tool_definitions(&self) -> Vec<ToolDefinition> {
            vec![ToolDefinition {
                name: "echo".to_string(),
                description: "Echoes input back".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "text": {"type": "string"}
                    },
                    "required": ["text"]
                }),
            }]
        }

        async fn execute(
            &self,
            tool_use_id: &str,
            _name: &str,
            input: &serde_json::Value,
        ) -> ContentBlock {
            let text = input
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("no text");
            ContentBlock::tool_result(tool_use_id, text)
        }
    }

    #[test]
    fn test_anthropic_agent_creation() {
        let agent = AnthropicAgent::new("test-key".to_string(), "claude-sonnet-4-5".to_string());
        assert_eq!(agent.api_key, "test-key");
        assert_eq!(agent.model, "claude-sonnet-4-5");
    }

    #[test]
    fn test_messages_request_serialization() {
        let request = MessagesRequest {
            model: "claude-sonnet-4-5".to_string(),
            max_tokens: 1024,
            system: Some("You are helpful.".to_string()),
            messages: vec![Message {
                role: Role::User,
                content: vec![ContentBlock::text("Hello")],
            }],
            tools: vec![],
        };

        let json = serde_json::to_value(&request).unwrap();
        assert_eq!(json["model"], "claude-sonnet-4-5");
        assert_eq!(json["max_tokens"], 1024);
        assert_eq!(json["system"], "You are helpful.");
        assert_eq!(json["messages"][0]["role"], "user");
        assert_eq!(json["messages"][0]["content"][0]["type"], "text");
        assert_eq!(json["messages"][0]["content"][0]["text"], "Hello");
        // tools should be omitted when empty
        assert!(json.get("tools").is_none());
    }

    #[test]
    fn test_messages_request_with_tools() {
        let request = MessagesRequest {
            model: "claude-sonnet-4-5".to_string(),
            max_tokens: 1024,
            system: None,
            messages: vec![],
            tools: vec![ToolDefinition {
                name: "test_tool".to_string(),
                description: "A test tool".to_string(),
                input_schema: json!({"type": "object", "properties": {}}),
            }],
        };

        let json = serde_json::to_value(&request).unwrap();
        assert!(json.get("system").is_none());
        assert_eq!(json["tools"][0]["name"], "test_tool");
    }

    #[test]
    fn test_response_deserialization() {
        let json = json!({
            "id": "msg_123",
            "type": "message",
            "role": "assistant",
            "content": [
                {"type": "text", "text": "Hello!"}
            ],
            "model": "claude-sonnet-4-5",
            "stop_reason": "end_turn",
            "usage": {
                "input_tokens": 10,
                "output_tokens": 5
            }
        });

        let response: MessagesResponse = serde_json::from_value(json).unwrap();
        assert_eq!(response.id, "msg_123");
        assert_eq!(response.role, Role::Assistant);
        assert_eq!(response.stop_reason, Some(StopReason::EndTurn));
        assert_eq!(response.usage.input_tokens, 10);
        assert_eq!(response.usage.output_tokens, 5);

        match &response.content[0] {
            ContentBlock::Text { text } => assert_eq!(text, "Hello!"),
            _ => panic!("expected text block"),
        }
    }

    #[test]
    fn test_tool_use_response_deserialization() {
        let json = json!({
            "id": "msg_456",
            "type": "message",
            "role": "assistant",
            "content": [
                {
                    "type": "tool_use",
                    "id": "tu_789",
                    "name": "schedule_task",
                    "input": {"prompt": "hello", "schedule_type": "once", "schedule_value": "in 5 min"}
                }
            ],
            "model": "claude-sonnet-4-5",
            "stop_reason": "tool_use",
            "usage": {"input_tokens": 20, "output_tokens": 15}
        });

        let response: MessagesResponse = serde_json::from_value(json).unwrap();
        assert_eq!(response.stop_reason, Some(StopReason::ToolUse));

        match &response.content[0] {
            ContentBlock::ToolUse { id, name, input } => {
                assert_eq!(id, "tu_789");
                assert_eq!(name, "schedule_task");
                assert_eq!(input["prompt"], "hello");
            }
            _ => panic!("expected tool_use block"),
        }
    }

    #[test]
    fn test_content_block_constructors() {
        let text = ContentBlock::text("hello");
        match text {
            ContentBlock::Text { text } => assert_eq!(text, "hello"),
            _ => panic!("expected text"),
        }

        let result = ContentBlock::tool_result("tu_1", "done");
        match result {
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                assert_eq!(tool_use_id, "tu_1");
                assert_eq!(content, "done");
                assert!(is_error.is_none());
            }
            _ => panic!("expected tool_result"),
        }

        let error = ContentBlock::tool_error("tu_2", "failed");
        match error {
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                assert_eq!(tool_use_id, "tu_2");
                assert_eq!(content, "failed");
                assert_eq!(is_error, Some(true));
            }
            _ => panic!("expected tool_result with is_error"),
        }
    }

    #[test]
    fn test_api_error_deserialization() {
        let json = json!({
            "type": "error",
            "error": {
                "type": "invalid_request_error",
                "message": "max_tokens must be positive"
            }
        });

        let err: ApiErrorResponse = serde_json::from_value(json).unwrap();
        assert_eq!(err.error.error_type, "invalid_request_error");
        assert_eq!(err.error.message, "max_tokens must be positive");
    }

    #[test]
    fn test_role_display() {
        assert_eq!(Role::User.to_string(), "user");
        assert_eq!(Role::Assistant.to_string(), "assistant");
    }

    #[test]
    fn test_tool_result_serialization() {
        let block = ContentBlock::tool_result("tu_1", "result text");
        let json = serde_json::to_value(&block).unwrap();
        assert_eq!(json["type"], "tool_result");
        assert_eq!(json["tool_use_id"], "tu_1");
        assert_eq!(json["content"], "result text");
        // is_error should be omitted when None
        assert!(json.get("is_error").is_none());
    }

    #[test]
    fn test_tool_error_serialization() {
        let block = ContentBlock::tool_error("tu_2", "something broke");
        let json = serde_json::to_value(&block).unwrap();
        assert_eq!(json["type"], "tool_result");
        assert_eq!(json["is_error"], true);
    }

    #[test]
    fn test_empty_tool_executor() {
        let executor = EmptyToolExecutor;
        assert!(executor.tool_definitions().is_empty());
    }

    #[tokio::test]
    async fn test_echo_tool_executor() {
        let executor = EchoToolExecutor;
        let defs = executor.tool_definitions();
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].name, "echo");

        let result = executor
            .execute("tu_test", "echo", &json!({"text": "hello world"}))
            .await;
        match result {
            ContentBlock::ToolResult { content, .. } => assert_eq!(content, "hello world"),
            _ => panic!("expected tool_result"),
        }
    }

    // ── Content block round-trip tests ───────────────────────────────

    #[test]
    fn test_text_block_round_trip() {
        let original = ContentBlock::text("round trip test");
        let serialized = serde_json::to_value(&original).unwrap();
        let deserialized: ContentBlock = serde_json::from_value(serialized).unwrap();
        match deserialized {
            ContentBlock::Text { text } => assert_eq!(text, "round trip test"),
            _ => panic!("expected text block after round-trip"),
        }
    }

    #[test]
    fn test_tool_use_block_round_trip() {
        let original = ContentBlock::ToolUse {
            id: "tu_abc".to_string(),
            name: "schedule_task".to_string(),
            input: json!({"prompt": "remind me", "schedule_type": "once"}),
        };
        let serialized = serde_json::to_value(&original).unwrap();
        let deserialized: ContentBlock = serde_json::from_value(serialized).unwrap();
        match deserialized {
            ContentBlock::ToolUse { id, name, input } => {
                assert_eq!(id, "tu_abc");
                assert_eq!(name, "schedule_task");
                assert_eq!(input["prompt"], "remind me");
            }
            _ => panic!("expected tool_use block after round-trip"),
        }
    }

    #[test]
    fn test_tool_result_block_round_trip() {
        let original = ContentBlock::tool_result("tu_1", "success");
        let serialized = serde_json::to_value(&original).unwrap();
        let deserialized: ContentBlock = serde_json::from_value(serialized).unwrap();
        match deserialized {
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                assert_eq!(tool_use_id, "tu_1");
                assert_eq!(content, "success");
                assert!(is_error.is_none());
            }
            _ => panic!("expected tool_result block after round-trip"),
        }
    }

    #[test]
    fn test_tool_error_block_round_trip() {
        let original = ContentBlock::tool_error("tu_2", "it broke");
        let serialized = serde_json::to_value(&original).unwrap();
        let deserialized: ContentBlock = serde_json::from_value(serialized).unwrap();
        match deserialized {
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                assert_eq!(tool_use_id, "tu_2");
                assert_eq!(content, "it broke");
                assert_eq!(is_error, Some(true));
            }
            _ => panic!("expected tool_result block after round-trip"),
        }
    }

    // ── Message round-trip ───────────────────────────────────────────

    #[test]
    fn test_message_round_trip() {
        let original = Message {
            role: Role::User,
            content: vec![
                ContentBlock::text("Hello"),
                ContentBlock::tool_result("tu_1", "done"),
            ],
        };
        let serialized = serde_json::to_value(&original).unwrap();
        let deserialized: Message = serde_json::from_value(serialized).unwrap();
        assert_eq!(deserialized.role, Role::User);
        assert_eq!(deserialized.content.len(), 2);
    }

    // ── Multi-block response deserialization ─────────────────────────

    #[test]
    fn test_multi_block_response_deserialization() {
        let json = json!({
            "id": "msg_multi",
            "type": "message",
            "role": "assistant",
            "content": [
                {"type": "text", "text": "Let me help. "},
                {"type": "text", "text": "Here is more."},
                {
                    "type": "tool_use",
                    "id": "tu_1",
                    "name": "list_tasks",
                    "input": {}
                }
            ],
            "model": "claude-sonnet-4-5",
            "stop_reason": "tool_use",
            "usage": {"input_tokens": 30, "output_tokens": 20}
        });

        let response: MessagesResponse = serde_json::from_value(json).unwrap();
        assert_eq!(response.content.len(), 3);

        // First two are text blocks
        match &response.content[0] {
            ContentBlock::Text { text } => assert_eq!(text, "Let me help. "),
            _ => panic!("expected text block"),
        }
        match &response.content[1] {
            ContentBlock::Text { text } => assert_eq!(text, "Here is more."),
            _ => panic!("expected text block"),
        }
        // Third is a tool_use block
        match &response.content[2] {
            ContentBlock::ToolUse { id, name, .. } => {
                assert_eq!(id, "tu_1");
                assert_eq!(name, "list_tasks");
            }
            _ => panic!("expected tool_use block"),
        }
    }

    // ── Stop reason variants ─────────────────────────────────────────

    #[test]
    fn test_all_stop_reason_variants() {
        for (reason_str, expected) in [
            ("end_turn", StopReason::EndTurn),
            ("tool_use", StopReason::ToolUse),
            ("max_tokens", StopReason::MaxTokens),
            ("stop_sequence", StopReason::StopSequence),
        ] {
            let json = json!({
                "id": "msg_1",
                "type": "message",
                "role": "assistant",
                "content": [{"type": "text", "text": "hi"}],
                "model": "test",
                "stop_reason": reason_str,
                "usage": {"input_tokens": 1, "output_tokens": 1}
            });
            let response: MessagesResponse = serde_json::from_value(json).unwrap();
            assert_eq!(response.stop_reason, Some(expected));
        }
    }

    // ── Agent::send with mock HTTP server ────────────────────────────

    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn make_api_response(content: serde_json::Value, stop_reason: &str) -> serde_json::Value {
        json!({
            "id": "msg_test",
            "type": "message",
            "role": "assistant",
            "content": content,
            "model": "test-model",
            "stop_reason": stop_reason,
            "usage": {"input_tokens": 10, "output_tokens": 5}
        })
    }

    #[tokio::test]
    async fn test_send_simple_text_response() {
        let server = MockServer::start().await;

        let body = make_api_response(json!([{"type": "text", "text": "Hello back!"}]), "end_turn");

        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&body))
            .mount(&server)
            .await;

        let agent = AnthropicAgent::with_api_url(
            "test-key".to_string(),
            "test-model".to_string(),
            format!("{}/v1/messages", server.uri()),
        );

        let executor = EmptyToolExecutor;
        let messages = vec![Message {
            role: Role::User,
            content: vec![ContentBlock::text("Hello")],
        }];

        let response = agent.send(None, messages, &executor).await.unwrap();
        assert_eq!(response.text, "Hello back!");
        assert_eq!(response.input_tokens, 10);
        assert_eq!(response.output_tokens, 5);
    }

    #[tokio::test]
    async fn test_send_tool_use_then_text() {
        let server = MockServer::start().await;

        // First API call: model requests a tool
        let tool_response = make_api_response(
            json!([{
                "type": "tool_use",
                "id": "tu_1",
                "name": "echo",
                "input": {"text": "ping"}
            }]),
            "tool_use",
        );

        // Second API call: model returns text
        let text_response = make_api_response(
            json!([{"type": "text", "text": "The echo said: ping"}]),
            "end_turn",
        );

        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&tool_response))
            .up_to_n_times(1)
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&text_response))
            .mount(&server)
            .await;

        let agent = AnthropicAgent::with_api_url(
            "test-key".to_string(),
            "test-model".to_string(),
            format!("{}/v1/messages", server.uri()),
        );

        let executor = EchoToolExecutor;
        let messages = vec![Message {
            role: Role::User,
            content: vec![ContentBlock::text("Echo this: ping")],
        }];

        let response = agent.send(None, messages, &executor).await.unwrap();
        assert_eq!(response.text, "The echo said: ping");
        // Tokens accumulate across both API calls
        assert_eq!(response.input_tokens, 20);
        assert_eq!(response.output_tokens, 10);
    }

    #[tokio::test]
    async fn test_send_api_error_propagates() {
        let server = MockServer::start().await;

        let error_body = json!({
            "type": "error",
            "error": {
                "type": "authentication_error",
                "message": "invalid api key"
            }
        });

        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(ResponseTemplate::new(401).set_body_json(&error_body))
            .mount(&server)
            .await;

        let agent = AnthropicAgent::with_api_url(
            "bad-key".to_string(),
            "test-model".to_string(),
            format!("{}/v1/messages", server.uri()),
        );

        let executor = EmptyToolExecutor;
        let messages = vec![Message {
            role: Role::User,
            content: vec![ContentBlock::text("Hello")],
        }];

        let result = agent.send(None, messages, &executor).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        let err_str = err.to_string();
        assert!(err_str.contains("401"), "error should contain status code");
        assert!(
            err_str.contains("invalid api key"),
            "error should contain message"
        );
    }

    #[tokio::test]
    async fn test_send_includes_system_prompt() {
        let server = MockServer::start().await;

        let body = make_api_response(json!([{"type": "text", "text": "I am Imp."}]), "end_turn");

        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&body))
            .expect(1)
            .mount(&server)
            .await;

        let agent = AnthropicAgent::with_api_url(
            "test-key".to_string(),
            "test-model".to_string(),
            format!("{}/v1/messages", server.uri()),
        );

        let executor = EmptyToolExecutor;
        let messages = vec![Message {
            role: Role::User,
            content: vec![ContentBlock::text("Who are you?")],
        }];

        let response = agent
            .send(Some("You are Imp."), messages, &executor)
            .await
            .unwrap();
        assert_eq!(response.text, "I am Imp.");
    }

    #[tokio::test]
    async fn test_send_concatenates_multi_text_blocks() {
        let server = MockServer::start().await;

        let body = make_api_response(
            json!([
                {"type": "text", "text": "First part. "},
                {"type": "text", "text": "Second part."}
            ]),
            "end_turn",
        );

        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&body))
            .mount(&server)
            .await;

        let agent = AnthropicAgent::with_api_url(
            "test-key".to_string(),
            "test-model".to_string(),
            format!("{}/v1/messages", server.uri()),
        );

        let executor = EmptyToolExecutor;
        let messages = vec![Message {
            role: Role::User,
            content: vec![ContentBlock::text("Tell me something.")],
        }];

        let response = agent.send(None, messages, &executor).await.unwrap();
        assert_eq!(response.text, "First part. Second part.");
    }

    #[test]
    fn test_agent_default_api_url() {
        let agent = AnthropicAgent::new("key".to_string(), "model".to_string());
        assert_eq!(agent.api_url, "https://api.anthropic.com/v1/messages");
    }
}
