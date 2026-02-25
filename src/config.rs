use crate::error::ImpError;
use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    pub anthropic_api_key: String,
    pub telegram_bot_token: String,
    pub telegram_owner_chat_id: i64,
    pub database_path: String,
    pub anthropic_model: String,
    pub web_fetch_allowed_domains: Vec<String>,
}

impl Config {
    pub fn from_env() -> Result<Self, ImpError> {
        let anthropic_api_key = required_var("ANTHROPIC_API_KEY")?;
        let telegram_bot_token = required_var("TELEGRAM_BOT_TOKEN")?;
        let owner_chat_id_str = required_var("TELEGRAM_OWNER_CHAT_ID")?;
        let telegram_owner_chat_id = owner_chat_id_str
            .parse::<i64>()
            .map_err(|e| ImpError::Config(format!("invalid TELEGRAM_OWNER_CHAT_ID: {e}")))?;

        let database_path = env::var("DATABASE_PATH").unwrap_or_else(|_| "data/imp.db".to_string());

        let anthropic_model =
            env::var("ANTHROPIC_MODEL").unwrap_or_else(|_| "claude-sonnet-4-5".to_string());

        let web_fetch_allowed_domains = env::var("WEB_FETCH_ALLOWED_DOMAINS")
            .unwrap_or_default()
            .split(',')
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .collect();

        Ok(Config {
            anthropic_api_key,
            telegram_bot_token,
            telegram_owner_chat_id,
            database_path,
            anthropic_model,
            web_fetch_allowed_domains,
        })
    }
}

fn required_var(name: &str) -> Result<String, ImpError> {
    env::var(name).map_err(|_| ImpError::Config(format!("{name} must be set")))
}
