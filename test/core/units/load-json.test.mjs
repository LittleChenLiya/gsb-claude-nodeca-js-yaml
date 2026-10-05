import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { load, loadAll, loadJSON, loadJSONAll, YAMLException } from 'js-yaml'

describe('loadJSON', () => {
  it('parses JSON-compatible YAML', () => {
    assert.deepEqual(loadJSON('{"a": 1, "b": [true, null, "x"]}'), {
      a: 1,
      b: [true, null, 'x']
    })
    assert.deepEqual(loadJSON('a: 1\nb: 2'), { a: 1, b: 2 })
    assert.deepEqual(loadJSON('- 1\n- 2\n- 3'), [1, 2, 3])
  })

  it('accepts string keys, including numeric-looking ones', () => {
    assert.deepEqual(loadJSON('"1": x'), { 1: 'x' })
    assert.deepEqual(loadJSON('"true": x'), { true: 'x' })
    assert.deepEqual(loadJSON('"null": x'), { null: 'x' })
    assert.deepEqual(loadJSON('a-b: x'), { 'a-b': 'x' })
  })

  it('rejects numeric keys at the key tag and line/column', () => {
    assert.throws(() => loadJSON('1: x'), (error) => {
      assert.ok(error instanceof YAMLException)
      assert.match(error.message, /JSON mapping keys must be strings/)
      assert.equal(error.mark.line, 0)
      assert.equal(error.mark.column, 0)
      return true
    })

    // An explicit key tag is located, not the value.
    assert.throws(() => loadJSON('!!int 2: x'), (error) => {
      assert.ok(error instanceof YAMLException)
      assert.match(error.message, /JSON mapping keys must be strings/)
      assert.equal(error.mark.line, 0)
      assert.equal(error.mark.column, 0)
      return true
    })

    // A key on a later line reports its own line/column.
    assert.throws(() => loadJSON('a: 1\n1: x'), (error) => {
      assert.ok(error instanceof YAMLException)
      assert.equal(error.mark.line, 1)
      assert.equal(error.mark.column, 0)
      return true
    })
  })

  it('rejects other non-string scalar keys', () => {
    assert.throws(() => loadJSON('true: x'), /mapping keys must be strings/)
    assert.throws(() => loadJSON('null: x'), /mapping keys must be strings/)
  })

  it('rejects complex (collection) keys at the key position', () => {
    assert.throws(() => loadJSON('? [1, 2]: x'), (error) => {
      assert.ok(error instanceof YAMLException)
      assert.match(error.message, /mapping keys must be strings/)
      assert.equal(error.mark.line, 0)
      assert.equal(error.mark.column, 2)
      return true
    })
  })

  it('rejects non-finite numbers', () => {
    assert.throws(() => loadJSON('a: !!float .inf'), /non-finite numbers/)
    assert.throws(() => loadJSON('a: !!float .nan'), /non-finite numbers/)
    assert.throws(() => loadJSON('a: !!float -.inf'), /non-finite numbers/)
  })

  it('allows shared acyclic references and expands them', () => {
    const result = loadJSON('a: &x [1, 2]\nb: *x')
    assert.deepEqual(result, { a: [1, 2], b: [1, 2] })
    assert.equal(result.a, result.b)
    assert.doesNotThrow(() => JSON.stringify(result))

    const nested = loadJSON('a: &x {k: 1}\nb: *x\nc: *x')
    assert.deepEqual(nested, { a: { k: 1 }, b: { k: 1 }, c: { k: 1 } })
    assert.equal(nested.a, nested.b)
    assert.equal(nested.b, nested.c)
  })

  it('rejects self-references and reference cycles', () => {
    assert.throws(() => loadJSON('a: &x [1, *x]'), /cyclic alias/)
    assert.throws(() => loadJSON('a: &x {b: *x}'), /cyclic alias/)
    assert.throws(() => loadJSON('a: &x {b: &y [*x]}\nc: *y'), /cyclic alias/)
  })

  it('rejects custom tags instead of calling them', () => {
    assert.throws(() => loadJSON('a: !custom x'), /unknown scalar tag/)
    assert.throws(() => loadJSON('a: !<tag:example.com,2024:foo> x'), /unknown scalar tag/)
  })

  it('never returns a partial result on violation', () => {
    // The violation is on the second pair; the first pair must not leak out.
    assert.throws(() => loadJSON('a: 1\n1: x'), /mapping keys must be strings/)
  })

  it('keeps JSON.parse duplicate-key semantics', () => {
    assert.deepEqual(loadJSON('a: 1\na: 2'), { a: 2 })
  })

  it('throws on empty and multi-document streams', () => {
    assert.throws(() => loadJSON(''), YAMLException)
    assert.throws(() => loadJSON('a: 1\n---\nb: 2'), YAMLException)
  })

  it('includes the filename in error messages', () => {
    assert.throws(() => loadJSON('1: x', { filename: 'data.yml' }), /data\.yml/)
  })
})

describe('loadJSONAll', () => {
  it('returns every document', () => {
    assert.deepEqual(loadJSONAll('a: 1\n---\nb: 2'), [{ a: 1 }, { b: 2 }])
    assert.deepEqual(loadJSONAll(''), [])
  })

  it('rejects violations in any document', () => {
    assert.throws(() => loadJSONAll('a: 1\n---\n1: x'), /mapping keys must be strings/)
  })
})

describe('load behavior is unchanged', () => {
  it('still stringifies non-string keys', () => {
    assert.deepEqual(load('1: x'), { 1: 'x' })
    assert.deepEqual(load('true: x'), { true: 'x' })
  })

  it('still constructs cyclic structures', () => {
    const result = load('a: &x [1, *x]')
    assert.equal(result.a[1], result.a)
  })

  it('loadAll is unaffected', () => {
    assert.deepEqual(loadAll('a: 1\n---\nb: 2'), [{ a: 1 }, { b: 2 }])
  })
})
