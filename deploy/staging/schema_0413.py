"""Fixed, append-only 0412 -> 0413 transition. No SQL/Docker/network execution.

The unchanged 0412 verifier authenticates the prior chain first. Nothing here
accepts arbitrary migrations, target hashes, evidence directories or image tags.
"""
import copy
import datetime as dt
import importlib.util
from pathlib import Path
import re


def _legacy():
    spec=importlib.util.spec_from_file_location('schema0413_unchanged_0412',Path(__file__).with_name('schema_0412.py'))
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value


legacy=_legacy()
TransitionError=legacy.TransitionError
need=legacy.need;digest=legacy.digest;raw_hash=legacy.raw_hash
parse=legacy.parse;read=legacy.read;secure=legacy.secure;timestamp=legacy.timestamp
authenticate_backup=legacy.authenticate_backup;verify_backup_proof=legacy.verify_backup_proof
static_projection=legacy.static_projection;delta=legacy.delta;trusted_module=legacy.trusted_module
FROM_SOURCE='ea26ee4fb38a65cb15313ab002934238b6324ff8'
REVIEWED_SOURCE='d7f7123eec55a549d1ab2e1967136a5d543b3645'
FROM_SCHEMA='a2c444e558672a6a4b5790ec3b0bcc2be76838f291e6d1be568e0121380f2c20'
TO_SCHEMA='37974846957f850f051b020f23493586ce49631aacc66a04bbdbb93b8f708fa3'
MIGRATION='supabase/migrations/20261119080000_0413_rag_operacoes_controladas.sql'
MIGRATION_SHA256='d15b59cae60ab667b4621acce9fbcf0c9b66efc23598e69003822cb638530bc4'
SYSTEM_ID=legacy.SYSTEM_ID;CONTAINER_ID=legacy.CONTAINER_ID
STATE=legacy.STATE;CONFIG=legacy.CONFIG
DIRECTORY=STATE/'schema-0413';APPROVAL=CONFIG/'schema-0413-approval.json';JOURNAL=DIRECTORY/'journal.json'
TABLES={'ai_embedding_price_reviews','ai_embedding_operations','ai_embedding_requests'}
INDEXES={'ai_embedding_price_reviews_pkey','ai_embedding_price_reviews_organization_id_id_key',
 'ai_embedding_operations_pkey','ai_embedding_operations_organization_id_id_key',
 'ai_embedding_operations_organization_id_knowledge_source_id_key','embedding_operation_source_running',
 'ai_embedding_requests_pkey','ai_embedding_requests_organization_id_id_key',
 'ai_embedding_requests_organization_id_operation_id_input_po_key'}
SCHEMA_PATHS={'supabase/baseline.sql','supabase/migrations/MANIFEST.md',MIGRATION,'lib/database.types.ts'}
GUARDED_SOURCE_FILES={'lib/ai/embeddings/operation-contract.ts','lib/ai/embeddings/operation-store.ts',
 'lib/ai/embeddings/source-revision.ts','lib/ai/embeddings/configuration.ts','lib/ai/embeddings/chave.ts',
 'lib/ai/embeddings/profile.ts','lib/ai/embed.ts','workers/rag-indexer.ts','lib/event-log/drain.ts',
 'lib/agent-engine/edge/llm/embedding-provider.ts','lib/agent-engine/edge/llm/embed.ts',
 'lib/ai/knowledge/busca.ts','lib/agent-engine/agent/search-knowledge.ts','lib/mcp/tools/evolucao.ts',
 'app/api/v1/ai/knowledge/embedding/route.ts','app/api/v1/ai/knowledge/embedding/validate/route.ts',
 'app/api/v1/ai/knowledge/embedding/operations/route.ts'}
EVIDENCE_FILES={'catalog-before.json','catalog-after.json','partition-before.json','partition-after.json',
 'backup-before.json','backup-after.json','data-before.json','data-after.json','data-proof.json','state-before.json','prior-registration.json'}


def prior_registration(prior):
    need(type(prior) is dict and prior.get('database_schema')==FROM_SCHEMA and not prior.get('pending'),
         'schema0413_registered_0412_required')
    return legacy.registration(prior)


