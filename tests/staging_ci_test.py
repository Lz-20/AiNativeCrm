"""Release protocol tests: real Git trees, no server, Docker or cloud credentials."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("staging_ci", ROOT / "scripts/staging-ci.py")
CI = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CI)
SHA = "a" * 40
SCHEMA = "b" * 64
DIGEST = "sha256:" + "c" * 64


class ReleaseProtocol(unittest.TestCase):
    def records(self, path):
        for service in CI.SERVICES:
            (path / f"{service}.json").write_text(json.dumps({
                "service": service, "sha": SHA, "schema_sha256": SCHEMA, "digest": DIGEST
            }), encoding="utf-8")

    def test_manifest_binds_all_three_digests_to_exact_commit_and_schema(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            self.records(path)
            request = CI.make_manifest(path, SHA, SCHEMA, "workflow_dispatch")
            self.assertEqual(request["images"], {s: DIGEST for s in CI.SERVICES})
            self.assertEqual(request["sha"], SHA)
            self.assertEqual(request["trigger"], "workflow_dispatch")

    def test_missing_duplicate_unknown_and_substituted_image_records_fail(self):
        for mutation in ("missing", "duplicate", "service", "sha", "schema_sha256", "digest"):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp)
                self.records(path)
                app = path / "app.json"
                if mutation == "missing":
                    app.unlink()
                elif mutation == "duplicate":
                    (path / "copy.json").write_bytes(app.read_bytes())
                else:
                    record = json.loads(app.read_text())
                    record[mutation] = "unexpected"
                    app.write_text(json.dumps(record))
                with self.assertRaises(ValueError):
                    CI.make_manifest(path, SHA, SCHEMA, "workflow_dispatch")

    def status(self):
        return {"sha": SHA, "schema_sha256": SCHEMA, "backup_verified": True,
                "rollback_verified": True, "auto_deploy_enabled": False, "paused": False}

    def test_manual_deploy_does_not_enable_automatic_deploy(self):
        CI.check_status(self.status(), SCHEMA, "workflow_dispatch")
        with self.assertRaises(ValueError):
            CI.check_status(self.status(), SCHEMA, "push")

    def test_schema_change_pause_and_non_boolean_proof_fail_closed(self):
        for key, value in (("schema_sha256", "d" * 64),
                           ("rollback_verified", "true"), ("paused", True)):
            with self.subTest(key=key):
                status = self.status()
                status[key] = value
                with self.assertRaises(ValueError):
                    CI.check_status(status, SCHEMA, "workflow_dispatch")

    def test_expired_backup_reaches_server_owned_refresh_gate(self):
        status = self.status()
        status["backup_verified"] = False
        CI.check_status(status, SCHEMA, "workflow_dispatch")

    def test_pending_recovery_blocks_new_deploy_but_legacy_missing_field_is_accepted(self):
        status = self.status()
        CI.check_status(status, SCHEMA, "workflow_dispatch")
        status["recovery_required"] = True
        with self.assertRaisesRegex(ValueError, "recovery"):
            CI.check_status(status, SCHEMA, "workflow_dispatch")

    def test_server_must_report_the_exact_requested_sha_and_all_digests(self):
        request = {"sha": SHA, "schema_sha256": SCHEMA, "images": {s: DIGEST for s in CI.SERVICES}}
        CI.verify_release(request, dict(request))
        for key in request:
            status = dict(request)
            status.pop(key)
            with self.subTest(key=key), self.assertRaises(ValueError):
                CI.verify_release(request, status)

    def test_ssh_arguments_reject_shell_metacharacters(self):
        for host, user in (("host;echo", "crm-actions"), ("-oProxyCommand=x", "crm-actions"),
                           ("127.0.0.1", "root;id"), ("[::1]", "crm-actions")):
            with self.subTest(host=host, user=user), self.assertRaises(ValueError):
                CI.validate_destination(host, user, "22")
        CI.validate_destination("example.invalid", "crm-actions", "22")

    def test_manifest_rejects_unknown_trigger(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.records(Path(tmp))
            with self.assertRaises(ValueError):
                CI.make_manifest(Path(tmp), SHA, SCHEMA, "pull_request")


class GitFingerprint(unittest.TestCase):
    def test_full_tree_detects_old_schema_change_even_after_unrelated_commit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            def git(*args):
                return subprocess.check_output(["git", "-C", tmp, *args], stderr=subprocess.DEVNULL).decode().strip()
            git("init", "-q")
            git("config", "user.name", "Fixture")
            git("config", "user.email", "fixture@example.invalid")
            (root / "supabase").mkdir()
            (root / "supabase/baseline.sql").write_text("select 1;\n")
            git("add", ".")
            git("commit", "-qm", "schema baseline")
            original = CI.schema_fingerprint(git("rev-parse", "HEAD"), root)
            (root / "README.md").write_text("application change\n")
            git("add", ".")
            git("commit", "-qm", "only app")
            self.assertEqual(original, CI.schema_fingerprint(git("rev-parse", "HEAD"), root))
            (root / "supabase/baseline.sql").write_text("select 2;\n")
            git("add", ".")
            git("commit", "-qm", "changed schema")
            (root / "README.md").write_text("another application change\n")
            git("add", ".")
            git("commit", "-qm", "only app again")
            self.assertNotEqual(original, CI.schema_fingerprint(git("rev-parse", "HEAD"), root))

    def test_non_commit_input_is_rejected(self):
        with self.assertRaises(ValueError):
            CI.schema_fingerprint("--all")


class SshBoundary(unittest.TestCase):
    def test_credentials_stay_out_of_command_and_result_and_temporary_key_is_removed(self):
        with tempfile.TemporaryDirectory() as tmp:
            request, output = Path(tmp) / "request.json", Path(tmp) / "output.json"
            request.write_text('{"operation":"status"}')
            identity_paths = []

            def ssh_fixture(command, **kwargs):
                self.assertIn("StrictHostKeyChecking=yes", command)
                self.assertIn("ClearAllForwardings=yes", command)
                self.assertEqual(command[-1], "ainativecrm-deploy")
                self.assertNotIn("fixture-private-key", " ".join(command))
                self.assertEqual(json.loads(kwargs["input"]), {"operation": "status"})
                identity = Path(command[command.index("-i") + 1])
                identity_paths.append(identity)
                self.assertEqual(identity.read_text(), "fixture-private-key\n")
                return subprocess.CompletedProcess(command, 0,
                    stdout=json.dumps({"sha": SHA, "secret": "never-artifact", "ok": True,
                        "project": "ainativecrm-staging", "recovery_required": False,
                        "transaction": "fixture-transaction"}).encode(), stderr=b"")

            env = {"VPS_HOST": "example.invalid", "VPS_USER": "crm-actions",
                   "VPS_PORT": "22", "VPS_SSH_KEY": "fixture-private-key",
                   "VPS_KNOWN_HOSTS": "example.invalid fixture-known-host"}
            with patch.dict(CI.os.environ, env), patch.object(CI.subprocess, "run", side_effect=ssh_fixture):
                CI.ssh_request(request, output)
            self.assertEqual(json.loads(output.read_text()), {"sha": SHA, "ok": True,
                "project": "ainativecrm-staging", "recovery_required": False,
                "transaction": "fixture-transaction"})
            self.assertFalse(identity_paths[0].exists())

    def test_failed_ssh_never_copies_stderr_or_server_output_to_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            request, output = Path(tmp) / "request.json", Path(tmp) / "output.json"
            request.write_text('{"operation":"status"}')
            env = {"VPS_HOST": "example.invalid", "VPS_USER": "crm-actions",
                   "VPS_PORT": "22", "VPS_SSH_KEY": "fixture-private-key",
                   "VPS_KNOWN_HOSTS": "example.invalid fixture-known-host"}
            result = subprocess.CompletedProcess([], 42, stdout=b"sensitive-output", stderr=b"sensitive-error")
            with patch.dict(CI.os.environ, env), patch.object(CI.subprocess, "run", return_value=result):
                with self.assertRaises(ValueError) as error:
                    CI.ssh_request(request, output)
            self.assertNotIn("sensitive", str(error.exception))
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
