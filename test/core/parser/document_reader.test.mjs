import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DocumentReader, load, loadAll, YAMLException } from 'js-yaml'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function feed (source, options, chunkSize = 1) {
  const reader = new DocumentReader(options)
  const bytes = encoder.encode(source)
  const documents = []
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    documents.push(...reader.write(bytes.slice(offset, offset + chunkSize)))
  }
  documents.push(...reader.end())
  return documents
}

describe('DocumentReader', () => {
  it('returns two documents fed byte by byte, ranges owning their separators', () => {
    const part1 = '---\nname: ☃\n...\n'
    const part2 = '---\nname: second\n'
    const source = part1 + part2
    const sourceBytes = encoder.encode(source)

    const documents = feed(source)

    // `...` belongs to the document it closes, `---` to the one it opens.
    assert.equal(documents.length, 2)
    assert.deepEqual(documents[0], {
      text: part1,
      start: 0,
      end: encoder.encode(part1).length
    })
    assert.deepEqual(documents[1], {
      text: part2,
      start: encoder.encode(part1).length,
      end: sourceBytes.length
    })

    // Ranges are byte ranges into the original stream.
    for (const document of documents) {
      assert.equal(decoder.decode(sourceBytes.slice(document.start, document.end)), document.text)
    }

    assert.deepEqual(documents.map(document => load(document.text)), [
      { name: '☃' },
      { name: 'second' }
    ])
    // The default loadAll is unchanged and agrees with the reader.
    assert.deepEqual(loadAll(source), [{ name: '☃' }, { name: 'second' }])
  })

  it('is insensitive to chunking', () => {
    const source = '---\nname: ☃\n...\n---\nkey: |\n  ---\n  text\n'
    const expected = feed(source, undefined, 1)
    for (const chunkSize of [2, 3, 5, 7, 64, 1024]) {
      assert.deepEqual(feed(source, undefined, chunkSize), expected)
    }
  })

  it('keeps --- inside a literal block scalar in a single document', () => {
    const documents = feed('---\nkey: |\n  ---\n  still the same scalar\n...\n')

    assert.equal(documents.length, 1)
    assert.deepEqual(load(documents[0].text), { key: '---\nstill the same scalar\n' })
  })

  it('keeps --- inside quoted scalars in a single document', () => {
    for (const source of ['key: "\n  ---\n  "\n', "key: '\n  ---\n  '\n"]) {
      const documents = feed(source)

      assert.equal(documents.length, 1)
      assert.deepEqual(load(documents[0].text), { key: ' --- ' })
    }
  })

  it('fails clearly on a truncated multi-byte character', () => {
    const reader = new DocumentReader()
    const bytes = encoder.encode('key: ☃') // ☃ = 0xE2 0x98 0x83

    reader.write(bytes.slice(0, bytes.length - 1))
    assert.throws(
      () => reader.end(),
      error => error instanceof YAMLException && /multi-byte UTF-8/.test(error.message)
    )
  })

  it('fails clearly on invalid UTF-8 bytes', () => {
    const reader = new DocumentReader()

    reader.write(new Uint8Array([0x61, 0xE2, 0x98]))
    assert.throws(
      () => reader.write(new Uint8Array([0x61])), // not a continuation byte
      error => error instanceof YAMLException && /UTF-8/.test(error.message)
    )
  })

  it('rejects an over-limit document without delivering it', () => {
    const reader = new DocumentReader({ maxDocumentBytes: 16 })

    assert.throws(
      () => reader.write(encoder.encode(`key: ${'x'.repeat(64)}\n`)),
      error => error instanceof YAMLException && /exceeds the limit/.test(error.message)
    )
  })

  it('rejects an over-limit document even when its boundary already arrived', () => {
    const reader = new DocumentReader({ maxDocumentBytes: 10 })

    assert.throws(
      () => reader.write(encoder.encode('a: 123456789\n---\nb: 1\n')),
      error => error instanceof YAMLException && /exceeds the limit/.test(error.message)
    )
  })

  it('accepts a BOM only at the start of a document', () => {
    // Stream start and document boundary: legal.
    assert.equal(feed('﻿---\na: 1\n').length, 1)
    assert.equal(feed('a: 1\n...\n﻿---\nb: 2\n').length, 2)

    // Mid-line and mid-document line-start: rejected.
    for (const source of ['a: 1\nb: ﻿x\n', 'a: 1\n﻿b: 2\n']) {
      assert.throws(
        () => feed(source),
        error => error instanceof YAMLException && /byte order mark/.test(error.message)
      )
    }
  })

  it('finalizes documents at EOF and at an explicit end', () => {
    assert.deepEqual(feed('a: 1').map(document => document.text), ['a: 1'])
    assert.deepEqual(feed('a: 1\n...\n\n').map(document => document.text), ['a: 1\n...\n'])
    assert.deepEqual(feed('a: 1\n---\nb: 2').map(document => document.text), ['a: 1\n', '---\nb: 2'])
    assert.deepEqual(feed(''), [])
    assert.deepEqual(feed('\n# only a comment\n'), [])
  })

  it('propagates parse errors for a malformed trailing document', () => {
    assert.throws(() => feed('a: 1\n  bad: [\n'), YAMLException)
  })
})