def check_delta_scope(value):
    allowed={'relations','columns','constraints','indexes','policies','triggers','types','publication_tables'}
    need(type(value) is dict and set(value)<=allowed,'schema0413_delta_class')
    seen=set();indexes=set();policies=set();types=set();foreign=set()
    for row in value.get('constraints',{}).get('added',[]):
        if row.get('contype')=='f':foreign.add(row.get('conname'))
    for kind,change in value.items():
        need(type(change) is dict and set(change)=={'added','removed'} and not change['removed']
             and all(type(change[k]) is list for k in change),'schema0413_additive_delta_required')
        for row in change['added']:
            need(type(row) is dict,'schema0413_delta_row')
            schema=row.get('schema_name',row.get('schemaname'))
            if kind=='triggers':
                need(row.get('tgisinternal') is True,'schema0413_no_new_business_trigger')
                try:constraint=legacy.json.loads(row['definition'])[4]
                except (ValueError,KeyError,TypeError,IndexError):raise TransitionError('schema0413_internal_trigger') from None
                need(constraint in foreign and (schema=='public' or (schema=='auth' and row.get('table_name')=='users')),
                     'schema0413_internal_trigger')
                continue
            need(schema=='public','schema0413_delta_schema')
            if kind=='relations':
                table=row.get('relname');grants=row.get('acl',[])
                need(table in TABLES and row.get('relkind')=='r' and row.get('owner')=='postgres'
                     and row.get('relrowsecurity') is True,'schema0413_relation_scope')
                roles={'postgres','service_role'}|({'authenticated'} if table!='ai_embedding_requests' else set())
                need(type(grants) is list and all(g.split('=')[0] in roles for g in grants),'schema0413_relation_acl')
                for grant in grants:
                    role,privileges=grant.split('=',1);rights=privileges.split('/')[0]
                    if role=='authenticated':need(rights=='r','schema0413_browser_write')
                    if role=='service_role':need(set(rights)==set('ar' if table=='ai_embedding_price_reviews' else 'arw'),
                                                 'schema0413_service_privileges')
                seen.add(table)
            elif kind=='types':
                need(row.get('typname') in TABLES|{'_'+t for t in TABLES} and row.get('owner')=='postgres','schema0413_type_scope')
                types.add(row['typname'])
            else:
                table=row.get('table_name',row.get('tablename'))
                need(table in TABLES,'schema0413_object_scope')
                if kind=='indexes':indexes.add(row.get('index_name'))
                if kind=='policies':policies.add((table,row.get('policyname')))
    need(seen==TABLES and indexes==INDEXES and len(foreign)==10
         and types==TABLES|{'_'+t for t in TABLES}
         and policies=={('ai_embedding_price_reviews','embedding_price_review_read'),('ai_embedding_operations','embedding_operation_read')},
         'schema0413_incomplete_delta')


