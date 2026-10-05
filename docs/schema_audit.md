---
title: Schema migration audit
category: Auditing
---

# Schema migration audit

`auditSchemaMigration` is an offline auditor for configuration files that are
about to switch YAML schema. It parses the event stream of the source **once**
and, for every scalar, compares how the built-in **CORE**, **JSON** and
**YAML 1.1** schemas resolve its type and canonical value.

Guarantees:

- Only the built-in safe schemas are used; custom tag constructors are never
  executed. An explicit tag unknown to the built-in schemas is reported as
  `unknown-tag` instead of being constructed.
- Explicitly tagged scalars and implicitly resolved plain scalars are
  interpreted through separate paths, mirroring the loader. Quoted scalars
  stay strings unless explicitly tagged.
- Plain strings and numbers are never auto-coerced when values are compared:
  identity always includes the resolved type (`"1"` vs `1`, `"yes"` vs `true`
  stay distinct).
- `load`/`loadAll` behavior is unchanged; the auditor is a pure read-only
  analysis.

## Usage

```js
import { auditSchemaMigration } from 'js-yaml'

const report = auditSchemaMigration(source, {
  filename: 'config.yml',
  from: 'core',    // schema the config currently uses (default)
  to: 'yaml11'     // schema being migrated to (default)
})
```

`from`/`to` only accept the built-in schema names `'core'`, `'json'` and
`'yaml11'`; every scalar is always resolved under all three.

A standalone CLI is available without building the dist bundle:

```bash
node support/audit-schema.mjs [--from core|json|yaml11] [--to core|json|yaml11] config.yml
```

It prints the JSON report and exits with code `1` when the migration
introduces any change or key conflict, `0` when clean, `2` on usage/IO errors.

## Report format

```ts
interface SchemaAuditReport {
  filename: string
  schemas: { from: 'core' | 'json' | 'yaml11', to: ..., compared: [...] }
  summary: {
    scalarCount: number
    typeChanges: number      // scalars whose resolved type/tag differs from -> to
    valueChanges: number     // same type, different canonical value
    statusChanges: number    // resolvability changed (e.g. unresolved in one schema)
    keyConflicts: number     // mappings with keys collapsing to one identity
    unknownTags: number      // scalars with a non-built-in explicit tag
    aliasCount: number
  }
  changes: ScalarAuditEntry[]       // scalars with change != 'unchanged'
  keyConflicts: KeyConflictEntry[]
  aliases: AliasAuditEntry[]
  scalars: ScalarAuditEntry[]       // every scalar, in document order
}
```

Each `ScalarAuditEntry`:

```ts
{
  path: '$.servers[0].enabled',  // JSONPath-like location
  line: 3, column: 14,           // 1-based position of the scalar text
  role: 'key' | 'value' | 'item' | 'document',
  style: 'plain' | 'single-quoted' | 'double-quoted' | 'literal' | 'folded',
  source: 'yes',                 // decoded scalar text
  explicitTag: null,             // full tag name when explicitly tagged
  anchor: null,                  // anchor name when the scalar defines one
  resolved: {
    core:   { status: 'resolved', tag: 'tag:yaml.org,2002:str',
              valueType: 'string', value: 'yes', canonical: 'yes' },
    json:   { ... },
    yaml11: { status: 'resolved', tag: 'tag:yaml.org,2002:bool',
              valueType: 'boolean', value: true, canonical: 'true' }
  },
  change: 'unchanged' | 'type-change' | 'value-change' | 'status-change'
}
```

A resolution `status` may also be `unknown-tag` (custom tag, not constructed),
`unresolved` (known tag rejected the text) or `non-scalar-tag`.

Each `KeyConflictEntry` reports a mapping whose keys are distinct under the
`from` schema but normalize to the same identity under the `to` schema:

```ts
{
  path: '$', line: 8, column: 1,       // the mapping
  identity: 'boolean:true',            // shared identity under the `to` schema
  keys: [
    { source: 'yes',  fromIdentity: 'string:yes',   path: '$.yes',  line: 8, column: 1 },
    { source: 'true', fromIdentity: 'boolean:true', path: '$.true', line: 9, column: 1 }
  ]
}
```

Each `AliasAuditEntry` locates both the alias and the anchor definition it
points to, so an alias of a migrated scalar can be traced back to its source:

```ts
{ name: 'mode', path: '$.worker', line: 7, column: 10,
  target: { path: '$.defaults', line: 6, column: 17 } }
```

## Example

Config (`config.yml`):

```yaml
enabled: yes          # string in CORE, boolean in YAML 1.1
label: "yes"          # quoted: stays a string everywhere
missing:
yes: first            # \
true: second          # / collide as boolean true under YAML 1.1
defaults: &mode on
worker: *mode
```

```bash
$ node support/audit-schema.mjs config.yml
```

```json
{
  "summary": { "scalarCount": 13, "typeChanges": 3, "valueChanges": 0,
               "statusChanges": 0, "keyConflicts": 1, "unknownTags": 0, "aliasCount": 1 },
  "changes": [
    { "path": "$.enabled",  "line": 1, "column": 10, "source": "yes", "change": "type-change", "...": "core=string, yaml11=boolean" },
    { "path": "$.yes",      "line": 4, "column": 1,  "source": "yes", "change": "type-change", "role": "key" },
    { "path": "$.defaults", "line": 6, "column": 17, "source": "on",  "change": "type-change", "anchor": "mode" }
  ],
  "keyConflicts": [
    { "path": "$", "identity": "boolean:true",
      "keys": [ { "source": "yes",  "fromIdentity": "string:yes",   "line": 4 },
                { "source": "true", "fromIdentity": "boolean:true", "line": 5 } ] }
  ],
  "aliases": [
    { "name": "mode", "path": "$.worker", "line": 7, "column": 10,
      "target": { "path": "$.defaults", "line": 6, "column": 17 } }
  ]
}
```

(abridged; the real report also contains the full `resolved` triple per
scalar and the `scalars` array with unchanged entries such as `label`.)

## Tests

The auditor is covered by a focused unit test that runs directly against the
TypeScript sources with a local Node (no build step required):

```bash
node --test test/core/units/schema-audit.test.mjs
```
