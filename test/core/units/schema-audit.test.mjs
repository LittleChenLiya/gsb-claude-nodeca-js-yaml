import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { auditSchemaMigration } from '../../../src/audit.ts'
import { load } from '../../../src/index.ts'

const STR = 'tag:yaml.org,2002:str'
const BOOL = 'tag:yaml.org,2002:bool'
const NULL = 'tag:yaml.org,2002:null'

function scalarAt (report, path, role = 'value') {
  const entry = report.scalars.filter((scalar) => scalar.path === path && scalar.role === role)
  assert.equal(entry.length, 1, `expected exactly one ${role} scalar at ${path}`)
  return entry[0]
}

describe('schema audit', () => {
  it('flags `yes` as a type change: string in CORE, boolean in YAML 1.1', () => {
    const report = auditSchemaMigration('flag: yes\n')

    const entry = scalarAt(report, '$.flag')
    assert.equal(entry.change, 'type-change')
    assert.equal(entry.style, 'plain')
    assert.equal(entry.explicitTag, null)
    assert.deepEqual([entry.line, entry.column], [1, 7])

    assert.equal(entry.resolved.core.tag, STR)
    assert.equal(entry.resolved.core.valueType, 'string')
    assert.equal(entry.resolved.core.value, 'yes')

    assert.equal(entry.resolved.json.tag, STR)
    assert.equal(entry.resolved.json.valueType, 'string')

    assert.equal(entry.resolved.yaml11.tag, BOOL)
    assert.equal(entry.resolved.yaml11.valueType, 'boolean')
    assert.equal(entry.resolved.yaml11.value, true)
    assert.equal(entry.resolved.yaml11.canonical, 'true')

    assert.deepEqual(report.changes.map((scalar) => scalar.path), ['$.flag'])
    assert.equal(report.summary.typeChanges, 1)
  })

  it('leaves quoted "yes" unchanged in every schema', () => {
    const report = auditSchemaMigration('a: "yes"\nb: \'yes\'\n')

    for (const path of ['$.a', '$.b']) {
      const entry = scalarAt(report, path)
      assert.equal(entry.change, 'unchanged')
      for (const schema of ['core', 'json', 'yaml11']) {
        assert.equal(entry.resolved[schema].tag, STR)
        assert.equal(entry.resolved[schema].value, 'yes')
      }
    }
    assert.equal(report.changes.length, 0)
  })

  it('reports mapping keys that collapse to one identity under the new schema', () => {
    const report = auditSchemaMigration('yes: 1\ntrue: 2\n')

    assert.equal(report.keyConflicts.length, 1)
    const conflict = report.keyConflicts[0]
    assert.equal(conflict.path, '$')
    assert.equal(conflict.identity, 'boolean:true')
    assert.deepEqual(
      conflict.keys.map((key) => [key.source, key.fromIdentity, key.line, key.column]),
      [['yes', 'string:yes', 1, 1], ['true', 'boolean:true', 2, 1]]
    )
    assert.equal(report.summary.keyConflicts, 1)
  })

  it('never coerces plain strings and numbers when comparing key identity', () => {
    // `1` (number) vs '1' (string), `yes` (bool in yaml11) vs 'yes' (string):
    // distinct identities in every schema, so no conflict may be reported.
    const report = auditSchemaMigration('1: a\n\'1\': b\nyes: c\n\'yes\': d\n')
    assert.equal(report.keyConflicts.length, 0)
  })

  it('locates the anchor definition an alias points to', () => {
    const report = auditSchemaMigration('defaults: &flag on\noverride: *flag\n')

    assert.equal(report.aliases.length, 1)
    const alias = report.aliases[0]
    assert.equal(alias.name, 'flag')
    assert.equal(alias.path, '$.override')
    assert.deepEqual([alias.line, alias.column], [2, 12])
    assert.deepEqual(alias.target, { path: '$.defaults', line: 1, column: 17 })

    // The anchored scalar itself is reported with its anchor and change.
    const anchored = scalarAt(report, '$.defaults')
    assert.equal(anchored.anchor, 'flag')
    assert.equal(anchored.change, 'type-change')
  })

  it('resolves explicit tags separately from implicit scalars', () => {
    const report = auditSchemaMigration('a: !!str yes\nb: !!int "42"\nc: yes\n')

    const taggedStr = scalarAt(report, '$.a')
    assert.equal(taggedStr.explicitTag, STR)
    assert.equal(taggedStr.change, 'unchanged')
    assert.equal(taggedStr.resolved.yaml11.value, 'yes')

    const taggedInt = scalarAt(report, '$.b')
    assert.equal(taggedInt.explicitTag, 'tag:yaml.org,2002:int')
    assert.equal(taggedInt.resolved.core.valueType, 'number')
    assert.equal(taggedInt.resolved.core.value, 42)

    // Same text without a tag resolves implicitly instead.
    const plain = scalarAt(report, '$.c')
    assert.equal(plain.explicitTag, null)
    assert.equal(plain.change, 'type-change')
  })

  it('reports unknown custom tags without constructing them', () => {
    const report = auditSchemaMigration('a: !custom/widget data\n')

    const entry = scalarAt(report, '$.a')
    assert.equal(entry.explicitTag, '!custom/widget')
    for (const schema of ['core', 'json', 'yaml11']) {
      assert.equal(entry.resolved[schema].status, 'unknown-tag')
    }
    assert.equal(entry.change, 'unchanged')
    assert.equal(report.summary.unknownTags, 1)
  })

  it('marks known tags that reject the source as unresolved', () => {
    const report = auditSchemaMigration('a: !!bool maybe\n')
    const entry = scalarAt(report, '$.a')
    assert.equal(entry.resolved.core.status, 'unresolved')
    assert.equal(entry.resolved.yaml11.status, 'unresolved')
  })

  it('resolves null forms per schema, including the empty scalar', () => {
    const report = auditSchemaMigration('a:\nb: null\nc: ~\n')

    const empty = scalarAt(report, '$.a')
    assert.equal(empty.resolved.core.tag, NULL)
    assert.equal(empty.resolved.core.value, null)
    assert.equal(empty.resolved.yaml11.tag, NULL)
    // JSON schema has no empty null: the empty scalar stays a string there.
    assert.equal(empty.resolved.json.tag, STR)
    assert.equal(empty.resolved.json.value, '')

    const explicitNull = scalarAt(report, '$.b')
    for (const schema of ['core', 'json', 'yaml11']) {
      assert.equal(explicitNull.resolved[schema].tag, NULL, `$.b in ${schema}`)
      assert.equal(explicitNull.resolved[schema].value, null)
      assert.equal(explicitNull.resolved[schema].canonical, 'null')
    }

    // `~` is null in CORE/YAML 1.1 but not in the JSON schema.
    const tilde = scalarAt(report, '$.c')
    assert.equal(tilde.resolved.core.tag, NULL)
    assert.equal(tilde.resolved.yaml11.tag, NULL)
    assert.equal(tilde.resolved.json.tag, STR)
    assert.equal(tilde.resolved.json.value, '~')
  })

  it('tracks paths through nested sequences and mappings', () => {
    const report = auditSchemaMigration('servers:\n  - port: 8080\n    enabled: yes\n')

    const port = scalarAt(report, '$.servers[0].port')
    assert.equal(port.resolved.core.valueType, 'number')

    const enabled = scalarAt(report, '$.servers[0].enabled')
    assert.equal(enabled.change, 'type-change')
    assert.deepEqual([enabled.line, enabled.column], [3, 14])
  })

  it('honors explicit from/to schema selection within the built-in trio', () => {
    const report = auditSchemaMigration('a: yes\n', { from: 'json', to: 'core' })
    assert.equal(scalarAt(report, '$.a').change, 'unchanged')
    assert.deepEqual(report.schemas, { from: 'json', to: 'core', compared: ['core', 'json', 'yaml11'] })

    assert.throws(() => auditSchemaMigration('a: 1\n', { from: 'nope' }), /unknown 'from' schema/)
  })

  it('does not change load behavior', () => {
    assert.equal(load('flag: yes\n').flag, 'yes')
    assert.equal(load('flag: yes\n', { schema: undefined }).flag, 'yes')
  })
})
