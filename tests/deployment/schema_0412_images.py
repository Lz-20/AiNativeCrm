"""Immutable c5919aa and freshly built 6c66153 images on an isolated expanded DB.

Real App/Worker/Scheduler, PostgREST, pgvector and tenant RLS. The tiny Auth
identity endpoint is a synthetic, HMAC-checked fixture (not a GoTrue acceptance).
All containers share an internal-only network; no model/customer egress exists.
"""
import base64
import hashlib
import hmac
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import time

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('schema0412_pg_fixture',HERE/'schema_0412_isolated.py')
pg=importlib.util.module_from_spec(spec);spec.loader.exec_module(pg)
m=pg.m;ROOT=pg.ROOT
SECRET='schema0412-synthetic-jwt-signing-key-not-production'
OLD={
 'app':'ghcr.io/lz-20/ainativecrm-app@sha256:af7b4552429a74c48a5895247d71ec3bbd9ce4d604e89da0aa88a0b5fb105ec3',
 'worker':'ghcr.io/lz-20/ainativecrm-worker@sha256:aed8016ef756324aed58e74adf26abf7586e449aa26366697b14df44edecf31a',
 'scheduler':'ghcr.io/lz-20/ainativecrm-scheduler@sha256:3716b2c9ae04a553cf60c6d5adc9784ee7b6abe98f004fa44546856674e6b2c2',
}
def encoded(value):return base64.urlsafe_b64encode(json.dumps(value,separators=(',',':')).encode()).decode().rstrip('=')
def token(role,subject=None):
    payload={'role':role,'iss':'supabase','iat':int(time.time()),'exp':int(time.time())+7200}
    if subject:payload.update(sub=subject,aud='authenticated',aal='aal1',email='schema0412-manager@invariant.test')
    body=encoded({'alg':'HS256','typ':'JWT'})+'.'+encoded(payload)
    return body+'.'+base64.urlsafe_b64encode(hmac.new(SECRET.encode(),body.encode(),hashlib.sha256).digest()).decode().rstrip('=')


GATEWAY=r'''
import base64,hashlib,hmac,http.server,json,os,urllib.request,urllib.error
secret=os.environ['FIXTURE_SECRET'];user=os.environ['FIXTURE_USER']
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def answer(self,status,data):
  raw=json.dumps(data).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(raw)
 def do_GET(self):
  if self.path.startswith('/auth/v1/user'):
   try:
    raw=self.headers.get('Authorization','').removeprefix('Bearer ');a,b,c=raw.split('.')
    valid=base64.urlsafe_b64encode(hmac.new(secret.encode(),(a+'.'+b).encode(),hashlib.sha256).digest()).decode().rstrip('=')
    claims=json.loads(base64.urlsafe_b64decode(b+'='*((-len(b))%4)))
    assert hmac.compare_digest(valid,c) and claims.get('sub')==user
   except Exception:return self.answer(401,{'message':'synthetic identity required'})
   return self.answer(200,{'id':user,'aud':'authenticated','role':'authenticated','email':'schema0412-manager@invariant.test',
    'app_metadata':{'provider':'email','providers':['email']},'user_metadata':{'locale':'pt-BR'},'identities':[],'factors':[]})
  return self.proxy()
 def do_POST(self):return self.proxy()
 def do_PATCH(self):return self.proxy()
 def proxy(self):
  if not self.path.startswith('/rest/v1/'):
   return self.answer(404,{'message':'fixture has only local Auth identity and real PostgREST'})
  size=int(self.headers.get('Content-Length','0'));data=self.rfile.read(size) if size else None
  headers={k:v for k,v in self.headers.items() if k.lower() not in ('host','connection','content-length')}
  req=urllib.request.Request('http://postgrest:3000/'+self.path[len('/rest/v1/'):],data=data,headers=headers,method=self.command)
  try:r=urllib.request.urlopen(req,timeout=20)
  except urllib.error.HTTPError as error:r=error
  self.send_response(r.status)
  for k,v in r.headers.items():
   if k.lower() not in ('connection','transfer-encoding','content-length'):self.send_header(k,v)
  self.end_headers();self.wfile.write(r.read())
http.server.ThreadingHTTPServer(('0.0.0.0',8000),Handler).serve_forever()
'''


