"""Behavior gates for the root-owned, staging-only logical backup verifier."""
import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from unittest.mock import MagicMock

SCRIPT = Path(__file__).parents[2] / "deploy/staging/backup_verify.py"


class BackupVerifierTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if SCRIPT.exists():
            spec = importlib.util.spec_from_file_location("backup_verify", SCRIPT)
            cls.module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.module)

    def fixture(self):
        grants = [{"grantor": "supabase_admin", "grantee": "supabase_admin", "privilege": "USAGE", "grantable": False},
                  {"grantor": "supabase_admin", "grantee": "postgres", "privilege": "USAGE", "grantable": True}]
        result = [{"kind": "schema", "name": name, "owner": "supabase_admin", "grants": grants}
                  for name in ["graphql", "graphql_public"]]
        for name in ["http_get", "http_post"]:
            body = "CREATE OR REPLACE FUNCTION net." + name + "() RETURNS integer LANGUAGE sql AS 'SELECT 1';"
            result.append({"kind": "function", "name": name, "owner": "supabase_admin", "signature": "",
                           "definition": body, "grants": [{"grantor": "supabase_admin", "grantee": "PUBLIC", "privilege": "EXECUTE", "grantable": False}]})
        return result

    def allow_fixture_functions(self):
        return patch.dict(self.module.FUNCTION_HASHES,
                          {o["name"]: hashlib.md5(o["definition"].encode()).hexdigest()
                           for o in self.fixture() if o["kind"] == "function"})

    def test_helper_exists(self):
        self.assertTrue(SCRIPT.is_file(), "root-only backup verifier must exist")

    def get_module(self):
        if not SCRIPT.exists():
            self.skipTest("implementation pending")
        return self.module

    def test_canonical_digest_is_order_independent(self):
        m = self.get_module()
        self.assertEqual(m.canonical_hash({"b": 2, "a": 1}), m.canonical_hash({"a": 1, "b": 2}))
        self.assertNotEqual(m.canonical_hash({"a": 1}), m.canonical_hash({"a": 2}))

    def test_identity_rejects_other_cluster_or_database_set(self):
        m = self.get_module()
        good = {"system_identifier": m.SOURCE_SYSTEM_ID, "server_version": "17.6", "databases": ["_supabase", "postgres"]}
        m.validate_identity(good)
        for key, value in [("system_identifier", "unexpected"), ("server_version", "16.0"), ("databases", ["postgres", "production"])]:
            with self.assertRaises(m.VerificationError):
                m.validate_identity({**good, key: value})

    def test_readonly_transaction_export_is_not_replication(self):
        m = self.get_module()
        begin = m.SNAPSHOT_BEGIN.upper()
        self.assertIn("REPEATABLE READ READ ONLY", begin)
        self.assertIn("PG_EXPORT_SNAPSHOT", begin)
        self.assertNotIn("REPLICATION", begin)

    def test_compensation_only_accepts_four_reviewed_objects(self):
        m = self.get_module()
        source = self.fixture()
        with self.allow_fixture_functions():
            sql = m.build_compensation(source)
        self.assertIn("CREATE OR REPLACE FUNCTION", sql)
        self.assertIn("GRANT USAGE ON SCHEMA", sql)
        self.assertNotIn("DROP ", sql)
        source[0]["name"] = "auth"
        with self.assertRaises(m.VerificationError):
            m.build_compensation(source)

    def test_compensation_keeps_grant_option_and_grantor(self):
        m = self.get_module()
        with self.allow_fixture_functions():
            sql = m.build_compensation(self.fixture())
        self.assertIn('TO "postgres" WITH GRANT OPTION', sql)
        self.assertIn('SET LOCAL ROLE "supabase_admin"', sql)

    def test_compensation_rejects_unreviewed_function_body(self):
        m = self.get_module()
        source = self.fixture()
        source[-1]["definition"] = "DROP DATABASE postgres;"
        with self.assertRaises(m.VerificationError):
            m.build_compensation(source)

    def test_restore_command_refuses_source_container(self):
        m = self.get_module()
        with self.assertRaises(m.VerificationError):
            m.restore_exec(m.SOURCE_CONTAINER_ID, ["psql"], runner=lambda *_: None)

    def test_copy_must_have_no_network_no_ports_and_resource_cap(self):
        m = self.get_module()
        project = "ainativecrm-backup-20261028t000000z-0123abcd"
        good = {"Id": "b" * 64, "Labels": {"com.docker.compose.project": project}, "NetworkMode": "none", "Ports": {}, "Memory": 3 * 1024 ** 3, "NanoCpus": 10 ** 9, "Mounts": [{"Type": "volume", "Name": project + "_data"}]}
        m.validate_copy(good, project)
        for key, value in [("Id", m.SOURCE_CONTAINER_ID), ("NetworkMode", "host"), ("Ports", {"5432/tcp": [{"HostIp": "127.0.0.1", "HostPort": "5432"}]}), ("Memory", 0), ("NanoCpus", 0)]:
            with self.assertRaises(m.VerificationError):
                m.validate_copy({**good, key: value}, project)

    def test_failed_compare_has_no_attestation(self):
        m = self.get_module()
        with self.assertRaises(m.VerificationError):
            m.require_equal({"postgres": {"tables": [1]}}, {"postgres": {"tables": [2]}}, "catalog")

    def test_tar_rejects_traversal_and_links(self):
        m = self.get_module()
        import io
        import tarfile
        for name, link in [("../escape", False), ("/absolute", False), ("symlink", True)]:
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode="w:gz") as tar:
                member = tarfile.TarInfo(name)
                if link:
                    member.type = tarfile.SYMTYPE
                    member.linkname = "/etc/passwd"
                tar.addfile(member)
            with tempfile.TemporaryDirectory() as root:
                file = Path(root) / "bad.tar.gz"
                file.write_bytes(stream.getvalue())
                with self.assertRaises(m.VerificationError):
                    m.validate_tar(file)

    def test_safe_error_never_contains_command_or_secret(self):
        m = self.get_module()
        message = str(m.VerificationError("dump", "raw-password-secret"))
        self.assertNotIn("raw-password-secret", message)

    def test_storage_metadata_change_rejects_even_when_files_are_stable(self):
        m = self.get_module()
        expected = {"storage.objects": {"count": 2, "hash": "before"},
                    "storage.buckets": {"count": 1, "hash": "same"},
                    "public.contacts": {"count": 4, "hash": "unrelated"}}
        changed = {"storage.objects": {"count": 2, "hash": "after"},
                   "storage.buckets": {"count": 1, "hash": "same"}}
        with patch.object(m, "Snapshot", MagicMock()), patch.object(m, "data_metadata", return_value=changed):
            with self.assertRaisesRegex(m.VerificationError, "storage_metadata_stability"):
                m.check_storage_snapshot(expected)
        changed["storage.objects"]["hash"] = "before"
        with patch.object(m, "Snapshot", MagicMock()), patch.object(m, "data_metadata", return_value=changed):
            m.check_storage_snapshot(expected)

    def test_constraint_array_cast_reparse_has_same_fingerprint(self):
        m = self.get_module()
        source = "CHECK (((kind)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[])))"
        restored = "CHECK (((kind)::text = ANY (ARRAY[('a'::character varying)::text, ('b'::character varying)::text])))"
        self.assertEqual(m.canonical_constraint(source), m.canonical_constraint(restored))
        self.assertNotEqual(m.canonical_constraint(source), m.canonical_constraint(restored.replace("'b'", "'c'")))
        self.assertNotEqual(m.canonical_constraint(source), m.canonical_constraint(restored.replace("varying", "varying(1)")))
        pretty_source = "CHECK (kind::text = ANY (ARRAY['a'::character varying, 'b'::character varying]::text[]))"
        pretty_restored = "CHECK (kind::text = ANY (ARRAY['a'::character varying::text, 'b'::character varying::text]))"
        self.assertEqual(m.canonical_constraint(pretty_source), m.canonical_constraint(pretty_restored))

    def test_constraint_normalization_preserves_literal_contents(self):
        m = self.get_module()
        sql = "CHECK (note = '(ARRAY[''a''::character varying])::text[]')"
        self.assertEqual(m.canonical_constraint(sql), sql)

    def test_acl_normalization_uses_object_specific_default(self):
        m = self.get_module()
        self.assertIn("acldefault('n',nspowner)", m.CATALOG_QUERIES["schemas"])
        self.assertIn("acldefault('r',c.relowner)", m.CATALOG_QUERIES["relations"])
        self.assertIn("acldefault('f',p.proowner)", m.CATALOG_QUERIES["functions"])

    def test_catalog_keeps_real_public_privilege_difference(self):
        m = self.get_module()
        class Session:
            def __init__(self, grants):
                self.grants = grants
            def json(self, query):
                if "FROM pg_proc p" in query:
                    return [{"schema_name": "public", "proname": "probe", "acl": self.grants}]
                return []
        owner_only = m.catalog_metadata(Session(["postgres=X/postgres"]))
        public_execute = m.catalog_metadata(Session(["=X/postgres", "postgres=X/postgres"]))
        self.assertNotEqual(m.canonical_hash(owner_only), m.canonical_hash(public_execute))
        with self.assertRaises(m.VerificationError):
            m.require_equal(owner_only, public_execute, "catalog")


if __name__ == "__main__":
    unittest.main()
