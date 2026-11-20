"""Fixed Staging history inspection. Root evidence is read, never repaired here.

The pinned legacy prefix is an authenticated observation of the ORIGINAL root
ledger, not a retroactive signature or an invented deployment receipt. A root
human review is a separate prerequisite; inspection never authorizes a rollout.
"""
from __future__ import annotations
import contextlib
import copy
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import uuid

CAPABILITY = 'staging-history-inspect-v1'
TX = re.compile(r'\d{8}T\d{6}Z-[a-f0-9]{12}\Z')
HASH = re.compile(r'[a-f0-9]{64}\Z')
SHA = re.compile(r'[a-f0-9]{40}\Z')
DIGEST = re.compile(r'sha256:[a-f0-9]{64}\Z')
SERVICES = ('app', 'worker', 'scheduler')
DEPLOY = '20261120T020945Z-9f57202fb372'
RECOVERY = '20261120T021305Z-128754217ad3'
AC8 = 'ac8de4bb963d3c46729073ce126dc2a2591b964c'
EA = 'ea26ee4fb38a65cb15313ab002934238b6324ff8'
SCHEMA = '37974846957f850f051b020f23493586ce49631aacc66a04bbdbb93b8f708fa3'
EA_SCHEMA = 'a2c444e558672a6a4b5790ec3b0bcc2be76838f291e6d1be568e0121380f2c20'
SYSTEM = '7701258112182636578'
STATIC_CATALOG = '245b598df8270a2248b7d992e539da62a78f1fc7c0af92d8ac593cdaf9f64506'
LEGACY_BYTES = 14254
LEGACY_HASH = 'cc1622a70fdf88413de4611e5ea2b71de656836669c51e20c072459e07d3ccf8'
LEGACY_BACKUPS = {
    DEPLOY: ('20261120T020755Z-fe8cbaca', 'aa7e3c69f9415bf3e2e94e0dead5662a921b10131e6a5a37d6feb954ad6e3554'),
    RECOVERY: ('20261120T021239Z-8f11964f', 'b4d6b6714911c755c8cd82daaadf8392aa416b16e3099defbfe867c26ff2fefe'),
}
AC8_IMAGES = dict(zip(SERVICES, (
    'sha256:40a5143fa8a79487b95238a2bedf62c6659b76144d366a4091c9c6b1ee9f42bb',
    'sha256:b874320174028e0e0b6993c3523e852a87ed82dba03de2a9a0466f7694621f81',
    'sha256:2b142518b2b104987e743f79278f042a5fca10cec6783f7b83022c6813124cbd')))
EA_IMAGES = dict(zip(SERVICES, (
    'sha256:ecbb64188ea47ed9358467b98ae720aac35654d4fdc71a11ea6a6de9104e747a',
    'sha256:f8e263c2b8a7cbc5bfe6b35847932bb88b9a9887c45f3a306404dcbd1e207f3a',
    'sha256:fdc66b6ebcd837aed46e23a2933283daf7ffb2d8b985a2ef0057ef040b7e10d0')))
ROOT = Path('/var/lib/ainativecrm-staging-deploy')
CONFIG = Path('/etc/ainativecrm-staging-deploy')
INSTALL = Path('/usr/local/libexec/ainativecrm-staging')


class Unknown(ValueError):
    pass


def need(value, code):
    if not value:
        raise Unknown(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def timestamp(value):
    need(isinstance(value, str), 'timestamp_required')
    result = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    need(result.tzinfo is not None, 'timestamp_timezone')
    return result


def unique(pairs):
    result = {}
    for key, value in pairs:
        need(key not in result, 'duplicate_evidence_key')
        result[key] = value
    return result


def json_value(raw):
    return json.loads(raw, object_pairs_hook=unique)


def secure(path, directory=False):
    need(path.is_absolute() and path.resolve() == path, 'evidence_symlink')
    # Check EVERY parent, including the private evidence's immediate directory.
    for parent in reversed(path.parents):
        info = parent.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
             'evidence_parent_permissions')
    info = path.lstat()
    need(info.st_uid == info.st_gid == 0, 'evidence_owner')
    need(stat.S_IMODE(info.st_mode) == (0o700 if directory else 0o600), 'evidence_mode')
    need(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode), 'evidence_type')
    if not directory:
        need(info.st_nlink == 1, 'evidence_hardlink')
    return info


