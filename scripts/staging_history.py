"""Validate fresh root inspect responses. Never accepts an Artifact as root proof."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import tempfile

CAPABILITY = 'staging-history-inspect-v1'
DEPLOY = '20261120T020945Z-9f57202fb372'
RECOVERY = '20261120T021305Z-128754217ad3'
LEGACY_RUN = 44655810765
AC8 = 'ac8de4bb963d3c46729073ce126dc2a2591b964c'
EA = 'ea26ee4fb38a65cb15313ab002934238b6324ff8'
SCHEMA = '37974846957f850f051b020f23493586ce49631aacc66a04bbdbb93b8f708fa3'
SYSTEM = '7701258112182636578'
# Obtained from both independent read-only root transaction observations. This
# pins evidence, NOT approval. Root's separate human review is still required.
EXPECTED_INCIDENT_SHA256 = '997be5797c4f0c09efb4b9e699463e26df54f2c95f5e2870f730ef30d8ed7be0'
HASH = re.compile(r'[a-f0-9]{64}\Z')
SHA = re.compile(r'[a-f0-9]{40}\Z')
TX = re.compile(r'\d{8}T\d{6}Z-[a-f0-9]{12}\Z')
DIGEST = re.compile(r'sha256:[a-f0-9]{64}\Z')
SERVICES = {'app', 'worker', 'scheduler'}


class HistoryError(ValueError):
    pass


def need(value, code):
    if not value:raise HistoryError(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def fixed_hash(value):
    return isinstance(value, str) and HASH.fullmatch(value)


def release(value):
    need(type(value) is dict and set(value) == {'sha', 'schema_sha256', 'images'}, 'root_release_shape')
    need(isinstance(value['sha'], str) and SHA.fullmatch(value['sha']) and fixed_hash(value['schema_sha256']),
         'root_release_identity')
    need(type(value['images']) is dict and set(value['images']) == SERVICES and
         all(isinstance(v, str) and DIGEST.fullmatch(v) for v in value['images'].values()), 'root_three_digests')


def record(value, *, backup_required):
    keys = {'transaction', 'operation', 'phase', 'request_sha256', 'requested_at', 'started_at', 'completed_at',
            'release', 'root_terminal_audit_sha256', 'request_evidence_kind', 'legacy_native_journal_present'}
    need(type(value) is dict and keys <= set(value) <= keys | {'backup', 'journal_sha256', 'receipt_sha256'},
         'root_record_shape')
    need(TX.fullmatch(value['transaction']) and value['operation'] in ('deploy', 'rollback')
         and value['phase'] == 'succeeded' and fixed_hash(value['request_sha256'])
         and fixed_hash(value['root_terminal_audit_sha256']), 'root_terminal_identity')
    need(value['request_evidence_kind'] == 'original_root_audit_identity_not_raw_ssh_bytes'
         and type(value['legacy_native_journal_present']) is bool, 'root_request_provenance')
    release(value['release'])
    if backup_required:
        proof = value.get('backup')
        need(type(proof) is dict and set(proof) == {'evidence_sha256', 'file_count', 'differences',
             'restore_verified', 'restart_verified', 'storage_verified', 'started_at', 'verified_at'}, 'root_backup_shape')
        need(fixed_hash(proof['evidence_sha256']) and type(proof['file_count']) is int and 13 <= proof['file_count'] <= 128
             and type(proof['differences']) is int and proof['differences'] == 0
             and all(proof[k] is True for k in ('restore_verified', 'restart_verified', 'storage_verified')),
             'root_restore_not_complete')


def validate(value, requested=DEPLOY):
    need(len(canonical(value)) <= 60000 and type(value) is dict, 'root_response_bound')
    need(type(value.get('format')) is int and value['format'] == 1 and value.get('capability') == CAPABILITY
         and value.get('read_only') is True and value.get('deployment_authorized') is False, 'root_capability_required')
    need(value.get('ok') is True and value.get('status') == 'authenticated'
         and value.get('deployment_lock') == value.get('backup_lock') == 'available', 'root_evidence_unknown_or_busy')
    expected = {'format', 'capability', 'ok', 'status', 'read_only', 'deployment_authorized', 'transaction',
                'deployment_lock', 'backup_lock', 'state', 'record', 'incident', 'evidence_sha256', 'review',
                'database', 'root_state_sha256', 'audit_sha256', 'prior_terminals', 'release_preparation_allowed'}
    need(set(value) == expected, 'root_response_fields')
    need(isinstance(value['transaction'], str) and TX.fullmatch(value['transaction']) and
         (requested == 'latest' or value['transaction'] == requested), 'root_transaction_binding')
    need(value['evidence_sha256'] == EXPECTED_INCIDENT_SHA256 ==
         hashlib.sha256(canonical(value['incident'])).hexdigest(), 'fixed_incident_digest')
    incident = value['incident']
    need(incident['capability'] == CAPABILITY and incident['registered_schema'] == SCHEMA
         and incident['database_system_identifier'] == SYSTEM, 'fixed_incident_database')
    for name, txid, sha in (('deploy', DEPLOY, AC8), ('recovery', RECOVERY, EA)):
        r = incident[name];record(r, backup_required=True)
        need(r['transaction'] == txid and r['release']['sha'] == sha, 'both_incident_transactions_required')
    record(value['record'], backup_required=True)
    if value['transaction'] in (DEPLOY, RECOVERY):
        need(value['record'] == incident['deploy' if value['transaction'] == DEPLOY else 'recovery'],
             'selected_incident_record')
    state = value['state']
    need(type(state) is dict and set(state) == {'current', 'previous', 'pending'} and state['pending'] is None,
         'root_pending_or_state_unknown')
    release(state['current'])
    if state['previous'] is not None:release(state['previous'])
    db = value['database']
    need(type(db) is dict and set(db) == {'source_system_identifier', 'source_container_id', 'registered_schema',
         'schema_0412_receipt_sha256', 'schema_0413_receipt_sha256', 'approved_schema_sha256', 'approved_catalog_sha256',
         'catalog_policy_sha256', 'static_catalog_sha256', 'current_cohort_verified', 'protected_boundary_sha256',
         'business_healthy', 'supabase_healthy', 'counts'}, 'root_database_shape')
    need(db['source_system_identifier'] == SYSTEM and db['registered_schema'] == SCHEMA
         and db['current_cohort_verified'] is True and type(db['business_healthy']) is int and db['business_healthy'] == 3
         and type(db['supabase_healthy']) is int and db['supabase_healthy'] == 11, 'root_live_identity_or_health')
    for key in ('source_container_id', 'schema_0412_receipt_sha256', 'schema_0413_receipt_sha256',
                'approved_schema_sha256', 'approved_catalog_sha256', 'catalog_policy_sha256',
                'static_catalog_sha256', 'protected_boundary_sha256'):
        need(fixed_hash(db[key]), 'root_database_digest')
    need(db['schema_0412_receipt_sha256'] == incident['schema_0412']['receipt_sha256']
         and db['schema_0413_receipt_sha256'] == incident['schema_0413']['receipt_sha256'], 'root_schema_receipt_chain')
    counts = db['counts']
    need(type(counts) is dict and set(counts) == {'embedding_enabled', 'running', 'reserved_unknown'}
         and all(type(v) is int and v == 0 for v in counts.values()), 'root_embedding_or_inflight')
    review = value['review']
    need(type(review) is dict and set(review) == {'status', 'approval_sha256'} and
         review['status'] in ('required', 'reviewed'), 'root_review_shape')
    need((review['status'] == 'reviewed' and fixed_hash(review['approval_sha256'])
          and value['release_preparation_allowed'] is True) or
         (review['status'] == 'required' and review['approval_sha256'] is None
          and value['release_preparation_allowed'] is False), 'root_human_review_binding')
    need(fixed_hash(value['root_state_sha256']) and fixed_hash(value['audit_sha256']), 'root_snapshot_digests')
    need(type(value['prior_terminals']) is list and len(value['prior_terminals']) <= 128, 'root_prior_terminal_bound')
    seen = set()
    for r in value['prior_terminals']:
        record(r, backup_required=False)
        need(r['transaction'] not in seen, 'duplicate_root_prior_terminal');seen.add(r['transaction'])
    return value


def require_review(value):
    validate(value)
    need(value['review']['status'] == 'reviewed' and value['release_preparation_allowed'] is True,
         'root_history_requires_independent_human_review')


def fetch(*, transport=None, transaction=DEPLOY, evidence_output=None):
    """Fresh SSH response only. No --proof-file, Artifact, env JSON or cache."""
    if transport is None:
        spec = importlib.util.spec_from_file_location('history_fixed_ssh', Path(__file__).with_name('staging-ci.py'))
        client = importlib.util.module_from_spec(spec);spec.loader.exec_module(client)
        transport = client.ssh_request
    need(transaction == 'latest' or (isinstance(transaction, str) and TX.fullmatch(transaction)), 'inspection_selector')
    with tempfile.TemporaryDirectory(prefix='staging-root-query-') as temporary:
        folder = Path(temporary);request = folder / 'request.json';output = folder / 'response.json'
        request.write_text(json.dumps({'operation': 'inspect', 'transaction': transaction}), encoding='utf-8')
        transport(request, output, timeout_seconds=120)
        value = validate(json.loads(output.read_text(encoding='utf-8')), transaction)
    if evidence_output is not None:
        Path(evidence_output).write_text(json.dumps(value, sort_keys=True, indent=2) + '\n', encoding='utf-8')
    return value
