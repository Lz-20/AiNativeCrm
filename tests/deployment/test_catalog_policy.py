"""Behavioral security cases from independently captured vendor DDL metadata."""
import copy
import datetime as dt
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


m = load("catalog_test_module", ROOT / "deploy/staging/catalog_policy.py")
b = load("backup_test_module", ROOT / "deploy/staging/backup_verify.py")
e = load("engine_test_module", ROOT / "deploy/staging/engine.py")
FIXTURE = json.loads((ROOT / "tests/deployment/fixtures/realtime_partition.json").read_text())
NOW = "2026-11-17T12:00:00+00:00"
OLD_NAME = FIXTURE["partition_name"]


def renamed(value, old, new):
    if isinstance(value, str):
        return value.replace(old, new)
    if isinstance(value, list):
        return [renamed(v, old, new) for v in value]
    if isinstance(value, dict):
        return {k: renamed(v, old, new) for k, v in value.items()}
    return value


def add_partition(catalog, topology, day):
    name = "messages_" + day.strftime("%Y_%m_%d")
    row = renamed(copy.deepcopy(FIXTURE["topology"]["partitions"][0]), OLD_NAME, name)
    row["oid"] = 100000 + (day - dt.date(2026, 1, 1)).days
    row["bound"] = ("FOR VALUES FROM ('" + day.isoformat() + " 00:00:00') TO ('"
                    + (day + dt.timedelta(days=1)).isoformat() + " 00:00:00')")
    for typ in row["types"]:
        if typ["kind"] == "c":
            typ["relation_oid"] = row["oid"]
    topology["partitions"].append(row)
    for kind, values in FIXTURE["rows"].items():
        values = renamed(copy.deepcopy(values), OLD_NAME, name)
        if kind == "indexes":
            for value in values:
                definition = next(r["definition"] for r in row["indexes"] if r["name"] == value["index_name"])
                value["definition_hash"] = hashlib.md5(definition.encode()).hexdigest()
        catalog["postgres"][kind].extend(values)
        catalog["postgres"][kind].sort(key=lambda v: json.dumps(v, sort_keys=True, separators=(",", ":")))
    return name


def remove_partition(catalog, topology, name):
    # Fixture operation only; never issues SQL or touches a real database.
    for kind in m.CLASSES:
        catalog["postgres"][kind] = [r for r in catalog["postgres"][kind] if not m.owned_row(kind, r, name)]
    topology["partitions"] = [r for r in topology["partitions"] if r["name"] != name]


def fixture():
    classes = list(b.CATALOG_QUERIES)
    catalog = {db: {key: [] for key in classes} for db in b.DATABASES}
    # Static sentinels ensure the exception cannot swallow other schemas or role/function changes.
    catalog["postgres"]["roles"] = [{"rolname": "fixture_role", "rolsuper": False}]
    catalog["postgres"]["relations"] = [{"schema_name": schema, "relname": "protected", "owner": "fixture"}
                                             for schema in ("public", "auth", "storage", "realtime")]
    catalog["postgres"]["functions"] = [{"schema_name": "public", "proname": "guard", "definition_hash": "fixed"}]
    catalog["postgres"]["policies"] = [{"schemaname": "public", "tablename": "protected", "policyname": "tenant", "roles": ["authenticated"]}]
    topology = {"parent": copy.deepcopy(FIXTURE["topology"]["parent"]), "partitions": []}
    add_partition(catalog, topology, dt.date(2026, 11, 16))
    policy = m.build_policy(catalog, m.digest(catalog), catalog, topology, m.SOURCE_CONTRACT, NOW)
    return catalog, topology, policy