def validate_approval(approval,prior,state):
    keys={'format','transition','from_source','reviewed_source','from_schema','to_schema','migration_sha256',
      'system_identifier','database','container_id','original_policy_sha256','prior_registration_sha256','prior_receipt_sha256',
      'old_policy_sha256','old_static_sha256','old_state_sha256','old_release','delta','delta_sha256',
      'approval_id','approved_at','ci_evidence_sha256'}
    need(type(approval) is dict and set(approval)==keys and type(approval['format']) is int and approval['format']==1,
         'schema0413_approval_format')
    expected={'transition':'rag-0413','from_source':FROM_SOURCE,'reviewed_source':REVIEWED_SOURCE,
      'from_schema':FROM_SCHEMA,'to_schema':TO_SCHEMA,'migration_sha256':MIGRATION_SHA256,
      'system_identifier':SYSTEM_ID,'database':'postgres','container_id':CONTAINER_ID}
    need(all(approval.get(k)==v for k,v in expected.items()),'schema0413_fixed_transition')
    previous=prior_registration(prior)
    need(state.get('schema_0412')==previous and approval['prior_registration_sha256']==digest(previous)
         and approval['prior_receipt_sha256']==prior['receipt_sha256'],'schema0413_prior_chain')
    need(state.get('approved_schema_sha256')==legacy.FROM_SCHEMA
         and state.get('approved_catalog_sha256')==prior['original_policy']['legacy_catalog_sha256'],
         'schema0413_original_approval_changed')
    need(approval['original_policy_sha256']==digest(prior['original_policy'])
         and approval['old_policy_sha256']==digest(prior['policy'])
         and approval['old_static_sha256']==prior['policy']['static_catalog_sha256'],'schema0413_prior_policy_anchor')
    for name in ('ci_evidence_sha256','old_state_sha256'):
        need(type(approval[name]) is str and legacy.HASH.fullmatch(approval[name]),'schema0413_approval_hash')
    need(type(approval['approval_id']) is str and re.fullmatch('[a-f0-9-]{36}',approval['approval_id']), 'schema0413_human_approval_required')
    need(timestamp(approval['approved_at'])<=dt.datetime.now(dt.timezone.utc),'schema0413_future_approval')
    old=approval['old_release']
    need(type(old) is dict and old.get('kind')=='git' and old.get('sha')==FROM_SOURCE
         and old.get('schema_sha256')==FROM_SCHEMA,'schema0413_old_release')
    need(set(old.get('images',{}))==set(old.get('image_ids',{}))=={'app','worker','scheduler'},'schema0413_old_image_set')
    for service,ref in old['images'].items():
        need(re.fullmatch('ghcr.io/lz-20/ainativecrm-'+service+'@sha256:[a-f0-9]{64}',ref)
             and re.fullmatch('sha256:[a-f0-9]{64}',old['image_ids'][service]),'schema0413_old_image_identity')
    check_delta_scope(approval['delta'])
    need(approval['delta_sha256']==digest(approval['delta']),'schema0413_delta_hash')
    return approval


def verify_change(before,after,approval):
    change=delta(before,after);check_delta_scope(change)
    if 'publication_tables' in change:
        automatic={row['pubname'] for row in before['postgres']['publications'] if row.get('puballtables') is True}
        need(all(row.get('pubname') in automatic for row in change['publication_tables']['added']),
             'schema0413_unapproved_publication_membership')
    need(change==approval['delta'] and digest(change)==approval['delta_sha256'],'schema0413_unapproved_catalog_delta')
    return digest(after)


def verify_data(before,after):
    extra=set(after)-set(before)
    need(extra=={'public.'+t for t in TABLES} and all(after[k].get('count')==0 for k in extra),
         'schema0413_new_ledger_must_be_empty')
    need(all(after.get(k)==v for k,v in before.items()),'schema0413_old_data_changed')
    return {'format':1,'before_sha256':digest(before),'after_sha256':digest(after),'unchanged':True,'new_tables_empty':True}


def evidence_inventory(values):
    need(set(values)==EVIDENCE_FILES,'schema0413_evidence_set')
    return {name:digest(value) for name,value in sorted(values.items())}


def catalog_context(approval,values,prior,cp,when):
    need(timestamp(when)>=timestamp(approval['approved_at']),'schema0413_receipt_time')
    need(digest(values['state-before.json'])==approval['old_state_sha256']
         and values['state-before.json'].get('current')==approval['old_release']
         and not values['state-before.json'].get('pending') and not values['state-before.json'].get('schema_0413')
         and values['prior-registration.json']==prior_registration(prior)
         and values['state-before.json'].get('schema_0412')==values['prior-registration.json'], 'schema0413_old_state_anchor')
    before=values['catalog-before.json'];after=values['catalog-after.json']
    a=static_projection(before,values['partition-before.json'],prior['policy'],when,cp.SOURCE_CONTRACT)
    z=static_projection(after,values['partition-after.json'],prior['policy'],when,cp.SOURCE_CONTRACT)
    need(digest(a)==approval['old_static_sha256'],'schema0413_before_static_anchor')
    verify_change(a,z,approval)
    need(values['data-proof.json']==verify_data(values['data-before.json'],values['data-after.json']),
         'schema0413_data_recalculation')
    policy={**prior['policy'],'static_catalog_sha256':digest(z),'initial_partitions':cp.names_in(after),'approved_at':when}
    cp.evaluate(after,values['partition-after.json'],policy,when,cp.SOURCE_CONTRACT)
    return a,z,policy


