"""Behavioral tests for the privileged, fixed-scope release controller."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
MODULE = ROOT / 'deploy/staging/engine.py'
spec = importlib.util.spec_from_file_location('staging_engine', MODULE) if MODULE.exists() else None
engine = importlib.util.module_from_spec(spec) if spec else None
if spec: spec.loader.exec_module(engine)

SHA = 'a' * 40
SCHEMA = 'b' * 64
DIGESTS = {name: 'sha256:' + char * 64 for name,char in zip(('app','worker','scheduler'), '123')}
REQUEST = {'operation':'deploy','trigger':'workflow_dispatch','sha':SHA,'schema_sha256':SCHEMA,'images':DIGESTS}
LEGACY = {'kind':'legacy','sha':None,'schema_sha256':SCHEMA,'images':{name:'sha256:'+char*64 for name,char in zip(('app','worker','scheduler'),'456')},'image_ids':{name:'sha256:'+char*64 for name,char in zip(('app','worker','scheduler'),'456')}}

class FakeRuntime:
    def __init__(self):
        self.state={'format_version':1,'approved_schema_sha256':SCHEMA,'approved_catalog_sha256':'c'*64,'current':copy.deepcopy(LEGACY),'previous':None,'pending':None,'rollback_verified':True,'auto_deploy_enabled':False}
        self.calls=[];self.events=[];self.paused=False;self.fail_service=None;self.fail_core=False;self.fail_rollback=False;self.catalog_ok=True;self.source_ok=True;self.backup_ok=True
    def load_state(self):return copy.deepcopy(self.state)
    def save_state(self,value):self.state=copy.deepcopy(value);self.calls.append(('save',bool(value.get('pending'))))
    def audit(self,event):self.events.append(copy.deepcopy(event))
    def status(self,state):return {'ok':True,'sha':state['current']['sha'],'schema_sha256':state['approved_schema_sha256'],'backup_verified':self.backup_ok,'rollback_verified':state['rollback_verified'],'auto_deploy_enabled':state['auto_deploy_enabled'],'paused':self.paused}
    def is_paused(self):return self.paused
    def verify_source(self,request,previous_sha):
        self.calls.append(('source',request['sha']))
        if not self.source_ok:raise engine.Failure('candidate_not_on_main')
        return request['schema_sha256']
    def ensure_backup(self,state):
        self.calls.append(('backup',))
        if not self.backup_ok:raise engine.Failure('backup_not_verified')
        if not self.catalog_ok:raise engine.Failure('database_catalog_drift')
        return {'restore_verified':True}
    def boundary(self):return {'protected':'same','supabase':'same','ports':'same','env':'same'}
    def verify_current(self,state,recovery=False):self.calls.append(('current',recovery))
    def prepare_images(self,release):
        self.calls.append(('prepare',release['kind']))
        return {name:'sha256:'+char*64 for name,char in zip(('app','worker','scheduler'),'789')} if release['kind']=='git' else release['image_ids']
    def update(self,service,release):
        self.calls.append(('update',service,release['kind']))
        if self.fail_rollback and release['kind']=='legacy':raise engine.Failure('rollback_update_failed')
    def wait_healthy(self,service,release):
        self.calls.append(('health',service,release['kind']))
        if self.fail_service==service and release['kind']=='git':raise engine.Failure('candidate_unhealthy')
    def core_probe(self):
        self.calls.append(('core',))
        if self.fail_core:
            self.fail_core=False
            raise engine.Failure('ordinary_core_read_failed')
        return {'readiness':True,'ordinary_user':True,'core_read_only':True}
    def verify_boundary(self,before):self.calls.append(('boundary',));return None

class EngineTests(unittest.TestCase):
    def setUp(self):self.assertIsNotNone(engine,'the staging release engine must exist');self.rt=FakeRuntime()
    def run_request(self,request=None):return engine.ReleaseEngine(self.rt).run(copy.deepcopy(request or REQUEST))
    def test_request_rejects_shell_digest_and_unknown_fields(self):
        for change in ({'sha':'main; id'}, {'images':{**DIGESTS,'app':'latest'}},{'compose':'/tmp/evil.yml'},{'operation':'exec'}):
            candidate=copy.deepcopy(REQUEST);candidate.update(change)
            with self.assertRaises(engine.Failure):engine.validate_request(candidate)
    def test_request_requires_exact_three_services_and_full_sha(self):
        for value in ({'app':DIGESTS['app']},{**DIGESTS,'db':DIGESTS['app']}):
            with self.assertRaises(engine.Failure):engine.validate_request({**REQUEST,'images':value})
        with self.assertRaises(engine.Failure):engine.validate_request({**REQUEST,'sha':'a'*7})
    def test_status_and_rollback_have_no_extra_fields(self):
        engine.validate_request({'operation':'status'})
        engine.validate_request({'operation':'rollback'})
        with self.assertRaises(engine.Failure):engine.validate_request({'operation':'rollback','sha':SHA})
    def test_schema_fingerprint_covers_exact_git_tree_bytes(self):
        source=b'100644 blob abc\tsupabase/baseline.sql\0'
        self.assertEqual(engine.schema_fingerprint(source),hashlib.sha256(source).hexdigest())
        self.assertNotEqual(engine.schema_fingerprint(source),engine.schema_fingerprint(source+b'new.sql\0'))
    def test_schema_change_stops_before_pull_or_container_write(self):
        with self.assertRaises(engine.Failure):self.run_request({**REQUEST,'schema_sha256':'d'*64})
        self.assertFalse(any(c[0] in ('prepare','update') for c in self.rt.calls))
    def test_failed_backup_or_catalog_blocks_every_container_update(self):
        for attribute in ('backup_ok','catalog_ok'):
            self.rt=FakeRuntime();setattr(self.rt,attribute,False)
            with self.assertRaises(engine.Failure):self.run_request()
            self.assertFalse(any(c[0]=='update' for c in self.rt.calls))
    def test_untrusted_commit_stops_before_pull(self):
        self.rt.source_ok=False
        with self.assertRaises(engine.Failure):self.run_request()
        self.assertFalse(any(c[0]=='prepare' for c in self.rt.calls))
    def test_paused_deploy_does_not_touch_images_or_services(self):
        self.rt.paused=True
        with self.assertRaises(engine.Failure):self.run_request()
        self.assertEqual(self.rt.calls,[])
    def test_push_requires_explicit_enable_and_verified_rollback(self):
        with self.assertRaises(engine.Failure):self.run_request({**REQUEST,'trigger':'push'})
        self.rt.state['auto_deploy_enabled']=True;self.rt.state['rollback_verified']=False
        with self.assertRaises(engine.Failure):self.run_request({**REQUEST,'trigger':'push'})
        self.assertFalse(any(c[0]=='update' for c in self.rt.calls))
    def test_success_updates_only_three_services_then_commits_release(self):
        result=self.run_request()
        self.assertTrue(result['ok']);self.assertEqual(self.rt.state['current']['sha'],SHA)
        self.assertEqual(result['images'],DIGESTS)
        self.assertEqual(self.rt.state['previous'],LEGACY);self.assertIsNone(self.rt.state['pending'])
        self.assertEqual([c[1] for c in self.rt.calls if c[0]=='update'],['app','worker','scheduler'])
        self.assertLess(self.rt.calls.index(('backup',)),self.rt.calls.index(('prepare','git')))
        self.assertEqual(self.rt.calls[4],('save',True))
    def test_any_candidate_health_failure_restores_all_three_old_images(self):
        self.rt.fail_service='worker'
        with self.assertRaises(engine.Failure) as caught:self.run_request()
        self.assertEqual(caught.exception.code,'deployment_failed_rolled_back')
        self.assertEqual(self.rt.state['current'],LEGACY);self.assertIsNone(self.rt.state['pending'])
        self.assertEqual([c[1] for c in self.rt.calls if c[0]=='update' and c[2]=='legacy'],['app','worker','scheduler'])
    def test_core_read_failure_is_failure_even_with_three_healthy_containers(self):
        self.rt.fail_core=True
        with self.assertRaises(engine.Failure) as caught:self.run_request()
        self.assertEqual(caught.exception.code,'deployment_failed_rolled_back')
        self.assertEqual(self.rt.state['current'],LEGACY)
    def test_failed_rollback_keeps_recovery_journal_and_refuses_next_deploy(self):
        self.rt.fail_service='app';self.rt.fail_rollback=True
        with self.assertRaises(engine.Failure) as caught:self.run_request()
        self.assertEqual(caught.exception.code,'deployment_failed_rollback_required')
        self.assertIsNotNone(self.rt.state['pending'])
        with self.assertRaises(engine.Failure):self.run_request()
    def test_manual_rollback_works_while_paused_and_never_changes_schema(self):
        self.run_request();self.rt.paused=True
        self.run_request({'operation':'rollback'})
        self.assertEqual(self.rt.state['current'],LEGACY)
        self.assertEqual(self.rt.state['approved_schema_sha256'],SCHEMA)
    def test_status_does_not_write_or_pull(self):
        result=self.run_request({'operation':'status'})
        self.assertIsNone(result['sha']);self.assertEqual(self.rt.calls,[])

    def test_source_rejects_stale_commit_even_if_still_on_main(self):
        runtime=object.__new__(engine.RootRuntime)
        calls=[]
        def git(*args):
            calls.append(args)
            if args[:2]==('config','--get'):return engine.REPOSITORY.encode()
            if args==('merge-base','--is-ancestor','f'*40,SHA):raise engine.Failure('source_verification_failed')
            return b''
        runtime.git=git
        with self.assertRaises(engine.Failure):runtime.verify_source(REQUEST,'f'*40)
        self.assertIn(('merge-base','--is-ancestor','f'*40,SHA),calls)
        self.assertFalse(any(c[0]=='ls-tree' for c in calls))

    def test_changed_then_reverted_schema_still_requires_approval(self):
        runtime=object.__new__(engine.RootRuntime)
        def git(*args):
            if args[:2]==('config','--get'):return engine.REPOSITORY.encode()
            if args[0]=='log':return b'supabase/migrations/0500-change.sql\x00'
            return b''
        runtime.git=git
        with self.assertRaises(engine.Failure) as caught:runtime.verify_source(REQUEST,'f'*40)
        self.assertEqual(caught.exception.code,'schema_history_requires_operator_approval')

    def test_public_release_has_digest_only_and_preserves_legacy_null_sha(self):
        self.assertEqual(engine.public_images(engine.git_release(REQUEST)),DIGESTS)
        self.assertEqual(engine.public_images(LEGACY),LEGACY['images'])

    def test_duplicate_json_keys_and_oversize_request_rejected(self):
        for raw in (b'{"operation":"status","operation":"rollback"}',b' '*4097):
            with self.assertRaises(engine.Failure):engine.decode_request(raw)

    def container_row(self):
        return {'Config':{'Labels':{'com.docker.compose.project':engine.PROJECT,'com.docker.compose.service':'app'}},
            'HostConfig':{'PortBindings':{'3000/tcp':[{'HostIp':'127.0.0.1','HostPort':'3100'}]},
                'Memory':1024**3,'NanoCpus':1500000000,'PidsLimit':256,
                'LogConfig':{'Type':'json-file','Config':{'max-size':'10m','max-file':'3'}},'SecurityOpt':['no-new-privileges:true']},
            'NetworkSettings':{'Networks':{engine.PROJECT+'_staging':{},engine.SUPABASE_PROJECT+'_default':{}}},
            'Image':LEGACY['image_ids']['app'],'Mounts':[]}

    def test_container_scope_rejects_public_ports_host_privileges_and_mounts(self):
        runtime=object.__new__(engine.RootRuntime)
        valid=self.container_row();runtime.validate_container(valid,'app',{valid['Image']})
        for field,value in [('Privileged',True),('NetworkMode','host'),('Binds',['/:/host']),('Devices',[{}]),('CapAdd',['SYS_ADMIN']),('PidMode','host'),('PortBindings',{'3000/tcp':[{'HostIp':'0.0.0.0','HostPort':'3100'}]})]:
            invalid=copy.deepcopy(valid);invalid['HostConfig'][field]=value
            with self.subTest(field=field),self.assertRaises(engine.Failure):runtime.validate_container(invalid,'app',{valid['Image']})
        for field,value in [('Image','sha256:'+'0'*64),('Mounts',[{'Source':'/var/run/docker.sock'}])]:
            invalid=copy.deepcopy(valid);invalid[field]=value
            with self.subTest(field=field),self.assertRaises(engine.Failure):runtime.validate_container(invalid,'app',{valid['Image']})

    def test_remote_images_require_arm64_source_labels_and_digest_binding(self):
        runtime=object.__new__(engine.RootRuntime)
        release=engine.git_release(REQUEST)
        def image(service):
            return {'Architecture':'arm64','Os':'linux','Id':'sha256:'+'7'*64,
                'RepoDigests':[release['images'][service]],'Config':{'Env':['NODE_ENV=production'],
                'Labels':{'org.opencontainers.image.revision':SHA,'org.opencontainers.image.source':engine.SOURCE_LABEL,'io.ainativecrm.schema-sha256':SCHEMA}}}
        altered=image('app')
        def docker(*args,**kwargs):
            if args[0]=='pull':return b''
            name=next(s for s in engine.SERVICES if 'ainativecrm-'+s+'@' in args[-1])
            return json.dumps([altered if name=='app' else image(name)]).encode()
        runtime.docker=docker
        runtime.prepare_images(release)
        for field,value in [('Architecture','amd64'),('RepoDigests',[]),('Config',{'Env':['SUPABASE_SERVICE_ROLE_KEY=fixture-secret']})]:
            altered=image('app');altered[field]=value
            with self.subTest(field=field),self.assertRaises(engine.Failure):runtime.prepare_images(release)

    def test_saved_release_never_accepts_third_party_namespace(self):
        release=engine.git_release(REQUEST);release['images']['app']='ghcr.io/other/app@'+DIGESTS['app']
        with self.assertRaises(engine.Failure):engine.validate_release(release,SCHEMA)

    def test_ssr_cookie_roundtrip_uses_named_chunks_and_ordinary_session(self):
        session={'access_token':'a'*6000,'refresh_token':'b'*100,'user':{'id':'fixture'}}
        cookie=engine.session_cookie(session,'11111111-1111-4111-8111-111111111111')
        parts=dict(part.split('=',1) for part in cookie.split('; '))
        self.assertIn('sb-pi-native-auth.0',parts)
        encoded=''.join(parts['sb-pi-native-auth.'+str(i)] for i in range(len(parts)-1))[7:]
        self.assertEqual(json.loads(engine.base64.urlsafe_b64decode(encoded+'='*(-len(encoded)%4))),session)

    def test_manual_recovery_recreates_missing_business_container(self):
        runtime=object.__new__(engine.RootRuntime)
        runtime.project_containers=lambda _: []
        runtime.verify_current(self.rt.state,recovery=True)
        with self.assertRaises(engine.Failure):runtime.verify_current(self.rt.state,recovery=False)
        unknown=self.container_row();unknown['Config']['Labels']['com.docker.compose.service']='db'
        runtime.project_containers=lambda _: [unknown]
        with self.assertRaises(engine.Failure):runtime.verify_current(self.rt.state,recovery=True)

    def test_recovery_allows_restoring_only_the_fixed_missing_loopback_listener(self):
        runtime=object.__new__(engine.RootRuntime)
        before={'listeners':[('tcp','0.0.0.0:22')],'supabase':'same'}
        after=copy.deepcopy(before);after['listeners'].append(('tcp','127.0.0.1:3100'))
        runtime.boundary=lambda:after
        runtime.verify_boundary(before)
        after['listeners'].append(('tcp','0.0.0.0:3100'))
        with self.assertRaises(engine.Failure):runtime.verify_boundary(before)

if __name__=='__main__':unittest.main()
