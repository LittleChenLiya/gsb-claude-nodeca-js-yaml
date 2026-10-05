import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DocumentReader, loadAll } from 'js-yaml'

function feed (input, chunkSize, options = {}) {
  const reader = new DocumentReader(options)
  const docs = []
  const bytes = new TextEncoder().encode(input)
  for (let i = 0; i < bytes.length; i += chunkSize) {
    docs.push(...reader.write(bytes.slice(i, i + chunkSize)))
  }
  docs.push(...reader.end())
  return docs
}

describe('DocumentReader', () => {
  it('returns two documents from per-byte chunks', () => {
    const input = 'a: 1\n---\nb: 2\n'
    const docs = feed(input, 1)

    assert.equal(docs.length, 2)
    assert.deepEqual(docs.map(d => d.value), [{ a: 1 }, { b: 2 }])
    assert.deepEqual(docs.map(d => [d.start, d.end]), [[0, 5], [5, 14]])
    assert.equal(input.slice(docs[0].start, docs[0].end), 'a: 1\n')
    assert.equal(input.slice(docs[1].start, docs[1].end), '---\nb: 2\n')
  })

  it('keeps --- inside a literal block scalar in one document', () => {
    const input = 'a: |\n  ---\n  text\nb: 2\n'
    const docs = feed(input, 1)

    assert.equal(docs.length, 1)
    assert.deepEqual(docs[0].value, { a: '---\ntext\n', b: 2 })
    assert.deepEqual([docs[0].start, docs[0].end], [0, 23])
  })

  it('keeps --- inside a quoted scalar in one document', () => {
    const input = 'a: "---"\n---\nb: 2\n'
    const docs = feed(input, 1)

    assert.equal(docs.length, 2)
    assert.deepEqual(docs.map(d => d.value), [{ a: '---' }, { b: 2 }])
  })

  it('fails explicitly on a truncated multi-byte character', () => {
    const reader = new DocumentReader()
    const bytes = new TextEncoder().encode('a: "\xe4\xb8\xad')
    reader.write(bytes.slice(0, bytes.length - 1))

    assert.throws(() => reader.end(), /truncated multi-byte/)
  })

  it('handles an explicit ... end marker with correct range ownership', () => {
    const input = 'a: 1\n...\n---\nb: 2\n'
    const docs = feed(input, 1)

    assert.equal(docs.length, 2)
    assert.deepEqual(docs.map(d => d.value), [{ a: 1 }, { b: 2 }])
    assert.deepEqual(docs.map(d => [d.start, d.end]), [[0, 8], [8, 18]])
    assert.equal(input.slice(docs[0].start, docs[0].end), 'a: 1\n...')
    assert.equal(input.slice(docs[1].start, docs[1].end), '\n---\nb: 2\n')
    assert.equal(docs[0].explicitEnd, true)
    assert.equal(docs[1].explicitStart, true)
  })

  it('accepts a BOM at the start of the stream', () => {
    const input = '﻿a: 1\n'
    const docs = feed(input, 1)

    assert.equal(docs.length, 1)
    assert.deepEqual(docs[0].value, { a: 1 })
  })

  it('accepts a BOM before a document separator', () => {
    const input = 'a: 1\n﻿---\nb: 2\n'
    const docs = feed(input, 1)

    assert.equal(docs.length, 2)
    assert.deepEqual(docs.map(d => d.value), [{ a: 1 }, { b: 2 }])
  })

  it('rejects an illegal BOM in the middle of a document', () => {
    const reader = new DocumentReader()

    assert.throws(
      () => reader.write('a: 1\n﻿b: 2\n'),
      /BOM is only allowed at the start of a document/
    )
  })

  it('rejects a document exceeding maxDocumentSize before delivery', () => {
    const reader = new DocumentReader({ maxDocumentSize: 5 })

    assert.throws(
      () => reader.write('a: 1234567890\n'),
      /document exceeds maxDocumentSize/
    )
  })

  it('returns empty documents for --- separators', () => {
    const input = '---\n---\n'
    const docs = feed(input, 1)

    assert.equal(docs.length, 2)
    assert.deepEqual(docs.map(d => d.value), [null, null])
    assert.deepEqual(docs.map(d => [d.start, d.end]), [[0, 4], [4, 8]])
  })

  it('matches loadAll results for a multi-document stream', () => {
    const input = 'a: 1\n---\nb: 2\n---\nc: 3\n'
    const docs = feed(input, 1)
    const expected = loadAll(input)

    assert.deepEqual(docs.map(d => d.value), expected)
  })

  it('calls onDocument as each document is delivered', () => {
    const input = 'a: 1\n---\nb: 2\n'
    const seen = []
    const docs = feed(input, 1, { onDocument: doc => seen.push(doc) })

    assert.equal(seen.length, 2)
    assert.equal(seen[0], docs[0])
    assert.equal(seen[1], docs[1])
  })
})