def validate_receipt(approval,receipt,values,prior,state,cp):
    keys={'format','transition','approval_sha256','prior_receipt_sha256','files','before_catalog_sha256',
      'after_catalog_sha256','before_static_sha256','after_static_sha256','completed_at'}
    need(type(receipt) is dict and set(receipt)==keys and type(receipt['format']) is int and receipt['format']==1
         and receipt['transition']=='rag-0413' and receipt['approval_sha256']==digest(approval)
         and receipt['prior_receipt_sha256']==prior['receipt_sha256'],'schema0413_receipt_format')
    need(receipt['files']==evidence_inventory(values),'schema0413_evidence_integrity')
    when=receipt['completed_at'];need(timestamp(when)>=timestamp(approval['approved_at']),'schema0413_receipt_time')
    a,z,policy=catalog_context(approval,values,prior,cp,when)
    need(receipt['before_catalog_sha256']==digest(values['catalog-before.json'])
         and receipt['after_catalog_sha256']==digest(values['catalog-after.json'])
         and receipt['before_static_sha256']==digest(a) and receipt['after_static_sha256']==digest(z),'schema0413_receipt_catalog')
    for name in ('backup-before.json','backup-after.json'):verify_backup_proof(values[name])
    need(values['backup-before.json']['source_catalog_sha256']==digest(values['catalog-before.json']), 'schema0413_before_backup_anchor')
    data=values['data-proof.json']
    need(set(data)=={'format','before_sha256','after_sha256','unchanged','new_tables_empty'}
         and type(data['format']) is int and data['format']==1 and data['unchanged'] is True and data['new_tables_empty'] is True
         and all(type(data[k]) is str and legacy.HASH.fullmatch(data[k]) for k in ('before_sha256','after_sha256')),
         'schema0413_data_proof')
    return {'approval':approval,'receipt':receipt,'prior':prior,'original_policy':prior['original_policy'],
      'policy':policy,'database_schema':TO_SCHEMA,'receipt_sha256':digest(receipt)}


def registration(context):
    return {'format':1,'transition':'rag-0413','approval_sha256':digest(context['approval']),
      'receipt_sha256':context['receipt_sha256'],'prior_registration_sha256':digest(prior_registration(context['prior'])),
      'prior_receipt_sha256':context['prior']['receipt_sha256'],'database_schema_sha256':TO_SCHEMA}


def read_context(state,original_policy,cp,*,allow_pending=False):
    present=JOURNAL.exists() or JOURNAL.is_symlink() or bool(state.get('schema_0413'))
    if not present:return None
    prior=legacy.read_context(state,original_policy,cp)
    prior_registration(prior)
    secure(DIRECTORY,directory=True);journal=read(JOURNAL)
    need(set(journal)=={'format','transition','phase','approval_sha256'} and type(journal['format']) is int
         and journal['format']==1 and journal['transition']=='rag-0413','schema0413_journal_format')
    need(journal['phase']=='registered' or (allow_pending and journal['phase'] in
         ('validated','sql_committed','registration_failed','transaction_failed_or_unknown')),'schema0413_registration_incomplete')
    approval=validate_approval(read(APPROVAL),prior,state)
    need(journal['approval_sha256']==digest(approval),'schema0413_journal_anchor')
    if allow_pending and not (DIRECTORY/'receipt.json').exists():
        transaction=read(DIRECTORY/'transaction.json');names=EVIDENCE_FILES-{'backup-after.json'}
        values={name:read(DIRECTORY/name) for name in names}
        need(set(transaction)=={'format','approval_sha256','files','completed_at'} and type(transaction['format']) is int and transaction['format']==1
             and transaction['approval_sha256']==digest(approval) and transaction['files']=={n:digest(v) for n,v in values.items()},
             'schema0413_pending_evidence')
        authenticate_backup(values['backup-before.json'])
        need(values['backup-before.json']['source_catalog_sha256']==digest(values['catalog-before.json']),'schema0413_before_backup_anchor')
        _,_,policy=catalog_context(approval,values,prior,cp,transaction['completed_at'])
        return {'approval':approval,'prior':prior,'policy':policy,'original_policy':original_policy,'pending':True,
          'database_schema':TO_SCHEMA,'evidence':values,'completed_at':transaction['completed_at']}
    values={name:read(DIRECTORY/name) for name in EVIDENCE_FILES}
    context=validate_receipt(approval,read(DIRECTORY/'receipt.json'),values,prior,state,cp)
    for name in ('backup-before.json','backup-after.json'):authenticate_backup(values[name])
    post_dir=Path(values['backup-after.json']['backup_directory']);post=read(post_dir/'evidence.json')
    need(post.get('catalog_policy_sha256')==digest(context['policy']),'schema0413_post_restore_policy')
    post_catalog=legacy.receipted_file(post_dir,post,'catalog-source.json');topology=legacy.receipted_file(post_dir,post,'partition-source.json')
    observation=cp.evaluate(post_catalog,topology,context['policy'],post.get('started_at'),cp.SOURCE_CONTRACT)
    need(observation==post.get('partition_validation'),'schema0413_post_restore_recalculation')
    if not allow_pending:need(state.get('schema_0413')==registration(context),'schema0413_registration_mismatch')
    return context