def read(path, limit=1024 * 1024):
    before = secure(path)
    need(before.st_size <= limit, 'evidence_size')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        need((info.st_dev, info.st_ino) == (before.st_dev, before.st_ino), 'evidence_race')
        raw = stream.read(limit + 1)
        after = os.fstat(stream.fileno())
    need(len(raw) <= limit and (info.st_size, info.st_mtime_ns) == (after.st_size, after.st_mtime_ns),
         'evidence_changed_during_read')
    return raw


def file_hash(path, expected_bytes):
    info = secure(path)
    need(info.st_size == expected_bytes, 'backup_member_size')
    result = hashlib.sha256()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        need((before.st_dev, before.st_ino) == (info.st_dev, info.st_ino), 'backup_member_race')
        while block := stream.read(1024 * 1024):
            result.update(block)
        after = os.fstat(stream.fileno())
    need((before.st_size, before.st_mtime_ns) == (after.st_size, after.st_mtime_ns), 'backup_member_changed')
    return result.hexdigest()


def public_release(release):
    need(isinstance(release, dict) and release.get('kind') == 'git' and SHA.fullmatch(release.get('sha', '')),
         'release_identity')
    images = release.get('images', {})
    need(set(images) == set(SERVICES), 'release_services')
    result = {}
    for name in SERVICES:
        prefix = 'ghcr.io/lz-20/ainativecrm-' + name + '@'
        need(isinstance(images[name], str) and images[name].startswith(prefix), 'image_namespace')
        value = images[name][len(prefix):]
        need(DIGEST.fullmatch(value), 'image_digest')
        result[name] = value
    need(HASH.fullmatch(release.get('schema_sha256', '')), 'release_schema')
    return {'sha': release['sha'], 'schema_sha256': release['schema_sha256'], 'images': result}


def audit_records():
    raw = read(ROOT / 'deployments.jsonl', 4 * 1024 * 1024)
    need(raw.endswith(b'\n') and len(raw) >= LEGACY_BYTES and digest(raw[:LEGACY_BYTES]) == LEGACY_HASH,
         'legacy_audit_prefix_mismatch')
    records = [json_value(line) for line in raw.splitlines()]
    need(len(records) <= 20000, 'audit_record_limit')
    return raw, records


def transaction(records, txid):
    need(TX.fullmatch(txid), 'transaction_identity')
    starts = [(i, r) for i, r in enumerate(records) if r.get('transaction') == txid and r.get('phase') == 'started']
    need(len(starts) == 1, 'transaction_start_missing_or_duplicate')
    start_index, start = starts[0]
    members = [(i, r) for i, r in enumerate(records) if r.get('transaction') == txid]
    need([r.get('phase') for _, r in members] == ['started', 'succeeded'], 'transaction_not_unambiguously_succeeded')
    end_index, end = members[-1]
    need(all(start.get(k) == end.get(k) for k in ('operation', 'sha', 'images')), 'terminal_identity_mismatch')
    requests = [(i, r) for i, r in enumerate(records[:start_index]) if r.get('phase') == 'requested']
    need(requests, 'original_request_missing')
    request_index, request = requests[-1]
    need(request['operation'] == start['operation'], 'request_operation_mismatch')
    if start['operation'] == 'deploy':
        need(request.get('sha') == start['sha'], 'request_source_mismatch')
        need(request.get('images') == {s: start['images'][s].split('@')[-1] for s in SERVICES},
             'request_images_mismatch')
    else:
        need(start['operation'] == 'rollback' and request.get('sha') is None and request.get('images') is None,
             'original_fixed_rollback_request')
    need(not any(r.get('phase') in ('started', 'request_failed') for r in records[request_index + 1:start_index]),
         'ambiguous_request_interval')
    need(timestamp(request['at']) < timestamp(start['at']) < timestamp(end['at']), 'transaction_order')
    release = public_release({'kind': 'git', 'sha': start['sha'], 'images': start['images'],
                              'schema_sha256': EA_SCHEMA if start['sha'] == EA else SCHEMA})
    return {'transaction': txid, 'operation': start['operation'], 'phase': 'succeeded',
            'request_sha256': digest(canonical(request)), 'requested_at': request['at'],
            'started_at': start['at'], 'completed_at': end['at'], 'release': release,
            'root_terminal_audit_sha256': digest(canonical(end)),
            'request_evidence_kind': 'original_root_audit_identity_not_raw_ssh_bytes',
            'legacy_native_journal_present': False}, (request_index, start_index, end_index)


