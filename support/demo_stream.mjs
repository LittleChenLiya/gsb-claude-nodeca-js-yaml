#!/usr/bin/env node

/**
 * Demo: incremental document reader based on parseEvents.
 *
 * Feeds a two-document YAML stream one byte at a time and prints each
 * document as soon as its true boundary is detected. Also demonstrates
 * that a `---` embedded in a literal block scalar never splits a document,
 * that byte ranges include the original separator ownership, and that a
 * truncated multi-byte UTF-8 sequence fails explicitly.
 */

import { DocumentReader } from '../src/parser/stream.ts'

function feedOneByteAtATime (input, options = {}) {
  const reader = new DocumentReader(options)
  const docs = []
  const bytes = new TextEncoder().encode(input)
  for (let i = 0; i < bytes.length; i++) {
    docs.push(...reader.write(bytes.slice(i, i + 1)))
  }
  docs.push(...reader.end())
  return docs
}

function show (label, input, options = {}) {
  console.log(`--- ${label} ---`)
  console.log('input:', JSON.stringify(input))
  try {
    const docs = feedOneByteAtATime(input, options)
    console.log(`documents: ${docs.length}`)
    for (const doc of docs) {
      console.log(`  bytes [${doc.start}, ${doc.end}) explicitStart=${doc.explicitStart} explicitEnd=${doc.explicitEnd}`)
      console.log(`  value:`, JSON.stringify(doc.value))
      console.log(`  slice:`, JSON.stringify(input.slice(doc.start, doc.end)))
    }
  } catch (error) {
    console.log('error:', error.message)
  }
  console.log()
}

// 1. Two documents, per-byte chunks. The `---` separator belongs to the
//    following document; the range includes the original separator ownership.
show('1. two documents, per-byte chunks', 'a: 1\n---\nb: 2\n')

// 2. The same `---` text inside a literal block scalar still belongs to one
//    scalar and never splits the document.
show('2. literal block with ---', 'a: |\n  ---\n  text\nb: 2\n')

// 3. An explicit `...` end marker belongs to the document that ends it.
show('3. explicit end marker', 'a: 1\n...\n---\nb: 2\n')

// 4. A truncated multi-byte UTF-8 character fails explicitly.
show('4. truncated multi-byte', 'a: "\xe4\xb8\xad')

// 5. A document exceeding maxDocumentSize is rejected before delivery.
show('5. maxDocumentSize limit', 'a: 1234567890\n', { maxDocumentSize: 5 })

// 6. A BOM is only accepted at the start of the stream or before a document
//    marker; an illegal BOM in the middle of a document fails.
show('6. illegal BOM mid-document', 'a: 1\n﻿b: 2\n')
