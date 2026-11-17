"""Explicit real-PostgreSQL fixture runner, not a production backup/deploy tool.

Creates only its own capped, networkless, tmpfs-only container from an already
cached image. Never accepts a source container, host database URL, or host mount.
Run explicitly; unittest discovery does not execute this file.
"""
import datetime as dt
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
IMAGE = "supabase/postgres:17.6.1.136@sha256:f371b5f3f2ac0a05703f33d6e6134515fb2498cab708fb948a0aeb7481467c00"
NAME = "ainativecrm-catalog-test-" + uuid.uuid4().hex[:12]
NOW = "2026-11-17T12:00:00+00:00"


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "deploy/staging" / (name + ".py"))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


policy_module = module("catalog_policy")
backup = module("backup_verify")


class IsolatedDatabase:
    def __init__(self):
        self.cid = None

    def docker(self, *args, data=None):
        result = subprocess.run(["docker", *args], input=data, capture_output=True, timeout=90)
        if result.returncode:
            raise RuntimeError("isolated_command_failed_" + str(result.returncode))
        return result.stdout

    def check(self):
        row = json.loads(self.docker("inspect", self.cid))[0]
        assert row["Id"] != backup.SOURCE_CONTAINER_ID
        assert row["Name"] == "/" + NAME and row["Config"]["Labels"].get("ainativecrm.test") == NAME
        assert row["HostConfig"]["NetworkMode"] == "none" and not row["HostConfig"].get("PortBindings")
        assert row["HostConfig"]["ReadonlyRootfs"] is True
        assert row["HostConfig"]["Memory"] == 1024 ** 3 and row["HostConfig"]["NanoCpus"] == 10 ** 9
        assert all(m["Type"] == "tmpfs" for m in row["Mounts"]), "test_refuses_host_or_existing_volume_mount"
        return row

    def start(self):
        image = json.loads(self.docker("image", "inspect", IMAGE))[0]
        assert image["Architecture"] == "arm64"
        self.cid = self.docker("run", "-d", "--pull=never", "--name", NAME,
            "--label", "ainativecrm.test=" + NAME, "--network", "none", "--read-only",
            "--memory", "1g", "--cpus", "1", "--pids-limit", "128",
            "--security-opt", "no-new-privileges:true", "--log-driver", "none",
            "--tmpfs", "/tmp:rw,size=512m,mode=1777",
            "--tmpfs", "/var/lib/postgresql/data:rw,size=1m",
            "--entrypoint", "sleep", IMAGE, "infinity").decode().strip()
        self.check()
        self.exec("mkdir", "/tmp/restore-socket")
        self.exec("initdb", "-D", "/tmp/catalog-pg", "-U", "supabase_admin", "--auth-local=trust", "--auth-host=reject")
        self.pgctl("start")
        self.sql("postgres", "CREATE ROLE supabase_realtime_admin; CREATE ROLE dashboard_user; CREATE ROLE anon; "
                 "CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE postgres;")

    def exec(self, *args, data=None):
        self.check()
        return self.docker("exec", "-i", "--user", "postgres", self.cid, *args, data=data)

    def pgctl(self, action):
        return self.exec("pg_ctl", "-D", "/tmp/catalog-pg", "-l", "/tmp/catalog-pg.log", "-w", "-t", "60",
            "-o", "-c listen_addresses='' -c unix_socket_directories=/tmp/restore-socket -c shared_buffers=32MB "
                  "-c max_connections=10 -c wal_level=logical -c max_wal_senders=2 -c logging_collector=off "
                  "-c log_statement=none -c log_min_messages=fatal", "-m", "fast", action)

    def sql(self, database, sql):
        assert re.fullmatch(r"(?:postgres|catalog_case_[0-9]+|catalog_restore)", database)
        return self.exec("psql", "-X", "-qAt", "--no-password", "-v", "ON_ERROR_STOP=1",
                         "-h", "/tmp/restore-socket", "-U", "supabase_admin", "-d", database, data=sql.encode())

    def close(self):
        if self.cid:
            self.check()
            self.docker("rm", "-f", self.cid)
            assert not self.docker("ps", "-aq", "--filter", "label=ainativecrm.test=" + NAME).strip()


class Session:
    def __init__(self, instance, database):
        self.instance, self.database = instance, database

    def json(self, query):
        return json.loads(self.instance.sql(self.database, "BEGIN READ ONLY; SET LOCAL search_path=pg_catalog; " + query + "; ROLLBACK;"))


def snapshot(instance, database):
    session = Session(instance, database)
    # Same two-database shape as the actual verifier; the empty secondary Catalog
    # is an explicit fixture, not a claim about the real _supabase database.
    catalog = {"postgres": backup.catalog_metadata(session), "_supabase": {}}
    topology = session.json(policy_module.INVENTORY_SQL)
    data = backup.data_metadata(session)
    return catalog, topology, data


