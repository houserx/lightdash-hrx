//! Transaction statements (CONTRACTS §1): `BEGIN`, `START TRANSACTION`, `COMMIT`/`END` and
//! `ROLLBACK`.
//!
//! The engine is read-only, so a transaction block only marks the connection's transaction
//! status (`T` in ReadyForQuery, `E` after an error) and lets clients such as pg-cursor fetch from
//! a named portal in batches. There is nothing to commit or undo. Access and isolation modes
//! (`READ ONLY`, `ISOLATION LEVEL ...`) are accepted and change nothing. `AND CHAIN`, savepoints
//! and procedural `BEGIN ... END` blocks are refused with 0A000.

use datafusion::error::DataFusionError;
use datafusion::sql::parser::Statement as DFStatement;
use datafusion::sql::sqlparser::ast::Statement;
use pgwire::api::results::{Response, Tag};
use pgwire::messages::response::TransactionStatus;

use crate::session::sqlstate;

/// A transaction statement.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Transaction {
    Begin,
    Commit,
    Rollback,
}

impl Transaction {
    /// The transaction statement this is, `None` if it is not one.
    pub fn of(statement: &DFStatement) -> Option<Result<Transaction, DataFusionError>> {
        let DFStatement::Statement(s) = statement else {
            return None;
        };
        let txn = match s.as_ref() {
            Statement::StartTransaction {
                modifier: None,
                statements,
                exception: None,
                has_end_keyword: false,
                ..
            } if statements.is_empty() => Transaction::Begin,
            Statement::Commit {
                chain: false,
                modifier: None,
                ..
            } => Transaction::Commit,
            Statement::Rollback {
                chain: false,
                savepoint: None,
            } => Transaction::Rollback,
            Statement::StartTransaction { .. }
            | Statement::Commit { .. }
            | Statement::Rollback { .. }
            | Statement::Savepoint { .. }
            | Statement::ReleaseSavepoint { .. } => {
                return Some(Err(not_supported(s.as_ref())));
            }
            _ => return None,
        };
        Some(Ok(txn))
    }

    /// Whether this statement may run in a failed transaction block: only the ones that end it.
    pub fn ends_block(self) -> bool {
        matches!(self, Transaction::Commit | Transaction::Rollback)
    }

    /// What the client is told, given the connection's transaction status before the statement.
    ///
    /// As in Postgres, `COMMIT` of a failed block rolls it back and answers `ROLLBACK`, and
    /// `BEGIN` inside a block or `COMMIT`/`ROLLBACK` outside one are accepted.
    pub fn response(self, status: TransactionStatus) -> Response {
        match self {
            Transaction::Begin => Response::TransactionStart(Tag::new("BEGIN")),
            Transaction::Commit if status == TransactionStatus::Error => {
                Response::TransactionEnd(Tag::new("ROLLBACK"))
            }
            Transaction::Commit => Response::TransactionEnd(Tag::new("COMMIT")),
            Transaction::Rollback => Response::TransactionEnd(Tag::new("ROLLBACK")),
        }
    }
}

fn not_supported(statement: &Statement) -> DataFusionError {
    sqlstate(
        "0A000",
        format!("transaction statement is not supported: {statement}"),
    )
}

/// Refuses, with SQLSTATE 25P02, any statement but `COMMIT` or `ROLLBACK` in a failed
/// transaction block, as Postgres does.
pub fn check_not_aborted(
    status: TransactionStatus,
    statement: &DFStatement,
) -> Result<(), DataFusionError> {
    let ends_block = matches!(Transaction::of(statement), Some(Ok(t)) if t.ends_block());
    if status == TransactionStatus::Error && !ends_block {
        return Err(aborted_block());
    }
    Ok(())
}

/// The error for a statement in a failed transaction block (SQLSTATE 25P02).
pub fn aborted_block() -> DataFusionError {
    sqlstate(
        "25P02",
        "current transaction is aborted, commands ignored until end of transaction block"
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::SqlStateError;
    use datafusion::config::Dialect;
    use datafusion::prelude::SessionContext;

    fn txn(sql: &str) -> Option<Result<Transaction, DataFusionError>> {
        let state = SessionContext::new().state();
        let statement = state.sql_to_statement(sql, &Dialect::Generic).unwrap();
        Transaction::of(&statement)
    }

    #[test]
    fn transaction_statements_are_recognised() {
        let ok = |sql: &str| txn(sql).unwrap().unwrap();
        for sql in [
            "BEGIN",
            "BEGIN TRANSACTION",
            "BEGIN WORK",
            "START TRANSACTION",
            "START TRANSACTION READ ONLY",
            "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY",
        ] {
            assert_eq!(ok(sql), Transaction::Begin, "{sql}");
        }
        for sql in ["COMMIT", "COMMIT WORK", "END"] {
            assert_eq!(ok(sql), Transaction::Commit, "{sql}");
        }
        for sql in ["ROLLBACK", "ROLLBACK TRANSACTION"] {
            assert_eq!(ok(sql), Transaction::Rollback, "{sql}");
        }
        assert!(txn("SELECT 1").is_none());
        assert!(txn("SET timezone = 'UTC'").is_none());
    }

    #[test]
    fn chains_and_savepoints_are_refused_with_0a000() {
        for sql in [
            "COMMIT AND CHAIN",
            "ROLLBACK AND CHAIN",
            "ROLLBACK TO SAVEPOINT s",
            "SAVEPOINT s",
            "RELEASE SAVEPOINT s",
        ] {
            let e = txn(sql).unwrap().unwrap_err();
            let DataFusionError::External(e) = e else {
                panic!("{sql}: not a SQLSTATE error")
            };
            assert_eq!(
                e.downcast_ref::<SqlStateError>().unwrap().code,
                "0A000",
                "{sql}"
            );
        }
    }

    #[test]
    fn commit_of_a_failed_block_rolls_back() {
        let tag = |r: Response| match r {
            Response::TransactionStart(t) | Response::TransactionEnd(t) => format!("{t:?}"),
            _ => panic!("not a transaction response"),
        };
        assert!(tag(Transaction::Commit.response(TransactionStatus::Error)).contains("ROLLBACK"));
        assert!(
            tag(Transaction::Commit.response(TransactionStatus::Transaction)).contains("COMMIT")
        );
        assert!(tag(Transaction::Begin.response(TransactionStatus::Idle)).contains("BEGIN"));
    }

    fn check(status: TransactionStatus, sql: &str) -> bool {
        let state = SessionContext::new().state();
        let statement = state.sql_to_statement(sql, &Dialect::Generic).unwrap();
        check_not_aborted(status, &statement).is_ok()
    }

    #[test]
    fn a_failed_block_only_accepts_commit_or_rollback() {
        assert!(check(TransactionStatus::Error, "ROLLBACK"));
        assert!(check(TransactionStatus::Error, "COMMIT"));
        assert!(!check(TransactionStatus::Error, "SELECT 1"));
        assert!(!check(TransactionStatus::Error, "SET timezone = 'UTC'"));
        assert!(!check(TransactionStatus::Error, "BEGIN"));
        assert!(check(TransactionStatus::Transaction, "SELECT 1"));
        assert!(check(TransactionStatus::Idle, "SELECT 1"));
    }
}
