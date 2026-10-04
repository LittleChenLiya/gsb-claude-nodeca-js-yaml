#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import argparse from 'argparse'
import { auditSchemaMigration, formatAuditReport } from 'js-yaml'

const cli = new argparse.ArgumentParser({
  prog: 'js-yaml-audit',
  add_help: true,
  description: 'Offline schema migration auditor: compares CORE, JSON and YAML11 resolution of every scalar without executing custom tag constructors.'
})

cli.add_argument('-v', '--version', {
  action: 'version',
  version: '5.4.2'
})

cli.add_argument('file', {
  help: 'YAML file to audit, utf-8 encoded without BOM',
  nargs: '?',
  default: '-'
})

const options = cli.parse_args()

if (options.file === '-' && process.stdin.isTTY) {
  cli.print_help()
  process.exit(1)
}

let input

try {
  input = readFileSync(options.file === '-' ? 0 : options.file, 'utf8')
} catch (error) {
  if (error.code === 'ENOENT') {
    console.error('File not found: ' + options.file)
    process.exit(2)
  }

  console.error(error.message || String(error))
  process.exit(1)
}

try {
  const result = auditSchemaMigration(input, { filename: options.file })
  process.stdout.write(formatAuditReport(result))
} catch (error) {
  console.error(error.message || String(error))
  process.exit(1)
}
