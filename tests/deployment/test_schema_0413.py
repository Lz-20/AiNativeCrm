import copy
import importlib.util
import json
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
m=load('fixed_schema0413',ROOT/'deploy/staging/schema_0413.py')
old=load('old_0412_fixture',ROOT/'tests/deployment/test_schema_0412.py')
cp=old.catalog.m


def state_and_prior(before,policy):
    release={'kind':'git','sha':m.FROM_SOURCE,'schema_sha256':m.FROM_SCHEMA,
      'images':{s:'ghcr.io/lz-20/ainativecrm-'+s+'@sha256:'+c*64 for s,c in zip(('app','worker','scheduler'),'789')},
      'image_ids':{s:'sha256:'+c*64 for s,c in zip(('app','worker','scheduler'),'789')}}
    prior={'approval':{'format':1,'fixture_prior_only':True},'receipt_sha256':'e'*64,
      'database_schema':m.FROM_SCHEMA,'policy':policy,'original_policy':policy}
    state={'format_version':1,'approved_schema_sha256':m.legacy.FROM_SCHEMA,'approved_catalog_sha256':policy['legacy_catalog_sha256'],
      'current':release,'previous':None,'pending':None,'schema_0412':m.prior_registration(prior),'rollback_verified':True}
    return state,prior


def approval(before,after,topology,prior,state):
    when=prior['policy']['approved_at']
    a=m.static_projection(before,topology,prior['policy'],when,cp.SOURCE_CONTRACT)
    z=m.static_projection(after,topology,prior['policy'],when,cp.SOURCE_CONTRACT)
    change=m.delta(a,z)
    return {'format':1,'transition':'rag-0413','from_source':m.FROM_SOURCE,'reviewed_source':m.REVIEWED_SOURCE,
      'from_schema':m.FROM_SCHEMA,'to_schema':m.TO_SCHEMA,'migration_sha256':m.MIGRATION_SHA256,
      'system_identifier':m.SYSTEM_ID,'database':'postgres','container_id':m.CONTAINER_ID,
      'original_policy_sha256':m.digest(prior['original_policy']),'prior_registration_sha256':m.digest(state['schema_0412']),
      'prior_receipt_sha256':prior['receipt_sha256'],'old_policy_sha256':m.digest(prior['policy']),
      'old_static_sha256':m.digest(a),'old_state_sha256':m.digest(state),'old_release':copy.deepcopy(state['current']),
      'delta':change,'delta_sha256':m.digest(change),'approval_id':'00000000-0000-4000-8000-000000000413',
      'approved_at':when,'ci_evidence_sha256':'c'*64}


def fixture():
    _,before,topology,original,_,old_plan,_,_=old.fixture()
    _,_,policy=m.legacy.catalog_context(old_plan,{'catalog-before.json':old.fixture()[0],'catalog-after.json':before,
      'partition-before.json':topology,'partition-after.json':topology},original,cp,old.catalog.NOW)
    after=copy.deepcopy(before)
    for table in sorted(m.TABLES):
        acl=['postgres=arwdDxt/postgres','service_role='+('ar' if table=='ai_embedding_price_reviews' else 'arw')+'/postgres']
        if table!='ai_embedding_requests':acl.append('authenticated=r/postgres')
        after['postgres']['relations'].append({'schema_name':'public','relname':table,'relkind':'r','owner':'postgres','relrowsecurity':True,'acl':sorted(acl)})
        for name in (table,'_'+table):after['postgres']['types'].append({'schema_name':'public','typname':name,'owner':'postgres'})
    for index in sorted(m.INDEXES):
        table=next(t for t in m.TABLES if index.startswith(t)) if index!='embedding_operation_source_running' else 'ai_embedding_operations'
        after['postgres']['indexes'].append({'schema_name':'public','table_name':table,'index_name':index,'definition_hash':'a'*32})
    for table,name in [('ai_embedding_price_reviews','embedding_price_review_read'),('ai_embedding_operations','embedding_operation_read')]:
        after['postgres']['policies'].append({'schemaname':'public','tablename':table,'policyname':name})
    for i in range(10):
        table='ai_embedding_operations';name=table+'_fixture_'+str(i)+'_fkey'
        after['postgres']['constraints'].append({'schema_name':'public','table_name':table,'conname':name,'contype':'f','definition_hash':'b'*64})
        for j in range(4):after['postgres']['triggers'].append({'schema_name':'public','table_name':table,'tgisinternal':True,
          'definition':json.dumps(['RI_FKey_fixture()',j,False,False,name,'hash'])})
    for kind in after['postgres']:after['postgres'][kind].sort(key=lambda x:json.dumps(x,sort_keys=True))
    state,prior=state_and_prior(before,policy);prior['original_policy']=original
    state['approved_catalog_sha256']=original['legacy_catalog_sha256']
    plan=approval(before,after,topology,prior,state)
    proof={'restore_verified':True,'differences':0,'source_system_identifier':m.SYSTEM_ID,'source_database':'postgres',
      'evidence_sha256':'d'*64,'source_catalog_sha256':m.digest(before)}
    return before,after,topology,prior,state,plan,proof