def backup(directory, expected_hash, state, rt):
    need(directory.parent == ROOT / 'backups', 'fixed_backup_parent')
    secure(directory, directory=True)
    raw = read(directory / 'evidence.json')
    need(HASH.fullmatch(expected_hash) and digest(raw) == expected_hash, 'backup_evidence_digest')
    evidence = json_value(raw)
    need(evidence.get('source_system_identifier') == SYSTEM and
         evidence.get('source_container_id') == rt.policy['db_container_id'], 'backup_database_identity')
    need(all(evidence.get(k) is True for k in ('restore_verified', 'restart_verified', 'storage_verified'))
         and evidence.get('differences') == 0 and evidence.get('source_database_writes') is False,
         'backup_restore_not_complete')
    files = evidence.get('files')
    need(isinstance(files, list) and 1 <= len(files) <= 128, 'backup_file_inventory')
    names = set()
    for entry in files:
        name = entry.get('file')
        need(isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,80}', name)
             and name not in names and name not in ('.', '..'), 'backup_member_identity')
        names.add(name)
        need(type(entry.get('bytes')) is int and 0 <= entry['bytes'] <= 64 * 1024**3, 'backup_member_bound')
        need(file_hash(directory / name, entry['bytes']) == entry.get('sha256'), 'backup_member_digest')
    need({'postgres.dump', '_supabase.dump', 'storage-files.tar.gz', 'storage-restored.tar.gz',
          'catalog-source.json', 'catalog-restore.json', 'catalog-restart.json',
          'data-source.json', 'data-restore.json', 'data-restart.json',
          'sequences-restore.json', 'sequences-restart.json'} <= names, 'complete_restore_inventory')
    for prefix in ('catalog', 'data'):
        need(read(directory / (prefix + '-source.json'), 16 * 1024**2) ==
             read(directory / (prefix + '-restore.json'), 16 * 1024**2) ==
             read(directory / (prefix + '-restart.json'), 16 * 1024**2), 'restored_' + prefix + '_difference')
    need(read(directory / 'sequences-restore.json') == read(directory / 'sequences-restart.json'),
         'restored_sequence_difference')
    # Recalculate the EXISTING partition policy at the original observation time.
    observation = evidence['partition_validation']
    proof = {'catalog_policy_sha256': evidence['catalog_policy_sha256'],
             'source_catalog_sha256': evidence['source_catalog_sha256'],
             'static_catalog_sha256': observation['static_catalog_sha256'],
             'partition_validation': observation}
    rt.verify_catalog_policy(proof, state, directory, CONFIG / 'catalog-policy.json')
    return {'evidence_sha256': expected_hash, 'file_count': len(files), 'differences': 0,
            'restore_verified': True, 'restart_verified': True, 'storage_verified': True,
            'started_at': evidence['started_at'], 'verified_at': evidence['verified_at']}


