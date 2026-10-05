#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import argparse from 'argparse'
import { DocumentReader } from 'js-yaml'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))

/// /////////////////////////////////////////////////////////////////////////////

const cli = new argparse.ArgumentParser({
  prog: 'js-yaml-stream',
  add_help: true,
  description: 'Incremental YAML document reader. Reads input in small chunks and emits each document as soon as its boundary is detected.'
})

cli.add_argument('-v', '--version', {
  action: 'version',
  version: pkg.version
})

cli.add_argument('-c', '--chunk-size', {
  help: 'Number of bytes to feed per write (default: 1, demonstrating per-byte incremental parsing)',
  type: 'int',
  default: 1,
  dest: 'chunkSize'
})

cli.add_argument('-m', '--max-document-size', {
  help: 'Maximum size in bytes of a single document; 0 disables the limit (default: 0)',
  type: 'int',
  default: 0,
  dest: 'maxDocumentSize'
})

cli.add_argument('-r', '--show-ranges', {
  help: 'Print the original byte range of each document to stderr',
  action: 'store_true',
  dest: 'showRanges'
})

cli.add_argument('file', {
  help: 'File to read, utf-8 encoded without BOM',
  nargs: '?',
  default: '-'
})

/// /////////////////////////////////////////////////////////////////////////////

const options = cli.parse_args()

/// /////////////////////////////////////////////////////////////////////////////

// '-' means stdin (fd 0); a terminal there => nothing piped in, show help
if (options.file === '-' && process.stdin.isTTY) {
  cli.print_help()
  process.exit(1)
}

let input

try {
  input = readFileSync(options.file === '-' ? 0 : options.file)
} catch (error) {
  if (error.code === 'ENOENT') {
    console.error(`File not found: ${options.file}`)
    process.exit(2)
  }

  console.error(error.message || String(error))
  process.exit(1)
}

/// /////////////////////////////////////////////////////////////////////////////

const reader = new DocumentReader({
  maxDocumentSize: options.maxDocumentSize
})

let documentCount = 0
let failed = false

function emit (doc) {
  documentCount++
  if (options.showRanges) {
    process.stderr.write(`# document ${documentCount}: bytes [${doc.start}, ${doc.end}) explicitStart=${doc.explicitStart} explicitEnd=${doc.explicitEnd}\n`)
  }
  process.stdout.write(JSON.stringify(doc.value) + '\n')
}

try {
  for (let i = 0; i < input.length; i += options.chunkSize) {
    const chunk = input.subarray(i, i + options.chunkSize)
    for (const doc of reader.write(chunk)) emit(doc)
  }
  for (const doc of reader.end()) emit(doc)
} catch (error) {
  failed = true
  console.error(error.message || String(error))
  process.exit(1)
}

if (!failed && options.showRanges) {
  process.stderr.write(`# total documents: ${documentCount}\n`)
}
