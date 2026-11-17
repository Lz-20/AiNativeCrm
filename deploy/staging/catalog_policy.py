"""Pure, fail-closed Catalog projection for one reviewed Realtime release.

This module never runs SQL, writes a baseline, or changes deployment authority.
Raw source/restore Catalogs must still compare exactly in backup_verify.py.
Only an independently installed root-owned policy enables this projection.
"""
import copy
import datetime as dt
import hashlib
import json
import re


SOURCE_CONTRACT = {
    "kind": "reviewed-upstream-mechanism",
    "repository": "https://github.com/supabase/realtime",
    "tag": "v2.143.3",
    "commit": "d46540b3a4a79113f40301d5e5cb690f41150b9b",
    "image_id": "sha256:768b559241dd234c4e8852c5c0f504e598b80f1df2ad4dd78d5486fbed2f17a2",
}
NAME = re.compile(r"messages_(\d{4}_\d{2}_\d{2})\Z")
HASH = re.compile(r"[a-f0-9]{64}\Z")
TOKEN = "messages__reviewed_day__"
CLASSES = ("relations", "columns", "indexes", "constraints", "types", "publication_tables")
POLICY_KEYS = {"format", "source_contract", "legacy_catalog_sha256", "static_catalog_sha256",
               "approved_at", "initial_partitions", "template_catalog"}


class CatalogError(ValueError):
    """Only fixed category names escape; never include Catalog payloads."""
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def need(condition, code):
    if not condition:
        raise CatalogError(code)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False).encode()).hexdigest()


def parse_policy(raw):
    """A reviewer must never see a different key value from the parser."""
    def pairs(items):
        result = {}
        for key, value in items:
            need(key not in result, "catalog_policy_duplicate_key")
            result[key] = value
        return result
    def constant(_value):
        raise CatalogError("catalog_policy_nonfinite_number")
    try:
        value = json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    except (ValueError, TypeError, UnicodeError) as error:
        if isinstance(error, CatalogError):
            raise
        raise CatalogError("catalog_policy_json") from None
    need(isinstance(value, dict), "catalog_policy_format")
    return value


def date_of(name):
    match = NAME.fullmatch(name) if isinstance(name, str) else None
    need(match is not None, "dynamic_partition_name")
    try:
        value = dt.datetime.strptime(match[1], "%Y_%m_%d").date()
    except ValueError:
        raise CatalogError("dynamic_partition_date") from None
    need(value.strftime("%Y_%m_%d") == match[1], "dynamic_partition_date")
    return value


def timestamp(value):
    try:
        parsed = dt.datetime.fromisoformat(value)
    except (ValueError, TypeError):
        raise CatalogError("catalog_timestamp") from None
    need(parsed.tzinfo is not None, "catalog_timestamp")
    return parsed.astimezone(dt.timezone.utc)


def owned_row(kind, row, name):
    if kind == "relations":
        return row.get("schema_name") == "realtime" and row.get("relname") == name
    if kind == "types":
        return row.get("schema_name") == "realtime" and row.get("typname") in (name, "_" + name)
    if kind == "publication_tables":
        return row.get("schemaname") == "realtime" and row.get("tablename") == name
    return row.get("schema_name") == "realtime" and row.get("table_name") == name


def names_in(catalog):
    need(isinstance(catalog, dict) and set(catalog) == {"postgres", "_supabase"}, "catalog_database_set")
    rows = catalog["postgres"].get("relations")
    need(isinstance(rows, list), "catalog_relations_missing")
    names = [r["relname"] for r in rows if r.get("schema_name") == "realtime"
             and isinstance(r.get("relname"), str) and NAME.fullmatch(r["relname"])]
    need(len(names) == len(set(names)), "dynamic_partition_duplicate")
    for name in names:
        date_of(name)
    return sorted(names)