def legacy(state, rt, records):
    deploy, di = transaction(records, DEPLOY)
    recovery, ri = transaction(records, RECOVERY)
    need(deploy['release'] == {'sha': AC8, 'schema_sha256': SCHEMA, 'images': AC8_IMAGES}
         and recovery['release'] == {'sha': EA, 'schema_sha256': EA_SCHEMA, 'images': EA_IMAGES},
         'fixed_incident_cohorts')
    need(di[2] < ri[0] and not any(r.get('phase') == 'started' for r in records[di[2] + 1:ri[1]]),
         'incident_chain_interleaved')
    for value in (deploy, recovery):
        name, anchor = LEGACY_BACKUPS[value['transaction']]
        value['backup'] = backup(ROOT / 'backups' / name, anchor, state, rt)
        need(timestamp(value['requested_at']) <= timestamp(value['backup']['started_at']) <
             timestamp(value['backup']['verified_at']) < timestamp(value['started_at']), 'backup_transaction_order')
    # Root's immutable incident identity does not depend on today's health/time.
    basis = {'capability': CAPABILITY, 'legacy_audit_prefix_sha256': LEGACY_HASH,
             'legacy_audit_prefix_bytes': LEGACY_BYTES, 'deploy': deploy, 'recovery': recovery,
             'database_system_identifier': SYSTEM, 'registered_schema': SCHEMA,
             'schema_0412': state['schema_0412'], 'schema_0413': state['schema_0413']}
    return basis, digest(canonical(basis))


def review(basis_hash):
    path = CONFIG / 'history-review.json'
    if not path.exists() and not path.is_symlink():
        return {'status': 'required', 'approval_sha256': None}
    value = json_value(read(path, 16384))
    need(set(value) == {'format', 'scope', 'approval_id', 'approved_at', 'approved_by',
                        'authorization_source', 'evidence_sha256', 'deploy_transaction', 'recovery_transaction'},
         'review_shape')
    need(value['format'] == 1 and value['scope'] == CAPABILITY and value['evidence_sha256'] == basis_hash
         and value['deploy_transaction'] == DEPLOY and value['recovery_transaction'] == RECOVERY,
         'review_evidence_binding')
    need(isinstance(value['approval_id'], str) and str(uuid.UUID(value['approval_id'])) == value['approval_id'],
         'human_review_id')
    for key in ('approved_by', 'authorization_source'):
        need(isinstance(value[key], str) and 1 <= len(value[key]) <= 512
             and value[key] not in ('NOT-APPROVED', 'CI', 'automatic'), 'human_review_identity')
    when = timestamp(value['approved_at'])
    need(timestamp('2026-11-20T02:13:49.580630+00:00') <= when <= dt.datetime.now(dt.timezone.utc),
         'human_review_time')
    return {'status': 'reviewed', 'approval_sha256': digest(canonical(value))}


def read_only_runtime(rt):
    """Do not let a failed read-only Docker/Git probe append command_failed audit."""
    def command(args, label, *, data=None, timeout=60):
        result = subprocess.run(args, input=data, capture_output=True, timeout=timeout,
                                env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root',
                                     'LANG': 'C.UTF-8', 'DOCKER_CONFIG': '/root/.docker', 'GIT_TERMINAL_PROMPT': '0'})
        need(result.returncode == 0, 'readonly_probe_failed')
        return result.stdout
    return command