class Fixed0413Tests(unittest.TestCase):
    def setUp(self):self.before,self.after,self.topology,self.prior,self.state,self.plan,self.proof=fixture()
    def test_valid_fixed_plan_keeps_0412_registration_and_original_anchors(self):
        before=copy.deepcopy(self.state);m.validate_approval(self.plan,self.prior,self.state);self.assertEqual(before,self.state)
    def test_sql_fixture_exact_identity(self):
        self.assertEqual(m.raw_hash((ROOT/'tests/deployment/fixtures/migration0413.sql.txt').read_bytes()),m.MIGRATION_SHA256)
    def test_new_schema_cannot_hide_modified_budget_code_behind_reviewed_ancestry(self):
        m.validate_budget_source('synthetic-merge',lambda revision,path:path.encode())
        with self.assertRaises(ValueError):
            m.validate_budget_source('synthetic-merge',lambda revision,path: b'bypass' if revision!='d7f7123eec55a549d1ab2e1967136a5d543b3645' else path.encode())
    def test_missing_manual_approval_wrong_sha_schema_sql_identity_and_fields_fail(self):
        for key,value in [('approval_id','NOT-APPROVED'),('approved_at',None),('reviewed_source','0'*40),
          ('migration_sha256','0'*64),('to_schema',m.FROM_SCHEMA),('from_schema',m.legacy.FROM_SCHEMA),
          ('container_id','0'*64),('sql','SELECT 1'),('format',True),('prior_receipt_sha256','0'*64)]:
            bad={**self.plan,key:value}
            with self.assertRaises(ValueError):m.validate_approval(bad,self.prior,self.state)
        for raw in (b'{}',b'{"x":1,"x":2}',b'{"x":NaN}',b'[]'):
            with self.assertRaises(ValueError):m.validate_approval(m.parse(raw),self.prior,self.state)
    def test_unregistered_or_tampered_prior_chain_rejected(self):
        for change in ({'schema_0412':None},{'approved_schema_sha256':m.FROM_SCHEMA},{'approved_catalog_sha256':'0'*64}):
            with self.assertRaises(ValueError):m.validate_approval(self.plan,self.prior,{**self.state,**change})
        with self.assertRaises(ValueError):m.validate_approval(self.plan,{**self.prior,'pending':True},self.state)
    def test_hostile_catalog_owner_acl_rls_function_role_auth_storage_rejected(self):
        before=m.static_projection(self.before,self.topology,self.prior['policy'],old.catalog.NOW,cp.SOURCE_CONTRACT)
        for category in ('owner','acl','rls','function','role','auth','storage','index'):
            after=copy.deepcopy(self.after)
            row=next(r for r in after['postgres']['relations'] if r.get('relname')=='ai_embedding_requests')
            if category=='owner':row['owner']='attacker'
            elif category=='acl':row['acl'].append('authenticated=r/postgres')
            elif category=='rls':row['relrowsecurity']=False
            elif category=='function':after['postgres']['functions'][0]['definition_hash']='malicious'
            elif category=='role':after['postgres']['roles'].append({'rolname':'evil','rolsuper':True})
            elif category=='index':after['postgres']['indexes'].append({'schema_name':'public','table_name':'ai_embedding_requests','index_name':'evil'})
            else:after['postgres']['relations'].append({'schema_name':category,'relname':'evil','relkind':'r','owner':'postgres'})
            projected=m.static_projection(after,self.topology,self.prior['policy'],old.catalog.NOW,cp.SOURCE_CONTRACT)
            with self.assertRaises(ValueError):m.verify_change(before,projected,self.plan)
    def test_old_data_and_nonzero_restore_are_still_rejected(self):
        before={'public.contacts':{'count':1,'hash':'a'}}
        after={**before,**{'public.'+t:{'count':0,'hash':''} for t in m.TABLES}}
        self.assertTrue(m.verify_data(before,after)['unchanged'])
        after['public.contacts']={'count':0,'hash':''}
        with self.assertRaises(ValueError):m.verify_data(before,after)
        with self.assertRaises(ValueError):m.verify_backup_proof({**self.proof,'differences':1})
    def test_old_ea_cohort_only_with_disabled_embedding_and_no_inflight(self):
        context={'approval':self.plan};m.validate_release(self.state['current'],context)
        with self.assertRaises(ValueError):m.validate_release(self.state['current'],context,old_profile_in_use=True)
        with self.assertRaises(ValueError):m.validate_release({**self.state['current'],'sha':m.legacy.FROM_SOURCE},context)
        with self.assertRaises(ValueError):m.validate_release({**self.state['current'],'schema_sha256':m.TO_SCHEMA},context)


