use crate::{
    AcknowledgementFrontier, CiphertextEnvelope, RelayError, RelayStore, RendezvousSignal,
    SingleOwnerAccount,
};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use std::{collections::BTreeMap, path::Path};

const SCHEMA: &str = r#"
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS relay_schema (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL
);
INSERT OR IGNORE INTO relay_schema(singleton, version) VALUES (1, 2);

CREATE TABLE IF NOT EXISTS account_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    public_record_json BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS envelopes (
    envelope_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    sender_device_id TEXT NOT NULL,
    recipient_device_id TEXT NOT NULL,
    trust_epoch INTEGER NOT NULL CHECK (trust_epoch >= 0),
    sender_sequence INTEGER NOT NULL CHECK (sender_sequence > 0),
    created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0),
    expires_at_unix_ms INTEGER NOT NULL CHECK (expires_at_unix_ms >= 0),
    ciphertext BLOB NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0 CHECK (delivered IN (0, 1)),
    UNIQUE(sender_device_id, sender_sequence)
);
CREATE INDEX IF NOT EXISTS envelopes_mailbox
    ON envelopes(recipient_device_id, sender_device_id, sender_sequence);
CREATE INDEX IF NOT EXISTS envelopes_expiry ON envelopes(expires_at_unix_ms);

CREATE TABLE IF NOT EXISTS seen_envelope_ids (
    envelope_id TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS seen_sender_sequences (
    sender_device_id TEXT NOT NULL,
    sender_sequence INTEGER NOT NULL CHECK (sender_sequence > 0),
    envelope_id TEXT NOT NULL,
    PRIMARY KEY(sender_device_id, sender_sequence)
);

CREATE TABLE IF NOT EXISTS acknowledgement_frontiers (
    recipient_device_id TEXT NOT NULL,
    sender_device_id TEXT NOT NULL,
    through_sequence INTEGER NOT NULL CHECK (through_sequence >= 0),
    PRIMARY KEY(recipient_device_id, sender_device_id)
);

CREATE TABLE IF NOT EXISTS rendezvous_signals (
    signal_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    sender_device_id TEXT NOT NULL,
    recipient_device_id TEXT NOT NULL,
    trust_epoch INTEGER NOT NULL CHECK (trust_epoch >= 0),
    created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0),
    expires_at_unix_ms INTEGER NOT NULL CHECK (expires_at_unix_ms >= 0),
    ciphertext BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS signals_recipient
    ON rendezvous_signals(recipient_device_id, created_at_unix_ms);
CREATE INDEX IF NOT EXISTS signals_expiry ON rendezvous_signals(expires_at_unix_ms);
CREATE TABLE IF NOT EXISTS seen_signal_ids (
    signal_id TEXT PRIMARY KEY
);
"#;

/// Durable, non-networked `RelayStore` backed by SQLite.
pub struct SqliteRelayStore {
    connection: Connection,
}

impl std::fmt::Debug for SqliteRelayStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SqliteRelayStore")
            .finish_non_exhaustive()
    }
}

impl SqliteRelayStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, RelayError> {
        let path = path.as_ref();
        let existed = path.exists();
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let connection = Connection::open_with_flags(path, flags).map_err(store_error)?;
        if !existed {
            set_owner_only_permissions(path)?;
        }
        Self::initialize(connection)
    }

    pub fn open_in_memory() -> Result<Self, RelayError> {
        Self::initialize(Connection::open_in_memory().map_err(store_error)?)
    }

    fn initialize(mut connection: Connection) -> Result<Self, RelayError> {
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(store_error)?;
        let transaction = connection.transaction().map_err(store_error)?;
        transaction.execute_batch(SCHEMA).map_err(store_error)?;
        let version: i64 = transaction
            .query_row(
                "SELECT version FROM relay_schema WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .map_err(store_error)?;
        if version == 1 {
            transaction
                .execute(
                    "ALTER TABLE envelopes ADD COLUMN delivered INTEGER NOT NULL DEFAULT 0 \
                     CHECK (delivered IN (0, 1))",
                    [],
                )
                .map_err(store_error)?;
            transaction
                .execute(
                    "UPDATE relay_schema SET version = 2 WHERE singleton = 1",
                    [],
                )
                .map_err(store_error)?;
        } else if version != 2 {
            return Err(RelayError::Store(format!(
                "unsupported relay schema version {version}"
            )));
        }
        transaction.commit().map_err(store_error)?;
        Ok(Self { connection })
    }
}

