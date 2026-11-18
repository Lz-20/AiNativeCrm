"""Fixed-transition, immutable-image and crash safety. SQL lives in the real PG gate."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest

ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
m=load('schema0412_test',ROOT/'deploy/staging/schema_0412.py')
e=load('schema0412_engine_test',ROOT/'deploy/staging/engine.py')
catalog=load('schema0412_catalog_test',ROOT/'tests/deployment/test_catalog_policy.py')
legacy=load('schema0412_legacy_engine_test',ROOT/'tests/deployment/test_staging_engine.py')


def fixture():
    before,topology,policy=catalog.fixture();after=copy.deepcopy(before)
    for name in sorted(m.TABLES):
        after['postgres']['relations'].append({'schema_name':'public','relname':name,'relkind':'r','owner':'postgres',
          'acl':['postgres=arwdDxt/postgres','service_role=arwdDxt/postgres','authenticated=r/postgres'],
          'relrowsecurity':True,'relforcerowsecurity':False})
    after['postgres']['columns'].append({'schema_name':'public','table_name':'ai_knowledge_versions',
      'attname':'embedding_profile','type_name':'jsonb','attnotnull':False})
    for name in sorted(m.NEW_FUNCTIONS|m.REPLACED_FUNCTIONS):
        after['postgres']['functions'].append({'schema_name':'public','proname':name,'owner':'postgres','definition_hash':'new'})
    a=m.static_projection(before,topology,policy,catalog.NOW,catalog.m.SOURCE_CONTRACT)
    z=m.static_projection(after,topology,policy,catalog.NOW,catalog.m.SOURCE_CONTRACT)
    release={'kind':'git','sha':m.FROM_SOURCE,'schema_sha256':m.FROM_SCHEMA,
      'images':{s:'ghcr.io/lz-20/ainativecrm-'+s+'@sha256:'+c*64 for s,c in zip(e.SERVICES,'456')},
      'image_ids':{s:'sha256:'+c*64 for s,c in zip(e.SERVICES,'456')}}
    state={'format_version':1,'approved_schema_sha256':m.FROM_SCHEMA,'approved_catalog_sha256':policy['legacy_catalog_sha256'],
      'current':release,'previous':None,'pending':None,'rollback_verified':True,'auto_deploy_enabled':True}
    approval={'format':1,'transition':'embedding-0412','from_source':m.FROM_SOURCE,'reviewed_source':m.REVIEWED_SOURCE,
      'from_schema':m.FROM_SCHEMA,'to_schema':m.TO_SCHEMA,'migration_sha256':m.MIGRATION_SHA256,
      'system_identifier':m.SYSTEM_ID,'database':'postgres','container_id':m.CONTAINER_ID,
      'old_policy_sha256':m.digest(policy),'old_static_sha256':policy['static_catalog_sha256'],'old_release':copy.deepcopy(release),
      'delta':m.delta(a,z),'delta_sha256':m.digest(m.delta(a,z)),'approval_id':'00000000-0000-4000-8000-000000000412',
      'approved_at':catalog.NOW,'ci_evidence_sha256':'c'*64}
    proof={'restore_verified':True,'differences':0,'source_system_identifier':m.SYSTEM_ID,'source_database':'postgres',
      'evidence_sha256':'d'*64,'source_catalog_sha256':m.digest(before)}
    context={'approval':approval,'receipt_sha256':'e'*64,'database_schema':m.TO_SCHEMA,'policy':policy,'post_backup':proof}
    return before,after,topology,policy,state,approval,proof,context


class FixedSchemaTests(unittest.TestCase):
    def setUp(self):self.before,self.after,self.topology,self.policy,self.state,self.approval,self.proof,self.context=fixture()
    def test_reviewed_approval_is_accepted_without_replacing_original_hashes(self):
        old=copy.deepcopy(self.state);m.validate_approval(self.approval,self.policy,self.state);self.assertEqual(old,self.state)
    def test_exact_sql_blob_is_bound_to_the_existing_reviewed_commit(self):
        # Generic shallow CI has no unrelated PR object. The dedicated native
        # gate compares this exact fixture to git show of REVIEWED_SOURCE.
        raw=(ROOT/'tests/deployment/fixtures/migration0412.sql.txt').read_bytes()
        self.assertEqual(m.raw_hash(raw),m.MIGRATION_SHA256)
    def test_duplicate_keys_nan_unknown_and_wrong_transition_are_rejected(self):
        for raw in [b'{"x":1,"x":2}',b'{"x":NaN}',b'[]']:
            with self.assertRaises(m.TransitionError):m.parse(raw)
        for key,value in [('format',True),('migration_sha256','0'*64),('from_schema',m.TO_SCHEMA),('container_id','0'*64),('sql','SELECT 1')]:
            bad=copy.deepcopy(self.approval);bad[key]=value
            with self.assertRaises(m.TransitionError):m.validate_approval(bad,self.policy,self.state)
    def test_wrong_credential_acl_owner_rls_or_extra_objects_never_match_approval(self):
        a=m.static_projection(self.before,self.topology,self.policy,catalog.NOW,catalog.m.SOURCE_CONTRACT)
        for action in ['owner','acl','rls','public','auth','storage','role','function']:
            changed=copy.deepcopy(self.after)
            if action in ['owner','acl','rls']:
                row=next(r for r in changed['postgres']['relations'] if r.get('relname')=='ai_embedding_chunks')
                row[{'owner':'owner','acl':'acl','rls':'relrowsecurity'}[action]]={'owner':'attacker','acl':['anon=arwdDxt/postgres'],'rls':False}[action]
            elif action in ['public','auth','storage']:
                changed['postgres']['relations'].append({'schema_name':action,'relname':'unapproved','owner':'postgres'})
            elif action=='role':changed['postgres']['roles'].append({'rolname':'unapproved','rolsuper':True})
            else:changed['postgres']['functions'][0]['definition_hash']='unapproved'
            z=m.static_projection(changed,self.topology,self.policy,catalog.NOW,catalog.m.SOURCE_CONTRACT)
            with self.assertRaises(m.TransitionError):m.verify_change(a,z,self.approval)
    def test_old_release_is_not_relabelled_or_replaced_by_another_old_version(self):
        m.validate_release(self.state['current'],self.context)
        for field,value in [('sha','0'*40),('schema_sha256',m.TO_SCHEMA)]:
            changed=copy.deepcopy(self.state['current']);changed[field]=value
            if field=='schema_sha256':
                # The general controller still binds the saved SHA to image
                # labels; a transition receipt never edits the saved release.
                self.assertEqual(self.approval['old_release']['schema_sha256'],m.FROM_SCHEMA)
                with self.assertRaises(m.TransitionError):m.validate_release(changed,self.context)
            else:
                with self.assertRaises(m.TransitionError):m.validate_release(changed,self.context)
        with self.assertRaises(m.TransitionError):m.validate_release(self.state['current'],self.context,old_profile_in_use=True)
    def test_nonzero_restore_difference_and_changed_customer_data_rejected(self):
        for field,value in [('differences',1),('restore_verified',False),('source_system_identifier','wrong')]:
            with self.assertRaises(m.TransitionError):m.verify_backup_proof({**self.proof,field:value})
        before={'public.contacts':{'count':1,'hash':'old'}}
        after={**before,**{'public.'+x:{'count':0,'hash':''} for x in m.TABLES}}
        self.assertTrue(m.verify_data(before,after)['unchanged'])
        after['public.contacts']['hash']='changed'
        with self.assertRaises(m.TransitionError):m.verify_data({'public.contacts':{'count':1,'hash':'old'}},after)


class FakeMigrationRuntime:
    def __init__(self):
        self.before,self.after,self.topology,self.policy,self.state,self.plan,self.proof,self.context=fixture()
        self.calls=[];self.journal=None;self.fail=None
    def load_state(self):return copy.deepcopy(self.state)
    def old_policy(self):return self.policy
    def approval(self):return self.plan
    def migration_bytes(self):return (ROOT/'tests/deployment/fixtures/migration0412.sql.txt').read_bytes()
    def fresh_backup_before(self,state):self.calls.append('backup_before');return self.proof
    def start_journal(self,journal,state):self.journal=copy.deepcopy(journal);self.calls.append('journal')
    def write_journal(self,journal):self.journal=copy.deepcopy(journal)
    def transaction(self,approval,proof):
        self.calls.append('transaction')
        if self.fail=='transaction':raise RuntimeError('synthetic transaction failure')
        return self.after
    def post_backup_and_receipt(self,*args):
        self.calls.append('backup_after')
        if self.fail=='restore':raise m.TransitionError('schema0412_backup_not_verified')
        return self.context
    def write_receipt(self,context):
        self.calls.append('receipt')
        if self.fail=='receipt':raise OSError('synthetic file failure')
    def save_state(self,state):
        self.calls.append('registration')
        if self.fail=='registration':raise OSError('synthetic registration failure')
        self.state=copy.deepcopy(state)
    def audit(self,event):self.calls.append('audit')


class CoordinatorTests(unittest.TestCase):
    def test_success_orders_full_proofs_then_registration_without_container_operations(self):
        rt=FakeMigrationRuntime();old=copy.deepcopy(rt.state)
        result=m.MigrationCoordinator(rt).run()
        self.assertEqual(rt.calls,['backup_before','journal','transaction','backup_after','receipt','registration','audit'])
        self.assertEqual(rt.state,{**old,'schema_0412':result});self.assertEqual(rt.journal['phase'],'registered')
    def test_failure_never_changes_approved_hashes_or_starts_a_release(self):
        for stage in ['transaction','restore','receipt','registration']:
            rt=FakeMigrationRuntime();old=copy.deepcopy(rt.state);rt.fail=stage
            with self.assertRaises((RuntimeError,OSError,ValueError)):m.MigrationCoordinator(rt).run()
            self.assertEqual(rt.state,old)
            self.assertEqual(rt.journal['phase'],'transaction_failed_or_unknown' if stage=='transaction' else 'registration_failed')
            self.assertFalse(any('update' in x or 'rollout' in x for x in rt.calls))


class ReleaseAcrossExpansionTests(unittest.TestCase):
    def runtime(self):
        _,_,_,_,state,_,_,context=fixture()
        class Runtime(legacy.FakeRuntime):
            def schema_context(self,_):return context
            def verify_application_compatibility(self,release,ctx):
                try:m.validate_release(release,ctx,old_profile_in_use=self.new_profile)
                except m.TransitionError as error:raise e.Failure(error.code) from None
            def wait_healthy(self,service,release):
                self.calls.append(('health',service,release['sha']))
                if self.fail_service==service and release['sha']!=m.FROM_SOURCE:raise e.Failure('candidate_unhealthy')
        rt=Runtime();rt.state=state;rt.new_profile=False
        return rt
    def request(self):return {**legacy.REQUEST,'schema_sha256':m.TO_SCHEMA}
    def test_success_preserves_old_schema_in_prior_and_original_approved_hash(self):
        rt=self.runtime();old=copy.deepcopy(rt.state)
        e.ReleaseEngine(rt).run(self.request())
        self.assertEqual(rt.state['previous'],old['current'])
        self.assertEqual(rt.state['current']['schema_sha256'],m.TO_SCHEMA)
        self.assertEqual(rt.state['approved_schema_sha256'],m.FROM_SCHEMA)
    def test_failed_new_app_restores_old_images_without_downgrading_database(self):
        rt=self.runtime();old=copy.deepcopy(rt.state['current']);rt.fail_service='worker'
        with self.assertRaises(e.Failure) as caught:e.ReleaseEngine(rt).run(self.request())
        self.assertEqual(caught.exception.code,'deployment_failed_rolled_back')
        self.assertEqual(rt.state['current'],old);self.assertIsNone(rt.state['pending'])
    def test_active_new_profile_blocks_old_image_rollback_before_prepare(self):
        rt=self.runtime();e.ReleaseEngine(rt).run(self.request());rt.new_profile=True;rt.calls=[]
        with self.assertRaises(e.Failure):e.ReleaseEngine(rt).run({'operation':'rollback'})
        self.assertFalse(any(c[0] in ('update','prepare') for c in rt.calls))
    def test_incomplete_registration_fails_before_images(self):
        rt=self.runtime()
        def incomplete(_):raise e.Failure('schema0412_registration_incomplete')
        rt.schema_context=incomplete
        with self.assertRaises(e.Failure):e.ReleaseEngine(rt).run(self.request())
        self.assertFalse(any(c[0] in ('update','prepare') for c in rt.calls))


if __name__=='__main__':unittest.main()
