"""Real file receipts for the offline historical restore reader; no production data."""
import copy
import hashlib
import json
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from test_catalog_policy import b, m, fixture


class HistoricalReceiptTests(unittest.TestCase):
    def setUp(self):
        self.expected_history = None
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "backups" / "original"
        self.history = self.root / "catalog-history" / "replay"
        self.source.mkdir(parents=True)
        self.history.mkdir(parents=True)
        self.catalog, self.topology, _ = fixture()
        self.anchor = m.digest(self.catalog)
        common = {"source_container_id": b.SOURCE_CONTAINER_ID, "source_system_identifier": b.SOURCE_SYSTEM_ID,
                  "source_database_writes": False, "restore_verified": True, "restart_verified": True,
                  "storage_verified": True, "differences": 0, "source_catalog_sha256": self.anchor}
        self.source_evidence = {**common, "files": []}
        self.add_file(self.source, self.source_evidence, "catalog-source.json", self.catalog)
        self.add_file(self.source, self.source_evidence, "postgres.dump", b"synthetic archive")
        self.save_source()
        self.history_evidence = {**common, "format": 1, "context": "isolated_approved_archive_restore",
            "source_evidence_sha256": self.expected, "source_archive_sha256": b.file_hash(self.source / "postgres.dump"),
            "network": "none", "copy_removed": True, "files": []}
        self.add_file(self.history, self.history_evidence, "catalog-restored.json", self.catalog)
        self.add_file(self.history, self.history_evidence, "partition-restored.json", self.topology)
        self.save_history()

    def add_file(self, directory, evidence, name, value):
        raw = value if isinstance(value, bytes) else json.dumps(value).encode()
        (directory / name).write_bytes(raw)
        evidence["files"] = [row for row in evidence["files"] if row["file"] != name]
        evidence["files"].append({"file": name, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)})

    def save_source(self):
        raw = json.dumps(self.source_evidence).encode()
        (self.source / "evidence.json").write_bytes(raw)
        self.expected = hashlib.sha256(raw).hexdigest()

    def save_history(self, *, repin=False):
        raw = json.dumps(self.history_evidence).encode()
        (self.history / "history-evidence.json").write_bytes(raw)
        if self.expected_history is None or repin:
            self.expected_history = hashlib.sha256(raw).hexdigest()

    def read(self, *, owner=0, mode=0o600):
        def metadata(path):
            info = path.stat()
            return SimpleNamespace(st_uid=owner, st_mode=stat.S_IFREG | mode, st_nlink=1, st_size=info.st_size)
        with patch.object(b, "STATE_ROOT", self.root), patch.object(b, "private_dir"), patch.object(Path, "lstat", metadata):
            return b.read_approved_history(m, self.source, self.history, self.anchor, self.expected, self.expected_history)

    def test_authenticated_historical_restore_preserves_original_anchor(self):
        result = self.read()
        self.assertEqual(result["approved_catalog_sha256"], self.anchor)
        self.assertEqual(result["catalog"], self.catalog)

    def test_original_evidence_tamper_is_rejected(self):
        (self.source / "evidence.json").write_text("{}")
        with self.assertRaisesRegex(b.VerificationError, "source_evidence_integrity"): self.read()

    def test_archive_or_catalog_receipt_tamper_is_rejected(self):
        for name in ("postgres.dump", "catalog-source.json"):
            with self.subTest(name=name):
                self.setUp()
                (self.source / name).write_bytes(b"changed")
                with self.assertRaises(b.VerificationError): self.read()

    def test_missing_historical_topology_never_falls_back_to_current(self):
        (self.history / "partition-restored.json").unlink()
        with self.assertRaisesRegex(b.VerificationError, "history_file_unavailable"): self.read()

    def test_wrong_parent_or_bound_rejected_even_with_updated_file_receipt(self):
        for field, value in (("parent_oids", [999]), ("bound", "DEFAULT")):
            with self.subTest(field=field):
                self.setUp()
                topology = copy.deepcopy(self.topology)
                topology["partitions"][0][field] = value
                self.add_file(self.history, self.history_evidence, "partition-restored.json", topology)
                self.save_history(repin=True)
                with self.assertRaisesRegex(b.VerificationError, "topology_or_bound"): self.read()

    def test_history_proof_replacement_restore_difference_and_wrong_source_fail(self):
        for field, value in (("source_archive_sha256", "0" * 64), ("source_evidence_sha256", "0" * 64),
                             ("differences", 1), ("storage_verified", False), ("source_system_identifier", "other"),
                             ("network", "bridge"), ("context", "source")):
            with self.subTest(field=field):
                self.setUp()
                self.history_evidence[field] = value
                self.save_history(repin=True)
                with self.assertRaises(b.VerificationError): self.read()

    def test_wrong_root_file_permissions_and_duplicate_json_keys_fail(self):
        for change in ({"owner": 1000}, {"mode": 0o644}):
            with self.subTest(change=change), self.assertRaisesRegex(b.VerificationError, "file_metadata"):
                self.read(**change)
        (self.history / "history-evidence.json").write_text('{"format":1,"format":1}')
        self.expected_history = b.file_hash(self.history / "history-evidence.json")
        with self.assertRaisesRegex(b.VerificationError, "history_json"): self.read()

    def test_changed_restored_catalog_fails_even_with_new_receipt(self):
        changed = copy.deepcopy(self.catalog)
        changed["postgres"]["roles"][0]["rolsuper"] = True
        self.add_file(self.history, self.history_evidence, "catalog-restored.json", changed)
        self.save_history(repin=True)
        with self.assertRaisesRegex(b.VerificationError, "catalog_anchor"): self.read()

    def test_wrong_directory_never_reads_an_arbitrary_restore(self):
        self.history = self.root / "untrusted"
        with patch.object(b, "STATE_ROOT", self.root), patch.object(b, "private_dir"), \
                self.assertRaisesRegex(b.VerificationError, "fixed_directory"):
            b.read_approved_history(m, self.source, self.history, self.anchor, self.expected, self.expected_history)

    def test_valid_looking_replacement_history_still_requires_reviewed_receipt(self):
        self.history_evidence["unreviewed_replacement"] = True
        self.save_history()
        with self.assertRaisesRegex(b.VerificationError, "history_evidence_integrity"): self.read()


if __name__ == "__main__":
    unittest.main()
