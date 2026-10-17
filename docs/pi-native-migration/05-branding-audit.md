# Branding audit

The product name is **Pi Native CRM** and the package name is `pi-native-crm`.
The migration covers product copy, UI metadata, emails, Docker images, guides,
deployment scripts, governance tooling, fixtures, evidence, and documentation.

The rename is intentionally complete: wire headers, cookies, storage keys,
container labels, governance variables, persisted external identifiers, and
historical fixtures now use the Pi Native namespace. This is a new product
line, so existing installations that relied on the previous namespace need a
versioned deployment migration before upgrading.

| Surface | Current namespace |
| --- | --- |
| Webhook headers | `X-Pi-Native-Signature`, `X-Pi-Native-Event` |
| Authentication/support cookies | `sb-pi-native-auth`, `pi-native-impersonate` |
| Governance variables | `PI_NATIVE_*` |
| Docker/worker identifiers | `pi-native-crm-*` |
| Calendar and integration identifiers | `pi-native.*` / `pi-native_*` |

The repository-wide legacy scan is constructed without storing the removed
brand as a literal in the repository:

```sh
legacy_pattern="Desk""commCRM|Desk""comm|desk""comm|DESK""COMM"
rg -n -i "$legacy_pattern" --hidden \
  --glob '!.git/**' --glob '!node_modules/**'
```

On 2026-09-22 the scan returned zero matches. Filename scan also returns zero:

```sh
filename_pattern="desk""comm"
rg --files | rg -i "$filename_pattern" || true
```

Any future compatibility alias must be introduced as an explicit, versioned
migration with tests and rollback behavior; it must not silently reintroduce
the removed product namespace.