impl RelayStore for SqliteRelayStore {
    fn account(&self) -> Result<Option<SingleOwnerAccount>, RelayError> {
        let bytes: Option<Vec<u8>> = self
            .connection
            .query_row(
                "SELECT public_record_json FROM account_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(store_error)?;
        bytes
            .map(|value| serde_json::from_slice(&value).map_err(serialization_error))
            .transpose()
    }

    fn put_account(&mut self, account: SingleOwnerAccount) -> Result<(), RelayError> {
        let bytes = serde_json::to_vec(&account).map_err(serialization_error)?;
        let transaction = self.connection.transaction().map_err(store_error)?;
        transaction
            .execute(
                "INSERT INTO account_state(singleton, public_record_json) VALUES (1, ?1) \
                 ON CONFLICT(singleton) DO UPDATE SET public_record_json = excluded.public_record_json",
                [bytes],
            )
            .map_err(store_error)?;
        transaction.commit().map_err(store_error)
    }

    fn mailbox_bytes(&self, recipient: &str) -> Result<u64, RelayError> {
        let bytes: i64 = self
            .connection
            .query_row(
                "SELECT COALESCE(SUM(length(ciphertext)), 0) FROM envelopes \
                 WHERE recipient_device_id = ?1",
                [recipient],
                |row| row.get(0),
            )
            .map_err(store_error)?;
        nonnegative_u64(bytes, "mailbox byte count")
    }

    fn envelope_by_id(&self, envelope_id: &str) -> Result<Option<CiphertextEnvelope>, RelayError> {
        query_envelope(
            &self.connection,
            "SELECT envelope_id, account_id, sender_device_id, recipient_device_id, \
             trust_epoch, sender_sequence, created_at_unix_ms, expires_at_unix_ms, ciphertext \
             FROM envelopes WHERE envelope_id = ?1",
            rusqlite::params![envelope_id],
        )
    }

    fn was_envelope_id_seen(&self, envelope_id: &str) -> Result<bool, RelayError> {
        exists(
            &self.connection,
            "SELECT 1 FROM seen_envelope_ids WHERE envelope_id = ?1",
            envelope_id,
        )
    }

    fn envelope_by_sender_sequence(
        &self,
        sender: &str,
        sequence: u64,
    ) -> Result<Option<CiphertextEnvelope>, RelayError> {
        query_envelope(
            &self.connection,
            "SELECT envelope_id, account_id, sender_device_id, recipient_device_id, \
             trust_epoch, sender_sequence, created_at_unix_ms, expires_at_unix_ms, ciphertext \
             FROM envelopes WHERE sender_device_id = ?1 AND sender_sequence = ?2",
            params![sender, sqlite_i64(sequence, "sender sequence")?],
        )
    }

    fn was_sender_sequence_seen(&self, sender: &str, sequence: u64) -> Result<bool, RelayError> {
        let sequence = sqlite_i64(sequence, "sender sequence")?;
        let found: Option<i64> = self
            .connection
            .query_row(
                "SELECT 1 FROM seen_sender_sequences \
                 WHERE sender_device_id = ?1 AND sender_sequence = ?2",
                params![sender, sequence],
                |row| row.get(0),
            )
            .optional()
            .map_err(store_error)?;
        Ok(found.is_some())
    }

    fn insert_envelope(&mut self, envelope: CiphertextEnvelope) -> Result<(), RelayError> {
        let transaction = self.connection.transaction().map_err(store_error)?;
        let frontier: Option<i64> = transaction
            .query_row(
                "SELECT through_sequence FROM acknowledgement_frontiers \
                 WHERE recipient_device_id = ?1 AND sender_device_id = ?2",
                params![envelope.recipient_device_id, envelope.sender_device_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(store_error)?;
        if frontier.is_some_and(|value| {
            u64::try_from(value).is_ok_and(|value| envelope.sender_sequence <= value)
        }) {
            return Err(RelayError::ReplayConflict);
        }
        insert_envelope_rows(&transaction, &envelope)?;
        transaction.commit().map_err(store_error)
    }

    fn mailbox(
        &mut self,
        recipient: &str,
        trust_epoch: u64,
        now_unix_ms: u64,
    ) -> Result<Vec<CiphertextEnvelope>, RelayError> {
        let transaction = self.connection.transaction().map_err(store_error)?;
        let items = {
            let mut statement = transaction
                .prepare(
                    "SELECT envelope_id, account_id, sender_device_id, recipient_device_id, \
                     trust_epoch, sender_sequence, created_at_unix_ms, expires_at_unix_ms, ciphertext \
                     FROM envelopes WHERE recipient_device_id = ?1 AND trust_epoch = ?2 \
                     AND expires_at_unix_ms > ?3 ORDER BY sender_device_id, sender_sequence",
                )
                .map_err(store_error)?;
            let rows = statement
                .query_map(
                    params![
                        recipient,
                        sqlite_i64(trust_epoch, "trust epoch")?,
                        sqlite_i64(now_unix_ms, "current time")?
                    ],
                    raw_envelope,
                )
                .map_err(store_error)?;
            rows.map(|row| row.map_err(store_error).and_then(decode_envelope))
                .collect::<Result<Vec<_>, _>>()?
        };
        for item in &items {
            transaction
                .execute(
                    "UPDATE envelopes SET delivered = 1 WHERE envelope_id = ?1",
                    [&item.envelope_id],
                )
                .map_err(store_error)?;
        }
        transaction.commit().map_err(store_error)?;
        Ok(items)
    }

    fn acknowledge(
        &mut self,
        recipient: &str,
        sender: &str,
        through_sequence: u64,
    ) -> Result<usize, RelayError> {
        let through = sqlite_i64(through_sequence, "acknowledgement sequence")?;
        let transaction = self.connection.transaction().map_err(store_error)?;
        let current: Option<i64> = transaction
            .query_row(
                "SELECT through_sequence FROM acknowledgement_frontiers \
                 WHERE recipient_device_id = ?1 AND sender_device_id = ?2",
                params![recipient, sender],
                |row| row.get(0),
            )
            .optional()
            .map_err(store_error)?;
        if current.is_some_and(|value| through <= value) {
            return Ok(0);
        }
        let (total, delivered, maximum): (i64, i64, Option<i64>) = transaction
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(delivered), 0), MAX(sender_sequence) \
                 FROM envelopes WHERE recipient_device_id = ?1 \
                 AND sender_device_id = ?2 AND sender_sequence <= ?3",
                params![recipient, sender, through],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(store_error)?;
        if total == 0 || delivered != total || maximum != Some(through) {
            return Err(RelayError::InvalidRecord(
                "acknowledgement lacks delivered message proof",
            ));
        }
        transaction
            .execute(
                "INSERT INTO acknowledgement_frontiers( \
                    recipient_device_id, sender_device_id, through_sequence \
                 ) VALUES (?1, ?2, ?3) ON CONFLICT(recipient_device_id, sender_device_id) \
                 DO UPDATE SET through_sequence = max(through_sequence, excluded.through_sequence)",
                params![recipient, sender, through],
            )
            .map_err(store_error)?;
        let removed = transaction
            .execute(
                "DELETE FROM envelopes WHERE recipient_device_id = ?1 \
                 AND sender_device_id = ?2 AND sender_sequence <= ?3",
                params![recipient, sender, through],
            )
            .map_err(store_error)?;
        transaction.commit().map_err(store_error)?;
        Ok(removed)
    }

    fn frontier(&self, recipient: &str) -> Result<AcknowledgementFrontier, RelayError> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT sender_device_id, through_sequence FROM acknowledgement_frontiers \
                 WHERE recipient_device_id = ?1 ORDER BY sender_device_id",
            )
            .map_err(store_error)?;
        let rows = statement
            .query_map([recipient], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(store_error)?;
        let mut by_sender = BTreeMap::new();
        for row in rows {
            let (sender, sequence) = row.map_err(store_error)?;
            by_sender.insert(
                sender,
                nonnegative_u64(sequence, "acknowledgement frontier")?,
            );
        }
        Ok(AcknowledgementFrontier {
            recipient_device_id: recipient.to_owned(),
            through_sequence_by_sender: by_sender,
        })
    }

    fn purge_expired(&mut self, now_unix_ms: u64) -> Result<usize, RelayError> {
        let now = sqlite_i64(now_unix_ms, "current time")?;
        let transaction = self.connection.transaction().map_err(store_error)?;
        let envelopes = transaction
            .execute(
                "DELETE FROM envelopes WHERE expires_at_unix_ms <= ?1",
                [now],
            )
            .map_err(store_error)?;
        let signals = transaction
            .execute(
                "DELETE FROM rendezvous_signals WHERE expires_at_unix_ms <= ?1",
                [now],
            )
            .map_err(store_error)?;
        transaction.commit().map_err(store_error)?;
        Ok(envelopes + signals)
    }

    fn insert_signal(&mut self, signal: RendezvousSignal) -> Result<(), RelayError> {
        let transaction = self.connection.transaction().map_err(store_error)?;
        transaction
            .execute(
                "INSERT INTO seen_signal_ids(signal_id) VALUES (?1)",
                [&signal.signal_id],
            )
            .map_err(store_error)?;
        transaction
            .execute(
                "INSERT INTO rendezvous_signals( \
                    signal_id, account_id, sender_device_id, recipient_device_id, trust_epoch, \
                    created_at_unix_ms, expires_at_unix_ms, ciphertext \
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    signal.signal_id,
                    signal.account_id,
                    signal.sender_device_id,
                    signal.recipient_device_id,
                    sqlite_i64(signal.trust_epoch, "trust epoch")?,
                    sqlite_i64(signal.created_at_unix_ms, "signal created time")?,
                    sqlite_i64(signal.expires_at_unix_ms, "signal expiry time")?,
                    signal.ciphertext,
                ],
            )
            .map_err(store_error)?;
        transaction.commit().map_err(store_error)
    }

