#!/usr/bin/env node

// Demo: incremental reading of a multi-document YAML stream.
//
// The stream is fed to DocumentReader one byte at a time. Documents are
// emitted as soon as their real boundary is seen: the `---` inside the
// literal block of the first document does not split it, and each emitted
// slice carries its byte range in the original stream (a `---` marker
// belongs to the document it opens, a `...` marker to the one it closes).
//
// Run: npm run demo:incremental
//   or: npm run build && node examples/incremental-documents.mjs

import { DocumentReader, load } from '../dist/js-yaml.mjs'

const source = `---
key: |
  ---
  this text, including the --- line above, is a single scalar
...
---
name: second document
`

const encoder = new TextEncoder()
const bytes = encoder.encode(source)

const reader = new DocumentReader()
const documents = []

for (let offset = 0; offset < bytes.length; offset++) {
  documents.push(...reader.write(bytes.slice(offset, offset + 1)))
}
documents.push(...reader.end())

for (const [index, document] of documents.entries()) {
  console.log(`document ${index + 1}: bytes [${document.start}, ${document.end})`)
  console.log(JSON.stringify(load(document.text)))
}
