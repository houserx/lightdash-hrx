//! Acceptance suite for the Federation Engine (protected folder: later sessions cannot edit it).
//!
//! Every test drives the real `engine` binary from outside: pg-wire, HTTP, and mock upstreams on
//! ephemeral ports. Each feature in the build line's feature list runs exactly one test:
//!
//!     cargo test --manifest-path federation-engine/Cargo.toml --test acceptance -- <module>::<test> --exact

mod harness;
mod harness_selftest;

mod audit;
mod config;
mod docs;
mod guard;
mod identity;
mod ops;
mod ops_marts;
mod pgwire;
mod platform;
mod promql;
mod sources;
mod write;