    fn signal_by_id(&self, signal_id: &str) -> Result<Option<RendezvousSignal>, RelayError> {
        let raw = self
            .connection
            .query_row(
                "SELECT signal_id, account_id, sender_device_id, recipient_device_id, \
                 trust_epoch, created_at_unix_ms, expires_at_unix_ms, ciphertext \
                 FROM rendezvous_signals WHERE signal_id = ?1",
                [signal_id],
                raw_signal,
            )
            .optional()
            .map_err(store_error)?;
        raw.map(decode_signal).transpose()
    }

    fn was_signal_id_seen(&self, signal_id: &str) -> Result<bool, RelayError> {
        exists(
            &self.connection,
            "SELECT 1 FROM seen_signal_ids WHERE signal_id = ?1",
            signal_id,
        )
    }

    fn take_signals(
        &mut self,
        recipient: &str,
        trust_epoch: u64,
        now_unix_ms: u64,
    ) -> Result<Vec<RendezvousSignal>, RelayError> {
        let transaction = self.connection.transaction().map_err(store_error)?;
        let items = {
            let mut statement = transaction
                .prepare(
                    "SELECT signal_id, account_id, sender_device_id, recipient_device_id, \
                     trust_epoch, created_at_unix_ms, expires_at_unix_ms, ciphertext \
                     FROM rendezvous_signals WHERE recipient_device_id = ?1 \
                     AND trust_epoch = ?2 AND expires_at_unix_ms > ?3 \
                     ORDER BY created_at_unix_ms, signal_id",
                )
                .map_err(store_error)?;
            let rows = statement
                .query_map(
                    params![
                        recipient,
                        sqlite_i64(trust_epoch, "trust epoch")?,
                        sqlite_i64(now_unix_ms, "current time")?
                    ],
                    raw_signal,
                )
                .map_err(store_error)?;
            rows.map(|row| row.map_err(store_error).and_then(decode_signal))
                .collect::<Result<Vec<_>, _>>()?
        };
        transaction
            .execute(
                "DELETE FROM rendezvous_signals WHERE recipient_device_id = ?1 \
                 AND trust_epoch = ?2 AND expires_at_unix_ms > ?3",
                params![
                    recipient,
                    sqlite_i64(trust_epoch, "trust epoch")?,
                    sqlite_i64(now_unix_ms, "current time")?
                ],
            )
            .map_err(store_error)?;
        transaction.commit().map_err(store_error)?;
        Ok(items)
    }

