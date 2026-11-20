#!/usr/bin/env python3
"""Root-installed release controller. Never execute code from a candidate checkout.

The SSH principal supplies JSON, not shell commands or Compose configuration.
Only the three fixed CRM services may be replaced. Database restore is not a
rollback operation; schema changes require a separate operator approval.
"""
from __future__ import annotations
import base64
import copy
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

sys.dont_write_bytecode = True

SERVICES = ('app', 'worker', 'scheduler')
PROJECT = 'ainativecrm-staging'
SUPABASE_PROJECT = 'ainativecrm-staging-supabase'
REPOSITORY = 'https://github.com/Lz-20/AiNativeCrm.git'
SOURCE_LABEL = 'https://github.com/Lz-20/AiNativeCrm'
INSTALL = Path('/usr/local/libexec/ainativecrm-staging')
CONFIG = Path('/etc/ainativecrm-staging-deploy')
STATE = Path('/var/lib/ainativecrm-staging-deploy')
APP_ENV = Path('/home/ubuntu/apps/AiNativeCrm-staging/final-20261027/private/app.env')
COMPOSE = INSTALL / 'compose.release.yml'
DOCKER = '/usr/bin/docker'
GIT = '/usr/bin/git'
SHA_RE = re.compile(r'[a-f0-9]{40}')
HASH_RE = re.compile(r'[a-f0-9]{64}')
DIGEST_RE = re.compile(r'sha256:[a-f0-9]{64}')
UUID_RE = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}')
TRANSACTION_RE = re.compile(r'\d{8}T\d{6}Z-[a-f0-9]{12}')
HISTORY_MODULE_SHA256 = '08984f0165303689a1eb09c03a864d2433c199219f1dea9088cb2a59a16e4076'
FIXED_ENV = {'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','HOME':'/root','LANG':'C.UTF-8','DOCKER_CONFIG':'/root/.docker','GIT_TERMINAL_PROMPT':'0'}
CORE_PATHS = ('/api/v1/contacts?limit=20', '/api/v1/pipelines', '/api/v1/tasks')


