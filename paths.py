from pathlib import Path

HII_HOME = Path.home() / ".hii"
HII_DB = HII_HOME / "hii.db"
HII_ARTIFACTS = HII_HOME / "artifacts"
HII_CACHE = HII_HOME / "cache"
HII_LEGACY = HII_HOME / "legacy"

def ensure_hii_dirs() -> None:
    HII_HOME.mkdir(parents=True, exist_ok=True)
    HII_ARTIFACTS.mkdir(parents=True, exist_ok=True)
    HII_CACHE.mkdir(parents=True, exist_ok=True)
    HII_LEGACY.mkdir(parents=True, exist_ok=True)
