#!/usr/bin/env python3
"""Offline checks for installer integrity and no-overwrite proof scripts."""
import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


installer = load("hii-wsl-cuda-install")
benchmark = load("hii-cuda-benchmark")
smoke = load("hii-cuda-server-smoke")


class CudaScripts(unittest.TestCase):
    def test_verified_download_is_reused_without_network(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "package.tar.xz"
            target.write_bytes(b"verified")
            with patch.object(installer.urllib.request, "urlopen") as request:
                installer.download("https://example.invalid", target, hashlib.sha256(b"verified").hexdigest())
                request.assert_not_called()

    def test_bad_download_cannot_replace_existing_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "package.tar.xz"
            target.write_bytes(b"original")
            with patch.object(installer.urllib.request, "urlopen", return_value=io.BytesIO(b"bad")):
                with self.assertRaisesRegex(RuntimeError, "Checksum mismatch"):
                    installer.download("https://example.invalid", target, "0" * 64)
            self.assertEqual(target.read_bytes(), b"original")

    def test_relative_installation_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, "absolute"):
            installer.install(Path("relative"), 4, Path("unused"))

    def test_benchmark_receipt_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "receipt.json"
            target.write_text("original")
            with self.assertRaisesRegex(RuntimeError, "overwrite"):
                benchmark.run(SimpleNamespace(output=target))
            self.assertEqual(target.read_text(), "original")

    def test_server_receipt_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "receipt.json"
            target.write_text("original")
            with self.assertRaisesRegex(RuntimeError, "overwrite"):
                smoke.run(SimpleNamespace(output=target))
            self.assertEqual(target.read_text(), "original")


if __name__ == "__main__":
    unittest.main()