class Failure(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def need(value, code):
    if not value: raise Failure(code)


def matches(pattern, value):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def utcnow(): return dt.datetime.now(dt.timezone.utc).isoformat()
def digest(raw): return hashlib.sha256(raw).hexdigest()
def schema_fingerprint(tree_bytes): return digest(tree_bytes)


def validate_request(value):
    need(type(value) is dict, 'request_object_required')
    operation = value.get('operation')
    need(operation in ('status','deploy','rollback','inspect'), 'operation_not_allowed')
    if operation == 'inspect':
        need(set(value) == {'operation','transaction'} and matches(TRANSACTION_RE,value['transaction']),
             'fixed_transaction_inspection_only')
        return value
    if operation != 'deploy':
        need(set(value) == {'operation'}, 'unexpected_request_fields')
        return value
    need(set(value) == {'operation','trigger','sha','schema_sha256','images'}, 'unexpected_request_fields')
    need(value['trigger'] in ('workflow_dispatch','push'), 'trigger_not_allowed')
    need(matches(SHA_RE,value['sha']), 'full_commit_sha_required')
    need(matches(HASH_RE,value['schema_sha256']), 'schema_fingerprint_required')
    need(type(value['images']) is dict and set(value['images']) == set(SERVICES), 'exact_three_images_required')
    need(all(matches(DIGEST_RE,d) for d in value['images'].values()), 'immutable_digests_required')
    return value


def decode_request(raw):
    need(isinstance(raw,bytes) and 0 < len(raw) <= 4096, 'request_size')
    def unique(pairs):
        value = {}
        for key,item in pairs:
            need(key not in value,'duplicate_json_key');value[key]=item
        return value
    try: value=json.loads(raw.decode('utf-8'),object_pairs_hook=unique)
    except (UnicodeError,ValueError): raise Failure('invalid_json') from None
    return validate_request(value)


def git_release(request):
    return {'kind':'git','sha':request['sha'],'schema_sha256':request['schema_sha256'],
      'images':{name:f'ghcr.io/lz-20/ainativecrm-{name}@{request["images"][name]}' for name in SERVICES}}


def public_images(release):
    return {name:ref.rsplit('@',1)[-1] for name,ref in release.get('images',{}).items()}


def validate_release(release, schema):
    need(type(release) is dict and release.get('kind') in ('git','legacy'),'invalid_saved_release')
    need(release.get('schema_sha256')==schema and matches(HASH_RE,schema),'saved_release_schema_mismatch')
    need(type(release.get('images')) is dict and set(release['images'])==set(SERVICES),'saved_release_services')
    if release['kind']=='legacy':
        need(release.get('sha') is None,'legacy_is_not_a_git_commit')
        need(all(matches(DIGEST_RE,v) for v in release['images'].values()),'legacy_local_image_ids')
    else:
        need(matches(SHA_RE,release.get('sha')),'saved_release_sha')
        for service,ref in release['images'].items():
            need(isinstance(ref,str) and re.fullmatch(r'ghcr\.io/lz-20/ainativecrm-'+service+r'@sha256:[a-f0-9]{64}',ref),'saved_image_namespace')
    if 'image_ids' in release:
        need(set(release['image_ids'])==set(SERVICES) and all(matches(DIGEST_RE,v) for v in release['image_ids'].values()),'saved_image_ids')


class ReleaseEngine:
    def __init__(self,runtime):self.rt=runtime

    def rollout(self,release):
        for service in SERVICES:
            getattr(self.rt,'history_stage',lambda _phase: None)('updating-'+service)
            self.rt.update(service,release)
            self.rt.wait_healthy(service,release)
            getattr(self.rt,'history_stage',lambda _phase: None)('healthy-'+service)
        health=self.rt.core_probe()
        getattr(self.rt,'history_stage',lambda _phase: None)('core-healthy')
        return health

    def run(self,request):
        validate_request(request)
        if request['operation'] in ('status','inspect'):return self._run(request)
        event={'operation':request['operation'],'sha':request.get('sha'),
               'images':request.get('images'),'at':utcnow()}
        self.rt.audit({**event,'phase':'requested'})
        try:return self._run(request)
        except BaseException as error:
            code=error.code if isinstance(error,Failure) else 'operation_interrupted_or_failed'
            self.rt.audit({**event,'phase':'request_failed','error':code,'at':utcnow()})
            raise

    def _run(self,request):
        state=self.rt.load_state()
        operation=request['operation']
        if operation=='status':return self.rt.status(state)
        if operation=='inspect':return self.rt.history_inspect(request)
        transition=getattr(self.rt,'schema_context',lambda _state: None)(state)
        schema=transition['database_schema'] if transition else state.get('approved_schema_sha256')
        def compatible(release):
            validate_release(release,release.get('schema_sha256') if transition else schema)
            if transition:self.rt.verify_application_compatibility(release,transition)
        compatible(state.get('current'))
        if operation=='deploy':
            need(not self.rt.is_paused(),'deployments_paused')
            need(not state.get('pending'),'unfinished_deployment_requires_rollback')
            need(state.get('rollback_verified') is True,'rollback_not_verified')
            need(request['trigger']!='push' or state.get('auto_deploy_enabled') is True,'automatic_deployment_disabled')
            need(request['schema_sha256']==schema,'schema_change_requires_operator_approval')
            previous_sha=state['current'].get('sha') or state.get('approved_source_sha')
            source_schema=self.rt.verify_source(request,previous_sha)
            need(source_schema==schema,'source_schema_change_requires_operator_approval')
            target=git_release(request)
        else:
            # Interrupted updates leave current at the last known successful release.
            target=copy.deepcopy(state['current'] if state.get('pending') else state.get('previous'))
            need(target is not None,'no_previous_release')
            compatible(target)
        getattr(self.rt,'history_preflight',lambda *_args: None)(state,request,target)
        backup_proof=self.rt.ensure_backup(state)
        self.rt.verify_current(state,recovery=operation=='rollback')
        before=self.rt.boundary()
        target['image_ids']=self.rt.prepare_images(target,use_cached=operation=='rollback')
        prior=copy.deepcopy(state['current'])
        txid=dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid.uuid4().hex[:12]
        getattr(self.rt,'history_prepare',lambda *_args: None)(state,request,target,prior,txid,backup_proof)
        state['pending']={'transaction':txid,'operation':operation,'target':target,'prior':prior,'started_at':utcnow()}
        self.rt.save_state(state)
        getattr(self.rt,'history_stage',lambda _phase: None)('started')
        self.rt.audit({'transaction':txid,'phase':'started','operation':operation,'sha':target['sha'],'images':target['images'],'at':utcnow()})
        try:
            health=self.rollout(target)
            self.rt.verify_boundary(before)
        except BaseException as error:
            code=error.code if isinstance(error,Failure) else 'operation_interrupted_or_failed'
            self.rt.audit({'transaction':txid,'phase':'failed','error':code,'at':utcnow()})
            try:
                if operation=='rollback':raise Failure('manual_rollback_failed')
                compatible(prior)
                self.rt.prepare_images(prior,use_cached=True)
                self.rollout(prior)
                self.rt.verify_boundary(before)
            except BaseException:
                self.rt.audit({'transaction':txid,'phase':'rollback_required','at':utcnow()})
                getattr(self.rt,'history_complete',lambda *_args: None)('rollback_required',state)
                raise Failure('deployment_failed_rollback_required') from None
            state['pending']=None
            self.rt.save_state(state)
            self.rt.audit({'transaction':txid,'phase':'rolled_back','sha':prior['sha'],'images':prior['images'],'at':utcnow()})
            getattr(self.rt,'history_complete',lambda *_args: None)('rolled_back',state)
            raise Failure('deployment_failed_rolled_back') from None
        state.update(current=target,previous=prior,pending=None,last_success_at=utcnow())
        self.rt.save_state(state)
        self.rt.audit({'transaction':txid,'phase':'succeeded','operation':operation,'sha':target['sha'],'images':target['images'],'at':utcnow()})
        getattr(self.rt,'history_complete',lambda *_args: None)('succeeded',state)
        return {'ok':True,'result':operation+'ed' if operation=='deploy' else 'rolled_back','sha':target['sha'],
                'schema_sha256':schema,'application_schema_sha256':target['schema_sha256'],
                'images':public_images(target),'health':health,'transaction':txid}


def secure_path(path, *, owner=0, mode=None, directory=False):
    need(path.is_absolute() and path.resolve()==path,'secure_path_no_symlink')
    info=path.lstat()
    need(info.st_uid==owner and not info.st_mode & 0o022,'trusted_path_owner_and_write_permissions')
    need(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode),'trusted_path_type')
    if mode is not None:need(stat.S_IMODE(info.st_mode)==mode,'trusted_path_exact_permissions')
    if not directory:need(info.st_nlink==1,'trusted_file_no_hardlinks')
    return info


