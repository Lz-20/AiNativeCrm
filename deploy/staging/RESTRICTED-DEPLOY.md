# Staging release controller

This controller only replaces `app`, `worker`, and `scheduler` in the existing
`ainativecrm-staging` project. It does not run SQL migrations, delete volumes,
change Supabase, or execute candidate repository scripts on the host.

## Installation boundary

An operator installs these reviewed files as root. Workflows never update them:

| Repository file | Installed path | Owner / mode |
| --- | --- | --- |
| `deploy.sh` | `/usr/local/sbin/ainativecrm-staging-entry` | root:root 0755 |
| `engine.py` | `/usr/local/libexec/ainativecrm-staging/engine.py` | root:root 0644 |
| `backup_verify.py` | `/usr/local/libexec/ainativecrm-staging/backup_verify.py` | root:root 0644 |
| `catalog_policy.py` (optional reviewed policy support) | `/usr/local/libexec/ainativecrm-staging/catalog_policy.py` | root:root 0644 |
| `compose.release.yml` | `/usr/local/libexec/ainativecrm-staging/compose.release.yml` | root:root 0644 |
| `ssh-entry.sh` | `/usr/local/libexec/ainativecrm-staging/ssh-entry.sh` | root:root 0755 |
| `rollback.sh` | `/usr/local/libexec/ainativecrm-staging/rollback.sh` | root:root 0755 |

All parents of privileged code must also be root-owned and not writable by the
deployment principal. `/etc/ainativecrm-staging-deploy` and
`/var/lib/ainativecrm-staging-deploy` are root:root 0700. JSON state, credentials,
attestations, generated image-only environment, and journals use 0600. The
protected runtime file remains at
`/home/ubuntu/apps/AiNativeCrm-staging/final-20261027/private/app.env`, with its
existing owner and 0600 permissions. No workflow receives this file.

The dedicated SSH account has a locked password, no Docker group, no general
sudo permission, and no forwarding or PTY. Its authorized key uses:

```text
restrict,command="/usr/local/libexec/ainativecrm-staging/ssh-entry.sh" ssh-ed25519 PUBLIC_KEY
```

The sole sudoers rule must include the empty argument string, preventing extra
arguments; validate the installed file with `visudo -cf` before using the key:

```text
ainativecrm-deploy ALL=(root) NOPASSWD: /usr/local/sbin/ainativecrm-staging-entry ""
```

The client pins verified `known_hosts` and sends the command
`ainativecrm-deploy`, with a single bounded JSON document on stdin. The root
entry ignores SSH environment and uses Python isolated mode. The SSH account
does not control a script directory, Compose file, Git mirror, Docker context,
SSH server configuration, or the backup hook.

## Operator registration

`policy.json` in the protected config directory contains:

- `project`: `ainativecrm-staging`
- `repository`: `https://github.com/Lz-20/AiNativeCrm.git`
- `system_identifier`: the verified staging PostgreSQL identifier
- `db_container_id`: the complete verified staging DB container ID
- `compose_sha256`: SHA256 of the installed template's exact bytes

Initialize a root-owned bare `source.git` under the state directory, with origin
set to the fixed repository. The controller fetches `main` and checks ancestry;
it never checks out or executes source from the mirror. Private repository
access, if needed, uses a server-side read-only credential independent of the
deployment SSH key. Private GHCR pull access similarly stays on the VPS.

`state.json` records `format_version: 1`, `approved_schema_sha256`,
`approved_catalog_sha256`, `approved_source_sha`, `current`, `previous`,
`pending`, `rollback_verified`, and `auto_deploy_enabled`. Both flags begin
false. Set `rollback_verified` only after the operator has actually exercised
the preserved image/configuration rollback; enable automatic deployment only
after the manual GitHub release and deliberate failure drill pass.

### Independently approved Embedding 0412 expansion

The optional `schema_0412.py`/`migrate_0412.py` protocol supports exactly the
reviewed c5919aa → 6c66153 schema conversion. It is not an SSH operation and is
not installed or activated by merging a PR. No sudoers, forced-command,
container service set or Compose permission is added. See the operator review
and isolated test evidence before requesting a separate installation approval.

Independent root approval at `/etc/ainativecrm-staging-deploy/schema-0412-approval.json`
pins the old policy/release, the fixed Git SQL SHA256, database identity and all
exact added/removed Catalog rows. Original `approved_*` hashes and the original
Realtime policy file remain unchanged. The derived policy is recalculated from
the authenticated before/after catalogs, not supplied as a replacement hash.

The future local root entry accepts only `--apply`, `--register` or
`--retry-rolled-back`, runs only
from its installed protected directory, uses the existing deployment/backup
locks, and reads a separately installed `migration-0412.sql` whose bytes must
match the reviewed Git object. It has no image-update operation. `--apply`
requires fresh full backup/restore proof before a bounded DDL transaction and
again after commit. A persistent journal and immutable receipts under the
protected state directory block releases until registration completes.
`--register` can complete a verified committed transition after interruption;
it never re-executes SQL and refuses unexpected current/pending state.
`--retry-rolled-back` independently proves the old static schema and cluster
identity, refuses any still-held migration advisory lock, archives the entire
failed evidence directory without deletion, then starts a new fixed attempt.
It cannot be used for an expanded/committed schema or a changed release state.

