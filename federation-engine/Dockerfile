# HouseRx Federation Engine (ENG-1799): release image.
#
# Build from the federation-engine/ directory (it holds the workspace and its path crates):
#   docker build -t federation-engine federation-engine
# Run with a config mounted read-only. Its listen_pg / listen_http must bind 0.0.0.0 inside the
# container (e.g. 0.0.0.0:5433 and 0.0.0.0:8088). Secrets come from the env vars the config names:
#   docker run -p 5433:5433 -p 8088:8088 \
#     -v /path/to/federation-engine.toml:/etc/federation-engine/federation-engine.toml:ro \
#     federation-engine

# ---- builder: release build of the `engine` binary -------------------------------------------
FROM rust:1.99-bookworm AS builder

# aws-lc-sys (rustls' aws-lc-rs provider) compiles C with cmake/clang when it has no prebuilt
# bindings for the target.
RUN apt-get update \
    && apt-get install -y --no-install-recommends cmake clang \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY src ./src
# tests/ is part of the workspace manifest ([[test]] acceptance); cargo only needs the files to
# exist to load the manifest, the release build of the bin never compiles them.
COPY tests ./tests

RUN cargo build --release --locked --bin engine \
    && cp target/release/engine /usr/local/bin/engine

# ---- runtime: distroless glibc base with CA certificates, no shell --------------------------
FROM gcr.io/distroless/cc-debian12:nonroot

COPY --from=builder /usr/local/bin/engine /usr/local/bin/engine

# 65532 is distroless' "nonroot" user; the engine needs no privileged ports or writable paths.
USER nonroot:nonroot

# 5433: Postgres wire protocol (listen_pg). 8088: HTTP (/healthz, /metrics, /v1/write, /v1/audit).
EXPOSE 5433 8088

ENTRYPOINT ["/usr/local/bin/engine"]
CMD ["--config", "/etc/federation-engine/federation-engine.toml"]
