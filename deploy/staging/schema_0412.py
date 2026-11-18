"""One reviewed expand transition, not a general SQL/Schema authorization API.

Original approval hashes and immutable image declarations are never rewritten.
Only independently installed root approval + authenticated evidence enable it.
This module has no Docker, SQL, shell or network execution capability.
"""
import copy
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat

FROM_SOURCE = 'c5919aac3d3e670621ad3409e44c13c44ae8ea0e'
REVIEWED_SOURCE = '6c661538b8fc69cdcd49763ae8579cc188d5c487'
FROM_SCHEMA = '6780b2fb6179943f3238834fc4f1ef490a02a567309e73a2fdbc131c9791bc98'
TO_SCHEMA = 'a2c444e558672a6a4b5790ec3b0bcc2be76838f291e6d1be568e0121380f2c20'
MIGRATION = 'supabase/migrations/20261118080000_0412_embedding_multiplos_provedores.sql'
MIGRATION_SHA256 = '36111c299829b91cb588c8cce81cd8de5643eb0d04b42577984dec79d4c80926'
SYSTEM_ID = '7701258112182636578'
CONTAINER_ID = '3269d88526fe446ab2a8744a24494a6b19d14f9634fbf2f6a83c2077248c1c22'
STATE = Path('/var/lib/ainativecrm-staging-deploy')
CONFIG = Path('/etc/ainativecrm-staging-deploy')
DIRECTORY = STATE / 'schema-0412'
APPROVAL = CONFIG / 'schema-0412-approval.json'
JOURNAL = DIRECTORY / 'journal.json'
HASH = re.compile('[a-f0-9]{64}\\Z')
TABLES = {'ai_embedding_configurations','ai_embedding_chunks'}
NEW_FUNCTIONS = {'fn_embedding_configuration_guard','fn_embedding_chunk_guard','fn_embedding_version_guard',
                 'fn_activate_embedding_version','fn_search_knowledge_profile'}
REPLACED_FUNCTIONS = {'fn_buscar_trechos_das_fontes','retrieve_top_k_chunks'}
SCHEMA_PATHS = {'supabase/baseline.sql','supabase/migrations/MANIFEST.md',MIGRATION,'lib/database.types.ts'}
EVIDENCE_FILES = {'catalog-before.json','catalog-after.json','partition-before.json','partition-after.json',
                  'backup-before.json','backup-after.json','data-proof.json'}


class TransitionError(ValueError):
    def __init__(self, code): self.code=code;super().__init__(code)


def need(value, code):
    if not value: raise TransitionError(code)


def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()


def raw_hash(value):return hashlib.sha256(value).hexdigest()


def parse(raw):
    def pairs(items):
        result={}
        for key,value in items:
            need(key not in result,'schema0412_duplicate_key');result[key]=value
        return result
    def invalid(_):raise TransitionError('schema0412_nonfinite')
    try:value=json.loads(raw,object_pairs_hook=pairs,parse_constant=invalid)
    except (ValueError,TypeError,UnicodeError) as error:
        if isinstance(error,TransitionError):raise
        raise TransitionError('schema0412_invalid_json') from None
    need(type(value) is dict,'schema0412_object_required');return value


def timestamp(value):
    try:parsed=dt.datetime.fromisoformat(value)
    except (ValueError,TypeError):raise TransitionError('schema0412_timestamp') from None
    need(parsed.tzinfo is not None,'schema0412_timestamp');return parsed


def secure(path, directory=False):
    need(path.is_absolute() and path.resolve()==path,'schema0412_path')
    for parent in path.parents:
        s=parent.lstat();need(stat.S_ISDIR(s.st_mode) and s.st_uid==0 and not s.st_mode&0o022,'schema0412_parent_owner')
    s=path.lstat()
    need(s.st_uid==0 and stat.S_IMODE(s.st_mode)==(0o700 if directory else 0o600)
         and (stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode)),'schema0412_file_owner_mode')
    if not directory:need(s.st_nlink==1 and s.st_size<=16*1024*1024,'schema0412_file_links_size')
    return s


