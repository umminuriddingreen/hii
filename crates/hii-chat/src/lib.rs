// SPDX-License-Identifier: LicenseRef-BSL-1.1
//! Shared Rust chat state for HII CLI and desktop projections.
//!
//! Callers choose the HII data root and hold [`files::AppFiles`] for the entire
//! chat-owner lifetime before opening [`store::Store`] or recovering generations.
//! Chat tables and migrations are namespaced within the caller's HII SQLite file.
//! This crate has no Tauri dependency; event sinks adapt persisted snapshots to
//! each surface's transport.

pub mod files;
pub mod model;
pub mod provider;
pub mod runtime;
pub mod service;
pub mod store;