DDL = """
CREATE SCHEMA realtime AUTHORIZATION supabase_realtime_admin;
CREATE SCHEMA auth;
CREATE SCHEMA storage;
CREATE TABLE public.protected(id integer PRIMARY KEY, tenant integer);
ALTER TABLE public.protected ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON public.protected FOR SELECT USING (tenant=1);
CREATE TABLE auth.protected(id integer);
CREATE TABLE storage.protected(id integer);
CREATE FUNCTION public.guard() RETURNS integer LANGUAGE sql AS 'SELECT 1';
CREATE TABLE realtime.messages (
 topic text NOT NULL, extension text NOT NULL, payload jsonb, event text,
 private boolean DEFAULT false, updated_at timestamp NOT NULL DEFAULT now(),
 inserted_at timestamp NOT NULL DEFAULT now(), id uuid NOT NULL DEFAULT gen_random_uuid(),
 binary_payload bytea, skip_broadcast boolean NOT NULL DEFAULT false,
 PRIMARY KEY(id,inserted_at), CONSTRAINT messages_payload_exclusive CHECK(payload IS NULL OR binary_payload IS NULL)
) PARTITION BY RANGE(inserted_at);
ALTER TABLE realtime.messages OWNER TO supabase_realtime_admin;
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
CREATE INDEX messages_inserted_at_topic_index ON realtime.messages USING btree(inserted_at DESC,topic)
 WHERE ((extension='broadcast'::text) AND (private IS TRUE));
CREATE PUBLICATION supabase_realtime_messages_publication FOR TABLE realtime.messages;
"""


def create_partition(instance, database, day):
    name = "messages_" + day.strftime("%Y_%m_%d")
    tomorrow = (day + dt.timedelta(days=1)).isoformat()
    instance.sql(database, f"CREATE TABLE realtime.{name} PARTITION OF realtime.messages FOR VALUES FROM ('{day}') TO ('{tomorrow}');"
        f"ALTER TABLE realtime.{name} OWNER TO supabase_realtime_admin; SET ROLE supabase_realtime_admin; "
        f"GRANT ALL ON realtime.{name} TO dashboard_user,postgres; "
        f"GRANT INSERT,SELECT ON realtime.{name} TO postgres WITH GRANT OPTION; RESET ROLE;")