def live(rt, state):
    context = rt.schema_context(state)
    need(context and context['database_schema'] == SCHEMA and rt.policy['system_identifier'] == SYSTEM,
         'registered_database_identity')
    rt.verify_current(state)
    for name in SERVICES:
        image = json_value(rt.docker('image', 'inspect', state['current']['image_ids'][name]))[0]
        labels = image.get('Config', {}).get('Labels') or {}
        need(image.get('Id') == state['current']['image_ids'][name]
             and state['current']['images'][name] in (image.get('RepoDigests') or [])
             and image.get('Os') == 'linux' and image.get('Architecture') == 'arm64'
             and labels.get('org.opencontainers.image.source') == 'https://github.com/Lz-20/AiNativeCrm'
             and labels.get('org.opencontainers.image.revision') == state['current']['sha']
             and labels.get('io.ainativecrm.schema-sha256') == state['current']['schema_sha256']
             and 'APP_VERSION=' + state['current']['sha'] in image.get('Config', {}).get('Env', []),
             'current_oci_identity')
    rt.verify_application_compatibility(state['current'], context)
    boundary = rt.boundary()
    identity = json_value(rt.command(['/usr/bin/python3', '-I', '-B', str(INSTALL / 'backup_verify.py'),
                                      '--identity-readonly'], 'readonly_catalog', timeout=120))
    need(identity.get('source_system_identifier') == SYSTEM and identity.get('static_catalog_sha256') == STATIC_CATALOG,
         'live_catalog_changed')
    sql = "BEGIN READ ONLY; SET LOCAL statement_timeout='10s'; SELECT json_build_object('embedding_enabled',(SELECT count(*) FROM public.ai_embedding_configurations WHERE enabled),'running',(SELECT count(*) FROM public.ai_embedding_operations WHERE status='running'),'reserved_unknown',(SELECT count(*) FROM public.ai_embedding_requests WHERE status IN ('reserved','unknown'))); ROLLBACK;"
    counts = json_value(rt.docker('exec', rt.policy['db_container_id'], 'psql', '-X', '-qAt', '--no-password',
                                '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', 'postgres', '-c', sql))
    need(counts == {'embedding_enabled': 0, 'running': 0, 'reserved_unknown': 0}, 'embedding_or_requests_in_use')
    return {'source_system_identifier': SYSTEM, 'source_container_id': rt.policy['db_container_id'],
            'registered_schema': SCHEMA, 'schema_0412_receipt_sha256': state['schema_0412']['receipt_sha256'],
            'schema_0413_receipt_sha256': state['schema_0413']['receipt_sha256'],
            'approved_schema_sha256': state['approved_schema_sha256'],
            'approved_catalog_sha256': state['approved_catalog_sha256'],
            'catalog_policy_sha256': identity['catalog_policy_sha256'],
            'static_catalog_sha256': identity['static_catalog_sha256'],
            'current_cohort_verified': True, 'protected_boundary_sha256': digest(canonical(boundary)),
            'business_healthy': 3, 'supabase_healthy': 11, 'counts': counts}


def state_view(state):
    pending = state.get('pending')
    pending_view = None
    if pending is not None:
        pending_view = {'transaction': pending.get('transaction') if isinstance(pending, dict)
                        and TX.fullmatch(pending.get('transaction', '')) else None,
                        'operation': pending.get('operation') if isinstance(pending, dict)
                        and pending.get('operation') in ('deploy', 'rollback') else 'unknown'}
    return {'current': public_release(state['current']),
            'previous': public_release(state['previous']) if state.get('previous') else None,
            'pending': pending_view}


def lineage(state, rt, records, basis):
    folder = ROOT / 'transactions'
    known = {}
    if folder.exists() or folder.is_symlink():
        secure(folder, directory=True)
        entries = list(folder.iterdir())
        need(len(entries) <= 256, 'transaction_inventory_limit')
        for entry in entries:
            need(TX.fullmatch(entry.name), 'transaction_directory_identity')
            known[entry.name] = inspect_native(entry.name, state, rt, records)
    later = [r for r in records if r.get('phase') == 'started' and
             timestamp(r['at']) > timestamp(basis['recovery']['completed_at'])]
    if not later:
        need(public_release(state['current']) == basis['recovery']['release'] and
             public_release(state['previous']) == basis['deploy']['release'], 'legacy_final_cohort_mismatch')
    else:
        need(all(r['transaction'] in known for r in later), 'unreceipted_later_transaction')
        latest = known[later[-1]['transaction']]
        need(latest['phase'] == 'succeeded' and public_release(state['current']) == latest['release'],
             'latest_transaction_unknown')
        receipt = json_value(read(folder / later[-1]['transaction'] / 'receipt.json'))
        need(receipt['state_sha256'] == digest(canonical(state)) and
             receipt['previous'] == state_view(state)['previous'], 'latest_state_receipt_mismatch')


