/**
 * Offline schema-migration auditor.
 *
 * Parses the event stream of a YAML source exactly once and, for every
 * scalar, compares how the built-in CORE, JSON and YAML 1.1 schemas resolve
 * its type and canonical value. The report helps migrating a configuration
 * file from one schema to another (CORE -> YAML 1.1 by default):
 *
 * - per-scalar resolution under each schema, with path and line/column;
 * - type/value changes between the `from` and `to` schemas;
 * - mapping-key conflicts: keys that are distinct under the `from` schema
 *   but collapse to the same identity under the `to` schema;
 * - alias references with the location of the anchored node they point to.
 *
 * Only the built-in safe schemas are used. Custom tag constructors are never
 * executed: an explicit tag unknown to the built-in schemas is reported as
 * `unknown-tag` instead of being constructed. Explicitly tagged scalars and
 * implicitly resolved plain scalars are interpreted through separate paths,
 * mirroring the loader. `load`/`loadAll` behavior is not affected.
 *
 * @category Auditing
 */

import { CORE_SCHEMA, JSON_SCHEMA, YAML11_SCHEMA, type Schema } from './schema.ts'
import { NOT_RESOLVED } from './tag.ts'
import { parseEvents } from './parser/parser.ts'
import { getScalarValue } from './parser/parser_scalar.ts'
import {
  EVENT_ID,
  SCALAR_STYLE,
  type Event,
  type ScalarEvent,
  type TagHandlers
} from './parser/events.ts'
import { tagNameFull } from './common/tagname.ts'

const NO_RANGE = -1

/** Built-in safe schemas every scalar is compared under. */
const COMPARED_SCHEMAS = {
  core: CORE_SCHEMA,
  json: JSON_SCHEMA,
  yaml11: YAML11_SCHEMA
} as const

/** @category Auditing */
type AuditSchemaName = keyof typeof COMPARED_SCHEMAS

const COMPARED_SCHEMA_NAMES = Object.keys(COMPARED_SCHEMAS) as AuditSchemaName[]

/** @category Auditing */
type ScalarValueType = 'null' | 'boolean' | 'number' | 'string' | 'date' | 'binary' | 'other'

/**
 * How one schema resolves one scalar. `unknown-tag` means the explicit tag
 * is not part of the built-in safe schemas (its constructor is not run);
 * `unresolved` means the tag is known but rejected the source text;
 * `non-scalar-tag` means the explicit tag denotes a collection.
 *
 * @category Auditing
 */
type ScalarResolution =
  {
    status: 'resolved'
    tag: string
    valueType: ScalarValueType
    value: unknown
    /** Printed form used for comparisons; never coerced across types. */
    canonical: string
  } |
  {
    status: 'unknown-tag' | 'unresolved' | 'non-scalar-tag'
    tag: string
  }

/** @category Auditing */
type ScalarChangeKind = 'unchanged' | 'type-change' | 'value-change' | 'status-change'

/** @category Auditing */
type ScalarStyleName = 'plain' | 'single-quoted' | 'double-quoted' | 'literal' | 'folded'

/** @category Auditing */
type ScalarRole = 'document' | 'key' | 'value' | 'item'

/** @category Auditing */
interface SourceLocation {
  path: string
  line: number
  column: number
}

/** @category Auditing */
interface ScalarAuditEntry extends SourceLocation {
  role: ScalarRole
  style: ScalarStyleName
  /** Decoded scalar text. */
  source: string
  /** Full explicit tag name, or `null` for implicitly resolved scalars. */
  explicitTag: string | null
  /** Anchor name if this scalar defines one. */
  anchor: string | null
  /** Resolution of the same scalar under each compared schema. */
  resolved: Record<AuditSchemaName, ScalarResolution>
  /** Change classification between the `from` and `to` schemas. */
  change: ScalarChangeKind
}

/** @category Auditing */
interface KeyConflictEntry extends SourceLocation {
  /** Identity the keys collapse to under the `to` schema (`type:canonical`). */
  identity: string
  keys: Array<SourceLocation & {
    /** Decoded key text. */
    source: string
    /** Key identity under the `from` schema. */
    fromIdentity: string
  }>
}

