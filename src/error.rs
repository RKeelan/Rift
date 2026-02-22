use thiserror::Error;

#[derive(Error, Debug)]
#[allow(dead_code)]
pub enum ImpError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("HTTP request error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Anthropic API error: {status} - {message}")]
    AnthropicApi { status: u16, message: String },

    #[error("tool execution error: {0}")]
    ToolExecution(String),

    #[error("configuration error: {0}")]
    Config(String),

    #[error("web fetch error: {0}")]
    WebFetch(String),
}

#[allow(dead_code)]
pub type Result<T> = std::result::Result<T, ImpError>;
