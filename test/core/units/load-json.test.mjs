import { describe, it } from 'node:test'

import assert from 'node:assert/strict'
import { load, loadJson, YAMLException } from 'js-yaml'

function expectJsonError (source, pattern, line, column) {
  try {
    loadJson(source)
  } catch (error) {
    assert.ok(error instanceof YAMLException)
    assert.match(error.message, pattern)
    if (line !== undefined) assert.equal(error.mark.line, line)
    if (column !== undefined) assert.equal(error.mark.column, column)
    return
  }

  assert.fail(`expected loadJson to throw for:\n${source}`)
}

describe('loadJson', () => {
  it('parses ordinary JSON-compatible documents', () => {
    assert.deepEqual(loadJson('a: "1"\nb: [1, true, false, null]\n'), {
      a: '1',
      b: [1, true, false, null]
    })
    assert.deepEqual(loadJson('{"a": 1, "b": [2.5, -3]}'), { a: 1, b: [2.5, -3] })
    assert.equal(loadJson('42'), 42)
    assert.equal(loadJson('"hello"'), 'hello')
    assert.equal(loadJson('null'), null)
  })

  it('accepts the string key "1" but rejects the number key 1', () => {
    assert.deepEqual(loadJson('"1": x\n'), { 1: 'x' })
    assert.deepEqual(loadJson('!!str 1: x\n'), { 1: 'x' })
    expectJsonError('1: x\n', /got !!int key/, 0, 0)
    expectJsonError('outer:\n  1: x\n', /got !!int key/, 1, 2)
  })

  it('locates the offending key tag and its line/column in the error mark', () => {
    expectJsonError('a: 1\n2: x\n', /!!int key/, 1, 0)
    expectJsonError('1.5: x\n', /!!float key/, 0, 0)
    expectJsonError('true: x\n', /!!bool key/, 0, 0)
    expectJsonError('null: x\n', /!!null key/, 0, 0)
    expectJsonError('? [1, 2]\n: v\n', /!!seq key/, 0, 0)
    expectJsonError('? {a: 1}\n: v\n', /!!map key/, 0, 0)
  })

  it('names the file in the error mark when filename is given', () => {
    assert.throws(
      () => loadJson('1: x\n', { filename: 'doc.yml' }),
      error => error.mark.name === 'doc.yml' && /!!int/.test(error.message))
  })

  it('expands shared, acyclic references into independent copies', () => {
    const result = loadJson('a: &x [1, {y: 2}]\nb: *x\nc: *x\n')

    assert.deepEqual(result, {
      a: [1, { y: 2 }],
      b: [1, { y: 2 }],
      c: [1, { y: 2 }]
    })
    assert.notEqual(result.a, result.b)
    assert.notEqual(result.a, result.c)
    assert.notEqual(result.b, result.c)
    assert.notEqual(result.a[1], result.b[1])

    result.a[1].y = 99
    assert.equal(result.b[1].y, 2)
    assert.equal(result.c[1].y, 2)

    // The expanded tree can always be serialized as JSON.
    assert.doesNotThrow(() => JSON.stringify(result))
  })

  it('expands shared anchored mappings as well', () => {
    const result = loadJson('a: &m {p: 1}\nb: *m\n')
    assert.deepEqual(result, { a: { p: 1 }, b: { p: 1 } })
    assert.notEqual(result.a, result.b)
    result.a.p = 2
    assert.equal(result.b.p, 1)
  })

  it('rejects self-referential aliases', () => {
    expectJsonError('a: &a [1, *a]\n', /recursive alias "a"/, 0, 11)
    expectJsonError('a: &a {b: *a}\n', /recursive alias "a"/, 0, 11)
    expectJsonError('x: &x\n  a: *x\n', /recursive alias "x"/, 1, 6)
  })

  it('rejects cycles through aliases of inner nodes', () => {
    expectJsonError('a:\n  b: &b [1]\n  c: &c [*b, *c]\n', /recursive alias "c"/)
  })

  it('rejects non-finite numbers (declared policy: reject)', () => {
    expectJsonError('a: !!float .inf\n', /non-finite.*!!float/, 0, 3)
    expectJsonError('a: !!float -.inf\n', /non-finite.*!!float/)
    expectJsonError('a: !!float .nan\n', /non-finite.*!!float/)
    // Plain `.nan` is just a string under the JSON schema, so it passes.
    assert.deepEqual(loadJson('a: .nan\n'), { a: '.nan' })
  })

  it('uses only the built-in JSON schema and never constructs custom tags', () => {
    // A schema option is not part of the API; even with an explicit !! prefix
    // the tag must resolve against the built-in set.
    expectJsonError('a: !foo bar\n', /unknown scalar tag/)
    expectJsonError('a: !!timestamp 2020-01-01\n', /unknown scalar tag|cannot resolve/)
    expectJsonError('a: !!omap [a: 1]\n', /only supports the !!seq tag/)
    expectJsonError('a: !!set { x }\n', /only supports the !!map tag/)

    // The built-in schema still resolves JSON scalar forms, including the
    // explicit integer notations.
    assert.deepEqual(loadJson('a: !!int 0x10\n'), { a: 16 })
    assert.deepEqual(loadJson('a: 0x10\n'), { a: '0x10' })
  })

  it('never delivers partial results when a violation appears late', () => {
    let delivered = 'untouched'

    assert.throws(
      () => {
        delivered = loadJson('a: 1\nb: 2\n3: bad\n')
      },
      YAMLException)

    assert.equal(delivered, 'untouched')
  })

  it('rejects duplicated keys, empty and multi-document inputs', () => {
    expectJsonError('a: 1\na: 2\n', /duplicated mapping key/, 1, 0)
    assert.throws(() => loadJson(''), /expected a document, but the input is empty/)
    assert.throws(
      () => loadJson('---\na: 1\n---\nb: 2\n'),
      /expected a single document in the stream/)
  })

  it('keeps a literal __proto__ key a safe own property', () => {
    const result = loadJson('__proto__:\n  polluted: 1\n')
    assert.equal(Object.prototype.polluted, undefined)
    const descriptor = Object.getOwnPropertyDescriptor(result, '__proto__')
    assert.ok(descriptor && 'value' in descriptor && descriptor.enumerable)
    assert.deepEqual(descriptor.value, { polluted: 1 })
    assert.doesNotThrow(() => JSON.stringify(result))
  })

  it('leaves ordinary load behavior unchanged', () => {
    // Coercion of non-string keys in the plain-object map still happens.
    assert.deepEqual(load('1: x'), { 1: 'x' })

    // Reference cycles are still constructible by ordinary load.
    const cyclic = load('a: &a [1, *a]\n')
    assert.equal(cyclic.a[1], cyclic.a)

    // Non-finite explicit floats still load.
    assert.equal(load('a: !!float .inf').a, Number.POSITIVE_INFINITY)
  })
})