/** @category Auditing */
interface AliasAuditEntry extends SourceLocation {
  /** Anchor name referenced by the alias. */
  name: string
  /** Location of the node that defines the anchor, if known. */
  target: SourceLocation | null
}

/** @category Auditing */
interface SchemaAuditReport {
  filename: string
  schemas: {
    from: AuditSchemaName
    to: AuditSchemaName
    compared: AuditSchemaName[]
  }
  summary: {
    scalarCount: number
    typeChanges: number
    valueChanges: number
    statusChanges: number
    keyConflicts: number
    unknownTags: number
    aliasCount: number
  }
  /** Scalars whose resolution differs between the `from` and `to` schemas. */
  changes: ScalarAuditEntry[]
  /** Mapping keys collapsing to one identity under the `to` schema. */
  keyConflicts: KeyConflictEntry[]
  /** Alias occurrences with the location of their anchor definition. */
  aliases: AliasAuditEntry[]
  /** Every scalar in document order, including unchanged ones. */
  scalars: ScalarAuditEntry[]
}

/** @category Auditing */
interface SchemaAuditOptions {
  /** File path used in the report. @defaultValue `''` */
  filename?: string
  /** Schema the configuration currently uses. @defaultValue `'core'` */
  from?: AuditSchemaName
  /** Schema being migrated to. @defaultValue `'yaml11'` */
  to?: AuditSchemaName
  /** Maximum nesting depth for collections. @defaultValue `100` */
  maxDepth?: number
}

const STYLE_NAMES: Record<number, ScalarStyleName> = {
  [SCALAR_STYLE.PLAIN]: 'plain',
  [SCALAR_STYLE.SINGLE_QUOTED]: 'single-quoted',
  [SCALAR_STYLE.DOUBLE_QUOTED]: 'double-quoted',
  [SCALAR_STYLE.LITERAL_BLOCK]: 'literal',
  [SCALAR_STYLE.FOLDED_BLOCK]: 'folded'
}

function valueTypeOf (value: unknown): ScalarValueType {
  if (value === null) return 'null'
  if (value instanceof Date) return 'date'
  if (value instanceof Uint8Array) return 'binary'

  switch (typeof value) {
    case 'boolean': return 'boolean'
    case 'number': return 'number'
    case 'string': return 'string'
    default: return 'other'
  }
}

function canonicalOf (value: unknown, valueType: ScalarValueType): string {
  switch (valueType) {
    case 'null': return 'null'
    case 'date': return (value as Date).toISOString()
    case 'binary': return Array.from(value as Uint8Array).join(',')
    default: return String(value)
  }
}

function resolvedResolution (tagName: string, value: unknown): ScalarResolution {
  const valueType = valueTypeOf(value)
  return { status: 'resolved', tag: tagName, valueType, value, canonical: canonicalOf(value, valueType) }
}

/**
 * Resolve one scalar under one built-in schema. Explicit tags and implicit
 * plain scalars go through separate paths, exactly like the constructor;
 * quoted and block scalars are always strings unless explicitly tagged.
 */
function resolveInSchema (
  schema: Schema,
  text: string,
  explicitTag: string | null,
  isPlain: boolean
): ScalarResolution {
  if (explicitTag !== null) {
    // `!` is the non-specific tag: the constructor resolves it as !!str.
    if (explicitTag === '!') {
      const tag = schema.defaultScalarTag
      return resolvedResolution(tag.tagName, tag.resolve(text, true, tag.tagName))
    }

    const scalarTag = schema.lookupScalarTag(explicitTag)
    if (!scalarTag) {
      const isCollection =
        schema.lookupMappingTag(explicitTag) !== undefined ||
        schema.lookupSequenceTag(explicitTag) !== undefined
      return { status: isCollection ? 'non-scalar-tag' : 'unknown-tag', tag: explicitTag }
    }

    const value = scalarTag.resolve(text, true, explicitTag)
    if (value === NOT_RESOLVED) return { status: 'unresolved', tag: explicitTag }

    return resolvedResolution(scalarTag.tagName, value)
  }

  if (isPlain) {
    const { value, tag } = schema.resolveImplicitScalarTag(text)
    return resolvedResolution(tag.tagName, value)
  }

  const tag = schema.defaultScalarTag
  return resolvedResolution(tag.tagName, tag.resolve(text, false, tag.tagName))
}

