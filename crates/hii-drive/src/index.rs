//! File metadata, manifests, versions, and device registry

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// File record in the index
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileRecord {
    pub object_id: String,
    pub path: PathBuf,
    pub version: u32,
    pub size: u64,
    pub modified_by: String,
    pub modified_at: chrono::DateTime<chrono::Utc>,
    pub chunks: Vec<String>,
}

/// Device record for synchronization
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceRecord {
    pub device_id: String,
    pub name: String,
    pub public_key: String,
    pub last_seen: chrono::DateTime<chrono::Utc>,
    pub is_authority: bool,
}

/// Index manages file records, manifests, versions, and device registry
pub struct Index {
    conn: Connection,
}

impl Index {
    /// Create or open an index database
    pub fn open<P: Into<PathBuf>>(base_path: P) -> Result<Self, rusqlite::Error> {
        let base_path = base_path.into();
        fs::create_dir_all(&base_path)
            .map_err(|_| rusqlite::Error::InvalidPath(base_path.clone()))?;
        let db_path = base_path.join("index.sqlite");

        let conn = Connection::open(&db_path)?;

        // Initialize schema
        Self::init_schema(&conn)?;

        Ok(Self { conn })
    }

    /// Initialize database schema
    fn init_schema(conn: &Connection) -> Result<(), rusqlite::Error> {
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS file_records (
                object_id TEXT PRIMARY KEY,
                path TEXT NOT NULL,
                version INTEGER NOT NULL,
                size INTEGER NOT NULL,
                modified_by TEXT NOT NULL,
                modified_at TEXT NOT NULL,
                chunks TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS devices (
                device_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                public_key TEXT NOT NULL,
                last_seen TEXT NOT NULL,
                is_authority INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS sync_events (
                event_id TEXT PRIMARY KEY,
                object_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_file_records_path ON file_records(path);
            CREATE INDEX IF NOT EXISTS idx_sync_events_object_id ON sync_events(object_id);
            ",
        )?;

        Ok(())
    }

    /// Add a file record
    pub fn add_file_record(&self, record: &FileRecord) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT OR REPLACE INTO file_records
             (object_id, path, version, size, modified_by, modified_at, chunks)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![
                record.object_id,
                record.path.to_string_lossy(),
                record.version,
                record.size,
                record.modified_by,
                record.modified_at.timestamp(),
                serde_json::to_string(&record.chunks).unwrap_or("[]".to_string())
            ],
        )?;

        Ok(())
    }

    /// Get file record by path
    pub fn get_by_path(&self, path: &Path) -> Result<Option<FileRecord>, rusqlite::Error> {
        let record = self.conn.query_row(
            "SELECT object_id, path, version, size, modified_by, modified_at, chunks
             FROM file_records WHERE path = ?",
            [path.to_string_lossy()],
            |row| {
                let path: String = row.get(1)?;
                let modified_at: i64 = row.get(5)?;
                let chunks: String = row.get(6)?;
                Ok(FileRecord {
                    object_id: row.get(0)?,
                    path: PathBuf::from(path),
                    version: row.get(2)?,
                    size: row.get(3)?,
                    modified_by: row.get(4)?,
                    modified_at: chrono::DateTime::<chrono::Utc>::from_timestamp(modified_at, 0)
                        .unwrap_or_default(),
                    chunks: serde_json::from_str(&chunks).unwrap_or_default(),
                })
            },
        );

        match record {
            Ok(record) => Ok(Some(record)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// Register a device
    pub fn register_device(&self, device: &DeviceRecord) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT OR REPLACE INTO devices
             (device_id, name, public_key, last_seen, is_authority)
             VALUES (?, ?, ?, ?, ?)",
            params![
                device.device_id,
                device.name,
                device.public_key,
                device.last_seen.timestamp(),
                device.is_authority as i32
            ],
        )?;

        Ok(())
    }

    /// Get all registered devices
    pub fn get_devices(&self) -> Result<Vec<DeviceRecord>, rusqlite::Error> {
        let mut stmt = self
            .conn
            .prepare("SELECT device_id, name, public_key, last_seen, is_authority FROM devices")?;

        let devices = stmt.query_map([], |row| {
            Ok(DeviceRecord {
                device_id: row.get(0)?,
                name: row.get(1)?,
                public_key: row.get(2)?,
                last_seen: chrono::DateTime::<chrono::Utc>::from_timestamp(
                    row.get::<_, i64>(3)?,
                    0,
                )
                .unwrap_or_default(),
                is_authority: row.get::<_, i64>(4)? != 0,
            })
        })?;

        devices.collect::<Result<_, _>>()
    }

    /// Log a sync event
    pub fn log_sync_event(
        &self,
        object_id: &str,
        event_type: &str,
        payload: &serde_json::Value,
    ) -> Result<(), rusqlite::Error> {
        let event_id = Uuid::new_v4().to_string();

        self.conn.execute(
            "INSERT INTO sync_events (event_id, object_id, event_type, payload, created_at)
             VALUES (?, ?, ?, ?, ?)",
            params![
                event_id,
                object_id,
                event_type,
                serde_json::to_string(payload).unwrap_or("{}".to_string()),
                chrono::Utc::now().timestamp()
            ],
        )?;

        Ok(())
    }
}