def run():
    instance = IsolatedDatabase()
    results = []
    started = dt.datetime.now(dt.timezone.utc).isoformat()
    try:
        instance.start()
        scenarios = [
            ("same_name_not_attached", "ALTER TABLE realtime.messages DETACH PARTITION realtime.messages_2026_11_16"),
            ("owner", "ALTER TABLE realtime.messages_2026_11_16 OWNER TO anon"),
            ("acl", "GRANT SELECT ON realtime.messages_2026_11_16 TO anon"),
            ("rls", "ALTER TABLE realtime.messages_2026_11_16 ENABLE ROW LEVEL SECURITY"),
            ("extra_index", "CREATE INDEX unexpected ON realtime.messages_2026_11_16(topic)"),
            ("extra_constraint", "ALTER TABLE realtime.messages_2026_11_16 ADD CHECK (topic<>'blocked')"),
            ("extra_trigger", "CREATE FUNCTION public.trg() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$; CREATE TRIGGER unexpected BEFORE INSERT ON realtime.messages_2026_11_16 FOR EACH ROW EXECUTE FUNCTION public.trg()"),
            ("public_change", "ALTER TABLE public.protected ADD COLUMN unreviewed text"),
            ("auth_change", "ALTER TABLE auth.protected ADD COLUMN unreviewed text"),
            ("storage_change", "ALTER TABLE storage.protected ADD COLUMN unreviewed text"),
            ("function_change", "CREATE OR REPLACE FUNCTION public.guard() RETURNS integer LANGUAGE sql AS 'SELECT 2'"),
            ("policy_change", "ALTER POLICY tenant_guard ON public.protected USING (true)"),
            ("role_change", "ALTER ROLE anon SUPERUSER"),
            ("publication_extra", "CREATE PUBLICATION unreviewed FOR TABLE realtime.messages_2026_11_16"),
            ("recent_removal", "DROP TABLE realtime.messages_2026_11_16"),
        ]
        for number, (label, mutation) in enumerate(scenarios):
            database = "catalog_case_" + str(number)
            instance.sql("postgres", "CREATE DATABASE " + database)
            try:
                instance.sql(database, DDL)
                create_partition(instance, database, dt.date(2026, 11, 16))
                old, topology, data = snapshot(instance, database)
                try:
                    policy = policy_module.build_policy(old, policy_module.digest(old), old, topology,
                                                         policy_module.SOURCE_CONTRACT, NOW)
                except policy_module.CatalogError as error:
                    raise RuntimeError("synthetic_fixture_contract:" + error.code + ":" +
                                       json.dumps(topology["partitions"][0]["constraints"])) from None
                policy_module.evaluate(old, topology, policy, NOW, policy_module.SOURCE_CONTRACT)
                instance.sql(database, mutation)
                catalog, topology, _ = snapshot(instance, database)
                try:
                    policy_module.evaluate(catalog, topology, policy, NOW, policy_module.SOURCE_CONTRACT)
                except policy_module.CatalogError as error:
                    results.append({"case": label, "rejected": True, "category": error.code})
                else:
                    raise AssertionError("mutation_was_not_rejected:" + label)
            finally:
                instance.sql("postgres", "ALTER ROLE anon NOSUPERUSER")
                instance.sql("postgres", "DROP DATABASE " + database)
        database = "catalog_case_99"
        instance.sql("postgres", "CREATE DATABASE " + database)
        instance.sql(database, DDL)
        create_partition(instance, database, dt.date(2026, 11, 16))
        old, topology, _ = snapshot(instance, database)
        policy = policy_module.build_policy(old, policy_module.digest(old), old, topology, policy_module.SOURCE_CONTRACT, NOW)
        for day in range(17, 21):
            create_partition(instance, database, dt.date(2026, 11, day))
        catalog, topology, _ = snapshot(instance, database)
        policy_module.evaluate(catalog, topology, policy, NOW, policy_module.SOURCE_CONTRACT)
        results.append({"case": "five_valid_days", "accepted": True})
        try:
            instance.sql(database, "CREATE TABLE realtime.messages_2026_11_21 PARTITION OF realtime.messages "
                                   "FOR VALUES FROM ('2026-11-16') TO ('2026-11-17')")
        except RuntimeError:
            results.append({"case": "overlapping_partition_postgres_rejects", "rejected": True})
        else:
            raise AssertionError("overlap_was_not_rejected")
        instance.sql(database, "INSERT INTO public.protected VALUES(1,1); INSERT INTO realtime.messages(topic,extension,inserted_at) VALUES('synthetic','broadcast','2026-11-17')")
        catalog, topology, data = snapshot(instance, database)
        archive = instance.exec("pg_dump", "-h", "/tmp/restore-socket", "-U", "supabase_admin", "-Fc", database)
        instance.sql("postgres", "CREATE DATABASE catalog_restore")
        instance.exec("pg_restore", "--exit-on-error", "-h", "/tmp/restore-socket", "-U", "supabase_admin", "-d", "catalog_restore", data=archive)
        restored, restored_topology, restored_data = snapshot(instance, "catalog_restore")
        backup.require_equal(catalog, restored, "catalog")
        backup.require_equal(data, restored_data, "data")
        try:
            policy_module.evaluate(restored, restored_topology, policy, NOW, policy_module.SOURCE_CONTRACT,
                                   logical_restore=True)
        except policy_module.CatalogError as error:
            raise RuntimeError("synthetic_restore_contract:" + error.code + ":" + json.dumps({
                "source": topology["partitions"][0]["constraints"],
                "restored": restored_topology["partitions"][0]["constraints"],
            })) from None
        results.append({"case": "dump_restore_data_and_catalog_exact", "accepted": True, "archive_sha256": hashlib.sha256(archive).hexdigest()})
        instance.pgctl("restart")
        restarted, restarted_topology, restarted_data = snapshot(instance, "catalog_restore")
        backup.require_equal(catalog, restarted, "restart_catalog")
        backup.require_equal(data, restarted_data, "restart_data")
        policy_module.evaluate(restarted, restarted_topology, policy, NOW, policy_module.SOURCE_CONTRACT,
                               logical_restore=True)
        results.append({"case": "isolated_postgres_restart_exact", "accepted": True})
        instance.sql("catalog_restore", "UPDATE public.protected SET tenant=2")
        changed_data = snapshot(instance, "catalog_restore")[2]
        try:
            backup.require_equal(data, changed_data, "data")
        except backup.VerificationError:
            results.append({"case": "restore_row_tamper", "rejected": True})
        else:
            raise AssertionError("restore_data_tamper_accepted")
    finally:
        instance.close()
    return {"started_utc": started, "finished_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
            "project": NAME, "postgres_image": IMAGE, "source_database_accessed": False,
            "network": "none", "memory_limit": "1g", "cpu_limit": 1, "copy_removed": True,
            "cases": results, "all_passed": True}


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
