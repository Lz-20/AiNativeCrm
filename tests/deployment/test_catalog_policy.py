"""Behavioral security cases from independently captured vendor DDL metadata."""
import copy
import datetime as dt
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import stat
from types import SimpleNamespace
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


def history_fixture(catalog, topology):
    # These OIDs describe the synthetic historical snapshot, not today's source.
    return {"format": 1, "context": "authenticated_logical_restore",
            "approved_catalog_sha256": m.digest(catalog), "source_evidence_sha256": "a" * 64,
            "source_archive_sha256": "b" * 64, "history_evidence_sha256": "c" * 64,
            "catalog": copy.deepcopy(catalog), "topology": copy.deepcopy(topology)}


class FirstMigrationTests(unittest.TestCase):
    def setUp(self):
        self.catalog, self.topology, _ = fixture()
        add_partition(self.catalog, self.topology, dt.date(2026, 11, 17))
        self.approved = copy.deepcopy(self.catalog)
        self.history = history_fixture(self.catalog, self.topology)
        self.now = "2026-11-22T12:00:00+00:00"

    def build(self, history=True):
        return m.build_policy(self.approved, m.digest(self.approved), self.catalog, self.topology,
                              m.SOURCE_CONTRACT, self.now,
                              historical_restore=self.history if history else None)

    def test_all_original_partitions_still_exist(self):
        self.build(False)
        self.build()

    def test_partial_expired_removal(self):
        remove_partition(self.catalog, self.topology, "messages_2026_11_16")
        policy = self.build()
        self.assertEqual(policy["initial_partitions"], ["messages_2026_11_17"])
        self.assertEqual(policy["legacy_catalog_sha256"], m.digest(self.approved))

    def test_all_originals_expired_and_current_empty(self):
        for name in m.names_in(self.approved):
            remove_partition(self.catalog, self.topology, name)
        self.assertEqual(self.build()["initial_partitions"], [])

    def test_all_originals_expired_with_new_valid_partitions_and_later_maintenance(self):
        for name in m.names_in(self.approved):
            remove_partition(self.catalog, self.topology, name)
        add_partition(self.catalog, self.topology, dt.date(2026, 11, 21))
        policy = self.build()
        previous = policy["initial_partitions"]
        remove_partition(self.catalog, self.topology, "messages_2026_11_21")
        add_partition(self.catalog, self.topology, dt.date(2026, 11, 26))
        m.evaluate(self.catalog, self.topology, policy, "2026-11-27T12:00:00+00:00", m.SOURCE_CONTRACT, previous)

    def test_expiry_does_not_waive_missing_historical_topology(self):
        remove_partition(self.catalog, self.topology, "messages_2026_11_16")
        with self.assertRaisesRegex(m.CatalogError, "original_partition_topology_unavailable"):
            self.build(False)
        self.history["topology"]["partitions"][0]["parent_oids"] = [123]
        with self.assertRaisesRegex(m.CatalogError, "topology_or_bound"):
            self.build()

    def test_early_removal_rejected_even_with_verified_history(self):
        self.now = NOW
        remove_partition(self.catalog, self.topology, "messages_2026_11_16")
        with self.assertRaisesRegex(m.CatalogError, "removed_before_retention"):
            self.build()

    def test_missing_original_or_replaced_history_catalog_is_rejected(self):
        with self.assertRaises(m.CatalogError):
            m.build_policy(None, m.digest(self.approved), self.catalog, self.topology, m.SOURCE_CONTRACT, self.now)
        self.history["catalog"]["postgres"]["roles"][0]["rolsuper"] = True
        with self.assertRaisesRegex(m.CatalogError, "historical_catalog_anchor"):
            self.build()

    def test_history_receipt_and_context_cannot_be_omitted_or_faked_as_live(self):
        for key, value in (("source_evidence_sha256", None), ("context", "source"), ("format", True)):
            with self.subTest(key=key):
                original = self.history[key]
                self.history[key] = value
                with self.assertRaises(m.CatalogError): self.build()
                self.history[key] = original

    def test_historical_partition_template_mutation_is_rejected(self):
        row = next(r for r in self.approved["postgres"]["relations"] if r.get("relname") == "messages_2026_11_16")
        row["owner"] = "anon"
        self.history = history_fixture(self.approved, self.history["topology"])
        with self.assertRaises(m.CatalogError): self.build()

    def test_new_partition_owner_acl_rls_and_index_stay_strict(self):
        saved = copy.deepcopy((self.catalog, self.topology))
        for attribute, value in (("owner", "anon"), ("acl", ["anon=r/anon"]), ("relrowsecurity", True)):
            self.catalog, self.topology = copy.deepcopy(saved)
            add_partition(self.catalog, self.topology, dt.date(2026, 11, 21))
            row = next(r for r in self.catalog["postgres"]["relations"] if r.get("relname") == "messages_2026_11_21")
            row[attribute] = value
            with self.assertRaises(m.CatalogError): self.build()
        self.catalog, self.topology = copy.deepcopy(saved)
        add_partition(self.catalog, self.topology, dt.date(2026, 11, 21))
        self.topology["partitions"][-1]["indexes"][0]["owner"] = "anon"
        with self.assertRaises(m.CatalogError): self.build()

    def test_first_migration_still_rejects_static_roles_functions_and_business_changes(self):
        for kind, row in (("roles", {"rolname": "extra"}), ("functions", {"proname": "extra"})) + tuple(
                ("relations", {"schema_name": schema, "relname": "extra"}) for schema in ("public", "auth", "storage")):
            with self.subTest(kind=kind):
                self.setUp()
                self.catalog["postgres"][kind].append(row)
                with self.assertRaisesRegex(m.CatalogError, "static_catalog_drift"): self.build()