def topology_by_name(topology, names, logical_restore=False):
    need(isinstance(topology, dict) and set(topology) == {"parent", "partitions"}, "partition_inventory_shape")
    parent = topology["parent"]
    need(isinstance(parent, dict) and set(parent) == {"oid", "schema", "name", "kind", "key"}, "partition_parent_shape")
    need(type(parent["oid"]) is int and 0 < parent["oid"] < 2 ** 32
         and {k: v for k, v in parent.items() if k != "oid"} ==
         {"schema": "realtime", "name": "messages", "kind": "p", "key": "RANGE (inserted_at)"}, "partition_parent")
    need(isinstance(topology["partitions"], list), "partition_inventory_shape")
    result = {}
    seen_oids = {parent["oid"]}
    for row in topology["partitions"]:
        need(isinstance(row, dict) and isinstance(row.get("name"), str), "partition_inventory_shape")
        name = row["name"]
        need(name not in result, "dynamic_partition_duplicate")
        need(type(row.get("oid")) is int and 0 < row["oid"] < 2 ** 32
             and row["oid"] not in seen_oids, "partition_oid")
        seen_oids.add(row["oid"])
        day = date_of(name)
        expected_bound = ("FOR VALUES FROM ('" + day.isoformat() + " 00:00:00') TO ('"
                          + (day + dt.timedelta(days=1)).isoformat() + " 00:00:00')")
        expected = {"oid": row["oid"], "schema": "realtime", "name": name, "kind": "r",
                    "partition": True, "persistence": "p", "tablespace": 0, "options": None,
                    "has_rules": False, "security_labels": 0, "replica_identity": "d",
                    "access_method": "heap", "parent_oids": [parent["oid"]], "bound": expected_bound,
                    "extension_memberships": [], "rules": [], "direct_publications": [], "extra_dependents": []}
        need(set(row) == set(expected) | {"indexes", "constraints", "types"}, "partition_inventory_fields")
        need(all(row[k] == v for k, v in expected.items()), "partition_topology_or_bound")
        need(row["indexes"] == expected_indexes(name), "partition_index_contract")
        constraints = expected_constraints(name)
        # pg_dump/pg_restore may mark the attached PRIMARY KEY connoinherit=true.
        # Only the guarded logical-restore copy accepts that representation. The
        # source gate stays exact, and CHECK inheritance/parent linkage stay exact.
        if logical_restore and isinstance(row["constraints"], list) and len(row["constraints"]) == 2:
            value = row["constraints"][0].get("noinherit")
            need(type(value) is bool, "partition_constraint_contract")
            constraints[0]["noinherit"] = value
        need(row["constraints"] == constraints, "partition_constraint_contract")
        need(row["types"] == expected_types(name, row["oid"]), "partition_type_dependencies")
        result[name] = row
    need(set(result) == set(names), "partition_inventory_catalog_disagreement")
    return result


def expected_indexes(name):
    specs = [("_inserted_at_topic_idx", "messages_inserted_at_topic_index", False,
              "(inserted_at DESC, topic) WHERE ((extension = 'broadcast'::text) AND (private IS TRUE))"),
             ("_pkey", "messages_pkey", True, "(id, inserted_at)")]
    return [{"name": name + suffix, "schema": "realtime", "owner": "supabase_realtime_admin",
             "kind": "i", "partition": True, "options": None, "tablespace": 0,
             "definition": "CREATE " + ("UNIQUE " if unique else "") + "INDEX " + name + suffix
                           + " ON realtime." + name + " USING btree " + definition,
             "parent_indexes": [{"schema": "realtime", "name": parent}]}
            for suffix, parent, unique, definition in specs]


def expected_constraints(name):
    return [{"name": name + "_pkey", "definition": "PRIMARY KEY (id, inserted_at)", "islocal": False,
             "inherit_count": 1, "noinherit": False, "parent_name": "messages_pkey"},
            {"name": "messages_payload_exclusive", "definition": "CHECK (payload IS NULL OR binary_payload IS NULL)",
             "islocal": False, "inherit_count": 1, "noinherit": False, "parent_name": None}]


