#!/usr/bin/env python3
"""Root-only logical backup and restore proof for the existing isolated staging.

The source is accessed only through read-only ordinary SQL sessions and pg_dump;
no replication/HBA window, source SQL mutation, service restart or migration.
Restore writes are restricted to a fresh networkless Docker Compose project.
All payloads (including password hashes, function bodies and row fingerprints)
stay in the root-owned private backup directory. Stdout is a small attestation.
"""
import contextlib
import datetime as dt
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import selectors
import secrets
import stat
import subprocess
import sys
import tarfile
import time

SOURCE_CONTAINER_ID = "3269d88526fe446ab2a8744a24494a6b19d14f9634fbf2f6a83c2077248c1c22"
SOURCE_SYSTEM_ID = "7701258112182636578"
SOURCE_PROJECT = "ainativecrm-staging-supabase"
SOURCE_ROOT = Path("/home/ubuntu/apps/AiNativeCrm-staging/infra/supabase")
STATE_ROOT = Path("/var/lib/ainativecrm-staging-deploy")
POLICY = Path("/etc/ainativecrm-staging-deploy/policy.json")
IMAGE = "supabase/postgres:17.6.1.136@sha256:f371b5f3f2ac0a05703f33d6e6134515fb2498cab708fb948a0aeb7481467c00"
DATABASES = ("postgres", "_supabase")
SNAPSHOT_BEGIN = """BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '10s';
SET LOCAL search_path = pg_catalog;
SELECT pg_export_snapshot();"""
INSPECT_FORMAT = ('{"Id":{{json .Id}},"Image":{{json .Image}},'
                  '"ImageReference":{{json .Config.Image}},"Labels":{{json .Config.Labels}},'
                  '"State":{{json .State}},"NetworkMode":{{json .HostConfig.NetworkMode}},'
                  '"Ports":{{json .NetworkSettings.Ports}},"Memory":{{json .HostConfig.Memory}},'
                  '"NanoCpus":{{json .HostConfig.NanoCpus}},"Mounts":{{json .Mounts}}}')


class VerificationError(RuntimeError):
    """Public error is a fixed stage code, never subprocess output or payload."""
    def __init__(self, stage, _private_detail=None):
        self.stage = re.sub(r"[^a-z0-9_-]", "_", stage.lower())[:80]
        super().__init__("backup_verification_failed:" + self.stage)


def require(condition, stage):
    if not condition:
        raise VerificationError(stage)


def canonical_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def file_hash(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def identifier(value):
    return '"' + value.replace('"', '""') + '"'


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def private_dir(path, create=False):
    """Refuse symlinks, non-root ownership and writeable ancestor directories."""
    if create:
        private_dir(path.parent)
        path.mkdir(mode=0o700, exist_ok=False)
    require(path.is_dir() and not path.is_symlink(), "private_directory_type")
    for parent in (path, *path.parents):
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                "private_directory_owner")
    require(stat.S_IMODE(path.stat().st_mode) == 0o700, "private_directory_mode")


def private_write(path, content):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(content.encode() if isinstance(content, str) else content)
        stream.flush()
        os.fsync(stream.fileno())


def write_json(path, value):
    private_write(path, json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False) + "\n")


