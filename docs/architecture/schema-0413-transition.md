# Fixed 0412 → 0413 transition (independent controller installation)

Depends on **PR #13 / 6d2f700**, not the older controller in main. PR #13 itself
depends on PR #11. This branch is based on the reviewed installed controller and
must not be merged directly into main before those dependencies are reviewed.
PR #15 / d7f7123 remains a separate business candidate. No merge is required for
an independently approved, fixed-byte controller installation.

The unchanged `schema_0412.py`, `migrate_0412.py`, `catalog_policy.py` and 0412 SQL
are retained. Only engine/backup integration and two new fixed 0413 modules are
installed. The new SQL resource is extracted from d7f7123 and checked against its
fixed SHA256. No API accepts SQL, paths, target containers, Schema hashes or images.

`schema_0413.read_context` first reopens the old 0412 approval/receipt and backup
receipts. A distinct root approval binds that registration, old effective policy,
old release/state, database identity, exact new object rows and fixed SQL. Both
raw Catalogs and real OID topology are preserved. The existing Realtime projection
validates all dynamic attributes before comparing every remaining static row.

The new private journal blocks deployment before COMMIT and registration. The
fixed local root entry holds deployment.lock and follows backup.lock, creates a
fresh complete restore proof before DDL, checks the transaction, then creates a
new restore proof after COMMIT. All old table hashes/row counts must be unchanged;
all three new ledger tables must start empty. Root reopens evidence, recomputes
data equality and links the new receipt to the old receipt before appending
state.schema_0413. No original approved hash or old evidence file is overwritten.

COMMIT unknown is never automatically retried. Explicit `--register` does not run
SQL: it requires the authenticated transaction/delta plus a new restore proof of
the actual expanded database and unchanged release/state. A pre-COMMIT failure
requires independent investigation/approval, not a retry loop. No down migration.

Business rollout still uses the original restricted SSH deploy/rollback protocol.
The new Schema/source gate requires d7f7123 ancestry and its exact Schema tree.
Only the saved ea26ee4 three-image group is the reviewed older application cohort.
Rollback requires Embedding disabled, no running index operations and no reserved
or unknown requests; old ea26ee4 does not enforce the new ledger. Other older
releases do not inherit cross-Schema approval.

The same root modes/owners/nlink and lock inodes are retained. No sudoers,
forced-command, Docker access, SSH operation, firewall, Compose or application
secret changes. Tests run synthetic, labelled tmpfs databases without host ports
and internal-only application networks. Their Auth identity fixture is explicitly
not GoTrue/MFA acceptance; current-site GoTrue/MFA/Storage rehearsal is a separate
future gate, with real backups retained privately and never uploaded to GitHub.

Living-system connections: human approval → fixed migration coordinator → backup
and restore evidence → append-only registration → existing deploy gate → operator
status/audit and explicit reconciliation. Status/incomplete journal is the visible
failure/next-step surface. No model/customer action is initiated by this path.