def expected_types(name, oid):
    return [{"name": "_" + name, "schema": "realtime", "kind": "b", "relation_oid": 0,
             "element_type": name, "element_schema": "realtime", "array_type": None, "array_schema": None},
            {"name": name, "schema": "realtime", "kind": "c", "relation_oid": oid,
             "element_type": None, "element_schema": None, "array_type": "_" + name, "array_schema": "realtime"}]


def canonical_rows(catalog, name, topology):
    """Normalize only identifiers known to this validated relation, never a schema wildcard."""
    result = {}
    for kind in CLASSES:
        need(isinstance(catalog.get(kind), list), "catalog_class_missing")
        rows = copy.deepcopy([r for r in catalog[kind] if owned_row(kind, r, name)])
        if kind == "indexes":
            by_name = {r["name"]: r for r in topology["indexes"]}
            for row in rows:
                index = by_name.get(row.get("index_name"))
                need(index is not None and row["definition_hash"] == hashlib.md5(index["definition"].encode()).hexdigest(),
                     "partition_index_catalog_disagreement")
                row["definition_hash"] = hashlib.md5(index["definition"].replace(name, TOKEN).encode()).hexdigest()
        def replace(value):
            if isinstance(value, str):
                return value.replace(name, TOKEN)
            if isinstance(value, list):
                return [replace(v) for v in value]
            if isinstance(value, dict):
                return {k: replace(v) for k, v in value.items()}
            return value
        rows = [replace(row) for row in rows]
        result[kind] = sorted(rows, key=lambda v: json.dumps(v, sort_keys=True))
    return result


def check_template(template):
    need(isinstance(template, dict) and set(template) == set(CLASSES), "partition_template_shape")
    need([len(template[k]) for k in CLASSES] == [1, 10, 2, 2, 2, 1], "partition_template_counts")
    relation = template["relations"][0]
    need(relation.get("owner") == "supabase_realtime_admin" and relation.get("relkind") == "r"
         and relation.get("relrowsecurity") is False and relation.get("relforcerowsecurity") is False,
         "partition_template_owner_rls")
    # Direct anon/authenticated/service_role access to leaf tables must remain absent.
    need(set(relation.get("acl", [])) == {
        "dashboard_user=arwdDxtm/supabase_realtime_admin", "postgres=a*r*wdDxtm/supabase_realtime_admin",
        "supabase_realtime_admin=arwdDxtm/supabase_realtime_admin"}, "partition_template_acl")
    need(template["publication_tables"][0].get("pubname") == "supabase_realtime_messages_publication"
         and template["publication_tables"][0].get("rowfilter") is None, "partition_template_publication")


def validate_policy(policy, legacy_hash):
    need(isinstance(policy, dict) and set(policy) == POLICY_KEYS and type(policy["format"]) is int
         and policy["format"] == 1, "catalog_policy_format")
    need(policy["source_contract"] == SOURCE_CONTRACT, "partition_source_unreviewed")
    need(isinstance(legacy_hash, str) and HASH.fullmatch(legacy_hash) is not None
         and policy["legacy_catalog_sha256"] == legacy_hash, "catalog_policy_legacy_anchor")
    need(isinstance(policy["static_catalog_sha256"], str) and HASH.fullmatch(policy["static_catalog_sha256"]) is not None,
         "catalog_static_hash")
    timestamp(policy["approved_at"])
    validate_names(policy["initial_partitions"])
    check_template(policy["template_catalog"])


def validate_names(names):
    need(isinstance(names, list) and all(isinstance(v, str) for v in names)
         and len(names) == len(set(names)), "partition_history_shape")
    for name in names:
        date_of(name)