    fn pending_signal_count(&self, recipient: &str) -> Result<usize, RelayError> {
        let count: i64 = self
            .connection
            .query_row(
                "SELECT COUNT(*) FROM rendezvous_signals WHERE recipient_device_id = ?1",
                [recipient],
                |row| row.get(0),
            )
            .map_err(store_error)?;
        usize::try_from(count).map_err(|_| RelayError::Store("invalid pending signal count".into()))
    }
}

type RawEnvelope = (String, String, String, String, i64, i64, i64, i64, Vec<u8>);
type RawSignal = (String, String, String, String, i64, i64, i64, Vec<u8>);

fn raw_envelope(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawEnvelope> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
    ))
}

fn decode_envelope(raw: RawEnvelope) -> Result<CiphertextEnvelope, RelayError> {
    Ok(CiphertextEnvelope {
        envelope_id: raw.0,
        account_id: raw.1,
        sender_device_id: raw.2,
        recipient_device_id: raw.3,
        trust_epoch: nonnegative_u64(raw.4, "trust epoch")?,
        sender_sequence: positive_u64(raw.5, "sender sequence")?,
        created_at_unix_ms: nonnegative_u64(raw.6, "envelope created time")?,
        expires_at_unix_ms: nonnegative_u64(raw.7, "envelope expiry time")?,
        ciphertext: raw.8,
    })
}