def read(path):secure(path);return parse(path.read_bytes())


def trusted_module(name):
    path=Path(__file__).resolve().with_name(name+'.py')
    need(path.resolve()==path,'schema0412_module_path')
    for parent in path.parents:
        info=parent.lstat();need(stat.S_ISDIR(info.st_mode) and info.st_uid==0 and not info.st_mode&0o022,'schema0412_module_parent')
    info=path.lstat()
    need(stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_nlink==1 and not info.st_mode&0o022,'schema0412_module_owner')
    spec=importlib.util.spec_from_file_location('installed_'+name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


def static_projection(catalog, topology, policy, observed_at, origin, previous=None):
    """Validate ALL dynamic attributes before removing only their exact rows.

    The returned hash is not an approval. Before/after difference still must
    match the independent, exact 0412 delta manifest below.
    """
    # Imported only from this reviewed source directory, never a candidate checkout.
    spec=importlib.util.spec_from_file_location('schema0412_catalog',Path(__file__).with_name('catalog_policy.py'))
    cp=importlib.util.module_from_spec(spec);spec.loader.exec_module(cp)
    projected=copy.deepcopy(catalog);names=cp.names_in(catalog)
    for kind in cp.CLASSES:
        projected['postgres'][kind]=[row for row in projected['postgres'][kind]
          if not any(cp.owned_row(kind,row,name) for name in names)]
    checked={**policy,'static_catalog_sha256':digest(projected)}
    cp.evaluate(catalog,topology,checked,observed_at,origin,previous)
    return projected


def delta(before, after):
    need(set(before)==set(after)=={'postgres','_supabase'},'schema0412_catalog_databases')
    need(before['_supabase']==after['_supabase'],'schema0412_secondary_catalog_changed')
    need(set(before['postgres'])==set(after['postgres']),'schema0412_catalog_classes')
    result={}
    for kind in before['postgres']:
        a={json.dumps(row,sort_keys=True,separators=(',',':'),ensure_ascii=False):row for row in before['postgres'][kind]}
        b={json.dumps(row,sort_keys=True,separators=(',',':'),ensure_ascii=False):row for row in after['postgres'][kind]}
        need(len(a)==len(before['postgres'][kind]) and len(b)==len(after['postgres'][kind]),'schema0412_duplicate_catalog_row')
        if a.keys()!=b.keys():result[kind]={'removed':[a[k] for k in sorted(a.keys()-b.keys())],
                                         'added':[b[k] for k in sorted(b.keys()-a.keys())]}
    return result


def check_delta_scope(value):
    """No schema-wide exclusion. Exact root-approved row values remain mandatory."""
    allowed={'relations','columns','functions','policies','indexes','constraints','triggers','types','publication_tables'}
    need(type(value) is dict and set(value)<=allowed,'schema0412_delta_class')
    seen_new=set();seen_functions=set();version_columns=[]
    for kind,change in value.items():
        need(type(change) is dict and set(change)=={'added','removed'}
             and all(type(change[k]) is list for k in change),'schema0412_delta_shape')
        for direction,rows in change.items():
            for row in rows:
                need(type(row) is dict,'schema0412_delta_row')
                schema=row.get('schema_name',row.get('schemaname'))
                need(schema=='public','schema0412_delta_schema')
                if direction=='removed':
                    need(kind=='functions' and row.get('proname') in REPLACED_FUNCTIONS,'schema0412_unapproved_deletion')
                elif kind=='functions':
                    need(row.get('proname') in NEW_FUNCTIONS|REPLACED_FUNCTIONS and row.get('owner')=='postgres','schema0412_function_scope')
                    seen_functions.add(row['proname'])
                elif kind=='relations':
                    need(row.get('relname') in TABLES and row.get('relkind')=='r' and row.get('owner')=='postgres'
                         and row.get('relrowsecurity') is True,'schema0412_relation_scope')
                    grants=row.get('acl',[])
                    need(all(g.split('=')[0] in ('postgres','service_role','authenticated') for g in grants),'schema0412_relation_acl')
                    need(all(g.split('=')[1].split('/')[0]=='r' for g in grants if g.startswith('authenticated=')),'schema0412_browser_write')
                    seen_new.add(row['relname'])
                elif kind=='types':
                    need(row.get('typname') in TABLES|{'_'+n for n in TABLES} and row.get('owner')=='postgres','schema0412_type_scope')
                elif kind=='triggers':
                    if row.get('tgisinternal'):
                        try:constraint=json.loads(row['definition'])[4]
                        except (ValueError,KeyError,TypeError,IndexError):raise TransitionError('schema0412_internal_trigger') from None
                        need(isinstance(constraint,str) and constraint.startswith(('ai_embedding_chunks_','ai_embedding_configurations_'))
                             and constraint.endswith('_fkey'),'schema0412_internal_trigger')
                    else:
                        need((row.get('table_name'),row.get('trigger_name')) in {
                          ('ai_embedding_configurations','embedding_configuration_guard'),('ai_embedding_chunks','embedding_chunk_guard'),
                          ('ai_knowledge_versions','embedding_version_guard')},'schema0412_trigger_scope')
                elif kind=='columns' and row.get('table_name')=='ai_knowledge_versions':
                    need(row.get('attname')=='embedding_profile' and row.get('type_name')=='jsonb'
                         and row.get('attnotnull') is False,'schema0412_version_column')
                    version_columns.append(row)
                else:
                    need(row.get('table_name',row.get('tablename')) in TABLES,'schema0412_object_scope')
    need(seen_new==TABLES and seen_functions==NEW_FUNCTIONS|REPLACED_FUNCTIONS and len(version_columns)==1,
         'schema0412_incomplete_delta')


def validate_approval(approval, old_policy, state):
    keys={'format','transition','from_source','reviewed_source','from_schema','to_schema','migration_sha256',
          'system_identifier','database','container_id','old_policy_sha256','old_static_sha256','old_release',
          'delta','delta_sha256','approval_id','approved_at','ci_evidence_sha256'}
    need(type(approval) is dict and set(approval)==keys and type(approval['format']) is int and approval['format']==1,
         'schema0412_approval_format')
    expected={'transition':'embedding-0412','from_source':FROM_SOURCE,'reviewed_source':REVIEWED_SOURCE,
              'from_schema':FROM_SCHEMA,'to_schema':TO_SCHEMA,'migration_sha256':MIGRATION_SHA256,
              'system_identifier':SYSTEM_ID,'database':'postgres','container_id':CONTAINER_ID}
    need(all(approval.get(k)==v for k,v in expected.items()),'schema0412_fixed_transition')
    need(state.get('approved_schema_sha256')==FROM_SCHEMA and old_policy.get('legacy_catalog_sha256')==state.get('approved_catalog_sha256'),
         'schema0412_original_approval_changed')
    need(approval['old_policy_sha256']==digest(old_policy) and approval['old_static_sha256']==old_policy['static_catalog_sha256'],
         'schema0412_policy_anchor')
    need(re.fullmatch('[a-f0-9-]{36}',approval.get('approval_id','')) is not None,'schema0412_approval_id')
    timestamp(approval['approved_at'])
    need(isinstance(approval['ci_evidence_sha256'],str) and HASH.fullmatch(approval['ci_evidence_sha256']),'schema0412_ci_receipt')
    old=approval['old_release']
    need(type(old) is dict and old.get('kind')=='git' and old.get('sha')==FROM_SOURCE and old.get('schema_sha256')==FROM_SCHEMA,
         'schema0412_old_release')
    need(set(old.get('images',{}))=={'app','worker','scheduler'} and set(old.get('image_ids',{}))=={'app','worker','scheduler'},
         'schema0412_old_image_set')
    for service,ref in old['images'].items():
        need(re.fullmatch('ghcr.io/lz-20/ainativecrm-'+service+'@sha256:[a-f0-9]{64}',ref) is not None
             and re.fullmatch('sha256:[a-f0-9]{64}',old['image_ids'][service]) is not None,'schema0412_old_image_identity')
    check_delta_scope(approval['delta'])
    need(approval['delta_sha256']==digest(approval['delta']),'schema0412_delta_hash')
    return approval


def verify_change(before, after, approval):
    change=delta(before,after);check_delta_scope(change)
    need(change==approval['delta'] and digest(change)==approval['delta_sha256'],'schema0412_unapproved_catalog_delta')
    return digest(after)


def verify_data(before, after):
    extra=set(after)-set(before)
    need(extra=={'public.'+t for t in TABLES},'schema0412_data_tables')
    need(all(after[k].get('count')==0 for k in extra),'schema0412_new_tables_not_empty')
    need(all(after.get(k)==v for k,v in before.items()),'schema0412_business_data_changed')
    return {'format':1,'before_sha256':digest(before),'after_sha256':digest(after),'unchanged':True,'new_tables_empty':True}


def verify_backup_proof(proof):
    need(type(proof) is dict and proof.get('restore_verified') is True and type(proof.get('differences')) is int
         and proof['differences']==0 and proof.get('source_system_identifier')==SYSTEM_ID
         and proof.get('source_database')=='postgres' and HASH.fullmatch(proof.get('evidence_sha256','')),
         'schema0412_backup_not_verified')
    return proof


def evidence_inventory(values):
    need(set(values)==EVIDENCE_FILES,'schema0412_evidence_set')
    return {name:digest(value) for name,value in sorted(values.items())}


def catalog_context(approval, evidence, old_policy, cp, when):
    before=evidence['catalog-before.json'];after=evidence['catalog-after.json']
    a=static_projection(before,evidence['partition-before.json'],old_policy,when,cp.SOURCE_CONTRACT)
    b=static_projection(after,evidence['partition-after.json'],old_policy,when,cp.SOURCE_CONTRACT)
    need(digest(a)==approval['old_static_sha256'],'schema0412_before_static_anchor')
    verify_change(a,b,approval)
    effective={**old_policy,'static_catalog_sha256':digest(b),'initial_partitions':cp.names_in(after),'approved_at':when}
    cp.evaluate(after,evidence['partition-after.json'],effective,when,cp.SOURCE_CONTRACT)
    return a,b,effective


def validate_receipt(approval, receipt, evidence, old_policy, state, cp):
    keys={'format','transition','approval_sha256','files','before_catalog_sha256','after_catalog_sha256',
          'before_static_sha256','after_static_sha256','completed_at'}
    need(type(receipt) is dict and set(receipt)==keys and type(receipt['format']) is int and receipt['format']==1
         and receipt['transition']=='embedding-0412' and receipt['approval_sha256']==digest(approval),'schema0412_receipt_format')
    need(receipt['files']==evidence_inventory(evidence),'schema0412_evidence_integrity')
    before=evidence['catalog-before.json'];after=evidence['catalog-after.json']
    when=receipt['completed_at'];timestamp(when)
    need(timestamp(when)>=timestamp(approval['approved_at']),'schema0412_receipt_time')
    a,b,effective=catalog_context(approval,evidence,old_policy,cp,when)
    need(receipt['before_catalog_sha256']==digest(before) and receipt['after_catalog_sha256']==digest(after)
         and receipt['before_static_sha256']==digest(a) and receipt['after_static_sha256']==digest(b),'schema0412_receipt_catalog')
    for name in ['backup-before.json','backup-after.json']:verify_backup_proof(evidence[name])
    need(evidence['backup-before.json']['source_catalog_sha256']==digest(before),'schema0412_before_backup_anchor')
    need(evidence['data-proof.json'].get('unchanged') is True and evidence['data-proof.json'].get('new_tables_empty') is True,
         'schema0412_data_proof')
    return {'approval':approval,'receipt':receipt,'policy':effective,'original_policy':old_policy,
            'database_schema':TO_SCHEMA,'receipt_sha256':digest(receipt)}


def registration(context):
    return {'format':1,'transition':'embedding-0412','approval_sha256':digest(context['approval']),
            'receipt_sha256':context['receipt_sha256'],'database_schema_sha256':TO_SCHEMA}


def read_context(state, old_policy, cp, *, allow_pending=False):
    present=JOURNAL.exists() or JOURNAL.is_symlink() or bool(state.get('schema_0412'))
    if not present:return None
    secure(DIRECTORY,directory=True)
    journal=read(JOURNAL)
    need(set(journal)=={'format','transition','phase','approval_sha256'} and type(journal.get('format')) is int
         and journal['format']==1 and journal.get('transition')=='embedding-0412','schema0412_journal_format')
    need(journal.get('phase')=='registered' or (allow_pending and journal.get('phase') in
         ('validated','sql_committed','registration_failed','transaction_failed_or_unknown')),
         'schema0412_registration_incomplete')
    approval=validate_approval(read(APPROVAL),old_policy,state)
    need(journal.get('approval_sha256')==digest(approval),'schema0412_journal_anchor')
    if allow_pending and not (DIRECTORY/'receipt.json').exists():
        pending=read(DIRECTORY/'transaction.json')
        names=EVIDENCE_FILES-{'backup-after.json'}
        values={name:read(DIRECTORY/name) for name in names}
        need(set(pending)=={'format','approval_sha256','files','completed_at'} and type(pending['format']) is int and pending['format']==1
             and pending['approval_sha256']==digest(approval)
             and pending['files']=={n:digest(v) for n,v in values.items()},'schema0412_pending_evidence')
        verify_backup_proof(values['backup-before.json'])
        need(values['backup-before.json']['source_catalog_sha256']==digest(values['catalog-before.json']),
             'schema0412_before_backup_anchor')
        authenticate_backup(values['backup-before.json'])
        a,b,effective=catalog_context(approval,values,old_policy,cp,pending['completed_at'])
        need(values['data-proof.json'].get('unchanged') is True and values['data-proof.json'].get('new_tables_empty') is True,
             'schema0412_data_proof')
        return {'approval':approval,'policy':effective,'original_policy':old_policy,'pending':True,'database_schema':TO_SCHEMA,
                'evidence':values,'completed_at':pending['completed_at']}
    receipt=read(DIRECTORY/'receipt.json')
    values={name:read(DIRECTORY/name) for name in EVIDENCE_FILES}
    context=validate_receipt(approval,receipt,values,old_policy,state,cp)
    for name in ['backup-before.json','backup-after.json']:authenticate_backup(values[name])
    post_dir=Path(values['backup-after.json']['backup_directory'])
    post=read(post_dir/'evidence.json')
    need(post.get('catalog_policy_sha256')==digest(context['policy']),'schema0412_post_restore_policy')
    post_catalog=receipted_file(post_dir,post,'catalog-source.json')
    post_topology=receipted_file(post_dir,post,'partition-source.json')
    observation=cp.evaluate(post_catalog,post_topology,context['policy'],post.get('started_at'),cp.SOURCE_CONTRACT)
    need(observation==post.get('partition_validation'),'schema0412_post_restore_recalculation')
    if not allow_pending:
        need(state.get('schema_0412')==registration(context),'schema0412_registration_mismatch')
    return context


def authenticate_backup(proof):
    """Re-open root receipt and catalog; booleans in a caller JSON are insufficient."""
    verify_backup_proof(proof)
    directory=Path(proof.get('backup_directory',''))
    need(directory.is_absolute() and directory.parent==STATE/'backups','schema0412_backup_directory')
    secure(directory,directory=True)
    path=directory/'evidence.json';secure(path)
    need(raw_hash(path.read_bytes())==proof['evidence_sha256'],'schema0412_restore_evidence_hash')
    evidence=read(path)
    need(all(evidence.get(k) is True for k in ['restore_verified','storage_verified','restart_verified'])
         and type(evidence.get('differences')) is int and evidence['differences']==0
         and evidence.get('source_database_writes') is False and evidence.get('source_system_identifier')==SYSTEM_ID
         and evidence.get('source_container_id')==CONTAINER_ID,'schema0412_restore_evidence_flags')
    catalog=receipted_file(directory,evidence,'catalog-source.json')
    need(digest(catalog)==proof['source_catalog_sha256'],
         'schema0412_restore_catalog_receipt')
    return evidence


def receipted_file(directory,evidence,name):
    need(name in ('catalog-source.json','partition-source.json'),'schema0412_fixed_receipt_file')
    path=directory/name;secure(path)
    rows=[r for r in evidence.get('files',[]) if r.get('file')==name]
    need(len(rows)==1 and rows[0].get('sha256')==raw_hash(path.read_bytes())
         and rows[0].get('bytes')==path.stat().st_size,'schema0412_restore_file_receipt')
    return read(path)


def validate_release(release, context, *, old_profile_in_use=False):
    if release.get('schema_sha256')==TO_SCHEMA:
        old=context['approval']['old_release']
        need(release.get('kind')=='git' and release.get('sha')!=FROM_SOURCE,'schema0412_new_release_kind')
        need(set(release.get('images',{}))==set(old['images']) and
             all(ref!=old['images'][service] for service,ref in release['images'].items()),'schema0412_old_image_relabel')
        return
    need(release==context['approval']['old_release'],'schema0412_unapproved_old_release')
    need(not old_profile_in_use,'schema0412_old_app_new_profile_active')


class MigrationCoordinator:
    """Fixed lifecycle; runtime owns locks, immutable evidence and the SQL transaction.

    No method calls Docker update or release rollout. A registration failure leaves
    a durable journal and the expanded DB, blocking the separate release engine.
    """
    def __init__(self, runtime):self.rt=runtime

    def run(self):
        state=self.rt.load_state();need(not state.get('pending') and not state.get('schema_0412'),'schema0412_state_not_ready')
        approval=validate_approval(self.rt.approval(),self.rt.old_policy(),state)
        need(state.get('current')==approval['old_release'],'schema0412_current_changed')
        need(raw_hash(self.rt.migration_bytes())==MIGRATION_SHA256,'schema0412_migration_bytes')
        proof=verify_backup_proof(self.rt.fresh_backup_before(state))
        journal={'format':1,'transition':'embedding-0412','phase':'applying','approval_sha256':digest(approval)}
        self.rt.start_journal(journal,state)
        committed=False
        try:
            result=self.rt.transaction(approval,proof)
            committed=True;journal['phase']='sql_committed';self.rt.write_journal(journal)
            need(self.rt.load_state()==state,'schema0412_state_changed_during_migration')
            # This callback must perform a NEW complete backup/restore/restart/Storage
            # proof, not copy the pre-migration proof or accept CI's synthetic result.
            context=self.rt.post_backup_and_receipt(approval,result,proof)
            verify_backup_proof(context['post_backup'])
            self.rt.write_receipt(context)
            new=copy.deepcopy(state);new['schema_0412']=registration(context)
            self.rt.save_state(new)
            journal['phase']='registered';self.rt.write_journal(journal)
            self.rt.audit({'phase':'schema0412_registered','approval_sha256':digest(approval),'receipt_sha256':context['receipt_sha256']})
            return registration(context)
        except BaseException:
            journal['phase']='registration_failed' if committed else 'transaction_failed_or_unknown'
            self.rt.write_journal(journal)
            raise
