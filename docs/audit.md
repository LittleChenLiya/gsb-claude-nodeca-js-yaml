# Schema migration audit

When preparing a configuration file for a YAML schema switch, the auditor
parses the event stream once and compares how the built-in **CORE**, **JSON**
and **YAML11** schemas resolve every scalar. It reports the original path,
line and column, and the resolved category under each schema.

The auditor is read-only. It uses only the built-in safe schemas and never
executes custom tag constructors. Explicit tags are resolved with
`isExplicit = true`, implicit plain scalars through the schema's implicit
resolver, and quoted/block scalars stay `!!str`, exactly as the constructor
does it. The original `load` behavior is unchanged.

## Usage

```sh
node bin/audit-schema.mjs config.yaml
```

The auditor reads a file (or standard input with `-`) and prints a text report.

## What it reports

### Scalar type/value changes

A scalar whose tag category or canonical value differs between schemas. Each
finding shows the path, line, column, scalar style, and the resolution under
each of the three schemas:

```
scalar type/value change: $.answer
  at line 2, column 9 (plain scalar)
  scalar: "yes"
  core    str    "yes"
  json    str    "yes"
  yaml11  bool   true
  -> tag category changes between schemas
  -> canonical value changes between schemas
```

The two result categories are the short tag name (`str`, `bool`, `int`,
`float`, `null`) and the canonical value. Plain string numbers are never
auto-coerced: a quoted `"123"` stays `str` everywhere, while a plain `0x10`
resolves to `int` under CORE and YAML11 but `str` under JSON.

### Key conflicts

Mapping keys that are distinct under CORE but collapse to the same identity
under YAML11. This is a migration hazard because the new schema would silently
turn one key into a duplicate of the other:

```
key conflict: $
  at line 8, column 1
  key "yes" at line 7, column 1
    core: str  json: str  yaml11: bool
    identity under yaml11: bool -> true
  key "Yes" at line 8, column 1
    core: str  json: str  yaml11: bool
    identity under yaml11: bool -> true
  -> distinct keys under core collapse to one identity under yaml11
```

### Aliases

When an alias points at an anchored scalar, the report locates the anchor
definition so the source of the aliased value can be traced:

```
alias: $.alias
  at line 11, column 9
  alias *x points to anchor defined at $.anchor (line 10, column 10)
  anchored scalar: "yes"
```

### Errors

An explicit tag that rejects the scalar text (the constructor would throw on
this) is reported as an error, but no custom constructor is executed.

## Small config example

```yaml
# config.yaml
answer: yes          # str under CORE, bool under YAML11 -> type change
quoted: "yes"        # quoted, stays str everywhere -> no change
yes: 1               # } both become bool true under YAML11
Yes: 2               # } -> key conflict
anchor: &x yes       # anchored scalar, type change reported with anchor name
alias: *x            # alias, source located at $.anchor
n: ~                 # null under CORE/YAML11, str under JSON -> type change
port: 8080           # int everywhere -> no change
hex: 0x10            # int under CORE/YAML11, str under JSON -> type change
```

Running `node bin/audit-schema.mjs config.yaml` reports the type changes for
`answer`, `anchor`, `n` and `hex`, the key conflict on `yes`/`Yes`, and the
alias from `alias` to `anchor`.

## Programmatic API

```js
import { auditSchemaMigration, formatAuditReport } from 'js-yaml'

const result = auditSchemaMigration(input, { filename: 'config.yaml' })
process.stdout.write(formatAuditReport(result))
```

The `AuditResult` contains `scalarFindings`, `aliases`, `keyConflicts` and
`errors`. Each scalar finding carries the path, line, column, style, anchor
name, explicit tag, and the `core`, `json` and `yaml11` resolutions.
