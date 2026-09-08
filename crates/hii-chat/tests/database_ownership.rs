// SPDX-License-Identifier: LicenseRef-BSL-1.1
use anyhow::Result;
use hii_chat::files::AppFiles;

#[test]
fn different_runtime_roots_cannot_own_the_same_database() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let first_root = directory.path().join("first-runtime");
    let second_root = directory.path().join("second-runtime");
    let database = directory.path().join("shared").join("hii.db");
    let owner = AppFiles::acquire_database(&first_root, &database)?;
    assert_eq!(owner.database(), database);
    assert!(AppFiles::acquire_database(&second_root, &database).is_err());

    // Creating the DB after the first lock must not change its ownership identity.
    let connection = rusqlite::Connection::open(&database)?;
    let alternate = directory.path().join("shared").join(".").join("hii.db");
    assert!(AppFiles::acquire_database(&second_root, &alternate).is_err());
    drop(connection);
    drop(owner);
    assert!(AppFiles::acquire_database(&second_root, &alternate).is_ok());
    Ok(())
}

#[test]
fn separate_databases_do_not_share_an_owner_lock() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let first = AppFiles::acquire(directory.path())?;
    let second = AppFiles::acquire_database(directory.path(), &directory.path().join("other.db"))?;
    assert_ne!(first.database(), second.database());
    Ok(())
}
