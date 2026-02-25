mod agent;
mod config;
mod db;
mod error;
mod scheduler;
mod telegram;
mod web_fetch;

use std::sync::Arc;

use config::Config;
use tracing_subscriber::EnvFilter;

use agent::anthropic::AnthropicAgent;
use agent::tools::ImpToolExecutor;
use db::Database;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Load .env file (ignore if missing — production uses real env vars)
    let _ = dotenvy::dotenv();

    // Initialize structured logging
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = Config::from_env()?;
    tracing::info!(model = %config.anthropic_model, "Imp starting");

    let db = Arc::new(Database::open(&config.database_path)?);
    let agent: Arc<dyn agent::Agent> = Arc::new(AnthropicAgent::new(
        config.anthropic_api_key,
        config.anthropic_model,
    ));
    let tool_executor: Arc<dyn agent::ToolExecutor> = Arc::new(ImpToolExecutor::new(
        db.clone(),
        config.web_fetch_allowed_domains,
    ));
    let bot = teloxide::Bot::new(config.telegram_bot_token);

    telegram::run(bot, config.telegram_owner_chat_id, db, agent, tool_executor).await;

    tracing::info!("Imp shutting down");
    Ok(())
}