def safe_policy():
    for path in (POLICY, *POLICY.parents):
        info = path.lstat()
        require(not stat.S_ISLNK(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                "policy_owner")
    policy = json.loads(POLICY.read_text())
    require(policy.get("db_container_id") == SOURCE_CONTAINER_ID, "policy_source_container")
    require(str(policy.get("system_identifier")) == SOURCE_SYSTEM_ID, "policy_source_cluster")
    return policy


def run(args, data=None, output=None, timeout=300):
    """Do not log command output: pg_dump/psql stderr can contain row secrets."""
    stream = None
    try:
        if output:
            fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            stream = os.fdopen(fd, "wb")
        result = subprocess.run(args, input=data, stdout=stream or subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=timeout, check=False)
        require(result.returncode == 0, "command_exit")
        if stream:
            stream.flush()
            os.fsync(stream.fileno())
            return b""
        return result.stdout
    except (OSError, subprocess.TimeoutExpired):
        raise VerificationError("command_timeout_or_io") from None
    finally:
        if stream:
            stream.close()


def inspect_container(cid):
    return json.loads(run(["docker", "inspect", "--format", INSPECT_FORMAT, cid]))


def validate_identity(identity):
    require(str(identity.get("system_identifier")) == SOURCE_SYSTEM_ID, "source_system_identifier")
    require(identity.get("server_version") == "17.6", "source_postgres_version")
    require(set(identity.get("databases", [])) == set(DATABASES), "source_database_set")


def source_identity(session):
    result = session.json("""SELECT json_build_object(
      'system_identifier',(SELECT system_identifier::text FROM pg_control_system()),
      'server_version',current_setting('server_version'),
      'databases',(SELECT json_agg(datname ORDER BY datname) FROM pg_database
        WHERE datallowconn AND NOT datistemplate))""")
    validate_identity(result)
    return result


def preflight():
    require(os.geteuid() == 0 and sys.platform == "linux", "root_linux_required")
    safe_policy()
    source = inspect_container(SOURCE_CONTAINER_ID)
    require(source["Id"] == SOURCE_CONTAINER_ID, "source_container_id")
    require(source["Labels"].get("com.docker.compose.project") == SOURCE_PROJECT,
            "source_project")
    require(source["State"].get("Health", {}).get("Status") == "healthy", "source_health")
    image = json.loads(run(["docker", "image", "inspect", "--format",
                           '{"Id":{{json .Id}},"Architecture":{{json .Architecture}}}', IMAGE]))
    require(image["Architecture"] == "arm64" and image["Id"] == source["Image"], "source_pinned_image")
    return source


class Snapshot:
    """A read-only transaction kept open while pg_dump imports its snapshot."""
    def __init__(self, cid, database, log=None, restored=False):
        self.cid, self.database, self.log, self.restored = cid, database, log, restored
        self.process = None
        self.buffer = b""

    def __enter__(self):
        require(self.database in DATABASES, "snapshot_database")
        args = ["docker", "exec", "-i", self.cid, "psql", "-X", "-qAt", "--no-password",
                "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=sqlstate", "-v", "SHOW_CONTEXT=never",
                "-U", "supabase_admin", "-d", self.database]
        if self.restored:
            require(self.cid != SOURCE_CONTAINER_ID, "source_restore_forbidden")
            args += ["-h", "/tmp/restore-socket"]
        if self.log:
            fd = os.open(self.log, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            self.error_stream = os.fdopen(fd, "wb")
        else:
            self.error_stream = open(os.devnull, "wb")
        self.process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=self.error_stream, bufsize=0)
        try:
            self.snapshot = self.query(SNAPSHOT_BEGIN).strip()
            require(bool(re.fullmatch(r"[0-9A-Fa-f-]+", self.snapshot)), "snapshot_identifier")
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def query(self, sql):
        marker = "backup_end_" + secrets.token_hex(16)
        self.process.stdin.write((sql.rstrip(";\n ") + ";\n\\echo " + marker + "\n").encode())
        self.process.stdin.flush()
        delimiter = (marker + "\n").encode()
        deadline = time.monotonic() + 130
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            while delimiter not in self.buffer:
                remaining = deadline - time.monotonic()
                require(remaining > 0, "snapshot_timeout")
                if not selector.select(min(remaining, 10)):
                    continue
                chunk = os.read(self.process.stdout.fileno(), 65536)
                require(bool(chunk), "snapshot_connection_closed")
                self.buffer += chunk
            result, self.buffer = self.buffer.split(delimiter, 1)
            return result.decode().strip()

    def json(self, sql):
        return json.loads(self.query(sql))

    def __exit__(self, *unused):
        if self.process:
            try:
                self.process.stdin.write(b"ROLLBACK;\n\\q\n")
                self.process.stdin.close()
                self.process.wait(timeout=10)
            except (OSError, subprocess.TimeoutExpired):
                self.process.kill()
                self.process.wait(timeout=10)
            self.process.stdout.close()
        self.error_stream.close()


# ACLs are semantic sets; NULL means the object-specific PostgreSQL defaults.
# Expanding NULL also preserves default PUBLIC privileges for functions/types;
# an explicit owner-only ACL therefore remains distinguishable from NULL there.
def acl(expression, object_type=None, owner=None):
    if object_type:
        expression = f"coalesce({expression},acldefault('{object_type}',{owner}))"
    return f"ARRAY(SELECT a::text FROM unnest({expression}) a ORDER BY a::text)"


def canonical_constraint(sql):
    """Canonicalize one PostgreSQL parser rewrite, without ignoring a CHECK.

    Unbounded varchar string constants cast together to text[] equal the same
    constants individually cast to text. Literal bytes/order are retained and
    typmod casts (which can truncate) are deliberately outside this grammar.
    Protect all SQL string literals before matching structural tokens.
    """
    prefix = "__CRM_LITERAL_"
    while prefix in sql:
        prefix += "_"
    literals = []
    def hide(match):
        literals.append(match.group(0))
        return prefix + str(len(literals) - 1) + "__"
    masked = re.sub(r"'(?:[^']|'')*'", hide, sql)
    token = re.escape(prefix) + r"\d+__"
    item = token + r"::character varying"
    source = re.compile(r"\(ARRAY\[(" + item + r"(?:,\s*" + item + r")*)\]\)::text\[\]")
    source_pretty = re.compile(r"ARRAY\[(" + item + r"(?:,\s*" + item + r")*)\]::text\[\]")
    restored_item = r"\(" + item + r"\)::text"
    restored = re.compile(r"ARRAY\[(" + restored_item + r"(?:,\s*" + restored_item + r")*)\]")
    restored_pretty_item = item + r"::text"
    restored_pretty = re.compile(r"ARRAY\[(" + restored_pretty_item + r"(?:,\s*" + restored_pretty_item + r")*)\]")
    def rewrite(match):
        return "ARRAY[" + ", ".join(t + "::text" for t in re.findall(token, match.group(1))) + "]"
    for pattern in (source, source_pretty, restored, restored_pretty):
        masked = pattern.sub(rewrite, masked)
    return re.sub(token, lambda match: literals[int(match.group(0)[len(prefix):-2])], masked)


USER_SCHEMA = "n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'"
CATALOG_QUERIES = {
    "roles": """SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,
       rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil,
       md5(coalesce(rolpassword,'')) AS password_hash FROM pg_authid""",
    "memberships": """SELECT pg_get_userbyid(roleid) AS role_name,pg_get_userbyid(member) AS member,
       pg_get_userbyid(grantor) AS grantor,admin_option,inherit_option,set_option FROM pg_auth_members""",
    "role_settings": """SELECT coalesce(r.rolname,'ALL') AS role_name,coalesce(d.datname,'ALL') AS database_name,
       md5(array_to_string(ARRAY(SELECT v FROM unnest(s.setconfig) v ORDER BY v),E'\\n')) AS settings_hash
       FROM pg_db_role_setting s LEFT JOIN pg_roles r ON r.oid=s.setrole
       LEFT JOIN pg_database d ON d.oid=s.setdatabase WHERE d.datname IS NULL OR d.datname IN ('postgres','_supabase')""",
    "databases": f"""SELECT datname,pg_get_userbyid(datdba) AS owner,encoding,datlocprovider,
       datcollate,datctype,datlocale,datconnlimit,datallowconn,{acl('datacl', 'd', 'datdba')} AS acl
       FROM pg_database WHERE datname IN ('postgres','_supabase')""",
    "default_acl": f"""SELECT pg_get_userbyid(a.defaclrole) AS owner,coalesce(n.nspname,'GLOBAL') AS schema_name,
       a.defaclobjtype AS object_type,{acl('a.defaclacl')} AS acl FROM pg_default_acl a
       LEFT JOIN pg_namespace n ON n.oid=a.defaclnamespace""",
    "schemas": f"""SELECT nspname,pg_get_userbyid(nspowner) AS owner,{acl('nspacl', 'n', 'nspowner')} AS acl
       FROM pg_namespace n WHERE {USER_SCHEMA}""",
    "extensions": """SELECT e.extname,e.extversion,n.nspname,pg_get_userbyid(e.extowner) AS owner,
       (SELECT jsonb_agg(jsonb_build_array(c.oid::regclass::text,condition) ORDER BY c.oid::regclass::text)
        FROM unnest(e.extconfig,e.extcondition) AS cfg(oid,condition) JOIN pg_class c ON c.oid=cfg.oid) AS config
       FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace""",
    "relations": f"""SELECT n.nspname AS schema_name,c.relname,c.relkind,pg_get_userbyid(c.relowner) AS owner,
       CASE WHEN c.relkind='S' THEN {acl('c.relacl', 'S', 'c.relowner')}
         ELSE {acl('c.relacl', 'r', 'c.relowner')} END AS acl,c.relrowsecurity,c.relforcerowsecurity,c.relreplident,c.reloptions,
       CASE WHEN c.relkind IN ('v','m') THEN md5(pg_get_viewdef(c.oid,true)) END AS view_hash
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE {USER_SCHEMA} AND c.relkind IN ('r','p','v','m','S','f')""",
    "columns": f"""SELECT n.nspname AS schema_name,c.relname AS table_name,a.attname,
       row_number() OVER(PARTITION BY c.oid ORDER BY a.attnum) AS column_position,
       format_type(a.atttypid,a.atttypmod) AS type_name,a.attnotnull,a.attidentity,a.attgenerated,
       {acl('a.attacl', 'c', 'c.relowner')} AS acl,md5(coalesce(pg_get_expr(d.adbin,d.adrelid),'')) AS default_hash
       FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
       WHERE {USER_SCHEMA} AND c.relkind IN ('r','p','v','m','S','f') AND a.attnum>0 AND NOT a.attisdropped""",
    "functions": f"""SELECT n.nspname AS schema_name,p.proname,pg_get_function_identity_arguments(p.oid) AS args,
       pg_get_userbyid(p.proowner) AS owner,{acl('p.proacl', 'f', 'p.proowner')} AS acl,p.prosecdef,
       md5(pg_get_functiondef(p.oid)) AS definition_hash FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE {USER_SCHEMA} AND p.prokind IN ('f','p')""",
    "policies": """SELECT schemaname,tablename,policyname,permissive,roles,cmd,
       md5(jsonb_build_array(qual,with_check)::text) AS expression_hash FROM pg_policies""",
    "indexes": f"""SELECT n.nspname AS schema_name,c.relname AS index_name,t.relname AS table_name,
       i.indisvalid,i.indisready,i.indislive,i.indisunique,i.indisprimary,md5(pg_get_indexdef(i.indexrelid)) AS definition_hash
       FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace WHERE {USER_SCHEMA}""",
    "constraints": f"""SELECT n.nspname AS schema_name,c.relname AS table_name,k.conname,k.contype,
       k.convalidated,k.condeferrable,k.condeferred,pg_get_constraintdef(k.oid,true) AS definition
       FROM pg_constraint k JOIN pg_namespace n ON n.oid=k.connamespace LEFT JOIN pg_class c ON c.oid=k.conrelid
       WHERE {USER_SCHEMA}""",
    "triggers": f"""SELECT n.nspname AS schema_name,c.relname AS table_name,
       CASE WHEN t.tgisinternal THEN NULL ELSE t.tgname END AS trigger_name,t.tgenabled,t.tgisinternal,
       CASE WHEN t.tgisinternal THEN jsonb_build_array(t.tgfoid::regprocedure::text,t.tgtype,t.tgdeferrable,
         t.tginitdeferred,k.conname,md5(t.tgargs::text))::text ELSE pg_get_triggerdef(t.oid,true) END AS definition
       FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
       LEFT JOIN pg_constraint k ON k.oid=t.tgconstraint WHERE {USER_SCHEMA}""",
    "event_triggers": """SELECT evtname,evtevent,evtenabled,evttags,pg_get_userbyid(evtowner) AS owner,
       evtfoid::regprocedure::text AS function_name FROM pg_event_trigger""",
    "publications": """SELECT pubname,pg_get_userbyid(pubowner) AS owner,puballtables,pubinsert,pubupdate,
       pubdelete,pubtruncate,pubviaroot FROM pg_publication""",
    "publication_tables": "SELECT pubname,schemaname,tablename,attnames,rowfilter FROM pg_publication_tables",
    "sequences": f"""SELECT n.nspname AS schema_name,c.relname AS sequence_name,
       (to_jsonb(s)-'seqrelid') AS parameters FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace WHERE {USER_SCHEMA}""",
    "types": f"""SELECT n.nspname AS schema_name,t.typname,t.typtype,t.typcategory,
       pg_get_userbyid(t.typowner) AS owner,{acl('t.typacl', 'T', 't.typowner')} AS acl,
       CASE WHEN t.typbasetype<>0 THEN format_type(t.typbasetype,t.typtypmod) END AS base_type,
       t.typnotnull,t.typdefault,(SELECT jsonb_agg(enumlabel ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid=t.oid) AS enum
       FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE {USER_SCHEMA}""",
}


def catalog_metadata(session):
    result = {name: session.json("SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]') FROM ("
                                + sql + ") x") for name, sql in CATALOG_QUERIES.items()}
    for item in result["constraints"]:
        item["definition_hash"] = hashlib.sha256(canonical_constraint(item.pop("definition")).encode()).hexdigest()
    # Source/restore JSON order must depend on canonical values, not their
    # different pre-normalization SQL representations.
    for name in result:
        result[name].sort(key=lambda item: json.dumps(item, sort_keys=True, separators=(",", ":")))
    return result


def source_catalog_metadata(sessions=None):
    if sessions is not None:
        return {db: catalog_metadata(sessions[db]) for db in DATABASES}
    with contextlib.ExitStack() as stack:
        active = {db: stack.enter_context(Snapshot(SOURCE_CONTAINER_ID, db)) for db in DATABASES}
        source_identity(active["postgres"])
        return source_catalog_metadata(active)


def data_metadata(session, schema_only=None):
    schema_clause = " AND n.nspname=" + literal(schema_only) if schema_only else ""
    tables = session.json(f"""SELECT coalesce(jsonb_agg(jsonb_build_array(n.nspname,c.relname) ORDER BY n.nspname,c.relname),'[]')
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE {USER_SCHEMA} AND c.relkind IN ('r','p','m'){schema_clause}""")
    result = {}
    for schema, table in tables:
        sql = ("SELECT jsonb_build_object('count',count(*),'hash',md5(coalesce(string_agg(j,E'\\n' ORDER BY j),''))) "
               "FROM (SELECT to_jsonb(t)::text AS j FROM " + identifier(schema) + "." + identifier(table) + " t) rows")
        result[schema + "." + table] = session.json(sql)
    if not schema_only:
        result["__largeobjects__"] = session.json("""SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY loid,pageno),'[]')
           FROM (SELECT loid,pageno,md5(data) AS content_hash FROM pg_largeobject) x""")
    return result


def capture_compensation(session):
    # Only these four known vendor customization differences are authorized.
    result = session.json("""SELECT jsonb_agg(x ORDER BY x->>'kind',x->>'name') FROM (
      SELECT jsonb_build_object('kind','schema','name',n.nspname,'owner',pg_get_userbyid(n.nspowner),
        'grants',(SELECT jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),
          'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
          'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantee,a.privilege_type)
          FROM aclexplode(n.nspacl) a)) AS x
      FROM pg_namespace n WHERE n.nspname IN ('graphql','graphql_public')
      UNION ALL
      SELECT jsonb_build_object('kind','function','name',p.proname,'owner',pg_get_userbyid(p.proowner),
        'signature',pg_get_function_identity_arguments(p.oid),'definition',pg_get_functiondef(p.oid),
        'definition_hash',md5(pg_get_functiondef(p.oid)),
        'grants',(SELECT jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),
          'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
          'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantee,a.privilege_type)
          FROM aclexplode(p.proacl) a))
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      JOIN pg_depend d ON d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e'
      JOIN pg_extension e ON e.oid=d.refobjid
      WHERE n.nspname='net' AND p.proname IN ('http_get','http_post')
        AND e.extname='pg_net' AND e.extversion='0.20.3') objects""")
    build_compensation(result)  # Validate before writing sensitive payload.
    return result


FUNCTION_HASHES = {"http_get": "32ca253f5f762c0e7e624a7cbeafe84c", "http_post": "be449e12bb39ad4542a215a42a826e82"}


def build_compensation(objects):
    require(isinstance(objects, list) and len(objects) == 4, "managed_object_count")
    require({(o.get("kind"), o.get("name")) for o in objects} ==
            {("schema", "graphql"), ("schema", "graphql_public"), ("function", "http_get"), ("function", "http_post")},
            "managed_object_allowlist")
    lines = ["BEGIN;", "SET LOCAL search_path = pg_catalog;"]
    for obj in objects:
        require(obj["owner"] == "supabase_admin" and obj.get("grants"), "managed_owner_or_acl")
        if obj["kind"] == "function":
            body = obj["definition"]
            require(body.startswith("CREATE OR REPLACE FUNCTION net." + obj["name"] + "("), "managed_function_prefix")
            require(hashlib.md5(body.encode()).hexdigest() == FUNCTION_HASHES[obj["name"]], "managed_function_review_hash")
            require(bool(re.fullmatch(r"[a-z_, ]*", obj["signature"])), "managed_function_signature")
            lines.append(body.rstrip() + ";")
            target = "FUNCTION net." + identifier(obj["name"]) + "(" + obj["signature"] + ")"
        else:
            target = "SCHEMA " + identifier(obj["name"])
        # Target is a new private restore copy; revoke its default PUBLIC grants,
        # then recreate the exact original grantor/grantee/grant-option set.
        lines += ['SET LOCAL ROLE "supabase_admin";', "REVOKE ALL ON " + target + " FROM PUBLIC;"]
        for grant in obj["grants"]:
            require(grant["grantor"] == "supabase_admin", "managed_grantor")
            allowed = {"USAGE", "CREATE"} if obj["kind"] == "schema" else {"EXECUTE"}
            require(grant["privilege"] in allowed, "managed_privilege")
            grantee = "PUBLIC" if grant["grantee"] == "PUBLIC" else identifier(grant["grantee"])
            lines.append("GRANT " + grant["privilege"] + " ON " + target + " TO " + grantee
                         + (" WITH GRANT OPTION" if grant["grantable"] else "") + ";")
        lines.append("RESET ROLE;")
    lines.append("COMMIT;")
    return "\n".join(lines) + "\n"


def require_equal(expected, actual, stage):
    require(expected == actual, stage + "_differences")


def validate_tar(path):
    with tarfile.open(path, "r:gz") as archive:
        for member in archive:
            name = PurePosixPath(member.name)
            require(not name.is_absolute() and ".." not in name.parts and (member.isfile() or member.isdir()),
                    "archive_unsafe_member")


def tar_manifest(path):
    validate_tar(path)
    with tarfile.open(path, "r:gz") as archive:
        return {member.name: {"bytes": member.size, "sha256": hashlib.sha256(archive.extractfile(member).read()).hexdigest()}
                for member in archive if member.isfile()}


def validate_copy(copy, project):
    require(copy["Id"] != SOURCE_CONTAINER_ID and bool(re.fullmatch(r"ainativecrm-backup-[a-z0-9-]+", project)), "copy_identity")
    require(copy["Labels"].get("com.docker.compose.project") == project, "copy_project")
    require(copy["NetworkMode"] == "none" and not any((copy["Ports"] or {}).values()), "copy_network")
    require(0 < copy["Memory"] <= 3 * 1024 ** 3 and 0 < copy["NanoCpus"] <= 10 ** 9, "copy_resource_limit")
    require(all(m["Type"] == "volume" and m["Name"] in {project + "_" + name for name in ("data", "config", "storage")}
                for m in copy["Mounts"]), "copy_volumes")


def restore_exec(cid, args, data=None, user=None, output=None, runner=run):
    require(bool(re.fullmatch(r"[a-f0-9]{64}", cid)) and cid != SOURCE_CONTAINER_ID, "source_restore_forbidden")
    return runner(["docker", "exec", "-i"] + (["--user", user] if user else []) + [cid] + args,
                  data=data, output=output)


def restore_sql(cid, sql, database="template1"):
    require(database in (*DATABASES, "template1"), "restore_database")
    return restore_exec(cid, ["psql", "-X", "-qAt", "--no-password", "-v", "ON_ERROR_STOP=1",
                             "-v", "VERBOSITY=sqlstate", "-v", "SHOW_CONTEXT=never", "-h", "/tmp/restore-socket",
                             "-U", "supabase_admin", "-d", database], sql.encode() if isinstance(sql, str) else sql)


def compose_document(project):
    return {"name": project, "services": {"db": {"image": IMAGE, "platform": "linux/arm64",
            "pull_policy": "never", "entrypoint": ["sleep", "infinity"], "restart": "no",
            "network_mode": "none", "mem_limit": "3g", "cpus": 1, "pids_limit": 256,
            "shm_size": "256m", "security_opt": ["no-new-privileges:true"], "logging": {"driver": "none"},
            "volumes": ["data:/var/lib/postgresql/data", "config:/etc/postgresql-custom", "storage:/restore-storage"]}},
            "volumes": {"data": {}, "config": {}, "storage": {}}}


def source_storage_id():
    ids = run(["docker", "ps", "-q", "--no-trunc", "--filter", "label=com.docker.compose.project=" + SOURCE_PROJECT,
               "--filter", "label=com.docker.compose.service=storage"]).decode().split()
    require(len(ids) == 1, "source_storage_identity")
    data = inspect_container(ids[0])
    require(data["State"].get("Health", {}).get("Status") == "healthy", "source_storage_health")
    return ids[0]


def check_storage_snapshot(expected):
    # File tar is not transactional. Reject a concurrent Storage write instead
    # of accepting mismatched metadata/files from an earlier exported snapshot.
    with Snapshot(SOURCE_CONTAINER_ID, "postgres") as session:
        current = data_metadata(session, schema_only="storage")
    source = {key: value for key, value in expected.items() if key.startswith("storage.")}
    require_equal(source, current, "storage_metadata_stability")


def backup_files(dest, sessions, expected_storage):
    for db in DATABASES:
        run(["docker", "exec", "-e", "PGOPTIONS=-c default_transaction_read_only=on", SOURCE_CONTAINER_ID, "pg_dump", "--no-password", "-U", "supabase_admin",
             "--format=custom", "--lock-wait-timeout=10s", "--snapshot=" + sessions[db].snapshot, db],
            output=dest / (db + ".dump"))
    run(["docker", "exec", "-e", "PGOPTIONS=-c default_transaction_read_only=on", SOURCE_CONTAINER_ID, "pg_dumpall", "--no-password", "-U", "supabase_admin", "--globals-only"],
        output=dest / "globals.sql")
    run(["docker", "exec", SOURCE_CONTAINER_ID, "tar", "-czf", "-", "-C", "/etc/postgresql-custom", "."],
        output=dest / "db-config.tar.gz")
    storage = source_storage_id()
    check_storage_snapshot(expected_storage)
    run(["docker", "exec", storage, "tar", "-czf", "-", "-C", "/var/lib/storage", "."], output=dest / "storage-files.tar.gz")
    run(["docker", "exec", storage, "tar", "-czf", "-", "-C", "/var/lib/storage", "."], output=dest / "storage-files-recheck.tar.gz")
    require_equal(tar_manifest(dest / "storage-files.tar.gz"), tar_manifest(dest / "storage-files-recheck.tar.gz"), "storage_stability")
    check_storage_snapshot(expected_storage)
    # Protected encryption configuration, never emitted to stdout or Git.
    names = [".env", ".supabase-version", "docker-compose.yml", "docker-compose.staging.yml",
             "staging/images.lock.json", "staging/source-lock.json", "staging/lds.template.yaml",
             "volumes/api", "volumes/db/realtime.sql", "volumes/db/webhooks.sql", "volumes/db/roles.sql",
             "volumes/db/jwt.sql", "volumes/db/_supabase.sql", "volumes/db/logs.sql", "volumes/db/pooler.sql",
             "volumes/pooler", "volumes/functions"]
    for name in names:
        require((SOURCE_ROOT / name).resolve().is_relative_to(SOURCE_ROOT.resolve()), "source_config_path")
    run(["tar", "-czf", "-", "-C", str(SOURCE_ROOT), *names], output=dest / "deployment-config.tar.gz")


def restore_copy(dest, project):
    document = dest / "compose.restore.json"
    write_json(document, compose_document(project))
    dc = ["docker", "compose", "-p", project, "-f", str(document)]
    require(not run(["docker", "ps", "-aq", "--filter", "label=com.docker.compose.project=" + project]).strip(), "copy_project_exists")
    require(not run(["docker", "volume", "ls", "-q", "--filter", "label=com.docker.compose.project=" + project]).strip(), "copy_volume_exists")
    all_volumes = set(run(["docker", "volume", "ls", "--format", "{{.Name}}"]).decode().splitlines())
    require(not all_volumes.intersection({project + "_" + name for name in ("data", "config", "storage")}), "copy_volume_name_exists")
    run(dc + ["up", "-d", "--no-build", "--pull", "never"])
    cid = run(dc + ["ps", "-q", "db"]).decode().strip()
    copy = inspect_container(cid)
    validate_copy(copy, project)
    write_json(dest / "copy-identity.json", {"container_id": cid, "project": project,
                                           "volumes": [m["Name"] for m in copy["Mounts"]]})
    for archive, target in [("db-config.tar.gz", "/etc/postgresql-custom"), ("storage-files.tar.gz", "/restore-storage")]:
        validate_tar(dest / archive)
        restore_exec(cid, ["tar", "-xzf", "-", "-C", target], (dest / archive).read_bytes())
    restore_exec(cid, ["sh", "-c", "mkdir -p /tmp/restore-socket /var/run/postgresql; chown postgres:postgres /var/lib/postgresql/data /tmp/restore-socket /var/run/postgresql; chmod 700 /var/lib/postgresql/data /tmp/restore-socket"])
    restore_exec(cid, ["initdb", "-D", "/var/lib/postgresql/data", "-U", "supabase_admin", "--encoding=UTF8",
                       "--locale-provider=icu", "--icu-locale=en-US", "--locale=en_US.UTF-8",
                       "--auth-local=trust", "--auth-host=reject"], user="postgres")
    # Keep extension workers disconnected during restoration and fingerprinting.
    # Only this copy uses these command-line settings; source config is unchanged.
    opts = ("-c config_file=/etc/postgresql/postgresql.conf -c data_directory=/var/lib/postgresql/data "
            "-c hba_file=/var/lib/postgresql/data/pg_hba.conf -c ident_file=/var/lib/postgresql/data/pg_ident.conf "
            "-c listen_addresses='' -c unix_socket_directories=/tmp/restore-socket -c shared_buffers=128MB "
            "-c max_connections=50 -c logging_collector=off -c log_statement=none -c log_min_error_statement=panic "
            "-c log_parameter_max_length=0 -c log_parameter_max_length_on_error=0 -c log_min_messages=fatal "
            "-c cron.database_name=template1 -c pg_net.database_name=template1")
    pgctl = ["pg_ctl", "-D", "/var/lib/postgresql/data", "-l", "/tmp/restore-postgres.log", "-w", "-t", "60", "-o", opts]
    restore_exec(cid, pgctl + ["start"], user="postgres")
    copy_id = restore_sql(cid, "BEGIN READ ONLY; SELECT system_identifier::text FROM pg_control_system(); ROLLBACK;").decode().strip()
    require(copy_id != SOURCE_SYSTEM_ID and copy_id.isdigit(), "copy_cluster_id")
    globals_sql = (dest / "globals.sql").read_bytes()
    marker = b"CREATE ROLE supabase_admin;"
    require(globals_sql.count(marker) == 1, "restore_bootstrap_role")
    restore_sql(cid, globals_sql.replace(marker, b"-- bootstrap role already exists", 1))
    restore_sql(cid, "DROP DATABASE postgres;")  # New initdb copy only, guarded above.
    for db in DATABASES:
        # Keep the archive table of contents as private evidence, including the
        # sequence SET records pg_dump captures outside MVCC row visibility.
        restore_exec(cid, ["pg_restore", "--list"], (dest / (db + ".dump")).read_bytes(), output=dest / (db + "-archive-toc.txt"))
        require(bool((dest / (db + "-archive-toc.txt")).read_bytes()), "archive_catalog_empty")
        restore_exec(cid, ["pg_restore", "--exit-on-error", "--create", "--no-password", "-h", "/tmp/restore-socket",
                           "-U", "supabase_admin", "-d", "template1"], (dest / (db + ".dump")).read_bytes())
    restore_sql(cid, (dest / "managed-objects.sql").read_bytes(), "postgres")
    return cid, pgctl


def copy_fingerprints(cid, dest, suffix):
    with contextlib.ExitStack() as stack:
        sessions = {db: stack.enter_context(Snapshot(cid, db, dest / (db + "-" + suffix + ".log"), restored=True)) for db in DATABASES}
        catalog = {db: catalog_metadata(sessions[db]) for db in DATABASES}
        data = {db: data_metadata(sessions[db]) for db in DATABASES}
        write_json(dest / ("catalog-" + suffix + ".json"), catalog)
        write_json(dest / ("data-" + suffix + ".json"), data)
        return catalog, data


def sequence_values(cid, dest, suffix):
    """Check persisted sequence values across the copy restart.

    Sequence state is not MVCC: it deliberately stays out of the source snapshot
    comparison. pg_dump captures its own SEQUENCE SET state; compare the restored
    values before/after restart, and retain the archive's original sequence TOC.
    """
    result = {}
    with contextlib.ExitStack() as stack:
        for db in DATABASES:
            session = stack.enter_context(Snapshot(cid, db, dest / (db + "-sequences-" + suffix + ".log"), restored=True))
            names = session.json(f"""SELECT coalesce(jsonb_agg(jsonb_build_array(n.nspname,c.relname)
               ORDER BY n.nspname,c.relname),'[]') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
               WHERE {USER_SCHEMA} AND c.relkind='S'""")
            result[db] = {schema + "." + name: session.json(
                "SELECT jsonb_build_object('last_value',last_value,'is_called',is_called) FROM "
                + identifier(schema) + "." + identifier(name)) for schema, name in names}
    write_json(dest / ("sequences-" + suffix + ".json"), result)
    return result


def cleanup_copy(cid, project):
    copy = inspect_container(cid)
    validate_copy(copy, project)
    volumes = [m["Name"] for m in copy["Mounts"]]
    for volume in volumes:
        label = run(["docker", "volume", "inspect", "--format", '{{index .Labels "com.docker.compose.project"}}', volume]).decode().strip()
        require(label == project, "cleanup_volume_owner")
    run(["docker", "rm", "-f", cid])
    for volume in volumes:
        run(["docker", "volume", "rm", volume])


def publish_attestation(value):
    private_dir(STATE_ROOT)
    target = STATE_ROOT / "backup-attestation.json"
    if target.exists() or target.is_symlink():
        info = target.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600, "attestation_file_owner")
    temporary = STATE_ROOT / (".backup-attestation-" + secrets.token_hex(8))
    write_json(temporary, value)
    os.replace(temporary, target)