def inspect(rt, request):
    import fcntl
    result = {'format': 1, 'capability': CAPABILITY, 'ok': False, 'status': 'unknown',
              'read_only': True, 'deployment_authorized': False, 'transaction': request['transaction'],
              'deployment_lock': 'unknown', 'backup_lock': 'unknown'}
    original_command = rt.command
    try:
        need(TX.fullmatch(request['transaction']), 'transaction_identity')
        with contextlib.ExitStack() as stack:
            for name in ('deployment', 'backup'):
                path = ROOT / (name + '.lock'); secure(path)
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW); stack.callback(os.close, fd)
                try:fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    result.update(status='busy', reason='deployment_or_backup_active')
                    result[name + '_lock'] = 'held'
                    # Atomic state may show a known pending ID, but is NOT a proof
                    # of quiescence while another process owns either lock.
                    try:result['observed_state'] = state_view(json_value(read(ROOT / 'state.json')))
                    except (OSError, ValueError, KeyError, TypeError):pass
                    return result
                result[name + '_lock'] = 'available'
            state = json_value(read(ROOT / 'state.json'))
            result['state'] = state_view(state)
            need(state.get('pending') is None, 'pending_transaction')
            raw, records = audit_records()
            rt.command = read_only_runtime(rt)
            current = live(rt, state)
            basis, basis_hash = legacy(state, rt, records)
            assessment = review(basis_hash)
            if request['transaction'] in (DEPLOY, RECOVERY):
                selected = basis['deploy' if request['transaction'] == DEPLOY else 'recovery']
            else:
                selected = inspect_native(request['transaction'], state, rt, records)
            # A new release after the recovery is allowed only if its own durable
            # root record terminates consistently. Never infer this from current.
            lineage(state, rt, records, basis)
            result.update(ok=True, status='authenticated', record=selected, incident=basis,
                          evidence_sha256=basis_hash, review=assessment, database=current,
                          root_state_sha256=digest(read(ROOT / 'state.json')),
                          audit_sha256=digest(raw), release_preparation_allowed=assessment['status'] == 'reviewed')
    except (Exception,):
        # No exception message, raw audit, credential, customer row or path leaks.
        result.update(ok=False, status='unknown', reason='evidence_missing_conflicting_or_untrusted')
        result.pop('incident', None); result.pop('record', None)
    finally:
        rt.command = original_command
    need(len(canonical(result)) <= 60000, 'inspection_response_bound')
    return result


def directory(path):
    if not path.exists():
        secure(path.parent, directory=True)
        path.mkdir(mode=0o700)
    secure(path, directory=True)


def write(path, value, *, immutable=False):
    secure(path.parent, directory=True)
    if immutable:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(canonical(value) + b'\n'); stream.flush(); os.fsync(stream.fileno())
    else:
        if path.exists():secure(path)
        temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
        write(temporary, value, immutable=True)
        os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:os.fsync(fd)
    finally:os.close(fd)


def preflight(rt, state, request, target):
    # This check runs under the EXISTING deployment lock, so do not inspect()
    # (which intentionally tries the lock itself). No new lock order is added.
    _, records = audit_records()
    basis, anchor = legacy(state, rt, records)
    lineage(state, rt, records, basis)
    need(review(anchor)['status'] == 'reviewed', 'independent_history_review_required')
    if request['operation'] == 'deploy':
        need(request['sha'] != state['current'].get('sha') and
             not any(r.get('phase') == 'started' and r.get('sha') == request['sha'] for r in records),
             'source_already_attempted_no_automatic_retry')
    else:
        # previous is an ordering fact, never an acceptance authorization.
        need(public_release(target) == basis['recovery']['release'], 'rollback_requires_reviewed_ea_cohort')


