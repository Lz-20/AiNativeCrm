"""Real PG15/17 protocol laboratory. Only new labelled, tmpfs-only fixtures.

No source URL/container, credential or SQL path arguments are accepted. Fixed
Git blobs are read, never checked out/executed by a privileged production host.
"""
import base64
import copy
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid

ROOT=Path(__file__).resolve().parents[2]
def module(name,path=None):
    spec=importlib.util.spec_from_file_location('fixture_'+name,path or ROOT/'deploy/staging'/(name+'.py'))
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
m=module('schema_0412');b=module('backup_verify');cp=module('catalog_policy')
NOW=dt.datetime.now(dt.timezone.utc).isoformat()
ORG='e4122222-0000-4000-8000-000000000001'
USER='e4122222-0000-4000-8000-000000000002'
CONTACT='e4122222-0000-4000-8000-000000000003'
SOURCE='e4122222-0000-4000-8000-000000000004'
VERSION='e4122222-0000-4000-8000-000000000005'
KEY='e4122222-0000-4000-8000-000000000006'


def git_blob(sha,path):return subprocess.check_output(['git','show',sha+':'+path],cwd=ROOT)


def command(args,data=None,timeout=180):
    result=subprocess.run(args,input=data,capture_output=True,timeout=timeout)
    if result.returncode:raise RuntimeError('isolated_command_failed_'+str(result.returncode)+':'+result.stderr.decode('utf8','replace')[-300:])
    return result.stdout


class Database:
    def __init__(self,major,compatibility=False):
        assert major in ('15','17')
        self.major=major;self.image='pgvector/pgvector:pg'+major
        self.name='ainativecrm-schema0412-'+uuid.uuid4().hex[:12];self.cid=None
        self.network=self.name+'-private' if compatibility else None
    def start(self):
        command(['docker','pull',self.image])
        image=json.loads(command(['docker','image','inspect',self.image]))[0]
        assert image['Os']=='linux'
        self.image_id=image['Id'];self.image_arch=image['Architecture'];self.repo_digests=image.get('RepoDigests',[])
        if self.network:command(['docker','network','create','--internal','--label','ainativecrm.schema0412='+self.name,self.network])
        network=['--network',self.network,'--network-alias','db'] if self.network else ['--network','none']
        self.cid=command(['docker','run','-d','--pull=never','--name',self.name,'--label','ainativecrm.schema0412='+self.name,
          *network,'--read-only','--memory','2g','--cpus','2','--pids-limit','256',
          '--security-opt','no-new-privileges:true','--log-driver','none',
          '--tmpfs','/tmp:rw,size=1200m,mode=1777','--tmpfs','/var/lib/postgresql/data:rw,size=1m',
          '--entrypoint','sleep',self.image,'infinity']).decode().strip()
        self.check()
        self.exec(['mkdir','/tmp/schema0412-socket'])
        self.exec(['initdb','-D','/tmp/schema0412-data','-U','postgres','--auth-local=trust','--auth-host='+('trust' if self.network else 'reject')])
        if self.network:
            self.exec(['sh','-c','cat >> /tmp/schema0412-data/pg_hba.conf'],b'host all all 0.0.0.0/0 trust\nhost all all ::/0 trust\n')
        listen='*' if self.network else ''
        self.exec(['pg_ctl','-D','/tmp/schema0412-data','-l','/tmp/postgres.log','-o',"-k /tmp/schema0412-socket -c listen_addresses='"+listen+"' -c wal_level=logical",'-w','start'])
        self.sql('CREATE DATABASE _supabase;')
    def check(self):
        row=json.loads(command(['docker','inspect',self.cid]))[0]
        assert row['Id']!=b.SOURCE_CONTAINER_ID and row['Name']=='/'+self.name
        assert row['Config']['Labels']['ainativecrm.schema0412']==self.name
        assert row['HostConfig']['NetworkMode']==(self.network or 'none') and not row['HostConfig'].get('PortBindings')
        if self.network:assert json.loads(command(['docker','network','inspect',self.network]))[0]['Internal'] is True
        assert row['HostConfig']['ReadonlyRootfs'] and all(x['Type']=='tmpfs' for x in row['Mounts'])
    def exec(self,args,data=None):
        return command(['docker','exec','-i','--user','postgres',self.cid,*args],data=data)
    def sql(self,text,database='postgres'):
        assert database in ('postgres','_supabase','schema0412_restore')
        return self.exec(['psql','-X','-qAt','-v','ON_ERROR_STOP=1','--no-password','-h','/tmp/schema0412-socket','-U','postgres','-d',database,'-f','-'],text.encode()).decode().strip()
    def json(self,query,database='postgres'):
        return json.loads(self.sql('BEGIN READ ONLY; SET LOCAL search_path=pg_catalog; '+query+'; ROLLBACK;',database))
    def close(self):
        if self.cid:self.check();command(['docker','rm','-f',self.cid]);self.cid=None
        if self.network:command(['docker','network','rm',self.network])


