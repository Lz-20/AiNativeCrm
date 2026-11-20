"""Synthetic root histories only. Never imports credentials or contacts a VPS."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import shutil
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('history_under_test', HERE / 'deploy/staging/history_inspect.py')
h = importlib.util.module_from_spec(spec); spec.loader.exec_module(h)
spec = importlib.util.spec_from_file_location('history_engine_under_test', HERE / 'deploy/staging/engine.py')
e = importlib.util.module_from_spec(spec); spec.loader.exec_module(e)


def release(sha, images, schema):
    return {'kind': 'git', 'sha': sha, 'schema_sha256': schema,
            'images': {n: 'ghcr.io/lz-20/ainativecrm-' + n + '@' + images[n] for n in h.SERVICES},
            'image_ids': dict(images)}


class RequestTests(unittest.TestCase):
    def test_inspect_accepts_only_transaction_not_paths_shell_or_extra_fields(self):
        e.decode_request(json.dumps({'operation': 'inspect', 'transaction': h.DEPLOY}).encode())
        for value in ('../state.json', '/etc/shadow', h.DEPLOY + ';id', 'main', 'x' * 10000):
            with self.assertRaises(e.Failure):e.decode_request(json.dumps({'operation': 'inspect', 'transaction': value}).encode())
        with self.assertRaises(e.Failure):e.validate_request({'operation': 'inspect', 'transaction': h.DEPLOY, 'path': '/root'})

    def test_inspection_has_no_audit_side_effect_in_the_engine(self):
        class Runtime:
            def load_state(self):return {}
            def history_inspect(self, request):return {'ok': False, 'status': 'unknown'}
            def audit(self, event):raise AssertionError('inspection must not append audit')
        self.assertEqual(e.ReleaseEngine(Runtime()).run({'operation': 'inspect', 'transaction': h.DEPLOY})['status'], 'unknown')

    def test_installed_module_hash_is_fixed_to_exact_repository_bytes(self):
        self.assertEqual(e.HISTORY_MODULE_SHA256, hashlib.sha256((HERE / 'deploy/staging/history_inspect.py').read_bytes()).hexdigest())

    def test_source_history_gate_requires_actual_main_not_an_ancestor(self):
        rt = object.__new__(e.RootRuntime)
        rt.git = lambda *args: ('d' * 40).encode()
        rt.history_module = lambda: self.fail('wrong main must fail before proof access')
        with self.assertRaisesRegex(e.Failure, 'candidate_must_be_current_main'):
            rt.history_preflight({}, {'operation': 'deploy', 'sha': 'a' * 40}, {})


class Fixture:
    """Uses root's home rather than world-writable /tmp, matching real path rules."""
    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='isolated-history-', dir=Path.home())
        self.base = Path(self.tmp.name).resolve(); self.base.chmod(0o700)
        self.root = self.base / 'state'; self.root.mkdir(mode=0o700)
        self.config = self.base / 'config'; self.config.mkdir(mode=0o700)
        self.patches = [patch.object(h, 'ROOT', self.root), patch.object(h, 'CONFIG', self.config),
                        patch.object(h, 'read_only_runtime', lambda rt: rt.command)]
        for p in self.patches:p.start()
        self.state = {'current': release(h.EA, h.EA_IMAGES, h.EA_SCHEMA),
                      'previous': release(h.AC8, h.AC8_IMAGES, h.SCHEMA), 'pending': None,
                      'approved_schema_sha256': '1' * 64, 'approved_catalog_sha256': '2' * 64,
                      'schema_0412': {'receipt_sha256': '3' * 64},
                      'schema_0413': {'receipt_sha256': '4' * 64}}
        self.records = []
        for txid, operation, sha, images, minute in ((h.DEPLOY, 'deploy', h.AC8, h.AC8_IMAGES, 9),
                                                    (h.RECOVERY, 'rollback', h.EA, h.EA_IMAGES, 13)):
            self.records += [
                {'phase': 'requested', 'operation': operation, 'sha': sha if operation == 'deploy' else None,
                 'images': images if operation == 'deploy' else None, 'at': f'2026-11-20T02:{minute-2:02d}:00+00:00'},
                {'transaction': txid, 'phase': 'started', 'operation': operation, 'sha': sha,
                 'images': release(sha, images, h.SCHEMA)['images'], 'at': f'2026-11-20T02:{minute:02d}:00+00:00'},
                {'transaction': txid, 'phase': 'succeeded', 'operation': operation, 'sha': sha,
                 'images': release(sha, images, h.SCHEMA)['images'], 'at': f'2026-11-20T02:{minute:02d}:59+00:00'}]
        raw = b''.join(h.canonical(v) + b'\n' for v in self.records)
        self.put(self.root / 'deployments.jsonl', raw, raw=True)
        self.patches += [patch.object(h, 'LEGACY_BYTES', len(raw)), patch.object(h, 'LEGACY_HASH', h.digest(raw))]
        for p in self.patches[-2:]:p.start()
        self.put(self.root / 'state.json', self.state)
        for name in ('deployment.lock', 'backup.lock'):self.put(self.root / name, b'', raw=True)
        (self.root / 'backups').mkdir(mode=0o700)
        backup_anchors = {}
        for txid, minute in ((h.DEPLOY, 9), (h.RECOVERY, 13)):
            name = h.LEGACY_BACKUPS[txid][0]
            folder = self.root / 'backups' / name; folder.mkdir(mode=0o700)
            files = []
            for filename in ('postgres.dump', '_supabase.dump', 'storage-files.tar.gz', 'storage-restored.tar.gz',
                             'catalog-source.json', 'catalog-restore.json', 'catalog-restart.json',
                             'data-source.json', 'data-restore.json', 'data-restart.json',
                             'sequences-restore.json', 'sequences-restart.json'):
                content = b'{}\n'
                self.put(folder / filename, content, raw=True)
                files.append({'file': filename, 'bytes': len(content), 'sha256': h.digest(content)})
            ev = {'source_system_identifier': h.SYSTEM, 'source_container_id': '5' * 64,
                  'restore_verified': True, 'restart_verified': True, 'storage_verified': True,
                  'differences': 0, 'source_database_writes': False, 'files': files,
                  'partition_validation': {'static_catalog_sha256': h.STATIC_CATALOG},
                  'source_catalog_sha256': '6' * 64, 'catalog_policy_sha256': '7' * 64,
                  'started_at': f'2026-11-20T02:{minute-1:02d}:10+00:00',
                  'verified_at': f'2026-11-20T02:{minute-1:02d}:20+00:00'}
            self.put(folder / 'evidence.json', ev)
            backup_anchors[txid] = (name, h.digest((folder / 'evidence.json').read_bytes()))
        self.patches.append(patch.object(h, 'LEGACY_BACKUPS', backup_anchors));self.patches[-1].start()
        fixture = self
        class Runtime:
            def __init__(self):
                self.policy = {'db_container_id': '5' * 64, 'system_identifier': h.SYSTEM}
                self.reads = [];self.update_calls = []
            def command(self, args, label, **kwargs):
                self.reads.append(tuple(args))
                return h.canonical({'source_system_identifier': h.SYSTEM, 'static_catalog_sha256': h.STATIC_CATALOG,
                                    'catalog_policy_sha256': '7' * 64})
            def schema_context(self, state):return {'database_schema': h.SCHEMA}
            def verify_current(self, state):pass
            def verify_application_compatibility(self, release, context):pass
            def boundary(self):return {'supabase': {str(i): {} for i in range(11)}, 'protected_services': {}}
            def verify_catalog_policy(self, proof, state, folder, policy):
                fixture.test.assertEqual(proof['static_catalog_sha256'], h.STATIC_CATALOG)
            def docker(self, *args):
                self.reads.append(args)
                if args[:2] == ('image', 'inspect'):
                    release = fixture.state['current'];image = args[-1]
                    name = next(n for n in h.SERVICES if release['image_ids'][n] == image)
                    return h.canonical([{'Id': image, 'RepoDigests': [release['images'][name]], 'Os': 'linux', 'Architecture': 'arm64',
                        'Config': {'Labels': {'org.opencontainers.image.source': 'https://github.com/Lz-20/AiNativeCrm',
                        'org.opencontainers.image.revision': release['sha'], 'io.ainativecrm.schema-sha256': release['schema_sha256']},
                        'Env': ['APP_VERSION=' + release['sha']]}}])
                return h.canonical({'embedding_enabled': 0, 'running': 0, 'reserved_unknown': 0})
        self.rt = Runtime()

    def put(self, path, value, raw=False):
        path.write_bytes(value if raw else h.canonical(value) + b'\n');path.chmod(0o600)

    def approved(self):
        basis, anchor = h.legacy(self.state, self.rt, self.records)
        value = {'format': 1, 'scope': h.CAPABILITY, 'approval_id': '00000000-0000-4000-8000-000000000001',
                 'approved_at': '2026-11-20T02:14:00+00:00', 'approved_by': 'isolated-fixture-human',
                 'authorization_source': 'synthetic-test-only-not-a-production-approval',
                 'evidence_sha256': anchor, 'deploy_transaction': h.DEPLOY, 'recovery_transaction': h.RECOVERY}
        self.put(self.config / 'history-review.json', value)
        return basis, anchor

    def inspect(self, tx=h.DEPLOY):return h.inspect(self.rt, {'operation': 'inspect', 'transaction': tx})

    def close(self):
        for p in reversed(self.patches):p.stop()
        self.tmp.cleanup()


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'real root POSIX boundaries run in isolated Linux CI')
class RootHistoryTests(unittest.TestCase):
    def setUp(self):self.f = Fixture();self.f.test = self
    def tearDown(self):self.f.close()

    def test_both_actual_ids_form_chain_but_inspection_does_not_authorize_deploy(self):
        for tx in (h.DEPLOY, h.RECOVERY):
            value = self.f.inspect(tx)
            self.assertTrue(value['ok'], value);self.assertEqual(value['record']['transaction'], tx)
            self.assertEqual(value['review']['status'], 'required')
            self.assertFalse(value['deployment_authorized']);self.assertFalse(value['release_preparation_allowed'])
        self.assertEqual(self.f.rt.update_calls, [])

    def test_explicit_review_is_bound_to_original_two_transactions(self):
        self.f.approved();value = self.f.inspect()
        self.assertTrue(value['ok'], value);self.assertTrue(value['release_preparation_allowed'])
        self.assertFalse(value['deployment_authorized'])
        path = self.f.config / 'history-review.json';v = json.loads(path.read_bytes());v['evidence_sha256'] = '9' * 64
        self.f.put(path, v);self.assertEqual(self.f.inspect()['status'], 'unknown')

    def test_review_missing_refuses_new_deploy_before_any_container_mutation(self):
        with self.assertRaisesRegex(h.Unknown, 'independent_history_review_required'):
            h.preflight(self.f.rt, self.f.state, {'operation': 'deploy', 'sha': 'a' * 40}, {})
        self.assertEqual(self.f.rt.update_calls, [])

    def test_pinned_audit_cannot_be_missing_rewritten_truncated_or_appended_conflicting(self):
        path = self.f.root / 'deployments.jsonl';original = path.read_bytes()
        for bad in (b'', original[:-1], original.replace(b'succeeded', b'cancelled')):
            self.f.put(path, bad, raw=True);self.assertEqual(self.f.inspect()['status'], 'unknown')
        self.f.put(path, original + h.canonical(self.f.records[1]) + b'\n', raw=True)
        self.assertEqual(self.f.inspect()['status'], 'unknown')
        path.unlink();self.assertEqual(self.f.inspect()['status'], 'unknown')

    def test_backup_archive_or_catalog_digest_tamper_refuses(self):
        path = self.f.root / 'backups' / h.LEGACY_BACKUPS[h.DEPLOY][0] / 'postgres.dump'
        self.f.put(path, b'not original', raw=True)
        self.assertEqual(self.f.inspect()['status'], 'unknown')

    def test_busy_deployment_lock_is_not_cancellation_or_absence(self):
        import fcntl
        fd = os.open(self.f.root / 'deployment.lock', os.O_RDONLY)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.f.inspect()
            self.assertEqual(result['status'], 'busy');self.assertEqual(result['deployment_lock'], 'held')
            self.assertFalse(result['ok']);self.assertFalse(result['deployment_authorized'])
        finally:os.close(fd)

    def test_busy_backup_lock_refuses_proof_even_when_deployment_lock_available(self):
        import fcntl
        fd = os.open(self.f.root / 'backup.lock', os.O_RDONLY)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.f.inspect()['backup_lock'], 'held')
        finally:os.close(fd)

    def test_pending_request_is_not_a_successful_history(self):
        self.f.state['pending'] = {'transaction': '20261120T030000Z-000000000001', 'operation': 'deploy'}
        self.f.put(self.f.root / 'state.json', self.f.state)
        self.assertEqual(self.f.inspect()['status'], 'unknown')

    def test_wrong_current_cohort_does_not_reconcile_the_original_history(self):
        self.f.state['current']['sha'] = 'a' * 40
        self.f.put(self.f.root / 'state.json', self.f.state)
        self.assertEqual(self.f.inspect()['status'], 'unknown')

    def test_no_inflight_requests_is_required(self):
        old = self.f.rt.docker
        def docker(*args):
            if args[0] == 'exec':return h.canonical({'embedding_enabled': 0, 'running': 0, 'reserved_unknown': 1})
            return old(*args)
        self.f.rt.docker = docker
        self.assertEqual(self.f.inspect()['status'], 'unknown')

    def test_rollback_previous_ac8_is_rejected_even_after_history_review(self):
        self.f.approved()
        with self.assertRaisesRegex(h.Unknown, 'rollback_requires_reviewed_ea_cohort'):
            h.preflight(self.f.rt, self.f.state, {'operation': 'rollback'}, self.f.state['previous'])

    def test_same_sha_duplicate_is_rejected_without_retry(self):
        self.f.approved()
        for sha in (h.AC8, h.EA):
            with self.assertRaisesRegex(h.Unknown, 'source_already_attempted'):
                h.preflight(self.f.rt, self.f.state, {'operation': 'deploy', 'sha': sha}, {})

    def test_root_owner_mode_nlink_symlink_and_world_writable_parent_are_enforced(self):
        path = self.f.root / 'deployments.jsonl'
        path.chmod(0o644);self.assertEqual(self.f.inspect()['status'], 'unknown');path.chmod(0o600)
        alias = self.f.root / 'alias';os.link(path, alias)
        self.assertEqual(self.f.inspect()['status'], 'unknown');alias.unlink()
        path.rename(alias);path.symlink_to(alias)
        self.assertEqual(self.f.inspect()['status'], 'unknown');path.unlink();alias.rename(path)
        os.chown(path, 65534, 65534);self.assertEqual(self.f.inspect()['status'], 'unknown');os.chown(path, 0, 0)
        self.f.root.chmod(0o777);self.assertEqual(self.f.inspect()['status'], 'unknown');self.f.root.chmod(0o700)

    def test_inspection_is_byte_for_byte_read_only_and_does_not_disclose_unknown_fields(self):
        before = {str(p): p.read_bytes() for p in self.f.base.rglob('*') if p.is_file()}
        value = self.f.inspect();self.assertTrue(value['ok'], value)
        after = {str(p): p.read_bytes() for p in self.f.base.rglob('*') if p.is_file()}
        self.assertEqual(before, after)
        self.assertNotIn('api_key', json.dumps(value));self.assertNotIn('postgres.dump', json.dumps(value))

    def test_loader_rejects_wrong_hash_permissions_and_linked_module(self):
        install = self.f.base / 'install';install.mkdir(mode=0o700)
        path = install / 'history_inspect.py'
        path.write_bytes((HERE / 'deploy/staging/history_inspect.py').read_bytes());path.chmod(0o644)
        rt = object.__new__(e.RootRuntime)
        with patch.object(e, 'INSTALL', install):
            self.assertEqual(rt.history_module().CAPABILITY, h.CAPABILITY)
            path.chmod(0o666)
            with self.assertRaises(e.Failure):rt.history_module()
            path.chmod(0o644);path.write_bytes(b'# substituted code\n')
            with self.assertRaisesRegex(e.Failure, 'installed_history_module_hash'):rt.history_module()


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'isolated real POSIX root integration')
class NativeHistoryTests(unittest.TestCase):
    def setUp(self):
        self.f = Fixture();self.f.test = self;self.f.approved()
        f = self.f;rt = f.rt
        self.updates = [];self.responses = []
        rt.load_state = lambda: json.loads((f.root / 'state.json').read_bytes())
        def save_state(value):
            f.state = copy.deepcopy(value);f.put(f.root / 'state.json', value)
        rt.save_state = save_state
        rt.audit = lambda value: self.append_audit(value)
        rt.is_paused = lambda: False
        rt.verify_source = lambda request, prior: h.SCHEMA
        rt.verify_current = lambda state, recovery=False: None
        rt.prepare_images = lambda release, use_cached=False: {n: release['images'][n].split('@')[-1] for n in h.SERVICES}
        rt.update = lambda name, release: self.updates.append((name, release['sha']))
        rt.wait_healthy = lambda *args: None
        rt.core_probe = lambda: {'ordinary_user': True, 'core_read_only': True}
        rt.verify_boundary = lambda before: None
        rt.history_preflight = lambda state, request, target: h.preflight(rt, state, request, target)
        rt.history_prepare = lambda *args: h.prepare(rt, *args)
        rt.history_stage = lambda phase: h.stage(rt, phase)
        rt.history_complete = lambda phase, state: h.complete(rt, phase, state)
        rt.ensure_backup = lambda state: self.new_backup()
        f.state.update(rollback_verified=True, auto_deploy_enabled=True)
        f.put(f.root / 'state.json', f.state)
        self.request = {'operation': 'deploy', 'trigger': 'push', 'sha': 'a' * 40,
                        'schema_sha256': h.SCHEMA, 'images': {n: 'sha256:' + c * 64 for n, c in zip(h.SERVICES, 'abc')}}

    def tearDown(self):self.f.close()

    def append_audit(self, value):
        with (self.f.root / 'deployments.jsonl').open('ab') as stream:stream.write(h.canonical(value) + b'\n')

    def new_backup(self):
        source = self.f.root / 'backups' / h.LEGACY_BACKUPS[h.DEPLOY][0]
        target = self.f.root / 'backups' / ('synthetic-' + str(len(list((self.f.root / 'backups').iterdir()))))
        shutil.copytree(source, target);target.chmod(0o700)
        value = json.loads((target / 'evidence.json').read_bytes())
        now = h.dt.datetime.now(h.dt.timezone.utc)
        value.update(started_at=now.isoformat(), verified_at=(now + h.dt.timedelta(microseconds=1)).isoformat())
        self.f.put(target / 'evidence.json', value)
        return {'backup_directory': str(target), 'evidence_sha256': h.digest((target / 'evidence.json').read_bytes())}

    def deploy(self):return e.ReleaseEngine(self.f.rt).run(copy.deepcopy(self.request))

    def test_normal_rollout_produces_real_root_transaction_and_complete_bound_receipt(self):
        result = self.deploy();self.assertTrue(result['ok'])
        self.assertEqual(self.updates, [(n, self.request['sha']) for n in h.SERVICES])
        value = self.f.inspect(result['transaction'])
        self.assertTrue(value['ok'], value)
        self.assertTrue(value['record']['legacy_native_journal_present'])
        self.assertEqual(value['record']['release']['images'], self.request['images'])

    def test_runner_losing_result_or_cancelling_does_not_erase_completed_remote_transaction(self):
        # Run the actual engine in a distinct process; losing its transport result
        # is deliberately separate from killing/cancelling a root transaction.
        import multiprocessing
        ctx = multiprocessing.get_context('fork');accepted = ctx.Event();finish = ctx.Event()
        client_channel, root_channel = ctx.Pipe(duplex=False)
        rt = self.f.rt
        old_update = rt.update
        def update(name, release):
            if name == 'app':accepted.set();finish.wait(8)
            old_update(name, release)
        rt.update = update
        def root_server():
            import fcntl
            client_channel.close()
            fd = os.open(self.f.root / 'deployment.lock', os.O_RDONLY)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                result = self.deploy()
                try:root_channel.send(result)
                except (BrokenPipeError, OSError):pass
            finally:os.close(fd);root_channel.close()
        proc = ctx.Process(target=root_server);proc.start();root_channel.close()
        try:
            self.assertTrue(accepted.wait(8))
            self.assertEqual(self.f.inspect()['status'], 'busy')
            client_channel.close()
            # The SSH/Runner channel is now abandoned. The isolated root process
            # remains alive and finishes once the controlled barrier opens.
            self.assertTrue(proc.is_alive());finish.set();proc.join(12)
            self.assertEqual(proc.exitcode, 0)
            self.f.state = json.loads((self.f.root / 'state.json').read_bytes())
            folders = list((self.f.root / 'transactions').iterdir());self.assertEqual(len(folders), 1)
            result = self.f.inspect(folders[0].name)
            self.assertTrue(result['ok'], result)
            self.assertEqual(result['record']['phase'], 'succeeded')
        finally:
            client_channel.close()
            finish.set();proc.join(2)
            if proc.is_alive():proc.terminate();proc.join()

    def test_journal_or_receipt_missing_or_tampered_preserves_unknown_and_prevents_new_deploy(self):
        result = self.deploy();folder = self.f.root / 'transactions' / result['transaction']
        path = folder / 'journal.json';original = path.read_bytes()
        value = json.loads(original);value['phase'] = 'started';self.f.put(path, value)
        self.assertEqual(self.f.inspect(result['transaction'])['status'], 'unknown')
        self.request['sha'] = 'b' * 40
        with self.assertRaises(h.Unknown):self.deploy()
        self.assertEqual(len(self.updates), 3)
        self.f.put(path, original, raw=True);(folder / 'receipt.json').unlink()
        self.assertEqual(self.f.inspect(result['transaction'])['status'], 'unknown')

    def test_orphan_prepared_record_is_not_silently_retried(self):
        tx = '20261120T030000Z-000000000001'
        proof = self.new_backup()
        h.prepare(self.f.rt, self.f.state, self.request, release(self.request['sha'], self.request['images'], h.SCHEMA),
                  self.f.state['current'], tx, proof)
        self.assertEqual(self.f.inspect()['status'], 'unknown')
        with self.assertRaises(h.Unknown):self.deploy()
        self.assertEqual(self.updates, [])

    def test_completed_ea_rollback_is_independently_queryable_without_actions_artifacts(self):
        result = self.deploy()
        restored = e.ReleaseEngine(self.f.rt).run({'operation': 'rollback'})
        self.assertNotEqual(restored['transaction'], result['transaction'])
        value = self.f.inspect(restored['transaction'])
        self.assertTrue(value['ok'], value);self.assertEqual(value['record']['operation'], 'rollback')
        self.assertEqual(value['record']['release']['sha'], h.EA)

    def test_repeated_sha_after_success_cannot_start_a_second_transaction(self):
        self.deploy()
        with self.assertRaisesRegex(h.Unknown, 'source_already_attempted'):self.deploy()
        self.assertEqual(len(self.updates), 3)

    def test_interrupted_before_terminal_receipt_is_unknown_even_when_state_already_changed(self):
        self.f.rt.history_complete = lambda *args: (_ for _ in ()).throw(OSError('synthetic durable disk failure'))
        with self.assertRaises(OSError):self.deploy()
        self.assertEqual(self.f.state['current']['sha'], self.request['sha'])
        tx = list((self.f.root / 'transactions').iterdir())[0].name
        self.assertEqual(self.f.inspect(tx)['status'], 'unknown')
        self.assertEqual(len(self.updates), 3)


if __name__ == '__main__':unittest.main()
