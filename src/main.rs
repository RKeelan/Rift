mod agent;
mod config;
mod db;
mod error;
mod scheduler;
mod telegram;
mod web_fetch;

use std::sync::Arc;

use config::Config;
use tokio::sync::watch;
use tracing_subscriber::EnvFilter;

use agent::anthropic::AnthropicAgent;
use agent::tools::ImpToolExecutor;
use db::Database;

/// Wait for a shutdown signal: SIGINT (Ctrl+C) or SIGTERM (Docker stop).
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigterm =
            signal(SignalKind::terminate()).expect("failed to install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = sigterm.recv() => {}
        }
    }

    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await.ok();
    }
}

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

    let (shutdown_tx, shutdown_rx) = watch::channel(());
    let scheduler_handle = tokio::spawn(scheduler::run(
        bot.clone(),
        config.telegram_owner_chat_id,
        db.clone(),
        agent.clone(),
        tool_executor.clone(),
        shutdown_rx,
    ));

    tokio::select! {
        _ = telegram::run(bot, config.telegram_owner_chat_id, db, agent, tool_executor) => {}
        _ = shutdown_signal() => {
            tracing::info!("received termination signal");
        }
    }

    // Signal the scheduler to finish its current iteration and stop
    drop(shutdown_tx);
    match tokio::time::timeout(tokio::time::Duration::from_secs(10), scheduler_handle).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => tracing::error!(error = %e, "scheduler panicked"),
        Err(_) => tracing::warn!("scheduler did not stop within timeout"),
    }

    tracing::info!("Imp shutting down");
    Ok(())
}