/**
 * Strict identity of a resolved value: the type tag is part of the identity,
 * so plain strings and numbers are never coerced into each other when
 * comparing (`"1"` and `1` stay distinct, as do `"yes"` and `true`).
 */
function identityOf (resolution: ScalarResolution): string | null {
  if (resolution.status !== 'resolved') return null
  return `${resolution.valueType}:${resolution.canonical}`
}

function classifyChange (from: ScalarResolution, to: ScalarResolution): ScalarChangeKind {
  if (from.status !== 'resolved' || to.status !== 'resolved') {
    return from.status === to.status && from.tag === to.tag ? 'unchanged' : 'status-change'
  }

  if (from.tag !== to.tag || from.valueType !== to.valueType) return 'type-change'
  if (from.canonical !== to.canonical) return 'value-change'
  return 'unchanged'
}

function computeLineStarts (source: string): number[] {
  const starts = [0]

  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index)

    if (code === 0x0A) { // \n
      starts.push(index + 1)
    } else if (code === 0x0D) { // \r or \r\n
      if (source.charCodeAt(index + 1) === 0x0A) index++
      starts.push(index + 1)
    }
  }

  return starts
}

/** Convert a zero-based offset to one-based line/column. */
function offsetToLineColumn (lineStarts: readonly number[], offset: number): { line: number, column: number } {
  let low = 0
  let high = lineStarts.length - 1

  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (lineStarts[mid] <= offset) low = mid
    else high = mid - 1
  }

  return { line: low + 1, column: offset - lineStarts[low] + 1 }
}

const PLAIN_KEY_SEGMENT = /^[A-Za-z_$][0-9A-Za-z_$]*$/

function keySegment (keyText: string): string {
  return PLAIN_KEY_SEGMENT.test(keyText) ? `.${keyText}` : `[${JSON.stringify(keyText)}]`
}

interface SequenceFrame {
  kind: 'sequence'
  path: string
  index: number
}

interface KeyRecord extends SourceLocation {
  source: string
  fromIdentity: string | null
  toIdentity: string | null
}

interface MappingFrame {
  kind: 'mapping'
  path: string
  line: number
  column: number
  hasKey: boolean
  pendingKeySegment: string
  keys: KeyRecord[]
}

interface DocumentFrame {
  kind: 'document'
}

type Frame = SequenceFrame | MappingFrame | DocumentFrame

interface AnchorRecord extends SourceLocation {
  resolved: Record<AuditSchemaName, ScalarResolution> | null
}

function eventOffset (event: Event): number {
  if ('valueStart' in event && event.valueStart !== NO_RANGE) return event.valueStart
  if ('tagStart' in event && event.tagStart !== NO_RANGE) return event.tagStart
  if ('anchorStart' in event && event.anchorStart !== NO_RANGE) return event.anchorStart
  if ('start' in event) return event.start
  return 0
}

/**
 * Audit a YAML source for scalar resolution differences between the built-in
 * CORE, JSON and YAML 1.1 schemas. The source is parsed once; `load` behavior
 * is unchanged and no custom tag constructors are executed.
 *
 * @category Auditing
 */