def validate_release(release,context,*,old_profile_in_use=False):
    old=context['approval']['old_release']
    if release.get('schema_sha256')==TO_SCHEMA:
        need(release.get('kind')=='git' and release.get('sha')!=FROM_SOURCE and set(release.get('images',{}))==set(old['images'])
             and all(ref!=old['images'][name] for name,ref in release['images'].items()),'schema0413_old_image_relabel')
        return
    need(release==old,'schema0413_unapproved_old_release')
    need(not old_profile_in_use,'schema0413_old_app_embedding_or_requests_in_use')


def validate_budget_source(sha,read_git_blob):
    # A merge commit may change the commit identity, but it cannot silently
    # replace the reviewed budget/admission boundaries while keeping Schema413.
    for path in sorted(GUARDED_SOURCE_FILES):
        need(raw_hash(read_git_blob(sha,path))==raw_hash(read_git_blob(REVIEWED_SOURCE,path)),
             'schema0413_reviewed_budget_source_changed')


class MigrationCoordinator:
    def __init__(self,runtime):self.rt=runtime
    def run(self):
        state=self.rt.load_state();prior=self.rt.prior_context()
        need(not state.get('pending') and not state.get('schema_0413'),'schema0413_state_not_ready')
        approval=validate_approval(self.rt.approval(),prior,state)
        need(digest(state)==approval['old_state_sha256'] and state['current']==approval['old_release'],'schema0413_current_changed')
        need(raw_hash(self.rt.migration_bytes())==MIGRATION_SHA256,'schema0413_migration_bytes')
        self.rt.assert_embedding_disabled()
        proof=verify_backup_proof(self.rt.fresh_backup_before(state))
        journal={'format':1,'transition':'rag-0413','phase':'applying','approval_sha256':digest(approval)}
        self.rt.start_journal(journal,state);committed=False
        try:
            result=self.rt.transaction(approval,proof);committed=True
            journal['phase']='sql_committed';self.rt.write_journal(journal)
            need(self.rt.load_state()==state,'schema0413_state_changed_during_migration')
            context=self.rt.post_backup_and_receipt(approval,result,proof);verify_backup_proof(context['post_backup'])
            need(self.rt.load_state()==state,'schema0413_state_changed_during_verification')
            self.rt.write_receipt(context);new=copy.deepcopy(state);new['schema_0413']=registration(context)
            self.rt.save_state(new);journal['phase']='registered';self.rt.write_journal(journal)
            self.rt.audit({'phase':'schema0413_registered','approval_sha256':digest(approval),'receipt_sha256':context['receipt_sha256']})
            return registration(context)
        except BaseException:
            journal['phase']='registration_failed' if committed else 'transaction_failed_or_unknown'
            self.rt.write_journal(journal);raise
