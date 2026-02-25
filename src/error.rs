use thiserror::Error;

#[derive(Error, Debug)]
pub enum ImpError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("HTTP request error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Anthropic API error: {status} - {message}")]
    AnthropicApi { status: u16, message: String },

    #[error("configuration error: {0}")]
    Config(String),

    #[error("web fetch error: {0}")]
    WebFetch(String),
}

pub type Result<T> = std::result::Result<T, ImpError>;