class FakeRuntime:
    def __init__(self):
        self.before,self.after,self.topology,self.prior,self.state,self.plan,self.proof=fixture()
        self.calls=[];self.failure=None;self.journal=None
    def load_state(self):return copy.deepcopy(self.state)
    def prior_context(self):return self.prior
    def approval(self):return self.plan
    def migration_bytes(self):return (ROOT/'tests/deployment/fixtures/migration0413.sql.txt').read_bytes()
    def assert_embedding_disabled(self):self.calls.append('disabled')
    def fresh_backup_before(self,state):self.calls.append('backup_before');return self.proof
    def start_journal(self,journal,state):
        if self.journal is not None:raise m.TransitionError('already_started')
        self.journal=copy.deepcopy(journal);self.calls.append('start')
    def write_journal(self,value):self.journal=copy.deepcopy(value)
    def transaction(self,approval,proof):
        self.calls.append('sql')
        if self.failure=='precommit':raise RuntimeError('transaction_failure_or_unknown_commit')
        return {}
    def post_backup_and_receipt(self,*args):
        self.calls.append('backup_after')
        if self.failure=='postcommit':raise RuntimeError('registration_failure')
        return {'approval':self.plan,'prior':self.prior,'receipt_sha256':'f'*64,'post_backup':self.proof}
    def write_receipt(self,context):self.calls.append('receipt')
    def save_state(self,state):self.state=copy.deepcopy(state)
    def audit(self,event):self.calls.append('audit')


class Coordinator0413Tests(unittest.TestCase):
    def test_tampered_installed_sql_bytes_rejected_before_any_backup_or_sql(self):
        rt=FakeRuntime();rt.migration_bytes=lambda:b'SELECT 1'
        with self.assertRaises(ValueError):m.MigrationCoordinator(rt).run()
        self.assertEqual(rt.calls,[])
    def test_appends_registration_without_changing_0412_or_business(self):
        rt=FakeRuntime();before=rt.load_state();m.MigrationCoordinator(rt).run()
        self.assertEqual({k:v for k,v in rt.state.items() if k!='schema_0413'},before)
        self.assertEqual(rt.calls,['disabled','backup_before','start','sql','backup_after','receipt','audit'])
        self.assertEqual(rt.journal['phase'],'registered')
        with self.assertRaises(ValueError):m.MigrationCoordinator(rt).run()
        self.assertEqual(rt.calls.count('sql'),1)
    def test_failure_before_or_after_commit_blocks_automatic_retry(self):
        for phase,expected in [('precommit','transaction_failed_or_unknown'),('postcommit','registration_failed')]:
            rt=FakeRuntime();before=rt.load_state();rt.failure=phase
            with self.assertRaises(RuntimeError):m.MigrationCoordinator(rt).run()
            self.assertEqual(rt.state,before);self.assertEqual(rt.journal['phase'],expected)
            with self.assertRaises(ValueError):m.MigrationCoordinator(rt).run()
            self.assertEqual(rt.calls.count('sql'),1)
    def test_missing_approval_fails_before_any_backup_or_sql(self):
        rt=FakeRuntime();rt.plan={}
        with self.assertRaises(ValueError):m.MigrationCoordinator(rt).run()
        self.assertEqual(rt.calls,[])


if __name__=='__main__':unittest.main()