def evaluate(catalog, topology, policy, observed_at, origin, previous_names=None, *, logical_restore=False):
    validate_policy(policy, policy.get("legacy_catalog_sha256"))
    need(origin == SOURCE_CONTRACT, "partition_source_unreviewed")
    now = timestamp(observed_at)
    need(now >= timestamp(policy["approved_at"]), "catalog_observation_before_policy")
    names = names_in(catalog)
    need(type(logical_restore) is bool, "catalog_validation_context")
    by_name = topology_by_name(topology, names, logical_restore)
    previous = policy["initial_partitions"] if previous_names is None else previous_names
    validate_names(previous)
    for name in set(names) - set(previous):
        need(now.date() - dt.timedelta(days=1) <= date_of(name) <= now.date() + dt.timedelta(days=3),
             "partition_creation_outside_reviewed_window")
    for name in set(previous) - set(names):
        need(date_of(name) < now.date() - dt.timedelta(days=3), "partition_removed_before_retention")
    for name in names:
        need(date_of(name) <= now.date() + dt.timedelta(days=3), "partition_future_bound")
        need(canonical_rows(catalog["postgres"], name, by_name[name]) == policy["template_catalog"],
             "partition_catalog_attributes_changed")
    static = copy.deepcopy(catalog)
    for kind in CLASSES:
        static["postgres"][kind] = [r for r in static["postgres"][kind]
                                     if not any(owned_row(kind, r, name) for name in names)]
    static_hash = digest(static)
    need(static_hash == policy["static_catalog_sha256"], "database_static_catalog_drift")
    return {"format": 1, "context": "logical_restore" if logical_restore else "source",
            "policy_sha256": digest(policy), "static_catalog_sha256": static_hash,
            "raw_catalog_sha256": digest(catalog), "partition_names": names,
            "previous_partition_names": sorted(previous), "observed_at": observed_at,
            "source_contract": origin, "partition_inventory_sha256": digest(topology)}


def build_policy(approved_catalog, approved_hash, current_catalog, topology, origin, approved_at):
    """Offline review aid. Requires the original authenticated Catalog, not a newly blessed hash.

    It permits NO static difference between the old approved snapshot and current
    snapshot. Caller must separately authenticate the old snapshot against state
    and evidence.json. No policy file or state is written by this function.
    """
    need(digest(approved_catalog) == approved_hash, "original_catalog_anchor_mismatch")
    need(origin == SOURCE_CONTRACT, "partition_source_unreviewed")
    old_names = names_in(approved_catalog)
    need(bool(old_names), "reviewed_original_partition_required")
    current_names = names_in(current_catalog)
    by_name = topology_by_name(topology, current_names)
    need(set(old_names).issubset(by_name), "original_partition_topology_unavailable")
    template = canonical_rows(approved_catalog["postgres"], old_names[0], by_name[old_names[0]])
    check_template(template)
    static = copy.deepcopy(approved_catalog)
    for kind in CLASSES:
        static["postgres"][kind] = [r for r in static["postgres"][kind]
                                     if not any(owned_row(kind, r, name) for name in old_names)]
    policy = {"format": 1, "source_contract": origin, "legacy_catalog_sha256": approved_hash,
              "static_catalog_sha256": digest(static), "approved_at": approved_at,
              "initial_partitions": old_names, "template_catalog": template}
    # Old rows are checked too; changing an original partition cannot manufacture a template.
    for name in old_names:
        need(canonical_rows(approved_catalog["postgres"], name, by_name[name]) == template,
             "original_partitions_disagree")
    evaluate(current_catalog, topology, policy, approved_at, origin)
    policy["initial_partitions"] = current_names
    return policy


