from hii.paths import ensure_hii_dirs
from hii.storage.migrations import apply_migrations

def bootstrap_storage() -> None:
    ensure_hii_dirs()
    apply_migrations()
