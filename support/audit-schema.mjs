#!/usr/bin/env node
//
// Offline schema-migration auditor.
//
// Parses a YAML file once and reports how every scalar resolves under the
// built-in CORE, JSON and YAML 1.1 schemas: type/value changes between the
// `from` and `to` schemas, mapping-key conflicts introduced by the `to`
// schema, and alias references with their anchor definition locations.
// Custom tag constructors are never executed.
//
// Usage:
//   node support/audit-schema.mjs [--from core|json|yaml11] [--to core|json|yaml11] <file.yml>
//
// Example:
//   node support/audit-schema.mjs config.yml
//   node support/audit-schema.mjs --from core --to yaml11 config.yml

import { readFileSync } from 'node:fs'
import { auditSchemaMigration } from '../src/index.ts'

function usage (message) {
  if (message) console.error(`error: ${message}`)
  console.error('usage: node support/audit-schema.mjs [--from core|json|yaml11] [--to core|json|yaml11] <file.yml>')
  process.exit(message ? 2 : 0)
}

const options = { from: 'core', to: 'yaml11' }
let file = null

const args = process.argv.slice(2)
for (let index = 0; index < args.length; index++) {
  const arg = args[index]

  if (arg === '--help' || arg === '-h') usage()
  else if (arg === '--from' || arg === '--to') {
    const value = args[++index]
    if (!['core', 'json', 'yaml11'].includes(value)) usage(`invalid ${arg} schema: ${value}`)
    options[arg.slice(2)] = value
  } else if (arg.startsWith('--from=') || arg.startsWith('--to=')) {
    const [name, value] = arg.slice(2).split('=')
    if (!['core', 'json', 'yaml11'].includes(value)) usage(`invalid ${name} schema: ${value}`)
    options[name] = value
  } else if (arg.startsWith('-')) {
    usage(`unknown option: ${arg}`)
  } else if (file === null) {
    file = arg
  } else {
    usage(`unexpected extra argument: ${arg}`)
  }
}

if (file === null) usage('no input file given')

let source
try {
  source = readFileSync(file, 'utf8')
} catch (error) {
  console.error(`error: cannot read ${file}: ${error.message}`)
  process.exit(2)
}

const report = auditSchemaMigration(source, { filename: file, from: options.from, to: options.to })
console.log(JSON.stringify(report, null, 2))

// Exit code 1 when the migration introduces changes or key conflicts.
process.exit(report.changes.length > 0 || report.keyConflicts.length > 0 ? 1 : 0)
