"""Fresh root transport + real Actions dependency graph, entirely synthetic."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import staging_history as history
import staging_release_guard as gate
import staging_delivery as delivery
import staging_reconcile as observer
spec = importlib.util.spec_from_file_location('existing_safety_fixtures', ROOT / 'tests/staging_safety_test.py')
base = importlib.util.module_from_spec(spec);spec.loader.exec_module(base)


def proof(reviewed=True):
    def record(tx, sha, op, minute):
        images = {n: 'sha256:' + c * 64 for n, c in zip(('app', 'worker', 'scheduler'), '123')}
        return {'transaction': tx, 'operation': op, 'phase': 'succeeded', 'request_sha256': '1' * 64,
                'requested_at': f'2026-11-20T02:{minute-1:02d}:00Z', 'started_at': f'2026-11-20T02:{minute:02d}:00Z',
                'completed_at': f'2026-11-20T02:{minute:02d}:59Z',
                'release': {'sha': sha, 'schema_sha256': history.SCHEMA, 'images': images},
                'root_terminal_audit_sha256': '2' * 64,
                'request_evidence_kind': 'original_root_audit_identity_not_raw_ssh_bytes',
                'legacy_native_journal_present': False,
                'backup': {'evidence_sha256': '3' * 64, 'file_count': 35, 'differences': 0,
                           'restore_verified': True, 'restart_verified': True, 'storage_verified': True,
                           'started_at': f'2026-11-20T02:{minute-1:02d}:10Z',
                           'verified_at': f'2026-11-20T02:{minute-1:02d}:20Z'}}
    dep = record(history.DEPLOY, history.AC8, 'deploy', 9)
    rec = record(history.RECOVERY, history.EA, 'rollback', 13)
    incident = {'capability': history.CAPABILITY, 'legacy_audit_prefix_sha256': '4' * 64,
                'legacy_audit_prefix_bytes': 1000, 'deploy': dep, 'recovery': rec,
                'database_system_identifier': history.SYSTEM, 'registered_schema': history.SCHEMA,
                'schema_0412': {'receipt_sha256': '5' * 64}, 'schema_0413': {'receipt_sha256': '6' * 64}}
    original = record('20261119T040000Z-000000000001', history.EA, 'deploy', 5)
    del original['backup']
    return {'format': 1, 'capability': history.CAPABILITY, 'ok': True, 'status': 'authenticated',
            'read_only': True, 'deployment_authorized': False, 'transaction': history.DEPLOY,
            'deployment_lock': 'available', 'backup_lock': 'available',
            'state': {'current': rec['release'], 'previous': dep['release'], 'pending': None},
            'record': dep, 'incident': incident, 'evidence_sha256': hashlib.sha256(history.canonical(incident)).hexdigest(),
            'review': {'status': 'reviewed' if reviewed else 'required', 'approval_sha256': '7' * 64 if reviewed else None},
            'database': {'source_system_identifier': history.SYSTEM, 'source_container_id': '8' * 64,
                'registered_schema': history.SCHEMA, 'schema_0412_receipt_sha256': '5' * 64,
                'schema_0413_receipt_sha256': '6' * 64, 'approved_schema_sha256': '9' * 64,
                'approved_catalog_sha256': 'a' * 64, 'catalog_policy_sha256': 'b' * 64,
                'static_catalog_sha256': 'c' * 64, 'current_cohort_verified': True,
                'protected_boundary_sha256': 'd' * 64, 'business_healthy': 3, 'supabase_healthy': 11,
                'counts': {'embedding_enabled': 0, 'running': 0, 'reserved_unknown': 0}},
            'root_state_sha256': 'e' * 64, 'audit_sha256': 'f' * 64, 'prior_terminals': [original],
            'release_preparation_allowed': reviewed}


class Github(base.Github):
    def __init__(self, root_proof):
        super().__init__();self.payloads = {};self.artifacts = {}
        self.legacy = {'id': history.LEGACY_RUN, 'head_sha': history.AC8, 'run_attempt': 1,
            'path': '.github/workflows/staging-release.yml', 'head_branch': 'main',
            'head_repository': {'full_name': gate.REPOSITORY}, 'event': 'push', 'conclusion': 'cancelled',
            'run_started_at': '2026-11-20T02:00:00Z', 'updated_at': '2026-11-20T02:11:00Z'}
        self.old = {**self.legacy, 'id': history.LEGACY_RUN - 100, 'head_sha': history.EA,
                    'conclusion': 'success', 'run_attempt': 2}
        self.prior = [self.legacy, self.old]
        for run in self.prior:
            self.prior_jobs[run['id']] = [{'name': 'deploy', 'status': 'completed', 'conclusion': run['conclusion'],
                                         'started_at': '2026-11-20T02:01:00Z'}]
        release = {'operation': 'deploy', 'trigger': 'push', **root_proof['incident']['deploy']['release']}
        self.add(history.LEGACY_RUN, 'staging-release-' + history.AC8, {'release.json': release})
        record = root_proof['prior_terminals'][0]
        result = {'ok': True, 'transaction': record['transaction'], **record['release']}
        status = {**result, 'recovery_required': False}
        self.add(self.old['id'], 'staging-result-' + str(self.old['id']), {'status-before.json': {}})
        self.add(self.old['id'], 'staging-result-' + str(self.old['id']),
                 {'deployment.json': result, 'status-after.json': status})

    def add(self, run_id, name, files):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as archive:
            for path, value in files.items():archive.writestr(path, json.dumps(value))
        raw = stream.getvalue();id = len(self.payloads) + 1;self.payloads[id] = raw
        self.artifacts.setdefault(run_id, []).append({'id': id, 'name': name, 'expired': False,
            'created_at': '2026-11-20T02:10:30Z', 'size_in_bytes': len(raw), 'digest': 'sha256:' + hashlib.sha256(raw).hexdigest()})

    def __call__(self, path, **kwargs):
        if '/artifacts?' in path:
            id = int(path.split('/')[2]);return {'artifacts': self.artifacts.get(id, [])}
        if path.endswith('/zip'):return self.payloads[int(path.split('/')[-2])]
        return super().__call__(path, **kwargs)


class TrustedHistory(unittest.TestCase):
    def setUp(self):
        self.proof = proof()
        self.pin = patch.object(history, 'EXPECTED_INCIDENT_SHA256', self.proof['evidence_sha256']);self.pin.start()
    def tearDown(self):self.pin.stop()

    def test_complete_fixed_chain_and_human_review_allow_preparation_not_deploy(self):
        requests = []
        def reader():requests.append('inspect');return copy.deepcopy(self.proof)
        result = gate.delivery_history(base.SHA, 99, Github(self.proof), inspect_root=reader)
        self.assertEqual(requests, ['inspect']);self.assertEqual(len(result), 2)
        self.assertEqual(result[0]['recovery_transaction'], history.RECOVERY)
        self.assertEqual(result[0]['classification'], 'failed_release_recovered_not_ci_accepted')
        self.assertEqual(result[1]['classification'], 'original_success_and_pinned_root_terminal')
        self.assertFalse(self.proof['deployment_authorized'])

    def test_current_ea_alone_or_ordinary_status_json_cannot_clear_history(self):
        for bad in ({'ok': True, 'sha': history.EA}, {**self.proof, 'capability': 'old-status'}):
            with self.assertRaises(gate.Blocked):gate.delivery_history(base.SHA, 99, Github(self.proof), inspect_root=lambda: bad)

    def test_verified_chain_without_independent_human_review_stays_blocked(self):
        value = proof(False)
        with self.assertRaisesRegex(gate.Blocked, 'root_history_requires_independent_human_review'):
            gate.delivery_history(base.SHA, 99, Github(self.proof), inspect_root=lambda: value)

    def test_digest_audit_database_inflight_pending_and_review_mismatch_refuse(self):
        variants = []
        for key, value in [('evidence_sha256', '0' * 64), ('deployment_authorized', True), ('deployment_lock', 'held')]:
            variants.append({**self.proof, key: value})
        for path, value in [(('incident', 'recovery', 'phase'), 'cancelled'),
                            (('database', 'counts', 'reserved_unknown'), 1),
                            (('state', 'pending'), {'transaction': history.DEPLOY}),
                            (('review', 'approval_sha256'), None)]:
            v = copy.deepcopy(self.proof);at = v
            for part in path[:-1]:at = at[part]
            at[path[-1]] = value;variants.append(v)
        for bad in variants:
            with self.subTest(keys=bad.keys()), self.assertRaises((history.HistoryError, KeyError, TypeError)):
                history.validate(bad)

    def test_old_success_needs_original_complete_final_attempt_artifact_and_root_terminal(self):
        for variant in ('missing_result', 'wrong_interval', 'wrong_root_terminal', 'two_complete_results'):
            gh = Github(self.proof);v = copy.deepcopy(self.proof)
            if variant == 'missing_result':gh.artifacts[gh.old['id']].pop()
            elif variant == 'wrong_interval':gh.artifacts[gh.old['id']][-1]['created_at'] = '2026-11-19T00:00:00Z'
            elif variant == 'wrong_root_terminal':v['prior_terminals'][0]['transaction'] = '20261119T040000Z-000000000002'
            else:
                record = v['prior_terminals'][0];result = {'ok': True, 'transaction': record['transaction'], **record['release']}
                gh.add(gh.old['id'], 'staging-result-' + str(gh.old['id']),
                       {'deployment.json': result, 'status-after.json': {**result, 'recovery_required': False}})
            with self.subTest(variant=variant), self.assertRaises(gate.Blocked):
                gate.delivery_history(base.SHA, 99, gh, inspect_root=lambda: v)

    def test_successful_history_never_compensates_for_failed_pending_or_different_sha_ci(self):
        for mode in ('failure', 'running', 'cancelled', 'missing', 'other_sha'):
            gh = Github(self.proof)
            if mode == 'missing':gh.values['e2e.yml']['jobs'].pop()
            elif mode == 'other_sha':gh.values['e2e.yml']['run']['head_sha'] = 'f' * 40
            elif mode == 'running':gh.values['e2e.yml']['run']['status'] = 'in_progress'
            else:gh.values['e2e.yml']['jobs'][0]['conclusion'] = mode
            calls = []
            with tempfile.TemporaryDirectory() as tmp, self.assertRaises(gate.Blocked):
                delivery.deliver({**base.REQUEST, 'schema_sha256': history.SCHEMA},
                    gate.evaluate_quality(base.SHA, base.inventories()), 99, Path(tmp) / 'journal', read=gh,
                    transport=lambda *args, **kwargs: calls.append(args))
            self.assertEqual(calls, [])

    def test_reviewed_history_and_same_sha_quality_still_send_exactly_one_authorized_mock_deploy(self):
        calls = [];gh = Github(self.proof)
        request = {**base.REQUEST, 'schema_sha256': history.SCHEMA}
        before = {**base.BEFORE, 'schema_sha256': history.SCHEMA}
        after = {**before, 'sha': base.SHA, 'images': request['images']}
        def transport(path, output, **kwargs):
            value = json.loads(Path(path).read_text());calls.append(value['operation'])
            if value['operation'] == 'inspect':result = self.proof
            elif value['operation'] == 'deploy':result = {**base.RESULT, **request}
            else:result = after if 'deploy' in calls else before
            Path(output).write_text(json.dumps(result))
        with tempfile.TemporaryDirectory() as tmp:
            result = delivery.deliver(request, gate.evaluate_quality(base.SHA, base.inventories()), 99,
                                      Path(tmp) / 'journal', read=gh, transport=transport)
        self.assertEqual(result['phase'], 'verified');self.assertEqual(calls.count('deploy'), 1)
        self.assertNotIn('rollback', calls)

    def test_non_legacy_cancelled_incident_never_inherits_the_fixed_review(self):
        gh = Github(self.proof);gh.prior = [{**gh.legacy, 'id': history.LEGACY_RUN + 1}]
        gh.prior_jobs[history.LEGACY_RUN + 1] = gh.prior_jobs[history.LEGACY_RUN]
        with self.assertRaises(gate.Blocked):gate.delivery_history(base.SHA, 99, gh, inspect_root=lambda: self.proof)

    def test_transport_fetch_uses_only_inspect_not_a_proof_file_or_app_api(self):
        calls = []
        def transport(path, output, **kwargs):
            calls.append(json.loads(Path(path).read_text()));Path(output).write_text(json.dumps(self.proof))
        result = history.fetch(transport=transport)
        self.assertEqual(calls, [{'operation': 'inspect', 'transaction': history.DEPLOY}])
        self.assertFalse(result['deployment_authorized'])

    def test_cancelled_actions_and_lost_deploy_result_observe_both_root_transactions_without_deploy(self):
        for reviewed in (False, True):
            value = proof(reviewed);gh = Github(value)
            gh.legacy['status'] = 'completed'
            def read(path, **kwargs):
                if path == 'actions/runs/' + str(history.LEGACY_RUN):return gh.legacy
                return gh(path, **kwargs)
            calls = []
            def transport(path, output, **kwargs):
                q = json.loads(Path(path).read_text());calls.append(q)
                if q['operation'] == 'status':result = {**base.BEFORE, 'sha': history.EA}
                else:result = value
                Path(output).write_text(json.dumps(result))
            with tempfile.TemporaryDirectory() as tmp:
                result = observer.observe(history.LEGACY_RUN, Path(tmp) / 'reconciliation.json', read=read, transport=transport)
            self.assertEqual(calls, [{'operation': 'status'}, {'operation': 'inspect', 'transaction': history.DEPLOY}])
            self.assertEqual(result['transaction'], history.DEPLOY)
            self.assertEqual(result['recovery_transaction'], history.RECOVERY)
            self.assertFalse(result['allow_new_deploy']);self.assertFalse(result['automatic_rollback'])
            self.assertEqual(result['outcome'], 'historical_failure_recovered_after_root_review' if reviewed
                             else 'historical_chain_authenticated_human_review_required')


if __name__ == '__main__':unittest.main()