def verify_backup():
    preflight()
    private_dir(STATE_ROOT)
    backups = STATE_ROOT / "backups"
    if not backups.exists():
        private_dir(backups, create=True)
    private_dir(backups)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    nonce = secrets.token_hex(4)
    dest = backups / (stamp + "-" + nonce)
    private_dir(dest, create=True)
    project = "ainativecrm-backup-" + stamp.lower() + "-" + nonce
    evidence = {"started_at": dt.datetime.now(dt.timezone.utc).isoformat(), "project": project,
                "source_container_id": SOURCE_CONTAINER_ID, "source_system_identifier": SOURCE_SYSTEM_ID,
                "source_database_writes": False, "restore_verified": False, "copy_removed": False}
    try:
        with contextlib.ExitStack() as stack:
            sessions = {db: stack.enter_context(Snapshot(SOURCE_CONTAINER_ID, db, dest / (db + "-source.log"))) for db in DATABASES}
            evidence["source_identity"] = source_identity(sessions["postgres"])
            expected_catalog = source_catalog_metadata(sessions)
            expected_data = {db: data_metadata(sessions[db]) for db in DATABASES}
            objects = capture_compensation(sessions["postgres"])
            write_json(dest / "catalog-source.json", expected_catalog)
            write_json(dest / "data-source.json", expected_data)
            write_json(dest / "managed-objects.json", objects)
            private_write(dest / "managed-objects.sql", build_compensation(objects))
            backup_files(dest, sessions, expected_data["postgres"])
        # Normal worker data writes may continue; schema/roles must remain fixed.
        require_equal(expected_catalog, source_catalog_metadata(), "source_catalog_stability")
        cid, pgctl = restore_copy(dest, project)
        catalog, data = copy_fingerprints(cid, dest, "restore")
        require_equal(expected_catalog, catalog, "catalog")
        require_equal(expected_data, data, "data")
        sequence_before = sequence_values(cid, dest, "restore")
        restore_exec(cid, ["tar", "-czf", "-", "-C", "/restore-storage", "."], output=dest / "storage-restored.tar.gz")
        require_equal(tar_manifest(dest / "storage-files.tar.gz"), tar_manifest(dest / "storage-restored.tar.gz"), "storage_restore")
        restore_exec(cid, pgctl + ["-m", "fast", "restart"], user="postgres")
        catalog, data = copy_fingerprints(cid, dest, "restart")
        require_equal(expected_catalog, catalog, "restart_catalog")
        require_equal(expected_data, data, "restart_data")
        require_equal(sequence_before, sequence_values(cid, dest, "restart"), "restart_sequences")
        preflight()
        require_equal(expected_catalog, source_catalog_metadata(), "source_catalog_postflight")
        evidence.update({"restore_verified": True, "differences": 0,
                         "source_catalog_sha256": canonical_hash(expected_catalog),
                         "restart_verified": True, "storage_verified": True})
        cleanup_copy(cid, project)
        evidence["copy_removed"] = True
        evidence["files"] = [{"file": p.name, "bytes": p.stat().st_size, "sha256": file_hash(p)}
                             for p in sorted(dest.iterdir()) if p.is_file()]
        evidence["verified_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
        write_json(dest / "evidence.json", evidence)
        attestation = {"verified_at": evidence["verified_at"], "source_system_identifier": SOURCE_SYSTEM_ID,
                       "source_database": "postgres", "source_catalog_sha256": evidence["source_catalog_sha256"],
                       "restore_verified": True, "differences": 0, "backup_directory": str(dest),
                       "evidence_sha256": file_hash(dest / "evidence.json")}
        publish_attestation(attestation)
        return attestation
    except BaseException as error:
        evidence["failure_stage"] = error.stage if isinstance(error, VerificationError) else "unexpected_error"
        evidence["failed_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
        write_json(dest / "failure.json", evidence)
        # Failed copies remain for inspection. Never overwrite an earlier proof.
        raise VerificationError(evidence["failure_stage"]) from None


def main():
    os.umask(0o077)
    try:
        require(sys.argv[1:] in ([], ["--identity-readonly"]), "unsupported_arguments")
        if sys.argv[1:]:
            preflight()
            result = {"source_system_identifier": SOURCE_SYSTEM_ID,
                      "source_catalog_sha256": canonical_hash(source_catalog_metadata())}
        else:
            # Serialize backup attempts independently of the deploy lock.
            import fcntl
            require(os.geteuid() == 0, "root_required")
            private_dir(STATE_ROOT)
            fd = os.open(STATE_ROOT / "backup.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                result = verify_backup()
        print(json.dumps(result, sort_keys=True))
    except BaseException as error:
        stage = error.stage if isinstance(error, VerificationError) else "unexpected_error"
        print(json.dumps({"restore_verified": False, "error": stage}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