fn query_envelope<P: rusqlite::Params>(
    connection: &Connection,
    sql: &str,
    params: P,
) -> Result<Option<CiphertextEnvelope>, RelayError> {
    let raw = connection
        .query_row(sql, params, raw_envelope)
        .optional()
        .map_err(store_error)?;
    raw.map(decode_envelope).transpose()
}

fn insert_envelope_rows(
    transaction: &Transaction<'_>,
    envelope: &CiphertextEnvelope,
) -> Result<(), RelayError> {
    transaction
        .execute(
            "INSERT INTO seen_envelope_ids(envelope_id) VALUES (?1)",
            [&envelope.envelope_id],
        )
        .map_err(store_error)?;
    transaction
        .execute(
            "INSERT INTO seen_sender_sequences(sender_device_id, sender_sequence, envelope_id) \
             VALUES (?1, ?2, ?3)",
            params![
                envelope.sender_device_id,
                sqlite_i64(envelope.sender_sequence, "sender sequence")?,
                envelope.envelope_id,
            ],
        )
        .map_err(store_error)?;
    transaction
        .execute(
            "INSERT INTO envelopes( \
                envelope_id, account_id, sender_device_id, recipient_device_id, trust_epoch, \
                sender_sequence, created_at_unix_ms, expires_at_unix_ms, ciphertext \
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                envelope.envelope_id,
                envelope.account_id,
                envelope.sender_device_id,
                envelope.recipient_device_id,
                sqlite_i64(envelope.trust_epoch, "trust epoch")?,
                sqlite_i64(envelope.sender_sequence, "sender sequence")?,
                sqlite_i64(envelope.created_at_unix_ms, "envelope created time")?,
                sqlite_i64(envelope.expires_at_unix_ms, "envelope expiry time")?,
                envelope.ciphertext,
            ],
        )
        .map_err(store_error)?;
    Ok(())
}

fn raw_signal(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawSignal> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
    ))
}

fn decode_signal(raw: RawSignal) -> Result<RendezvousSignal, RelayError> {
    Ok(RendezvousSignal {
        signal_id: raw.0,
        account_id: raw.1,
        sender_device_id: raw.2,
        recipient_device_id: raw.3,
        trust_epoch: nonnegative_u64(raw.4, "trust epoch")?,
        created_at_unix_ms: nonnegative_u64(raw.5, "signal created time")?,
        expires_at_unix_ms: nonnegative_u64(raw.6, "signal expiry time")?,
        ciphertext: raw.7,
    })
}

fn exists(connection: &Connection, sql: &str, value: &str) -> Result<bool, RelayError> {
    let found: Option<i64> = connection
        .query_row(sql, [value], |row| row.get(0))
        .optional()
        .map_err(store_error)?;
    Ok(found.is_some())
}

fn sqlite_i64(value: u64, label: &'static str) -> Result<i64, RelayError> {
    i64::try_from(value).map_err(|_| RelayError::Store(format!("{label} exceeds SQLite range")))
}

fn nonnegative_u64(value: i64, label: &'static str) -> Result<u64, RelayError> {
    u64::try_from(value).map_err(|_| RelayError::Store(format!("invalid {label} in database")))
}

fn positive_u64(value: i64, label: &'static str) -> Result<u64, RelayError> {
    let value = nonnegative_u64(value, label)?;
    if value == 0 {
        return Err(RelayError::Store(format!("invalid {label} in database")));
    }
    Ok(value)
}

fn store_error(error: rusqlite::Error) -> RelayError {
    RelayError::Store(error.to_string())
}

fn serialization_error(error: serde_json::Error) -> RelayError {
    RelayError::Store(format!("invalid public account record: {error}"))
}

#[cfg(unix)]
fn set_owner_only_permissions(path: &Path) -> Result<(), RelayError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| RelayError::Store(error.to_string()))
}

#[cfg(not(unix))]
fn set_owner_only_permissions(_path: &Path) -> Result<(), RelayError> {
    Ok(())
}