function auditSchemaMigration (source: string, options?: SchemaAuditOptions): SchemaAuditReport {
  const filename = options?.filename ?? ''
  const fromName: AuditSchemaName = options?.from ?? 'core'
  const toName: AuditSchemaName = options?.to ?? 'yaml11'

  if (!Object.prototype.hasOwnProperty.call(COMPARED_SCHEMAS, fromName)) {
    throw new Error(`auditSchemaMigration: unknown 'from' schema ${JSON.stringify(fromName)}`)
  }
  if (!Object.prototype.hasOwnProperty.call(COMPARED_SCHEMAS, toName)) {
    throw new Error(`auditSchemaMigration: unknown 'to' schema ${JSON.stringify(toName)}`)
  }

  const events = parseEvents(source, { filename, maxDepth: options?.maxDepth })
  const lineStarts = computeLineStarts(source)

  const scalars: ScalarAuditEntry[] = []
  const changes: ScalarAuditEntry[] = []
  const keyConflicts: KeyConflictEntry[] = []
  const aliases: AliasAuditEntry[] = []
  const anchors = new Map<string, AnchorRecord>()

  const frames: Frame[] = []
  let tagHandlers: TagHandlers = Object.create(null)

  const locate = (offset: number): { line: number, column: number } =>
    offsetToLineColumn(lineStarts, offset)

  // True when the next node event lands in the key slot of a mapping.
  function nextNodeIsKey (): boolean {
    const parent = frames[frames.length - 1]
    return parent !== undefined && parent.kind === 'mapping' && !parent.hasKey
  }

  // Where the next node attaches: path of the node itself and its role.
  // `keyText` is the decoded key text when the node is a scalar mapping key.
  function attachNode (keyText: string | null): { path: string, role: ScalarRole } {
    const parent = frames[frames.length - 1]

    if (!parent || parent.kind === 'document') return { path: '$', role: 'document' }

    if (parent.kind === 'sequence') {
      const path = `${parent.path}[${parent.index}]`
      parent.index++
      return { path, role: 'item' }
    }

    if (!parent.hasKey) {
      parent.hasKey = true
      parent.pendingKeySegment = keySegment(keyText ?? '?')
      return { path: parent.path + parent.pendingKeySegment, role: 'key' }
    }

    parent.hasKey = false
    return { path: parent.path + parent.pendingKeySegment, role: 'value' }
  }

  function rememberAnchor (event: Event, location: SourceLocation, resolved: AnchorRecord['resolved']) {
    if ('anchorStart' in event && event.anchorStart !== NO_RANGE) {
      anchors.set(source.slice(event.anchorStart, event.anchorEnd), { ...location, resolved })
    }
  }

  function recordKey (location: SourceLocation, text: string, resolved: AnchorRecord['resolved']) {
    const parent = frames[frames.length - 1]
    if (!parent || parent.kind !== 'mapping') return

    parent.keys.push({
      ...location,
      source: text,
      fromIdentity: resolved ? identityOf(resolved[fromName]) : null,
      toIdentity: resolved ? identityOf(resolved[toName]) : null
    })
  }

  function processScalar (event: ScalarEvent) {
    const text = getScalarValue(source, event)
    const rawTag = event.tagStart === NO_RANGE ? '' : source.slice(event.tagStart, event.tagEnd)
    const explicitTag = rawTag === '' ? null : (rawTag === '!' ? '!' : tagNameFull(rawTag, tagHandlers))
    const isPlain = event.style === SCALAR_STYLE.PLAIN && explicitTag === null

    const { path, role } = attachNode(nextNodeIsKey() ? text : null)
    const { line, column } = locate(eventOffset(event))

    const resolved = Object.create(null) as Record<AuditSchemaName, ScalarResolution>
    for (const name of COMPARED_SCHEMA_NAMES) {
      resolved[name] = resolveInSchema(COMPARED_SCHEMAS[name], text, explicitTag, isPlain)
    }

    const change = classifyChange(resolved[fromName], resolved[toName])

    const entry: ScalarAuditEntry = {
      path,
      line,
      column,
      role,
      style: STYLE_NAMES[event.style],
      source: text,
      explicitTag,
      anchor: event.anchorStart === NO_RANGE ? null : source.slice(event.anchorStart, event.anchorEnd),
      resolved,
      change
    }

    scalars.push(entry)
    if (change !== 'unchanged') changes.push(entry)

    rememberAnchor(event, { path, line, column }, resolved)
    if (role === 'key') recordKey({ path, line, column }, text, resolved)
  }

  function processAlias (event: Extract<Event, { type: typeof EVENT_ID.ALIAS }>) {
    const name = source.slice(event.anchorStart, event.anchorEnd)
    const target = anchors.get(name) ?? null

    // An alias in key position reuses the anchored scalar's resolutions, so
    // key identity follows the alias target.
    const { path, role } = attachNode(nextNodeIsKey() ? `*${name}` : null)
    const { line, column } = locate(eventOffset(event))

    aliases.push({
      name,
      path,
      line,
      column,
      target: target ? { path: target.path, line: target.line, column: target.column } : null
    })

    if (role === 'key') recordKey({ path, line, column }, `*${name}`, target ? target.resolved : null)
  }

  function closeMapping (frame: MappingFrame) {
    const byToIdentity = new Map<string, KeyRecord[]>()

    for (const key of frame.keys) {
      if (key.toIdentity === null || key.fromIdentity === null) continue
      const group = byToIdentity.get(key.toIdentity)
      if (group) group.push(key)
      else byToIdentity.set(key.toIdentity, [key])
    }

    for (const [identity, keys] of byToIdentity) {
      if (keys.length < 2) continue

      // Only report keys that were distinct under the `from` schema: a
      // collision the old schema already had is not a migration hazard.
      const fromIdentities = new Set(keys.map(key => key.fromIdentity))
      if (fromIdentities.size < 2) continue

      keyConflicts.push({
        path: frame.path,
        line: frame.line,
        column: frame.column,
        identity,
        keys: keys.map(key => ({
          path: key.path,
          line: key.line,
          column: key.column,
          source: key.source,
          fromIdentity: key.fromIdentity as string
        }))
      })
    }
  }

  for (const event of events) {
    switch (event.type) {
      case EVENT_ID.DOCUMENT: {
        tagHandlers = Object.create(null)
        for (const directive of event.directives) {
          if (directive.kind === 'tag') tagHandlers[directive.handle] = directive.prefix
        }
        frames.push({ kind: 'document' })
        break
      }

      case EVENT_ID.SEQUENCE: {
        const { path } = attachNode(null)
        const { line, column } = locate(eventOffset(event))
        rememberAnchor(event, { path, line, column }, null)
        frames.push({ kind: 'sequence', path, index: 0 })
        break
      }

      case EVENT_ID.MAPPING: {
        const { path } = attachNode(null)
        const { line, column } = locate(eventOffset(event))
        rememberAnchor(event, { path, line, column }, null)
        frames.push({ kind: 'mapping', path, line, column, hasKey: false, pendingKeySegment: '', keys: [] })
        break
      }

      case EVENT_ID.SCALAR:
        processScalar(event)
        break

      case EVENT_ID.ALIAS:
        processAlias(event)
        break

      case EVENT_ID.POP: {
        const frame = frames.pop()
        if (frame && frame.kind === 'mapping') closeMapping(frame)
        break
      }
    }
  }

  let unknownTags = 0
  for (const entry of scalars) {
    for (const name of COMPARED_SCHEMA_NAMES) {
      if (entry.resolved[name].status === 'unknown-tag') {
        unknownTags++
        break
      }
    }
  }

  return {
    filename,
    schemas: { from: fromName, to: toName, compared: [...COMPARED_SCHEMA_NAMES] },
    summary: {
      scalarCount: scalars.length,
      typeChanges: changes.filter(entry => entry.change === 'type-change').length,
      valueChanges: changes.filter(entry => entry.change === 'value-change').length,
      statusChanges: changes.filter(entry => entry.change === 'status-change').length,
      keyConflicts: keyConflicts.length,
      unknownTags,
      aliasCount: aliases.length
    },
    changes,
    keyConflicts,
    aliases,
    scalars
  }
}

export {
  auditSchemaMigration,
  COMPARED_SCHEMAS,
  type AuditSchemaName,
  type ScalarValueType,
  type ScalarResolution,
  type ScalarChangeKind,
  type ScalarStyleName,
  type ScalarRole,
  type SourceLocation,
  type ScalarAuditEntry,
  type KeyConflictEntry,
  type AliasAuditEntry,
  type SchemaAuditReport,
  type SchemaAuditOptions
}