def read_root_json(path):
    secure_path(path,mode=0o600)
    need(path.stat().st_size<=1024*1024,'bounded_configuration')
    return json.loads(path.read_text())


def atomic_json(path,value):
    secure_path(path.parent,mode=0o700,directory=True)
    if path.exists():secure_path(path,mode=0o600)
    temporary=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
    fd=os.open(temporary,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    with os.fdopen(fd,'w') as stream:
        json.dump(value,stream,sort_keys=True,indent=2);stream.write('\n');stream.flush();os.fsync(stream.fileno())
    temporary.replace(path)
    fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(fd)
    finally:os.close(fd)


def parse_environment(raw):
    need(b'\x00' not in raw and len(raw)<=128*1024,'protected_environment_size')
    result={}
    for line in raw.decode().splitlines():
        if not line.strip() or line.startswith('#'):continue
        key,sep,value=line.partition('=')
        need(sep and re.fullmatch('[A-Z][A-Z0-9_]*',key) and key not in result,'protected_environment_format')
        result[key]=value
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None


def session_cookie(session, organization):
    encoded='base64-'+base64.urlsafe_b64encode(json.dumps(session,separators=(',',':'),ensure_ascii=False).encode()).decode().rstrip('=')
    parts=[encoded[i:i+3180] for i in range(0,len(encoded),3180)]
    cookies=[('sb-pi-native-auth' if len(parts)==1 else 'sb-pi-native-auth.'+str(i))+'='+part for i,part in enumerate(parts)]
    need(matches(UUID_RE,organization),'probe_organization_uuid')
    return '; '.join(cookies+['active_org='+organization])


class RootRuntime:
    def __init__(self):
        need(hasattr(os,'geteuid') and os.geteuid()==0,'root_installed_entry_only')
        for path in (Path('/usr/local'),Path('/usr/local/libexec'),INSTALL,CONFIG,STATE):
            secure_path(path,directory=True)
        secure_path(CONFIG,mode=0o700,directory=True);secure_path(STATE,mode=0o700,directory=True)
        need(Path(__file__).resolve()==INSTALL/'engine.py','run_installed_engine_only')
        for name in ('engine.py','compose.release.yml','backup_verify.py'):
            secure_path(INSTALL/name)
        self.policy=read_root_json(CONFIG/'policy.json')
        need(self.policy.get('project')==PROJECT and self.policy.get('repository')==REPOSITORY,'fixed_project_repository')
        need(self.policy.get('system_identifier')=='7701258112182636578','fixed_staging_database')
        need(re.fullmatch('[a-f0-9]{64}',self.policy.get('db_container_id','')),'fixed_database_container')
        need(digest(COMPOSE.read_bytes())==self.policy.get('compose_sha256'),'operator_installed_compose_hash')
        self.mirror=STATE/'source.git'
        secure_path(self.mirror,directory=True)
        self.runtime_env=self.read_environment()
        self.http=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
        self._release_env=None

    def command(self,args,label,*,data=None,timeout=60):
        proc=subprocess.run(args,input=data,capture_output=True,timeout=timeout,env=FIXED_ENV)
        if proc.returncode:
            self.audit({'phase':'command_failed','operation':label,'exit_code':proc.returncode,
                        'stderr_bytes':len(proc.stderr),'stderr_sha256':digest(proc.stderr),'at':utcnow()})
            raise Failure(label)
        return proc.stdout

    def docker(self,*args,**kwargs):return self.command([DOCKER,*args],'docker_operation_failed',**kwargs)
    def git(self,*args):return self.command([GIT,'-c','core.hooksPath=/dev/null','-c','protocol.file.allow=never','--git-dir='+str(self.mirror),*args],'source_verification_failed',timeout=120)
    def load_state(self):return read_root_json(STATE/'state.json')
    def save_state(self,state):atomic_json(STATE/'state.json',state)
    def is_paused(self):return (STATE/'paused').exists()

    def history_module(self):
        path=INSTALL/'history_inspect.py'
        secure_path(path,mode=0o644)
        need(digest(path.read_bytes())==HISTORY_MODULE_SHA256,'installed_history_module_hash')
        spec=importlib.util.spec_from_file_location('installed_history_inspect',path)
        value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value)
        return value

    def history_inspect(self,request):return self.history_module().inspect(self,request)
    def history_preflight(self,state,request,target):
        if request['operation']=='deploy':
            need(self.git('rev-parse','refs/remotes/origin/main').decode().strip()==request['sha'],
                 'candidate_must_be_current_main')
        try:self.history_module().preflight(self,state,request,target)
        except ValueError:raise Failure('trusted_history_or_human_review_required') from None
    def history_prepare(self,*args):self.history_module().prepare(self,*args)
    def history_stage(self,phase):self.history_module().stage(self,phase)
    def history_complete(self,phase,state):self.history_module().complete(self,phase,state)

    def schema_context(self,state):
        marker=STATE/'schema-0412'/'journal.json'
        marker413=STATE/'schema-0413'/'journal.json'
        has413=marker413.exists() or marker413.is_symlink() or bool(state.get('schema_0413'))
        if not marker.exists() and not marker.is_symlink() and not state.get('schema_0412') and not has413:
            self._schema_transition=None;return None
        for name in ('schema_0412.py','catalog_policy.py'):secure_path(INSTALL/name)
        def load(name):
            spec=importlib.util.spec_from_file_location('installed_'+name,INSTALL/(name+'.py'))
            value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
        self._schema_module=load('schema_0412');cp=load('catalog_policy')
        try:
            secure_path(CONFIG/'catalog-policy.json',mode=0o600)
            policy=cp.parse_policy((CONFIG/'catalog-policy.json').read_bytes())
            cp.validate_policy(policy,state['approved_catalog_sha256'])
            context=self._schema_module.read_context(state,policy,cp)
            if has413:
                secure_path(INSTALL/'schema_0413.py')
                self._schema_module=load('schema_0413')
                context=self._schema_module.read_context(state,policy,cp)
        except (self._schema_module.TransitionError,cp.CatalogError) as error:raise Failure(error.code) from None
        self._schema_transition=context;return context

    def verify_application_compatibility(self,release,context):
        # No automatic data/pointer rewrite when reverting an application image.
        in_use=False
        if release.get('schema_sha256')==self._schema_module.FROM_SCHEMA:
            query="SELECT EXISTS(SELECT 1 FROM public.ai_embedding_configurations WHERE enabled) OR EXISTS(SELECT 1 FROM public.ai_knowledge_sources s JOIN public.ai_knowledge_versions v ON v.id=s.active_kb_version_id AND v.organization_id=s.organization_id WHERE v.embedding_profile IS NOT NULL);"
            if context.get('database_schema')=='37974846957f850f051b020f23493586ce49631aacc66a04bbdbb93b8f708fa3':
                query="SELECT EXISTS(SELECT 1 FROM public.ai_embedding_configurations WHERE enabled) OR EXISTS(SELECT 1 FROM public.ai_embedding_operations WHERE status='running') OR EXISTS(SELECT 1 FROM public.ai_embedding_requests WHERE status IN ('reserved','unknown'));"
            result=self.docker('exec',self.policy['db_container_id'],'psql','-X','-qAt','--no-password',
                '-v','ON_ERROR_STOP=1','-U','supabase_admin','-d','postgres','-c',
                'BEGIN READ ONLY; SET LOCAL statement_timeout=\'10s\'; '+query+' ROLLBACK;')
            need(result.strip() in (b't',b'f'),'schema0412_profile_usage_probe');in_use=result.strip()==b't'
        try:self._schema_module.validate_release(release,context,old_profile_in_use=in_use)
        except self._schema_module.TransitionError as error:raise Failure(error.code) from None

    def audit(self,event):
        path=STATE/'deployments.jsonl'
        if path.exists():secure_path(path,mode=0o600)
        fd=os.open(path,os.O_WRONLY|os.O_APPEND|os.O_CREAT|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'w') as stream:stream.write(json.dumps(event,sort_keys=True)+'\n');stream.flush();os.fsync(stream.fileno())

    def read_environment(self):
        info=APP_ENV.lstat()
        need(APP_ENV.resolve()==APP_ENV and stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode)==0o600
             and info.st_uid in (0,1001) and info.st_nlink==1,'protected_runtime_environment')
        parent=APP_ENV.parent.lstat()
        need(stat.S_IMODE(parent.st_mode)==0o700 and parent.st_uid==info.st_uid,'protected_runtime_directory')
        values=parse_environment(APP_ENV.read_bytes())
        need(values.get('NEXT_PUBLIC_SUPABASE_URL')=='http://localhost:8000' and values.get('SUPABASE_INTERNAL_URL')=='http://api-gw:8000','fixed_staging_supabase_endpoints')
        need(bool(values.get('NEXT_PUBLIC_SUPABASE_ANON_KEY')) and bool(values.get('INTERNAL_SECRET')),'required_runtime_configuration')
        return values

    def backup(self,state):
        proof=read_root_json(STATE/'backup-attestation.json')
        try:when=dt.datetime.fromisoformat(proof['verified_at'])
        except (ValueError,KeyError,TypeError):raise Failure('invalid_backup_timestamp') from None
        need(when.tzinfo is not None,'backup_timestamp_timezone')
        age=(dt.datetime.now(dt.timezone.utc)-when).total_seconds()
        need(0<=age<=86400,'fresh_verified_backup_required')
        need(proof.get('restore_verified') is True and proof.get('differences')==0,'backup_restore_not_verified')
        need(proof.get('source_system_identifier')==self.policy['system_identifier'] and proof.get('source_database')=='postgres','backup_source_identity')
        need(matches(HASH_RE,state.get('approved_catalog_sha256')),'database_catalog_drift')
        directory=Path(proof.get('backup_directory',''))
        need(directory.is_absolute() and directory.parent==STATE/'backups','fixed_backup_directory')
        secure_path(directory,mode=0o700,directory=True)
        need(matches(HASH_RE,proof.get('evidence_sha256')),'backup_evidence_hash')
        evidence_path=directory/'evidence.json'
        secure_path(evidence_path,mode=0o600)
        need(digest(evidence_path.read_bytes())==proof['evidence_sha256'],'backup_evidence_integrity')
        catalog_policy = CONFIG/'catalog-policy.json'
        if catalog_policy.exists() or catalog_policy.is_symlink():
            self.verify_catalog_policy(proof, state, directory, catalog_policy)
        else:
            # Existing installations stay strict; no policy is generated automatically.
            need(proof.get('source_catalog_sha256')==state['approved_catalog_sha256'],'database_catalog_drift')
        return proof

    def verify_catalog_policy(self,proof,state,directory,policy_path):
        secure_path(INSTALL/'catalog_policy.py')
        spec=importlib.util.spec_from_file_location('installed_catalog_policy',INSTALL/'catalog_policy.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        secure_path(policy_path,mode=0o600)
        need(policy_path.stat().st_size<=1024*1024,'catalog_policy_size')
        try:
            policy=module.parse_policy(policy_path.read_bytes())
            module.validate_policy(policy,state['approved_catalog_sha256'])
        except module.CatalogError as error:raise Failure(error.code) from None
        transition=self.schema_context(state)
        if transition:policy=transition['policy']
        need(proof.get('catalog_policy_sha256')==module.digest(policy),'catalog_policy_proof_version')
        evidence=json.loads((directory/'evidence.json').read_bytes())
        need(all(evidence.get(k) is True for k in ('restore_verified','restart_verified','storage_verified'))
             and evidence.get('differences')==0,'backup_restore_not_verified')
        files=evidence.get('files');need(isinstance(files,list),'backup_evidence_inventory')
        def read_evidence(name):
            # Fixed names, bounded root-owned files; no request-supplied path or SQL.
            path=directory/name;secure_path(path,mode=0o600)
            need(path.stat().st_size<=16*1024*1024,'catalog_evidence_size')
            entries=[row for row in files if row.get('file')==name]
            raw=path.read_bytes()
            need(len(entries)==1 and entries[0].get('sha256')==digest(raw)
                 and entries[0].get('bytes')==len(raw),'catalog_evidence_integrity')
            return json.loads(raw)
        catalog=read_evidence('catalog-source.json');topology=read_evidence('partition-source.json')
        observed=proof.get('partition_validation')
        need(isinstance(observed,dict) and observed==evidence.get('partition_validation')
             and observed.get('observed_at')==evidence.get('started_at'),'partition_proof_integrity')
        try:
            actual=module.evaluate(catalog,topology,policy,observed.get('observed_at'),observed.get('source_contract'),
                                   observed.get('previous_partition_names'))
        except module.CatalogError as error:raise Failure(error.code) from None
        need(actual==observed and actual['raw_catalog_sha256']==proof.get('source_catalog_sha256')
             and actual['static_catalog_sha256']==proof.get('static_catalog_sha256'),'partition_proof_recalculation')

    def status(self,state):
        valid=False
        try:self.backup(state);valid=True
        except (Failure,OSError,ValueError):pass
        current=state.get('current',{})
        transition=self.schema_context(state)
        return {'ok':True,'project':PROJECT,'sha':current.get('sha'),
                'schema_sha256':transition['database_schema'] if transition else state.get('approved_schema_sha256'),
                'application_schema_sha256':current.get('schema_sha256'),
                'images':public_images(current),'backup_verified':valid,'rollback_verified':state.get('rollback_verified') is True,
                'auto_deploy_enabled':state.get('auto_deploy_enabled') is True,'paused':self.is_paused(),
                'recovery_required':bool(state.get('pending'))}

    def ensure_backup(self,state):
        # No SSH-supplied arguments, executable paths or shell fragments reach the hook.
        started=dt.datetime.now(dt.timezone.utc)
        self.command(['/usr/bin/python3',str(INSTALL/'backup_verify.py')],'fresh_backup_restore_verification_failed',timeout=1800)
        proof=self.backup(state)
        need(dt.datetime.fromisoformat(proof['verified_at'])>=started,'backup_hook_must_publish_new_verification')
        current=json.loads(self.command(['/usr/bin/python3',str(INSTALL/'backup_verify.py'),'--identity-readonly'],'live_database_identity_failed',timeout=120))
        need(current.get('source_system_identifier')==proof['source_system_identifier'] and current.get('source_catalog_sha256')==proof['source_catalog_sha256'],'database_catalog_changed_after_backup')
        if proof.get('catalog_policy_sha256'):
            need(current.get('catalog_policy_sha256')==proof['catalog_policy_sha256']
                 and current.get('static_catalog_sha256')==proof['static_catalog_sha256'],'live_catalog_policy_changed')
            self.audit({'phase':'catalog_policy_verified','catalog_policy_sha256':proof['catalog_policy_sha256'],
                        'static_catalog_sha256':proof['static_catalog_sha256'],
                        'raw_catalog_sha256':proof['source_catalog_sha256'],
                        'partition_count':len(proof['partition_validation']['partition_names']),'at':utcnow()})
        return proof

    def verify_source(self,request,previous_sha):
        need(self.git('config','--get','remote.origin.url').decode().strip()==REPOSITORY,'fixed_git_origin')
        self.git('fetch','--no-tags','origin','+refs/heads/main:refs/remotes/origin/main')
        sha=request['sha'];self.git('cat-file','-e',sha+'^{commit}')
        self.git('merge-base','--is-ancestor',sha,'refs/remotes/origin/main')
        need(matches(SHA_RE,previous_sha),'operator_registered_source_baseline_required')
        self.git('merge-base','--is-ancestor',previous_sha,sha)
        # Inspect the entire release interval, including schema changes later reverted.
        changes=self.git('log','--format=','--name-only','-z',previous_sha+'..'+sha,'--','supabase','lib/database.types.ts',':(glob)**/*.sql')
        if changes.strip(b'\x00\r\n '):
            transition=getattr(self,'_schema_transition',None)
            need(transition is not None and request['schema_sha256']==self._schema_module.TO_SCHEMA,
                 'schema_history_requires_operator_approval')
            paths={p.strip('\r\n ') for p in changes.decode().split('\x00') if p.strip('\r\n ')}
            need(paths<=self._schema_module.SCHEMA_PATHS,'schema0412_source_history_scope')
            self.git('merge-base','--is-ancestor',self._schema_module.REVIEWED_SOURCE,sha)
        raw=self.git('ls-tree','-r','-z','--full-tree',sha,'--','supabase','lib/database.types.ts')
        need(b'supabase/baseline.sql\x00' in raw and b'lib/database.types.ts\x00' in raw,'source_schema_inventory_present')
        actual=schema_fingerprint(raw)
        need(actual==request['schema_sha256'],'request_schema_does_not_match_commit')
        guard=getattr(getattr(self,'_schema_module',None),'validate_budget_source',None)
        if guard:
            try:guard(sha,lambda revision,path:self.git('show',revision+':'+path))
            except self._schema_module.TransitionError as error:raise Failure(error.code) from None
        return actual

    def inspect(self,ids):
        if not ids:return []
        return json.loads(self.docker('inspect',*ids))

    def project_containers(self,project):
        ids=self.docker('ps','-aq','--no-trunc','--filter','label=com.docker.compose.project='+project).decode().split()
        return self.inspect(ids)

    def validate_container(self,row,service,allowed_image_ids):
        labels=row['Config'].get('Labels',{});host=row['HostConfig']
        need(labels.get('com.docker.compose.project')==PROJECT and labels.get('com.docker.compose.service')==service,'container_project_identity')
        need(row['Image'] in allowed_image_ids,'container_image_identity')
        need(not row['Mounts'] and not host.get('Binds') and not host.get('Devices') and not host.get('CapAdd')
             and not host.get('Privileged') and host.get('NetworkMode')!='host' and not host.get('PidMode')
             and not host.get('UTSMode'),'no_host_privileges_or_data_mounts')
        allowed={PROJECT+'_staging'}|({SUPABASE_PROJECT+'_default'} if service!='scheduler' else set())
        need(set(row['NetworkSettings']['Networks'])==allowed,'fixed_service_networks')
        expected={'3000/tcp':[{'HostIp':'127.0.0.1','HostPort':'3100'}]} if service=='app' else {}
        need((host.get('PortBindings') or {})==expected,'only_loopback_app_publication')
        limit={'app':(1024**3,1500000000,256),'worker':(768*1024**2,1000000000,256),'scheduler':(128*1024**2,250000000,128)}[service]
        need((host.get('Memory'),host.get('NanoCpus'),host.get('PidsLimit'))==limit,'fixed_resource_limits')
        need(host.get('LogConfig')=={'Type':'json-file','Config':{'max-size':'10m','max-file':'3'}},'bounded_container_logs')
        if service!='scheduler':need('no-new-privileges:true' in host.get('SecurityOpt',[]),'no_new_privileges')

    def verify_current(self,state,recovery=False):
        rows=self.project_containers(PROJECT)
        names=[r['Config']['Labels'].get('com.docker.compose.service') for r in rows]
        if recovery:
            # A failed create may leave a missing service. Existing containers
            # still undergo every scope check; recovery may recreate only these.
            need(len(names)==len(set(names)) and set(names)<=set(SERVICES),'only_known_crm_containers_during_recovery')
        else:need(len(rows)==3 and set(names)==set(SERVICES),'exact_three_crm_containers')
        releases=[state['current']]
        if recovery and state.get('pending'):releases.append(state['pending']['target'])
        for row in rows:
            service=row['Config']['Labels']['com.docker.compose.service']
            allowed={r['image_ids'][service] for r in releases}
            self.validate_container(row,service,allowed)
            if not recovery:need(row['State']['Running'] and row['State'].get('Health',{}).get('Status')=='healthy','current_release_not_healthy')

    def boundary(self):
        services={}
        for name in ('x-ui','wg-quick@wg0','1panel'):
            text=self.command(['/usr/bin/systemctl','show',name,'--property=ActiveState,SubState,MainPID,ActiveEnterTimestampMonotonic'],'protected_service_read').decode()
            row=dict(line.split('=',1) for line in text.splitlines() if '=' in line)
            need(row.get('ActiveState')=='active','protected_service_not_active');services[name]=row
        supa=self.project_containers(SUPABASE_PROJECT)
        need(len(supa)==11 and all(r['State']['Running'] and r['State'].get('Health',{}).get('Status')=='healthy' for r in supa),'supabase_eleven_healthy')
        need(any(r['Id']==self.policy['db_container_id'] and r['Config']['Labels'].get('com.docker.compose.service')=='db' for r in supa),'fixed_database_container')
        containers={r['Id']:{'image':r['Image'],'started':r['State']['StartedAt'],'pid':r['State']['Pid'],'mounts':r['Mounts'],'ports':r['HostConfig'].get('PortBindings')} for r in supa}
        sockets=set()
        for line in self.command(['/usr/bin/ss','-H','-lntu'],'listener_inventory').decode().splitlines():
            parts=line.split();need(len(parts)>=6,'listener_format');sockets.add((parts[0],parts[4]))
        return {'protected_services':services,'supabase':containers,'listeners':sorted(sockets),'environment_sha256':digest(APP_ENV.read_bytes())}

    def verify_boundary(self,before):
        after=self.boundary()
        before=copy.deepcopy(before)
        # Recovery of a stopped app restores this sole authorized listener.
        # validate_container and readiness independently require its exact bind.
        for item in (before,after):
            item['listeners']=[p for p in item['listeners'] if tuple(p)!=('tcp','127.0.0.1:3100')]
        need(after==before,'protected_services_supabase_ports_or_env_changed')

    def prepare_images(self,release,use_cached=False):
        validate_release(release,release['schema_sha256'])
        images={}
        for service in SERVICES:
            ref=release['images'][service]
            row=None
            if release['kind']=='git' and use_cached:
                need('image_ids' in release,'recovery_requires_recorded_image_ids')
                try:row=json.loads(self.docker('image','inspect',release['image_ids'][service]))[0]
                except Failure:pass  # A missing cache may be fetched by its fixed digest.
            if row is None:
                if release['kind']=='git':self.docker('pull','--platform','linux/arm64',ref,timeout=900)
                row=json.loads(self.docker('image','inspect',ref))[0]
            if use_cached and release.get('image_ids'):
                need(row['Id']==release['image_ids'][service],'cached_recovery_image_identity')
            need(row.get('Architecture')=='arm64' and row.get('Os')=='linux','image_must_be_native_linux_arm64')
            need(not row.get('Config',{}).get('Volumes'),'image_declares_unreviewed_volumes')
            for item in row.get('Config',{}).get('Env',[]):
                key,_,value=item.partition('=')
                need(not value or not re.search(r'SECRET|PASSWORD|TOKEN|API_KEY|SERVICE_ROLE|ENCRYPTION_KEY|CRED_AES_KEY|SUPABASE_DB_URL',key),'image_contains_privileged_configuration')
            if release['kind']=='git':
                need(ref in (row.get('RepoDigests') or []),'pulled_digest_binding')
                labels=row['Config'].get('Labels') or {}
                need(labels.get('org.opencontainers.image.revision')==release['sha'] and labels.get('org.opencontainers.image.source')==SOURCE_LABEL
                     and labels.get('io.ainativecrm.schema-sha256')==release['schema_sha256'],'image_source_and_schema_labels')
            else:need(row['Id']==ref,'legacy_image_id_preserved')
            images[service]=row['Id']
        if release.get('image_ids'):need(images==release['image_ids'],'saved_image_ids_unchanged')
        return images

    def compose_args(self,release):
        values={name.upper()+'_IMAGE':release['images'][name] for name in SERVICES}
        env_path=STATE/'release.env'
        if env_path.exists():secure_path(env_path,mode=0o600)
        temporary=STATE/('release.'+uuid.uuid4().hex+'.tmp')
        fd=os.open(temporary,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
        with os.fdopen(fd,'w') as stream:
            stream.write(''.join(k+'='+v+'\n' for k,v in values.items()));stream.flush();os.fsync(stream.fileno())
        temporary.replace(env_path)
        return [DOCKER,'compose','-p',PROJECT,'--project-directory',str(INSTALL),'-f',str(COMPOSE),
                '--env-file',str(APP_ENV),'--env-file',str(env_path)]

    def update(self,service,release):
        need(service in SERVICES,'only_business_service_update')
        need(digest(COMPOSE.read_bytes())==self.policy['compose_sha256'],'fixed_compose_unchanged')
        self.command(self.compose_args(release)+['up','-d','--no-build','--pull','never','--no-deps',service],'single_service_update_failed',timeout=180)

    def wait_healthy(self,service,release):
        deadline=time.monotonic()+180
        while time.monotonic()<deadline:
            rows=[r for r in self.project_containers(PROJECT) if r['Config']['Labels'].get('com.docker.compose.service')==service]
            need(len(rows)==1,'one_updated_service')
            row=rows[0];self.validate_container(row,service,{release['image_ids'][service]})
            state=row['State'];health=state.get('Health',{}).get('Status')
            need(state['Running'] and health!='unhealthy' and not state.get('OOMKilled'),'updated_service_failed')
            if health=='healthy':
                if service=='app':self.readiness()
                if service=='worker':
                    js="const http=require('http');http.get('http://127.0.0.1:8787/healthz',r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>{try{const j=JSON.parse(b);process.exit(r.statusCode===200&&j.db==='ok'&&j.event_log_drain?.carregado===true?0:1)}catch{process.exit(1)}})}).on('error',()=>process.exit(1));"
                    self.docker('exec',row['Id'],'node','-e',js,timeout=20)
                return
            time.sleep(3)
        raise Failure('container_health_timeout')

    def http_request(self,url,*,headers=None,method='GET',body=None,json_body=True):
        request=urllib.request.Request(url,data=None if body is None else json.dumps(body).encode(),headers=headers or {},method=method)
        try:
            with self.http.open(request,timeout=20) as response:
                raw=response.read(2*1024*1024+1)
                need(response.status==200 and len(raw)<=2*1024*1024,'http_probe_failed')
        except (urllib.error.URLError,OSError):raise Failure('http_probe_failed') from None
        if not json_body:return raw
        try:return json.loads(raw)
        except (ValueError,UnicodeError):raise Failure('http_probe_invalid_json') from None

    def readiness(self):
        response=self.http_request('http://127.0.0.1:3100/api/v1/health')
        need(type(response) is dict and 'error' not in response and type(response.get('data')) is dict,'app_readiness_response_shape')
        result=response['data']
        checks=result.get('checks')
        need(type(checks) is dict and type(checks.get('supabase')) is dict,'app_readiness_response_shape')
        need(checks['supabase'].get('status')=='ok','supabase_readiness_failed')
        need(result.get('status') in ('healthy','degraded'),'app_readiness_failed')
        return {'http_status':200,'supabase':'ok','status':result['status']}

    def core_probe(self):
        readiness=self.readiness()
        values=self.read_environment()
        html=self.http_request('http://127.0.0.1:3100/login',json_body=False).decode('utf-8')
        found=re.search(r'window\.__PUBLIC_ENV__=(\{.*?\});',html)
        need(found is not None,'public_runtime_configuration_missing')
        public=json.loads(found.group(1))
        need(public.get('NEXT_PUBLIC_SUPABASE_URL')==values['NEXT_PUBLIC_SUPABASE_URL'] and public.get('NEXT_PUBLIC_SUPABASE_ANON_KEY')==values['NEXT_PUBLIC_SUPABASE_ANON_KEY'],'browser_supabase_runtime_configuration_mismatch')
        for key,value in values.items():
            if value and not key.startswith('NEXT_PUBLIC_') and re.search(r'SECRET|PASSWORD|TOKEN|SERVICE_ROLE|ENCRYPTION_KEY|CRED_AES_KEY|SUPABASE_DB_URL',key):
                need(value not in html,'server_secret_exposed_in_html')
        credentials=read_root_json(CONFIG/'probe-credentials.json')
        need(set(credentials)=={'email','password','user_id','organization_id','contact_id'},'ordinary_probe_configuration')
        need(all(matches(UUID_RE,credentials[k]) for k in ('user_id','organization_id','contact_id')),'ordinary_probe_identifiers')
        public_key=values['NEXT_PUBLIC_SUPABASE_ANON_KEY']
        headers={'apikey':public_key,'Content-Type':'application/json'}
        session=self.http_request('http://127.0.0.1:8000/auth/v1/token?grant_type=password',headers=headers,method='POST',body={'email':credentials['email'],'password':credentials['password']})
        if 'expires_at' not in session and type(session.get('expires_in')) is int:
            session['expires_at']=int(time.time())+session['expires_in']
        need(session.get('user',{}).get('id')==credentials['user_id'],'ordinary_probe_user_identity')
        token=session.get('access_token')
        need(isinstance(token,str) and len(token.split('.'))==3,'ordinary_auth_access_token')
        payload=json.loads(base64.urlsafe_b64decode(token.split('.')[1]+'='*(-len(token.split('.')[1])%4)))
        need(payload.get('role')=='authenticated' and payload.get('sub')==credentials['user_id'],'ordinary_probe_must_not_bypass_rls')
        user_headers={**headers,'Authorization':'Bearer '+token}
        checks=[]
        try:
            pa=self.http_request('http://127.0.0.1:8000/rest/v1/platform_admins?select=user_id&user_id=eq.'+credentials['user_id']+'&revoked_at=is.null',headers=user_headers)
            need(pa==[],'probe_must_not_be_platform_admin')
            role=self.http_request('http://127.0.0.1:8000/rest/v1/rpc/fn_user_role_in_org',headers=user_headers,method='POST',body={'p_org':credentials['organization_id']})
            need(role=='manager','ordinary_probe_manager_role')
            cookie=session_cookie(session,credentials['organization_id'])
            for path in CORE_PATHS:
                data=self.http_request('http://127.0.0.1:3100'+path,headers={'Cookie':cookie,'Accept':'application/json'})
                need(type(data) is dict and 'data' in data and 'error' not in data,'core_read_response_failed')
                checks.append({'path':path,'http_status':200})
            # A growing contact list may push the fixture off its first page.
            path='/api/v1/contacts/'+credentials['contact_id']
            data=self.http_request('http://127.0.0.1:3100'+path,headers={'Cookie':cookie,'Accept':'application/json'})
            contact=data.get('data',{})
            need(type(contact) is dict and contact.get('id')==credentials['contact_id'] and
                 contact.get('organization_id')==credentials['organization_id'],'ordinary_contact_fixture_missing')
            checks.append({'path':'/api/v1/contacts/{fixture_id}','http_status':200})
        finally:
            # Auth sessions are closed; the business probes above only perform GETs.
            req=urllib.request.Request('http://127.0.0.1:8000/auth/v1/logout?scope=local',headers=user_headers,method='POST')
            try:
                with self.http.open(req,timeout=15) as response:need(response.status in (200,204),'probe_logout_failed')
            except (urllib.error.URLError,OSError):raise Failure('probe_logout_failed') from None
        return {'readiness':readiness,'public_runtime_configuration':True,'ordinary_user':True,'core_read_only':True,'checks':checks}


def main():
    need(len(sys.argv)==1,'entry_accepts_json_stdin_only')
    def interrupted(signum,frame):raise Failure('interrupted_signal_'+str(signum))
    for sig in (signal.SIGINT,signal.SIGTERM,signal.SIGHUP,signal.SIGALRM):signal.signal(sig,interrupted)
    signal.alarm(15)
    try:request=decode_request(sys.stdin.buffer.read(4097))
    finally:signal.alarm(0)
    runtime=RootRuntime()
    if request['operation']=='inspect':
        # The read-only module uses existing, O_RDONLY/non-creating lock files;
        # it reports held/unknown rather than pretending the remote was stopped.
        print(json.dumps(runtime.history_inspect(request),sort_keys=True))
        return
    import fcntl
    lock=STATE/'deployment.lock'
    if lock.exists():secure_path(lock,mode=0o600)
    descriptor=os.open(lock,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    try:
        try:fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise Failure('another_deployment_is_running') from None
        result=ReleaseEngine(runtime).run(request)
        print(json.dumps(result,sort_keys=True))
    finally:os.close(descriptor)


if __name__=='__main__':
    os.umask(0o077)
    try:main()
    except BaseException as error:
        code=error.code if isinstance(error,Failure) else 'deployment_failed_details_redacted'
        print(json.dumps({'ok':False,'error':code,'details_redacted':True}));sys.exit(1)