def run_image_compatibility(major,dest):
    db=pg.Database(major,compatibility=True);owned=[];applications=[];images={};counter=0
    def docker(*args,data=None,timeout=240):return pg.command(['docker',*args],data=data,timeout=timeout)
    def spawn(label,image,env=None,alias=None,entry=None,args=None):
        nonlocal counter
        counter+=1;name=db.name+'-'+label+'-'+str(counter)
        command=['run','-d','--pull=never','--name',name,'--label','ainativecrm.schema0412='+db.name,
          '--network',db.network,'--memory','2g','--cpus','2','--pids-limit','256','--security-opt','no-new-privileges:true','--log-driver','none']
        if alias:command+=['--network-alias',alias]
        for key,value in (env or {}).items():command+=['-e',key+'='+value]
        if entry:command+=['--entrypoint',entry]
        cid=docker(*command,image,*(args or [])).decode().strip();owned.append(cid)
        row=json.loads(docker('inspect',cid))[0]
        assert row['HostConfig']['NetworkMode']==db.network and not row['HostConfig'].get('PortBindings')
        assert not row['Mounts'] and row['Config']['Labels']['ainativecrm.schema0412']==db.name
        return cid
    def stop(ids):
        for cid in ids:
            row=json.loads(docker('inspect',cid))[0];assert row['Config']['Labels']['ainativecrm.schema0412']==db.name
            docker('rm','-f',cid);owned.remove(cid)
    def request(gateway,service,path,cookie=None):
        script="import json,sys,urllib.request,urllib.error;v=json.load(sys.stdin);q=urllib.request.Request(v['url'],headers=v['headers']);\ntry:r=urllib.request.urlopen(q,timeout=8)\nexcept urllib.error.HTTPError as e:r=e\nprint(json.dumps({'status':r.status,'body':r.read().decode()}))"
        data={'url':'http://'+service+path,'headers':{'Cookie':cookie} if cookie else {}}
        return json.loads(docker('exec','-i',gateway,'python','-c',script,data=json.dumps(data).encode()))
    def wait_http(gateway,service,path,cookie=None):
        for _ in range(90):
            try:
                value=request(gateway,service,path,cookie)
                if value['status']==200:return value
            except RuntimeError:pass
            time.sleep(1)
        raise AssertionError('isolated_http_not_ready_'+service+path)
    try:
        db.start();pg.init(db)
        db.sql("CREATE ROLE authenticator LOGIN; GRANT anon,authenticated,service_role TO authenticator;")
        db.sql(f"""INSERT INTO public.crm_pipelines(organization_id,name,slug) VALUES('{pg.ORG}','SVC-101 pipeline','schema0412');
          INSERT INTO public.crm_tasks(organization_id,title,contact_id) VALUES('{pg.ORG}','SVC-101 task','{pg.CONTACT}');""")
        before=pg.catalog(db)
        migration=pg.git_blob(m.REVIEWED_SOURCE,m.MIGRATION);assert m.raw_hash(migration)==m.MIGRATION_SHA256
        db.sql('BEGIN; '+migration.decode()+'; COMMIT;')
        # Real internal PostgREST: JWT roles and RLS are enforced by PostgreSQL.
        docker('pull','postgrest/postgrest:v14.18');docker('pull','python:3.13-alpine')
        spawn('postgrest','postgrest/postgrest:v14.18',{'PGRST_DB_URI':'postgresql://authenticator@db:5432/postgres',
          'PGRST_DB_SCHEMAS':'public','PGRST_DB_ANON_ROLE':'anon','PGRST_JWT_SECRET':SECRET},'postgrest')
        gateway=spawn('gateway','python:3.13-alpine',{'FIXTURE_SECRET':SECRET,'FIXTURE_USER':pg.USER},'api-gw','python',['-c',GATEWAY])
        anon=token('anon');service=token('service_role');access=token('authenticated',pg.USER)
        session={'access_token':access,'refresh_token':'synthetic-refresh','token_type':'bearer','expires_in':7200,
          'expires_at':int(time.time())+7200,'user':{'id':pg.USER,'email':'schema0412-manager@invariant.test'}}
        cookie='sb-pi-native-auth=base64-'+base64.urlsafe_b64encode(json.dumps(session,separators=(',',':')).encode()).decode().rstrip('=')+'; active_org='+pg.ORG
        env={'NODE_ENV':'production','NEXT_PUBLIC_SUPABASE_URL':'http://localhost:8000','SUPABASE_INTERNAL_URL':'http://api-gw:8000',
          'NEXT_PUBLIC_SUPABASE_ANON_KEY':anon,'SUPABASE_SERVICE_ROLE_KEY':service,'NEXT_PUBLIC_APP_URL':'http://app:3000',
          'NEXT_PUBLIC_ADMIN_URL':'http://app:3000','INTERNAL_SECRET':'synthetic-schema0412-cron-secret',
          'INTERNAL_CRON_SECRET':'synthetic-schema0412-cron-secret','AI_CRED_AES_KEY':base64.b64encode(bytes(32)).decode(),
          'CPF_ENCRYPTION_KEY':base64.b64encode(bytes(32)).decode(),'WAHA_BYO_ENCRYPTION_KEY':base64.b64encode(bytes(32)).decode(),
          'SENTRY_DSN':'off','NEXT_PUBLIC_SENTRY_DSN':'off','CRM_DEMO_MODE':'false','SUPABASE_DB_URL':'postgresql://postgres@db:5432/postgres',
          'CRM_BASE_URL':'http://app:3000','OPENAI_API_KEY':'','ANTHROPIC_API_KEY':'','DEEPSEEK_API_KEY':'','AI_GATEWAY_API_KEY':'',
          'PORT':'3000','HOSTNAME':'0.0.0.0'}
        def inspect_image(ref,source,schema):
            row=json.loads(docker('image','inspect',ref))[0];labels=row['Config'].get('Labels',{})
            assert row['Os']=='linux' and row['Architecture']=='arm64'
            assert labels['org.opencontainers.image.revision']==source and labels['io.ainativecrm.schema-sha256']==schema
            assert 'APP_VERSION='+source in row['Config']['Env']
            return {'reference':ref,'image_id':row['Id'],'source_sha':source,'schema_sha256':schema,'architecture':row['Architecture']}
        for name,ref in OLD.items():docker('pull',ref);images['old_'+name]=inspect_image(ref,m.FROM_SOURCE,m.FROM_SCHEMA)
        def boot(refs):
            ids=[spawn('app',refs['app'],env,'app'),spawn('worker',refs['worker'],env,'worker'),spawn('scheduler',refs['scheduler'],env)]
            wait_http(gateway,'app:3000','/login')
            for path in ['/api/v1/contacts?limit=20','/api/v1/pipelines','/api/v1/tasks']:
                response=wait_http(gateway,'app:3000',path,cookie)
                if path.startswith('/api/v1/contacts'):assert pg.CONTACT in response['body']
            health=wait_http(gateway,'worker:8787','/healthz');assert health['status']==200
            assert docker('exec',ids[2],'pgrep','crond').strip()
            applications.append({'references':refs,'crm_paths_ok':True,'worker_healthz':200,'scheduler_crond':True})
            return ids
        old_ids=boot(OLD)
        stop(old_ids)
        # Rebuild all three production images from the immutable reviewed source,
        # no GHCR publication and no reuse of another commit's green CI.
        new={}
        with tempfile.TemporaryDirectory(prefix='schema0412-source-') as temp:
            raw=pg.command(['git','archive',m.REVIEWED_SOURCE],timeout=180)
            with tarfile.open(fileobj=io.BytesIO(raw)) as archive:archive.extractall(temp,filter='data')
            for name,file in [('app','Dockerfile'),('worker','Dockerfile.worker'),('scheduler','Dockerfile.scheduler')]:
                tag='schema0412-'+db.name+'-'+name+':new';new[name]=tag
                docker('build','--label','org.opencontainers.image.revision='+m.REVIEWED_SOURCE,
                  '--label','org.opencontainers.image.source=https://github.com/Lz-20/AiNativeCrm',
                  '--label','io.ainativecrm.schema-sha256='+m.TO_SCHEMA,'--build-arg','APP_VERSION='+m.REVIEWED_SOURCE,
                  '-f',str(Path(temp)/file),'-t',tag,temp,timeout=1800)
                images['new_'+name]=inspect_image(tag,m.REVIEWED_SOURCE,m.TO_SCHEMA)
        new_ids=boot(new)
        response=wait_http(gateway,'app:3000','/api/v1/ai/knowledge/embedding',cookie)
        assert json.loads(response['body'])['data']['configuration'] is None
        fp='embedding:v1:'+hashlib.sha256(json.dumps([1,'siliconflow','https://api.siliconflow.cn/v1','BAAI/bge-m3',1024,'1'],separators=(',',':')).encode()).hexdigest()
        db.sql(f"""INSERT INTO public.ai_embedding_configurations(organization_id,provider,base_url,model,dimensions,model_revision,fingerprint,enabled)
          VALUES('{pg.ORG}','siliconflow','https://api.siliconflow.cn/v1','BAAI/bge-m3',1024,'1','{fp}',false);""")
        response=request(gateway,'app:3000','/api/v1/ai/knowledge/embedding',cookie)
        assert json.loads(response['body'])['data']['configuration']['model']=='BAAI/bge-m3'
        stop(new_ids)
        rollback_ids=boot(OLD)
        assert db.sql(f"SELECT model FROM public.ai_embedding_configurations WHERE organization_id='{pg.ORG}'")=='BAAI/bge-m3'
        assert db.sql(f"SELECT count(*) FROM public.ai_chunks WHERE knowledge_source_id='{pg.SOURCE}'")=='1'
        stop(rollback_ids)
        return {'postgres_major':major,'images':images,'phases':applications,'schema_registration_separates_image_and_database':True,
          'rollback_preserved_new_data':True,'auth_identity':'synthetic_HMAC_fixture_not_GoTrue_acceptance',
          'database_and_RLS':'real_PostgREST_and_pgvector','network':'internal_only','paid_model_calls':0,
          'business_messages_sent':0,'source_staging_accessed':False,'failures':0}
    finally:
        if db.cid:
            stop(list(owned));db.close()


if __name__=='__main__':
    major=os.environ.get('TEST_PG_MAJOR','17');dest=ROOT/'schema-0412-evidence';dest.mkdir(exist_ok=True)
    value=run_image_compatibility(major,dest)
    (dest/('image-compatibility-pg'+major+'.json')).write_text(json.dumps(value,indent=2),encoding='utf8')
    print(json.dumps(value))