# Read-only, same-snapshot OID relationships. No customer row content.
INVENTORY_SQL = r"""

SELECT jsonb_build_object(
 'parent', (SELECT jsonb_build_object('oid',c.oid::bigint,'schema','realtime','name',c.relname,'kind',c.relkind,'key',pg_get_partkeydef(c.oid)) FROM pg_class c WHERE c.oid='realtime.messages'::regclass),
 'partitions', coalesce((SELECT jsonb_agg(jsonb_build_object(
  'oid',c.oid::bigint,'schema','realtime','name',c.relname,'kind',c.relkind,'partition',c.relispartition,'persistence',c.relpersistence,'tablespace',c.reltablespace::bigint,'options',c.reloptions,'has_rules',c.relhasrules,'security_labels',(SELECT count(*) FROM pg_seclabel l WHERE l.classoid='pg_class'::regclass AND l.objoid=c.oid),'replica_identity',c.relreplident,'access_method',(SELECT amname FROM pg_am WHERE oid=c.relam),
  'parent_oids',(SELECT jsonb_agg(inhparent::bigint ORDER BY inhseqno) FROM pg_inherits WHERE inhrelid=c.oid),
  'bound',pg_get_expr(c.relpartbound,c.oid),
  'indexes',(SELECT jsonb_agg(jsonb_build_object('name',ic.relname,'schema',ins.nspname,'owner',pg_get_userbyid(ic.relowner),'kind',ic.relkind,'partition',ic.relispartition,'options',ic.reloptions,'tablespace',ic.reltablespace::bigint,'definition',pg_get_indexdef(ic.oid),'parent_indexes',(SELECT jsonb_agg(jsonb_build_object('schema',pn.nspname,'name',pc.relname) ORDER BY pn.nspname,pc.relname) FROM pg_inherits ii JOIN pg_class pc ON pc.oid=ii.inhparent JOIN pg_namespace pn ON pn.oid=pc.relnamespace WHERE ii.inhrelid=ic.oid)) ORDER BY ic.relname) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid JOIN pg_namespace ins ON ins.oid=ic.relnamespace WHERE i.indrelid=c.oid),
  'constraints',(SELECT jsonb_agg(jsonb_build_object('name',k.conname,'definition',pg_get_constraintdef(k.oid,true),'islocal',k.conislocal,'inherit_count',k.coninhcount,'noinherit',k.connoinherit,'parent_name',(SELECT p.conname FROM pg_constraint p WHERE p.oid=k.conparentid)) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
  'types',(SELECT jsonb_agg(jsonb_build_object('name',t.typname,'schema',tn.nspname,'kind',t.typtype,'relation_oid',t.typrelid::bigint,'element_type',et.typname,'element_schema',en.nspname,'array_type',at.typname,'array_schema',an.nspname) ORDER BY t.typname) FROM pg_type t JOIN pg_namespace tn ON tn.oid=t.typnamespace LEFT JOIN pg_type et ON et.oid=t.typelem LEFT JOIN pg_namespace en ON en.oid=et.typnamespace LEFT JOIN pg_type at ON at.oid=t.typarray LEFT JOIN pg_namespace an ON an.oid=at.typnamespace WHERE t.oid IN (c.reltype,(SELECT typarray FROM pg_type WHERE oid=c.reltype))),
  'extension_memberships',(SELECT coalesce(jsonb_agg(e.extname),'[]') FROM pg_depend d JOIN pg_extension e ON d.refclassid='pg_extension'::regclass AND e.oid=d.refobjid WHERE d.deptype='e' AND ((d.classid='pg_class'::regclass AND d.objid IN (SELECT c.oid UNION ALL SELECT indexrelid FROM pg_index WHERE indrelid=c.oid)) OR (d.classid='pg_type'::regclass AND d.objid IN (c.reltype,(SELECT typarray FROM pg_type WHERE oid=c.reltype))))),
  'rules',(SELECT coalesce(jsonb_agg(pg_get_ruledef(oid,true)),'[]') FROM pg_rewrite WHERE ev_class=c.oid),
  'direct_publications',(SELECT coalesce(jsonb_agg(p.pubname),'[]') FROM pg_publication_rel pr JOIN pg_publication p ON p.oid=pr.prpubid WHERE pr.prrelid=c.oid),
  'extra_dependents',(SELECT coalesce(jsonb_agg(jsonb_build_object('class',d.classid::regclass::text,'type',d.deptype,'description',pg_describe_object(d.classid,d.objid,d.objsubid))),'[]') FROM pg_depend d WHERE d.refclassid='pg_class'::regclass AND d.refobjid=c.oid AND d.classid NOT IN ('pg_class'::regclass,'pg_type'::regclass,'pg_constraint'::regclass,'pg_attrdef'::regclass))
 ) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='realtime' AND c.relkind IN ('r','p','f') AND c.relname ~ '^messages_[0-9]{4}_[0-9]{2}_[0-9]{2}$'),'[]'))

"""