Registered state records a separate `schema_0412` receipt while old image
declarations retain the old schema. Status reports the active database schema
in `schema_sha256` and the real current image schema separately in
`application_schema_sha256`. A new-schema source interval may contain only the
four fixed reviewed schema paths, must include the reviewed Git source, and
must have the exact new schema tree fingerprint. Other DDL remains blocked.

App rollback never rolls back SQL or deletes the new tables. Only the approved
immutable c5919aa image group is backward-compatible. Reverting to it is refused
when any new embedding profile is enabled or a source points at a new-profile
version; the controller never silently changes knowledge pointers. A failed
rollback retains pending recovery state. Installation and real migration remain
separate operator actions, never a consequence of CI approval alone.

The legacy `current` entry has `kind: "legacy"`, `sha: null`,
`schema_sha256`, and both `images` and `image_ids` mapping the three services to
their actual local `sha256:...` image IDs. It is an r4 snapshot, not a Git commit.
`approved_source_sha` separately records the reviewed equivalent source commit.
Set `previous` and `pending` to null initially. Keep the preserved r4 images and
original Compose snapshot until operator retention policy explicitly retires them.

Schema fingerprint is SHA256 of the raw bytes from:

```sh
git ls-tree -r -z --full-tree COMMIT -- supabase lib/database.types.ts
```

The server independently calculates this fingerprint and also checks all
intervening commits for schema/SQL changes, including changes subsequently
reverted. Changed schema, changed catalog, an older candidate commit, or
unregistered source stops automatic publication. A separate operator process
must review and register intentional schema changes. CI does not approve them.

`probe-credentials.json` contains exactly `email`, `password`, `user_id`,
`organization_id`, and `contact_id` for an existing ordinary staging manager
fixture. The fixture must not be a platform administrator. Credentials stay in
the root-only file. The deployment probe uses public Supabase authentication,
an authenticated user session, and GET requests to contacts, pipelines, and
tasks. It verifies the fixture contact is visible and logs out after probing.
The engine neither seeds users nor bypasses RLS for this probe.

## Deployment and recovery

Deploy JSON contains only `operation`, `trigger`, full `sha`,
`schema_sha256`, and the three bare immutable `sha256:...` image digests. The
engine constructs the fixed GHCR names. It pulls native ARM64 images and checks
their digest binding and source/revision/schema labels before replacing a
container. The installed Compose template fixes resources, networks, logging,
and the sole published port `127.0.0.1:3100`.

Every deploy or manual rollback first invokes the fixed backup helper, requiring
a newly issued restore-verification attestation, matching live database/catalog,
and intact evidence. Old attestations alone cannot authorize container changes.
Only after this gate does it write a pending release atomically, update each
service, check Docker health plus readiness, and perform ordinary-user API probes.
An independently reviewed root policy may separate validated Realtime date
partitions from the strictly protected static Catalog; without it the legacy
full-hash gate is unchanged. Raw restore/data comparisons remain exact in both
modes. See [CATALOG-POLICY.md](CATALOG-POLICY.md) for the narrow contract,
original-baseline anchoring and separate installation/rollback procedure.
It compares existing service states, Supabase container identities, listening
ports, and the protected environment hash before and after.

Commands over the restricted SSH key:

```sh
printf '%s\n' '{"operation":"status"}' | ssh -o StrictHostKeyChecking=yes ainativecrm-deploy@VPS_HOST ainativecrm-deploy
printf '%s\n' '{"operation":"rollback"}' | ssh -o StrictHostKeyChecking=yes ainativecrm-deploy@VPS_HOST ainativecrm-deploy
```

Ordinary manual deployment should use the workflow; it validates the requested
source and sends the generated SHA/digests. Root operators may use the installed
`rollback.sh`. A failed candidate restores all three prior images and repeats
the same probes. It never rolls back the database. An interrupted or failed
rollback preserves `pending` and blocks later deploy requests; `rollback`
retries the last known successful release. Avoid editing this journal to hide
an unresolved recovery.

Pause from an existing operator shell with:

```sh
sudo install -m 0600 /dev/null /var/lib/ainativecrm-staging-deploy/paused
```

Resume by removing this exact marker after reviewing the cause. The workflow
also has its independent repository variable switch. Pause blocks deployment
while leaving status and manual rollback available.

`deployments.jsonl` records timestamps, requested/committed SHA and digests,
failure stages, and rollback results without command output or secrets.
`state.json` retains current/previous releases; `backups/` holds protected
restore evidence and database/Storage backups. These paths are root-only; use an
operator SSH session for review. No cleanup command is part of the engine.

## Verification

```sh
python3 -m unittest discover -s tests/deployment -p 'test_*.py' -v
bash -n deploy/staging/deploy.sh deploy/staging/rollback.sh deploy/staging/ssh-entry.sh
```

Unit tests exercise rejection of untrusted requests/images and schema drift,
fresh-backup gating, serialized service updates, authenticated-probe failures,
complete three-image rollback, interrupted recovery, and paused/manual behavior.
These tests do not replace the first real ARM64 GitHub deployment and controlled
failure rollback drill on staging.