def prepare(rt, state, request, target, prior, txid, backup_proof):
    need(TX.fullmatch(txid), 'transaction_identity')
    directory(ROOT / 'transactions'); directory(ROOT / 'transactions' / txid)
    value = {'format': 1, 'transaction': txid, 'request': copy.deepcopy(request),
             'target': copy.deepcopy(target), 'prior': copy.deepcopy(prior),
             'database_schema': SCHEMA, 'state_before_sha256': digest(canonical(state)),
             'backup': copy.deepcopy(backup_proof)}
    folder = ROOT / 'transactions' / txid
    write(folder / 'request.json', value, immutable=True)
    write(folder / 'journal.json', {'format': 1, 'transaction': txid, 'phase': 'prepared',
          'request_sha256': digest(canonical(value)), 'stages': []})
    rt._history_transaction = txid


def stage(rt, phase):
    txid = getattr(rt, '_history_transaction', None)
    need(txid and TX.fullmatch(txid), 'transaction_not_prepared')
    path = ROOT / 'transactions' / txid / 'journal.json'
    value = json_value(read(path)); need(len(value['stages']) < 64, 'stage_limit')
    value['phase'] = phase
    value['stages'].append({'phase': phase, 'at': dt.datetime.now(dt.timezone.utc).isoformat()})
    write(path, value)


def complete(rt, phase, state):
    stage(rt, phase)
    folder = ROOT / 'transactions' / rt._history_transaction
    journal = json_value(read(folder / 'journal.json'))
    receipt = {'format': 1, 'transaction': rt._history_transaction, 'phase': phase,
               'request_sha256': journal['request_sha256'], 'journal_sha256': digest(canonical(journal)),
               'state_sha256': digest(canonical(state)), 'current': state_view(state)['current'],
               'previous': state_view(state)['previous'], 'pending': state_view(state)['pending']}
    write(folder / 'receipt.json', receipt, immutable=True)


def inspect_native(txid, state, rt, records):
    need(TX.fullmatch(txid), 'transaction_identity')
    folder = ROOT / 'transactions' / txid; secure(folder, directory=True)
    request = json_value(read(folder / 'request.json'))
    journal = json_value(read(folder / 'journal.json'))
    receipt = json_value(read(folder / 'receipt.json'))
    need(all(v.get('format') == 1 and v.get('transaction') == txid for v in (request, journal, receipt)),
         'native_record_identity')
    anchor = digest(canonical(request))
    need(journal['request_sha256'] == receipt['request_sha256'] == anchor and
         receipt['journal_sha256'] == digest(canonical(journal)), 'native_record_digest')
    need(journal['phase'] == receipt['phase'] == 'succeeded' and receipt['pending'] is None,
         'native_transaction_unknown')
    record, _ = transaction(records, txid)
    need(record['release'] == public_release(request['target']) == receipt['current'], 'native_cohort_mismatch')
    stages = [v['phase'] for v in journal['stages']]
    need(stages == ['started', 'updating-app', 'healthy-app', 'updating-worker', 'healthy-worker',
                    'updating-scheduler', 'healthy-scheduler', 'core-healthy', 'succeeded'], 'native_stage_incomplete')
    proof = request['backup']
    record['backup'] = backup(Path(proof['backup_directory']), proof['evidence_sha256'], state, rt)
    need(timestamp(record['requested_at']) <= timestamp(record['backup']['started_at']) <
         timestamp(record['backup']['verified_at']) < timestamp(record['started_at']), 'native_backup_not_this_transaction')
    need(receipt['previous'] == public_release(request['prior']), 'native_prior_cohort')
    record.update(legacy_native_journal_present=True, request_sha256=anchor,
                  journal_sha256=digest(canonical(journal)), receipt_sha256=digest(canonical(receipt)))
    return record