class Session:
    def __init__(self,db,name='postgres'):self.db,self.name=db,name
    def json(self,query):return self.db.json(query,self.name)


def catalog(db):return {name:b.catalog_metadata(Session(db,name)) for name in ('postgres','_supabase')}


def snapshot(db):
    value=catalog(db);topology=db.json(cp.INVENTORY_SQL)
    return value,topology,b.data_metadata(Session(db))


def init(db):
    harness=git_blob(m.FROM_SOURCE,'scripts/test-db.sh').decode()
    section=harness[harness.index('echo "==> prelude:'):]
    prelude=re.search(r"psql_install <<'SQL'\n([\s\S]*?)\nSQL\n",section)[1]
    assert prelude.count('create extension')>=3
    db.sql(prelude)
    db.sql(git_blob(m.FROM_SOURCE,'supabase/baseline.sql').decode())
    # Actual partitioned parent, no dynamic leaves in this migration fixture.
    # Native Realtime leaf invariants remain in catalog_isolated_test.py.
    db.sql("CREATE ROLE supabase_realtime_admin; CREATE ROLE dashboard_user; CREATE SCHEMA realtime AUTHORIZATION supabase_realtime_admin;")
    vendor=(ROOT/'tests/deployment/catalog_isolated_test.py').read_text(encoding='utf8')
    ddl=re.search(r'DDL = """([\s\S]*?)"""',vendor)[1]
    db.sql(ddl[ddl.index('CREATE TABLE realtime.messages'):])
    db.sql(f"""INSERT INTO auth.users(id,email) VALUES('{USER}','schema0412-manager@invariant.test');
      INSERT INTO public.organizations(id,slug,legal_name,display_name) VALUES('{ORG}','schema0412-org','Synthetic','Synthetic');
      INSERT INTO public.user_organizations(user_id,organization_id,role,accepted_at) VALUES('{USER}','{ORG}','manager',now());
      INSERT INTO public.contacts(id,organization_id,display_name) VALUES('{CONTACT}','{ORG}','SVC-101 synthetic contact');
      INSERT INTO public.ai_knowledge_sources(id,organization_id,source_type,name,status,is_active) VALUES('{SOURCE}','{ORG}','documento','SVC-101','ready',true);
      INSERT INTO public.ai_knowledge_versions(id,organization_id,knowledge_source_id,version_number,status,is_active,total_chunks,embedding_model,embedding_dims)
        VALUES('{VERSION}','{ORG}','{SOURCE}',1,'ready',true,1,'openai/text-embedding-3-small',1536);
      INSERT INTO public.ai_chunks(organization_id,knowledge_source_id,kb_version_id,position,content,content_hash,token_count,embedding)
        VALUES('{ORG}','{SOURCE}','{VERSION}',0,'SVC-101 synthetic legacy excerpt','synthetic',8,array_fill(0.1::real,array[1536])::vector);
      UPDATE public.ai_knowledge_sources SET active_kb_version_id='{VERSION}' WHERE id='{SOURCE}';""")


def reference_policy(before):
    fixture=json.loads((ROOT/'tests/deployment/fixtures/realtime_partition.json').read_text(encoding='utf8'))
    return {'format':1,'source_contract':cp.SOURCE_CONTRACT,'legacy_catalog_sha256':m.digest(before),
      'static_catalog_sha256':m.digest(before),'approved_at':NOW,'initial_partitions':[],'template_catalog':fixture['rows']}