class CatalogPolicyTests(unittest.TestCase):
    def setUp(self):
        self.catalog, self.topology, self.policy = fixture()

    def evaluate(self, now=NOW, previous=None, origin=None):
        return m.evaluate(self.catalog, self.topology, self.policy, now,
                          m.SOURCE_CONTRACT if origin is None else origin, previous)

    def test_identical_catalog_passes(self):
        self.assertEqual(self.evaluate()["static_catalog_sha256"], self.policy["static_catalog_sha256"])

    def test_only_validated_new_day_is_allowed(self):
        original = self.evaluate()
        add_partition(self.catalog, self.topology, dt.date(2026, 11, 17))
        result = self.evaluate()
        self.assertEqual(result["static_catalog_sha256"], original["static_catalog_sha256"])
        self.assertNotEqual(result["raw_catalog_sha256"], original["raw_catalog_sha256"])

    def test_continuous_maintenance_and_next_day_do_not_require_new_static_approval(self):
        for day in range(17, 21):
            add_partition(self.catalog, self.topology, dt.date(2026, 11, day))
        first = self.evaluate()
        add_partition(self.catalog, self.topology, dt.date(2026, 11, 21))
        second = self.evaluate("2026-11-18T12:00:00+00:00", first["partition_names"])
        self.assertEqual(first["static_catalog_sha256"], second["static_catalog_sha256"])

    def test_only_expired_partition_removal_is_allowed(self):
        previous = self.evaluate()["partition_names"]
        remove_partition(self.catalog, self.topology, OLD_NAME)
        with self.assertRaisesRegex(m.CatalogError, "removed_before_retention"):
            self.evaluate(previous=previous)
        self.evaluate("2026-11-20T12:00:00+00:00", previous)

    def test_new_backdated_or_future_partitions_are_rejected(self):
        for day in (dt.date(2026, 10, 1), dt.date(2026, 11, 21)):
            with self.subTest(day=day):
                self.setUp()
                add_partition(self.catalog, self.topology, day)
                with self.assertRaises(m.CatalogError):
                    self.evaluate()

    def test_fake_name_without_partition_or_wrong_oid_parent_is_rejected(self):
        for key, value in [("partition", False), ("parent_oids", [1]), ("parent_oids", [17826, 1]),
                           ("schema", "public"), ("kind", "p"), ("access_method", "evil"),
                           ("persistence", "u"), ("tablespace", 1), ("options", ["x=y"])]:
            with self.subTest(key=key):
                self.setUp()
                self.topology["partitions"][0][key] = value
                with self.assertRaises(m.CatalogError):
                    self.evaluate()

    def test_overlapping_or_wrong_midnight_bounds_are_rejected(self):
        for bounds in ["DEFAULT", "FOR VALUES FROM ('2026-11-16 00:01:00') TO ('2026-11-17 00:00:00')",
                       "FOR VALUES FROM ('2026-11-16 00:00:00') TO ('2026-11-18 00:00:00')"]:
            with self.subTest(bounds=bounds):
                self.topology["partitions"][0]["bound"] = bounds
                with self.assertRaises(m.CatalogError):
                    self.evaluate()

    def test_owner_acl_and_rls_mutations_are_rejected(self):
        for key, value in [("owner", "anon"), ("acl", ["anon=arwdDxtm/supabase_realtime_admin"]),
                           ("relrowsecurity", True), ("relforcerowsecurity", True)]:
            with self.subTest(key=key):
                self.setUp()
                row = next(r for r in self.catalog["postgres"]["relations"] if r["relname"] == OLD_NAME)
                row[key] = value
                with self.assertRaises(m.CatalogError):
                    self.evaluate()

    def test_column_default_type_or_column_acl_mutation_is_rejected(self):
        for key, value in [("default_hash", "evil"), ("type_name", "text"), ("acl", ["anon=r/fixture"])]:
            with self.subTest(key=key):
                self.setUp()
                self.catalog["postgres"]["columns"][0][key] = value
                with self.assertRaises(m.CatalogError):
                    self.evaluate()

    def test_abnormal_indexes_constraints_triggers_policies_and_rules_are_rejected(self):
        for kind in ("indexes", "constraints", "triggers", "policies"):
            with self.subTest(kind=kind):
                self.setUp()
                self.catalog["postgres"][kind].append({"schema_name": "realtime", "table_name": OLD_NAME,
                                                       "schemaname": "realtime", "tablename": OLD_NAME, "extra": "unexpected"})
                with self.assertRaises(m.CatalogError):
                    self.evaluate()
        self.setUp()
        self.topology["partitions"][0]["rules"] = ["CREATE RULE hidden"]
        with self.assertRaises(m.CatalogError):
            self.evaluate()

    def test_index_attachment_definition_and_owner_must_all_match(self):
        for key, value in [("owner", "anon"), ("definition", "CREATE INDEX evil"), ("parent_indexes", [])]:
            with self.subTest(key=key):
                self.setUp()
                self.topology["partitions"][0]["indexes"][0][key] = value
                with self.assertRaises(m.CatalogError):
                    self.evaluate()

    def test_pg_restore_primary_key_flag_is_only_accepted_in_guarded_copy_context(self):
        self.topology["partitions"][0]["constraints"][0]["noinherit"] = True
        with self.assertRaises(m.CatalogError):
            self.evaluate()
        result = m.evaluate(self.catalog, self.topology, self.policy, NOW, m.SOURCE_CONTRACT, logical_restore=True)
        self.assertEqual(result["context"], "logical_restore")
        self.topology["partitions"][0]["constraints"][1]["noinherit"] = True
        with self.assertRaises(m.CatalogError):
            m.evaluate(self.catalog, self.topology, self.policy, NOW, m.SOURCE_CONTRACT, logical_restore=True)

    def test_publication_filters_and_extra_membership_are_rejected(self):
        for key, value in [("pubname", "evil"), ("rowfilter", "true"), ("attnames", ["topic"])]:
            with self.subTest(key=key):
                self.setUp()
                self.catalog["postgres"]["publication_tables"][0][key] = value
                with self.assertRaises(m.CatalogError):
                    self.evaluate()
        self.setUp()
        self.topology["partitions"][0]["direct_publications"] = ["unexpected"]
        with self.assertRaises(m.CatalogError):
            self.evaluate()

    def test_type_oid_links_extensions_and_dependents_are_rejected(self):
        for key, value in [("extension_memberships", ["pgcrypto"]), ("extra_dependents", [{"class": "pg_rewrite"}]),
                           ("security_labels", 1)]:
            with self.subTest(key=key):
                self.setUp()
                self.topology["partitions"][0][key] = value
                with self.assertRaises(m.CatalogError):
                    self.evaluate()
        self.setUp()
        self.topology["partitions"][0]["types"][1]["relation_oid"] = 1
        with self.assertRaises(m.CatalogError):
            self.evaluate()

    def test_other_schemas_roles_functions_and_unrelated_realtime_objects_remain_exact(self):
        for kind, row in [("roles", {"rolname": "attacker"}), ("functions", {"proname": "evil"}),
                          ("default_acl", {"grant": "anon=ALL"}), ("policies", {"policyname": "allow_all"})] + [
                              ("relations", {"schema_name": schema, "relname": "extra"})
                              for schema in ("public", "auth", "storage", "realtime")]:
            with self.subTest(kind=kind, row=row):
                self.setUp()
                self.catalog["postgres"][kind].append(row)
                with self.assertRaisesRegex(m.CatalogError, "static_catalog_drift"):
                    self.evaluate()
        self.setUp()
        self.catalog["_supabase"]["roles"].append({"rolname": "attacker"})
        with self.assertRaises(m.CatalogError):
            self.evaluate()

    def test_unreviewed_source_missing_inventory_and_forged_static_approval_are_rejected(self):
        with self.assertRaisesRegex(m.CatalogError, "source_unreviewed"):
            self.evaluate(origin={"kind": "unknown"})
        self.topology["partitions"] = []
        with self.assertRaises(m.CatalogError):
            self.evaluate()
        with self.assertRaises(m.CatalogError):
            m.validate_policy(self.policy, "0" * 64)

    def test_policy_migration_never_blesses_current_raw_hash_or_other_static_changes(self):
        old = copy.deepcopy(self.catalog)
        add_partition(self.catalog, self.topology, dt.date(2026, 11, 17))
        policy = m.build_policy(old, m.digest(old), self.catalog, self.topology, m.SOURCE_CONTRACT, NOW)
        self.assertEqual(policy["legacy_catalog_sha256"], m.digest(old))
        self.assertNotEqual(policy["legacy_catalog_sha256"], m.digest(self.catalog))
        self.catalog["postgres"]["roles"][0]["rolsuper"] = True
        with self.assertRaises(m.CatalogError):
            m.build_policy(old, m.digest(old), self.catalog, self.topology, m.SOURCE_CONTRACT, NOW)

    def test_restore_comparison_is_still_raw_and_rejects_any_data_difference(self):
        b.require_equal(self.catalog, copy.deepcopy(self.catalog), "catalog")
        changed = copy.deepcopy(self.catalog)
        changed["postgres"]["roles"][0]["rolsuper"] = True
        with self.assertRaises(b.VerificationError):
            b.require_equal(self.catalog, changed, "catalog")
        with self.assertRaises(b.VerificationError):
            b.require_equal({"public.fixture": {"count": 1, "hash": "original"}},
                            {"public.fixture": {"count": 1, "hash": "changed"}}, "data")


class RootProofTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.install = self.root / "install"
        self.install.mkdir()
        (self.install / "catalog_policy.py").write_bytes((ROOT / "deploy/staging/catalog_policy.py").read_bytes())
        self.catalog, self.topology, self.policy = fixture()
        self.observed = m.evaluate(self.catalog, self.topology, self.policy, NOW, m.SOURCE_CONTRACT)
        self.files = {"catalog-source.json": self.catalog, "partition-source.json": self.topology}
        inventory = []
        for name, value in self.files.items():
            raw = json.dumps(value).encode()
            (self.root / name).write_bytes(raw)
            inventory.append({"file": name, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()})
        self.evidence = {"started_at": NOW, "restore_verified": True, "restart_verified": True,
                         "storage_verified": True, "differences": 0,
                         "partition_validation": self.observed, "files": inventory}
        self.write_evidence()
        self.proof = {"source_catalog_sha256": m.digest(self.catalog),
                      "static_catalog_sha256": self.observed["static_catalog_sha256"],
                      "catalog_policy_sha256": m.digest(self.policy), "partition_validation": self.observed}
        self.runtime = object.__new__(e.RootRuntime)
        self.state = {"approved_catalog_sha256": self.policy["legacy_catalog_sha256"]}

    def write_evidence(self):
        (self.root / "evidence.json").write_text(json.dumps(self.evidence))

    def check(self):
        with patch.object(e, "INSTALL", self.install), patch.object(e, "secure_path"), \
                patch.object(e, "read_root_json", return_value=self.policy):
            return self.runtime.verify_catalog_policy(self.proof, self.state, self.root, self.root / "catalog-policy.json")

    def test_root_gate_recalculates_successful_proof(self):
        self.check()

    def test_root_gate_rejects_restore_differences_even_if_policy_hash_matches(self):
        self.evidence["differences"] = 1
        self.write_evidence()
        with self.assertRaisesRegex(e.Failure, "restore_not_verified"):
            self.check()

    def test_root_gate_rejects_tampered_catalog_file(self):
        (self.root / "catalog-source.json").write_text("{}")
        with self.assertRaisesRegex(e.Failure, "evidence_integrity"):
            self.check()

    def test_root_gate_rejects_unversioned_or_forged_projection(self):
        for key in ("catalog_policy_sha256", "static_catalog_sha256", "source_catalog_sha256"):
            with self.subTest(key=key):
                saved = self.proof[key]
                self.proof[key] = "0" * 64
                with self.assertRaises(e.Failure):
                    self.check()
                self.proof[key] = saved

    def test_root_gate_never_accepts_the_restore_only_context_as_source_evidence(self):
        self.observed["context"] = "logical_restore"
        self.write_evidence()
        with self.assertRaisesRegex(e.Failure, "proof_recalculation"):
            self.check()

    def test_partition_query_is_read_only_and_does_not_read_customer_tables(self):
        self.assertTrue(m.INVENTORY_SQL.strip().startswith("SELECT"))
        self.assertIsNone(__import__("re").search(r"\b(?:ALTER|DROP|CREATE|INSERT|UPDATE|DELETE|COPY)\b", m.INVENTORY_SQL))
        self.assertNotIn("public.contacts", m.INVENTORY_SQL)

    def backup_gate(self, activate, raw_hash=None, age_seconds=0):
        state_dir = self.root / "state"
        directory = state_dir / "backups" / "fixture"
        directory.mkdir(parents=True, exist_ok=True)
        for name in ("evidence.json", "catalog-source.json", "partition-source.json"):
            (directory / name).write_bytes((self.root / name).read_bytes())
        config = self.root / "config"
        config.mkdir(exist_ok=True)
        if activate:
            (config / "catalog-policy.json").write_text(json.dumps(self.policy))
        proof = {**self.proof, "verified_at": (dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=age_seconds)).isoformat(),
                 "restore_verified": True, "differences": 0, "source_system_identifier": "unit-fixture",
                 "source_database": "postgres", "backup_directory": str(directory),
                 "evidence_sha256": hashlib.sha256((directory / "evidence.json").read_bytes()).hexdigest()}
        if raw_hash is not None:
            proof["source_catalog_sha256"] = raw_hash
        (state_dir / "backup-attestation.json").write_text(json.dumps(proof))
        self.runtime.policy = {"system_identifier": "unit-fixture"}
        with patch.object(e, "STATE", state_dir), patch.object(e, "CONFIG", config), \
                patch.object(e, "INSTALL", self.install), patch.object(e, "secure_path"):
            return self.runtime.backup(self.state)

    def test_missing_policy_preserves_legacy_full_catalog_protection(self):
        self.backup_gate(False)
        with self.assertRaisesRegex(e.Failure, "database_catalog_drift"):
            self.backup_gate(False, raw_hash="0" * 64)

    def test_optional_policy_keeps_original_state_anchor_and_recalculates_proof(self):
        before = copy.deepcopy(self.state)
        self.backup_gate(True)
        self.assertEqual(before, self.state)

    def test_optional_policy_does_not_waive_freshness(self):
        with self.assertRaisesRegex(e.Failure, "fresh_verified_backup_required"):
            self.backup_gate(True, age_seconds=90000)

    def test_live_origin_rejects_an_unreviewed_image_even_with_healthy_container(self):
        with patch.object(b, "run", return_value=b"fixture-container\n"), \
                patch.object(b, "inspect_container", return_value={"Image": "sha256:" + "0" * 64,
                    "State": {"Health": {"Status": "healthy"}}}):
            with self.assertRaisesRegex(b.VerificationError, "source_unreviewed"):
                b.realtime_origin(m)

    def test_absent_operator_policy_does_not_load_candidate_code(self):
        with patch.object(b, "CATALOG_POLICY", self.root / "not-installed.json"), \
                patch.object(b.importlib.util, "spec_from_file_location") as loader:
            self.assertIsNone(b.catalog_extension())
            loader.assert_not_called()

    def test_ensure_backup_rechecks_live_policy_and_audits_only_fixed_hash_fields(self):
        proof = {**self.proof, "verified_at": (dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=2)).isoformat(),
                 "source_system_identifier": "unit-fixture"}
        live = {k: proof[k] for k in ("source_system_identifier", "source_catalog_sha256",
                                      "catalog_policy_sha256", "static_catalog_sha256")}
        with patch.object(e.RootRuntime, "backup", return_value=proof), \
                patch.object(e.RootRuntime, "command", side_effect=[b"", json.dumps(live).encode()]), \
                patch.object(e.RootRuntime, "audit") as audit:
            self.runtime.ensure_backup(self.state)
            self.assertEqual(audit.call_args[0][0]["phase"], "catalog_policy_verified")
            self.assertNotIn("template_catalog", audit.call_args[0][0])
        live["static_catalog_sha256"] = "0" * 64
        with patch.object(e.RootRuntime, "backup", return_value=proof), \
                patch.object(e.RootRuntime, "command", side_effect=[b"", json.dumps(live).encode()]), \
                patch.object(e.RootRuntime, "audit") as audit:
            with self.assertRaisesRegex(e.Failure, "live_catalog_policy_changed"):
                self.runtime.ensure_backup(self.state)
            audit.assert_not_called()


if __name__ == "__main__":
    unittest.main()
