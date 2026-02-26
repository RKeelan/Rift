# ── Build stage ──────────────────────────────────────────────────
FROM rust:slim-bookworm AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Cache dependency builds: copy manifests, build a dummy binary, then replace
# with real source. Layers below only rebuild when Cargo.toml/Cargo.lock change.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs \
    && cargo build --release \
    && rm -rf src

COPY src/ src/
RUN touch src/main.rs && cargo build --release

# ── Runtime stage ───────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/imp /usr/local/bin/imp

RUN useradd --system --no-create-home imp \
    && mkdir -p /data \
    && chown imp:imp /data

USER imp
VOLUME /data
ENV DATABASE_PATH=/data/imp.db

CMD ["imp"]
