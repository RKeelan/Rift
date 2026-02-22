mod agent;
mod config;
mod db;
mod error;
mod scheduler;
mod telegram;
mod web_fetch;

use config::Config;
use tracing_subscriber::EnvFilter;

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

    // Subsystems will be wired in here in later steps.

    tracing::info!("Imp shutting down");
    Ok(())
}