def test_database(major,dest):
    db=Database(major);out=[]
    try:
        db.start();init(db)
        before,topology_before,data_before=snapshot(db);policy=reference_policy(before)
        cp.evaluate(before,topology_before,policy,NOW,cp.SOURCE_CONTRACT)
        migration=git_blob(m.REVIEWED_SOURCE,m.MIGRATION)
        assert m.raw_hash(migration)==m.MIGRATION_SHA256
        index_oid=db.sql("SELECT 'public.ai_chunks_embedding_ivfflat_idx'::regclass::oid")
        # The same fixed DDL fails inside a real transaction; connection close
        # rolls it back without a cleanup/down migration.
        try:db.sql('BEGIN; '+migration.decode()+'; SELECT 1/0; COMMIT;')
        except RuntimeError:pass
        else:raise AssertionError('fault_injection_did_not_fail')
        rolled,_,rolled_data=snapshot(db)
        assert rolled==before and rolled_data==data_before
        out.append('transaction_failure_rolls_back_ddl_and_preserves_data')
        db.sql('BEGIN; '+migration.decode()+'; COMMIT;')
        after,topology_after,data_after=snapshot(db)
        a=m.static_projection(before,topology_before,policy,NOW,cp.SOURCE_CONTRACT)
        z=m.static_projection(after,topology_after,policy,NOW,cp.SOURCE_CONTRACT)
        change=m.delta(a,z);m.check_delta_scope(change)
        approval={'delta':change,'delta_sha256':m.digest(change)}
        m.verify_change(a,z,approval)
        out.append('exact_0412_catalog_difference_only')
        db.sql(migration.decode())
        repeated,_,_=snapshot(db)
        assert repeated==after
        assert db.sql("SELECT 'public.ai_chunks_embedding_ivfflat_idx'::regclass::oid")==index_oid
        assert db.sql(f"SELECT count(*) FROM public.retrieve_top_k_chunks('{ORG}','{VERSION}',array_fill(0.1::real,array[1536])::vector,5,-1)")=='1'
        out.append('idempotent_and_old_1536_index_and_rpc_preserved')
        # Projection of the sole new nullable column is exact, not an exclusion
        # of the whole knowledge table or its row count.
        data_after['public.ai_knowledge_versions']=db.json("SELECT jsonb_build_object('count',count(*),'hash',md5(coalesce(string_agg(j,E'\\n' ORDER BY j),''))) FROM (SELECT (to_jsonb(t)-'embedding_profile')::text AS j FROM public.ai_knowledge_versions t) rows")
        m.verify_data(data_before,data_after);out.append('all_old_rows_unchanged_and_new_tables_empty')
        # Unauthorized DDL outside OR inside the approved names changes exact rows.
        hostile=["CREATE TABLE public.unapproved(id int)","CREATE TABLE auth.unapproved(id int)",
          "CREATE TABLE storage.unapproved(id int)","CREATE ROLE schema0412_unapproved SUPERUSER",
          "ALTER TABLE public.ai_embedding_chunks DISABLE ROW LEVEL SECURITY",
          "GRANT INSERT ON public.ai_embedding_chunks TO authenticated",
          "CREATE INDEX unapproved_idx ON public.ai_embedding_chunks(content_hash)",
          "CREATE FUNCTION public.unapproved_fn() RETURNS integer LANGUAGE sql AS 'SELECT 1'"]
        for i,sql in enumerate(hostile):
            # A savepoint is not shared across CLI connections; use a disposable
            # restored copy per case, never issue malicious DDL to a real source.
            db.sql('CREATE DATABASE schema0412_restore TEMPLATE postgres;')
            try:
                db.sql(sql,'schema0412_restore')
                altered={'postgres':b.catalog_metadata(Session(db,'schema0412_restore')),'_supabase':after['_supabase']}
                # Role DDL is cluster-wide; capture both copies and revert only
                # this fixture role before the next isolated case.
                if 'CREATE ROLE' in sql:altered['_supabase']=b.catalog_metadata(Session(db,'_supabase'))
                projected=m.static_projection(altered,db.json(cp.INVENTORY_SQL,'schema0412_restore'),policy,NOW,cp.SOURCE_CONTRACT)
                try:m.verify_change(a,projected,approval)
                except m.TransitionError:pass
                else:raise AssertionError('hostile_ddl_accepted_'+str(i))
            finally:
                db.sql('DROP DATABASE schema0412_restore WITH (FORCE);')
                if 'CREATE ROLE' in sql:db.sql('DROP ROLE schema0412_unapproved;')
        out.append('eight_hostile_catalog_changes_rejected')
        # New space uses real pgvector storage/RPC and real tenant role claims.
        fp='embedding:v1:'+'a'*64;newversion='e4122222-0000-4000-8000-000000000007'
        db.sql(f"""INSERT INTO public.ai_provider_credentials(id,organization_id,provider,label,api_key_encrypted,api_key_iv,api_key_tag,api_key_last4,is_active,validated_at)
          VALUES('{KEY}','{ORG}','siliconflow','Synthetic','\\x01','\\x02','\\x03','test',true,now());
          INSERT INTO public.ai_embedding_configurations(organization_id,provider,base_url,model,dimensions,model_revision,fingerprint,credential_id,enabled)
          VALUES('{ORG}','siliconflow','https://api.siliconflow.cn/v1','BAAI/bge-m3',1024,'1','{fp}','{KEY}',true);
          INSERT INTO public.ai_knowledge_versions(id,organization_id,knowledge_source_id,version_number,status,is_active,embedding_model,embedding_dims,embedding_profile)
          VALUES('{newversion}','{ORG}','{SOURCE}',2,'building',false,'{fp}',1024,'{{"fingerprint":"{fp}","dimensions":1024}}');
          INSERT INTO public.ai_embedding_chunks(organization_id,knowledge_source_id,kb_version_id,position,content,content_hash,token_count,embedding,embedding_dims,embedding_fingerprint)
          VALUES('{ORG}','{SOURCE}','{newversion}',0,'SVC-101 new synthetic space','new-synthetic',8,array_fill(0.1::real,array[1024])::vector,1024,'{fp}');
          UPDATE public.ai_knowledge_versions SET status='ready',total_chunks=1 WHERE id='{newversion}';
          SELECT public.fn_activate_embedding_version('{ORG}','{SOURCE}','{newversion}','{fp}');""")
        assert db.sql(f"SELECT count(*) FROM public.fn_search_knowledge_profile('{ORG}',array['{SOURCE}']::uuid[],array_fill(0.1::real,array[1024])::vector,'{fp}',1024,5,-1)")=='1'
        # Old RPC cannot accidentally read the new table/space after activation.
        assert db.sql(f"SELECT count(*) FROM public.fn_buscar_trechos_das_fontes('{ORG}',array['{SOURCE}']::uuid[],array_fill(0.1::real,array[1536])::vector,5,-1,'openai/text-embedding-3-small')")=='0'
        own=db.sql(f"SET ROLE authenticated; SELECT set_config('request.jwt.claims','{{\"sub\":\"{USER}\"}}',false); SELECT count(*) FROM public.ai_embedding_chunks WHERE organization_id='{ORG}';")
        foreign=db.sql(f"SET ROLE authenticated; SELECT set_config('request.jwt.claims','{{\"sub\":\"00000000-0000-4000-8000-000000000001\"}}',false); SELECT count(*) FROM public.ai_embedding_chunks WHERE organization_id='{ORG}';")
        assert own.splitlines()[-1]=='1' and foreign.splitlines()[-1]=='0'
        out.append('new_1024_rpc_and_cross_tenant_rls_and_old_space_exclusion')
        # Logical dump, actual restore, and restart of the disposable cluster.
        archive=db.exec(['pg_dump','-h','/tmp/schema0412-socket','-U','postgres','-Fc','postgres'])
        db.sql('CREATE DATABASE schema0412_restore;')
        db.exec(['pg_restore','-h','/tmp/schema0412-socket','-U','postgres','--exit-on-error','-d','schema0412_restore'],archive)
        restored=b.data_metadata(Session(db,'schema0412_restore'));current=b.data_metadata(Session(db))
        assert restored==current
        db.exec(['pg_ctl','-D','/tmp/schema0412-data','-m','fast','-w','restart'])
        assert b.data_metadata(Session(db,'schema0412_restore'))==current
        out.append('full_dump_restore_restart_data_equal')
        dest.mkdir(parents=True,exist_ok=True)
        (dest/('delta-pg'+major+'.json')).write_text(json.dumps(change,sort_keys=True,indent=2),encoding='utf8')
        return {'postgres_major':major,'postgres_image_id':db.image_id,'image_repo_digests':db.repo_digests,
          'architecture':db.image_arch,'source_schema':m.FROM_SCHEMA,'target_schema':m.TO_SCHEMA,
          'migration_sha256':m.MIGRATION_SHA256,'reviewed_source_sha':m.REVIEWED_SOURCE,
          'delta_sha256':m.digest(change),'passed':out,'failures':0,'live_source_accessed':False,'model_requests':0}
    finally:db.close()


if __name__=='__main__':
    major=os.environ.get('TEST_PG_MAJOR','17')
    result=test_database(major,ROOT/'schema-0412-evidence')
    (ROOT/'schema-0412-evidence'/('postgres'+major+'.json')).write_text(json.dumps(result,indent=2),encoding='utf8')
    print(json.dumps(result))