class CatalogPolicyTests(unittest.TestCase):
    def setUp(self):
        self.catalog, self.topology, self.policy = fixture()

    def evaluate(self, now=NOW, previous=None, origin=None):
        return m.evaluate(self.catalog, self.topology, self.policy, now,
                          m.SOURCE_CONTRACT if origin is None else origin, previous)

    def test_identical_catalog_passes(self):
        self.assertEqual(self.evaluate()["static_catalog_sha256"], self.policy["static_catalog_sha256"])

    def test_policy_json_rejects_duplicate_keys_nonfinite_values_and_boolean_version(self):
        for raw in ['{"format":1,"format":1}', '{"nested":{"x":1,"x":2}}', '{"value":NaN}', '[]']:
            with self.subTest(raw=raw), self.assertRaises(m.CatalogError):
                m.parse_policy(raw)
        self.policy["format"] = True
        with self.assertRaisesRegex(m.CatalogError, "catalog_policy_format"):
            self.evaluate()

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

    def check(self, raw_policy=None):
        path = self.root / "catalog-policy.json"
        path.write_text(json.dumps(self.policy) if raw_policy is None else raw_policy)
        with patch.object(e, "INSTALL", self.install), patch.object(e, "secure_path"):
            return self.runtime.verify_catalog_policy(self.proof, self.state, self.root, path)

    def test_root_gate_recalculates_successful_proof(self):
        self.check()

    def test_root_gate_uses_duplicate_rejecting_parser(self):
        with self.assertRaisesRegex(e.Failure, "duplicate_key"):
            self.check('{"format":1,"format":1}')

    def test_missing_observation_timestamp_is_fixed_failure_not_key_error(self):
        self.observed.pop("observed_at")
        self.evidence.pop("started_at")
        self.write_evidence()
        with self.assertRaisesRegex(e.Failure, "catalog_timestamp"):
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


class PartitionHistoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.directory = self.root / "backups" / "fixture"
        self.directory.mkdir(parents=True)
        self.catalog, self.topology, self.policy = fixture()
        self.catalog_path = self.directory / "catalog-source.json"
        self.catalog_path.write_text(json.dumps(self.catalog))
        self.evidence = {"source_container_id": b.SOURCE_CONTAINER_ID, "source_database_writes": False,
                         "restore_verified": True, "restart_verified": True, "storage_verified": True,
                         "differences": 0, "files": [{"file": "catalog-source.json",
                             "sha256": b.file_hash(self.catalog_path), "bytes": self.catalog_path.stat().st_size}]}
        self.proof = {"source_system_identifier": b.SOURCE_SYSTEM_ID, "source_database": "postgres",
                      "restore_verified": True, "differences": 0, "backup_directory": str(self.directory),
                      "source_catalog_sha256": m.digest(self.catalog)}

    def save(self):
        evidence_path = self.directory / "evidence.json"
        evidence_path.write_text(json.dumps(self.evidence))
        self.proof["evidence_sha256"] = b.file_hash(evidence_path)
        (self.root / "backup-attestation.json").write_text(json.dumps(self.proof))

    def read_history(self, *, owner=0, mode=0o600):
        # Only metadata is simulated for portable Windows/non-root CI fixtures.
        # All file content, receipts and canonical hashes are actually read.
        def metadata(path):
            info = path.stat()
            return SimpleNamespace(st_uid=owner, st_mode=stat.S_IFREG | mode,
                                   st_nlink=1, st_size=info.st_size)
        with patch.object(b, "STATE_ROOT", self.root), patch.object(b, "private_dir"), \
                patch.object(Path, "lstat", metadata):
            return b.previous_partition_names(m, self.policy)

    def test_legacy_bootstrap_requires_complete_authenticated_restore(self):
        self.save()
        self.assertEqual(self.read_history(), self.policy["initial_partitions"])

    def test_missing_history_never_resets_to_initial_names(self):
        with patch.object(b, "STATE_ROOT", self.root):
            with self.assertRaisesRegex(b.VerificationError, "prior_proof_missing"):
                b.previous_partition_names(m, self.policy)

    def test_corrupt_legacy_receipt_or_wrong_source_is_rejected(self):
        self.save()
        self.catalog_path.write_text("{}")
        with self.assertRaisesRegex(b.VerificationError, "legacy_catalog_integrity"):
            self.read_history()
        self.proof["source_system_identifier"] = "other-cluster"
        self.save()
        with self.assertRaisesRegex(b.VerificationError, "source_or_restore"):
            self.read_history()

    def test_incomplete_restore_and_wrong_file_permissions_fail_closed(self):
        self.evidence["storage_verified"] = False
        self.save()
        with self.assertRaisesRegex(b.VerificationError, "source_or_restore"):
            self.read_history()
        self.evidence["storage_verified"] = True
        self.save()
        for change in ({"owner": 1000}, {"mode": 0o644}):
            with self.subTest(change=change), self.assertRaisesRegex(b.VerificationError, "prior_proof_owner"):
                self.read_history(**change)

    def test_policy_history_cannot_silently_switch_policy(self):
        self.proof["catalog_policy_sha256"] = "0" * 64
        self.save()
        with self.assertRaisesRegex(b.VerificationError, "prior_policy_changed"):
            self.read_history()


if __name__ == "__main__":
    unittest.main()
