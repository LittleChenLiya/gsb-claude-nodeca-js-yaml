import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { auditSchemaMigration, formatAuditReport } from '../../../src/audit.ts'

describe('auditSchemaMigration', () => {
  it('reports a type change for plain "yes" (str under core, bool under yaml11)', () => {
    const result = auditSchemaMigration('answer: yes\n', { filename: 'cfg.yaml' })

    assert.equal(result.scalarFindings.length, 1)
    const finding = result.scalarFindings[0]
    assert.equal(finding.path, '$.answer')
    assert.equal(finding.line, 1)
    assert.equal(finding.column, 9)
    assert.equal(finding.source, 'yes')
    assert.equal(finding.style, 'plain')
    assert.equal(finding.core.tag, 'str')
    assert.equal(finding.core.canonical, '"yes"')
    assert.equal(finding.json.tag, 'str')
    assert.equal(finding.yaml11.tag, 'bool')
    assert.equal(finding.yaml11.canonical, 'true')
    assert.equal(finding.typeChange, true)
  })

  it('does not change quoted scalars ("yes" stays str everywhere)', () => {
    const result = auditSchemaMigration('a: "yes"\nb: \'yes\'\n', { filename: 'cfg.yaml' })

    assert.equal(result.scalarFindings.length, 0)
  })

  it('reports a key conflict when distinct keys collapse under yaml11', () => {
    const result = auditSchemaMigration('yes: 1\nYes: 2\n', { filename: 'cfg.yaml' })

    assert.equal(result.keyConflicts.length, 1)
    const conflict = result.keyConflicts[0]
    assert.equal(conflict.path, '$')
    assert.equal(conflict.entries.length, 2)
    assert.equal(conflict.entries[0].source, 'yes')
    assert.equal(conflict.entries[0].core, 'str')
    assert.equal(conflict.entries[0].yaml11, 'bool')
    assert.equal(conflict.entries[1].source, 'Yes')
    assert.equal(conflict.entries[1].core, 'str')
    assert.equal(conflict.entries[1].yaml11, 'bool')
    assert.equal(conflict.entries[0].identity, conflict.entries[1].identity)
  })

  it('does not report a key conflict when keys stay distinct', () => {
    const result = auditSchemaMigration('yes: 1\nno: 2\n', { filename: 'cfg.yaml' })

    assert.equal(result.keyConflicts.length, 0)
  })

  it('locates the source of an alias pointing at an anchored scalar', () => {
    const result = auditSchemaMigration('anchor: &x yes\nalias: *x\n', { filename: 'cfg.yaml' })

    assert.equal(result.aliases.length, 1)
    const alias = result.aliases[0]
    assert.equal(alias.path, '$.alias')
    assert.equal(alias.anchor, 'x')
    assert.equal(alias.sourcePath, '$.anchor')
    assert.equal(alias.sourceLine, 1)
    assert.equal(alias.sourceColumn, 10)
    assert.equal(alias.source, 'yes')
  })

  it('reports the anchor name on the anchored scalar finding', () => {
    const result = auditSchemaMigration('anchor: &x yes\n', { filename: 'cfg.yaml' })

    assert.equal(result.scalarFindings.length, 1)
    assert.equal(result.scalarFindings[0].anchor, 'x')
  })

  it('handles explicit tags separately from implicit scalars', () => {
    const strResult = auditSchemaMigration('a: !!str yes\n', { filename: 'cfg.yaml' })
    assert.equal(strResult.scalarFindings.length, 0)

    const boolResult = auditSchemaMigration('a: !!bool yes\n', { filename: 'cfg.yaml' })
    assert.equal(boolResult.scalarFindings.length, 0)

    const badResult = auditSchemaMigration('a: !!int yes\n', { filename: 'cfg.yaml' })
    assert.equal(badResult.errors.length, 1)
    assert.equal(badResult.errors[0].path, '$.a')
  })

  it('compares null variants across schemas', () => {
    const result = auditSchemaMigration('a: ~\nb: null\nc: Null\nd: NULL\ne:\n', { filename: 'cfg.yaml' })

    const sources = result.scalarFindings.map(f => f.source)
    assert.deepEqual(sources, ['~', 'Null', 'NULL', ''])

    for (const finding of result.scalarFindings) {
      assert.equal(finding.core.tag, 'null')
      assert.equal(finding.json.tag, 'str')
      assert.equal(finding.yaml11.tag, 'null')
    }

    const nullFinding = result.scalarFindings.find(f => f.source === 'null')
    assert.equal(nullFinding, undefined)
  })

  it('compares numeric scalars without auto-coercing strings', () => {
    const result = auditSchemaMigration('a: 0x10\nb: 8080\nc: "123"\n', { filename: 'cfg.yaml' })

    const hex = result.scalarFindings.find(f => f.source === '0x10')
    assert.equal(hex.core.tag, 'int')
    assert.equal(hex.core.canonical, '16')
    assert.equal(hex.json.tag, 'str')
    assert.equal(hex.yaml11.tag, 'int')

    const port = result.scalarFindings.find(f => f.source === '8080')
    assert.equal(port, undefined)

    const quoted = result.scalarFindings.find(f => f.source === '123')
    assert.equal(quoted, undefined)
  })

  it('reports nested paths for sequences and mappings', () => {
    const result = auditSchemaMigration('list:\n  - yes\n  - yes\nmap:\n  nested: yes\n', { filename: 'cfg.yaml' })

    const paths = result.scalarFindings.map(f => f.path)
    assert.deepEqual(paths, ['$.list[0]', '$.list[1]', '$.map.nested'])
  })

  it('reports line and column for each finding', () => {
    const result = auditSchemaMigration('a: yes\nb:\n  c: yes\n', { filename: 'cfg.yaml' })

    assert.equal(result.scalarFindings.length, 2)
    assert.equal(result.scalarFindings[0].line, 1)
    assert.equal(result.scalarFindings[0].column, 4)
    assert.equal(result.scalarFindings[1].line, 3)
    assert.equal(result.scalarFindings[1].column, 6)
  })

  it('reports no findings when all schemas agree', () => {
    const result = auditSchemaMigration('a: hello\nb: 123\nc: true\n', { filename: 'cfg.yaml' })

    assert.equal(result.scalarFindings.length, 0)
    assert.equal(result.keyConflicts.length, 0)
    assert.equal(result.aliases.length, 0)
    assert.equal(result.errors.length, 0)
  })

  it('does not execute custom tag constructors', () => {
    const result = auditSchemaMigration('a: !custom yes\n', { filename: 'cfg.yaml' })

    assert.equal(result.errors.length, 1)
  })
})

describe('formatAuditReport', () => {
  it('renders a text report with the two result categories', () => {
    const result = auditSchemaMigration('answer: yes\n', { filename: 'cfg.yaml' })
    const report = formatAuditReport(result)

    assert.ok(report.includes('schema migration audit: cfg.yaml'))
    assert.ok(report.includes('$.answer'))
    assert.ok(report.includes('core'))
    assert.ok(report.includes('json'))
    assert.ok(report.includes('yaml11'))
    assert.ok(report.includes('str'))
    assert.ok(report.includes('bool'))
  })

  it('renders "no differences found" for a clean config', () => {
    const result = auditSchemaMigration('a: hello\n', { filename: 'cfg.yaml' })
    const report = formatAuditReport(result)

    assert.ok(report.includes('no differences found'))
  })
})
