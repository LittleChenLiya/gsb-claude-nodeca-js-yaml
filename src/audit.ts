import {
  EVENT_ID,
  SCALAR_STYLE,
  type Event,
  type ScalarEvent,
  type TagHandlers
} from './parser/events.ts'
import { parseEvents } from './parser/parser.ts'
import { getScalarValue } from './parser/parser_scalar.ts'
import {
  CORE_SCHEMA,
  JSON_SCHEMA,
  YAML11_SCHEMA,
  type Schema
} from './schema.ts'
import { NOT_RESOLVED } from './tag.ts'
import { tagNameFull } from './common/tagname.ts'

/**
 * Schema migration auditor: parses an event stream once and compares how the
 * built-in CORE, JSON and YAML11 schemas resolve every scalar.
 *
 * The auditor is read-only and uses only the built-in safe schemas; it never
 * runs custom tag constructors. Explicit tags are resolved with
 * `isExplicit = true`, implicit plain scalars through the schema's implicit
 * resolver, and quoted/block scalars stay `!!str` just like the constructor
 * does it.
 *
 * @category Audit
 */

const NO_RANGE = -1

/** Short tag name for the built-in YAML tags, full URI otherwise. */
function shortTagName (tagName: string): string {
  const prefix = 'tag:yaml.org,2002:'
  return tagName.startsWith(prefix) ? tagName.slice(prefix.length) : tagName
}

/** Canonical, type-explicit rendering used for comparison and reports. */
function canonicalValue (value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'bigint') return value.toString() + 'n'
  if (value === undefined) return 'undefined'
  return String(value)
}

/** Identity used to detect mapping-key collisions under a schema. */
function keyIdentity (resolution: ScalarResolution): string {
  return resolution.tag + '\0' + resolution.canonical
}

/** Resolved form of one scalar under one schema. */
interface ScalarResolution {
  /** Short tag category, e.g. `str`, `bool`, `int`, `float`, `null`. */
  tag: string
  /** Full tag name (URI). */
  tagName: string
  /** Resolved JavaScript value. */
  value: unknown
  /** Canonical rendering of the value. */
  canonical: string
  /** Whether the scalar carried an explicit tag. */
  explicit: boolean
  /**
   * Whether resolution succeeded. `false` only when an explicit tag rejected
   * the scalar text (the constructor would throw on this).
   */
  ok: boolean
}

/** A scalar whose tag or value differs between schemas. */
interface ScalarFinding {
  kind: 'scalar'
  /** Dot/bracket path from the document root, e.g. `$.a.b[0]`. */
  path: string
  line: number
  column: number
  /** Raw scalar text (decoded value). */
  source: string
  /** Scalar style: `plain`, `single`, `double`, `literal` or `folded`. */
  style: string
  /** Anchor name if the scalar defines one, otherwise `null`. */
  anchor: string | null
  /** Raw explicit tag text if present, otherwise `null`. */
  explicitTag: string | null
  core: ScalarResolution
  json: ScalarResolution
  yaml11: ScalarResolution
  /** True if any two schemas disagree on the tag category. */
  typeChange: boolean
  /** True if any two schemas disagree on the canonical value. */
  valueChange: boolean
}

/** An alias usage, with the location of the anchored scalar it points at. */
interface AliasFinding {
  kind: 'alias'
  path: string
  line: number
  column: number
  anchor: string
  sourcePath: string
  sourceLine: number
  sourceColumn: number
  source: string
}

/** One entry in a key conflict: a key that collides with another. */
interface KeyConflictEntry {
  path: string
  line: number
  column: number
  source: string
  core: string
  json: string
  yaml11: string
  /** Identity under YAML11 that collides. */
  identity: string
}

/**
 * Two mapping keys that are distinct under CORE but collapse to the same
 * identity under YAML11 — a migration hazard, since the new schema would
 * silently turn one key into a duplicate of the other.
 */
interface KeyConflictFinding {
  kind: 'key-conflict'
  /** Path of the mapping that contains the colliding keys. */
  path: string
  line: number
  column: number
  entries: KeyConflictEntry[]
}

/** A resolution error (an explicit tag that rejects the scalar text). */
interface AuditError {
  kind: 'error'
  path: string
  line: number
  column: number
  source: string
  message: string
}

interface AuditResult {
  filename: string
  scalarFindings: ScalarFinding[]
  aliases: AliasFinding[]
  keyConflicts: KeyConflictFinding[]
  errors: AuditError[]
}

interface AuditOptions {
  /** File path used in reports. @defaultValue `''` */
  filename?: string
  /**
   * Schemas to compare. Only the built-in safe schemas are accepted; custom
   * tags are never executed.
   */
  schemas?: {
    core?: Schema
    json?: Schema
    yaml11?: Schema
  }
}

const DEFAULT_SCHEMAS = {
  core: CORE_SCHEMA,
  json: JSON_SCHEMA,
  yaml11: YAML11_SCHEMA
}

const STYLE_NAMES: Record<number, string> = {
  [SCALAR_STYLE.PLAIN]: 'plain',
  [SCALAR_STYLE.SINGLE_QUOTED]: 'single',
  [SCALAR_STYLE.DOUBLE_QUOTED]: 'double',
  [SCALAR_STYLE.LITERAL_BLOCK]: 'literal',
  [SCALAR_STYLE.FOLDED_BLOCK]: 'folded'
}

function lineColumn (source: string, offset: number): { line: number, column: number } {
  let line = 1
  let lineStart = 0

  for (let i = 0; i < offset; i++) {
    if (source.charCodeAt(i) === 0x0A/* \n */) {
      line++
      lineStart = i + 1
    }
  }

  return { line, column: offset - lineStart + 1 }
}

function resolveScalar (
  schema: Schema,
  input: string,
  value: string,
  event: ScalarEvent,
  tagHandlers: TagHandlers
): ScalarResolution {
  const explicit = event.tagStart !== NO_RANGE

  if (explicit) {
    const rawTag = input.slice(event.tagStart, event.tagEnd)

    // `!` is the non-specific tag: it forces !!str for plain scalars.
    if (rawTag === '!') {
      const tag = schema.defaultScalarTag
      return {
        tag: shortTagName(tag.tagName),
        tagName: tag.tagName,
        value,
        canonical: canonicalValue(value),
        explicit: true,
        ok: true
      }
    }

    const tagName = tagNameFull(rawTag, tagHandlers)
    const scalarTag = schema.lookupScalarTag(tagName)

    if (scalarTag) {
      const result = scalarTag.resolve(value, true, tagName)

      if (result === NOT_RESOLVED) {
        return {
          tag: shortTagName(tagName),
          tagName,
          value: undefined,
          canonical: '',
          explicit: true,
          ok: false
        }
      }

      return {
        tag: shortTagName(scalarTag.tagName),
        tagName: scalarTag.tagName,
        value: result,
        canonical: canonicalValue(result),
        explicit: true,
        ok: true
      }
    }

    // An empty scalar with a collection tag means an empty collection.
    if (value === '') {
      const collectionTag =
        schema.lookupMappingTag(tagName) ??
        schema.lookupSequenceTag(tagName)

      if (collectionTag) {
        return {
          tag: shortTagName(collectionTag.tagName),
          tagName: collectionTag.tagName,
          value: null,
          canonical: '',
          explicit: true,
          ok: true
        }
      }
    }

    return {
      tag: shortTagName(tagName),
      tagName,
      value: undefined,
      canonical: '',
      explicit: true,
      ok: false
    }
  }

  if (event.style === SCALAR_STYLE.PLAIN) {
    const { value: resolved, tag } = schema.resolveImplicitScalarTag(value)
    return {
      tag: shortTagName(tag.tagName),
      tagName: tag.tagName,
      value: resolved,
      canonical: canonicalValue(resolved),
      explicit: false,
      ok: true
    }
  }

  // Quoted and block scalars are always !!str.
  const tag = schema.defaultScalarTag
  return {
    tag: 'str',
    tagName: tag.tagName,
    value,
    canonical: canonicalValue(value),
    explicit: false,
    ok: true
  }
}

interface AnchorRecord {
  path: string
  line: number
  column: number
  source: string
  resolutions: { core: ScalarResolution, json: ScalarResolution, yaml11: ScalarResolution }
}

interface KeyRecord {
  path: string
  line: number
  column: number
  source: string
  core: ScalarResolution
  json: ScalarResolution
  yaml11: ScalarResolution
  identity: string
}

type Frame =
  | { kind: 'doc' }
  | { kind: 'seq', path: string, index: number }
  | { kind: 'map', path: string, phase: 'key' | 'value', pendingKey: string | null, keys: Map<string, KeyRecord> }

function keySegment (source: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(source)) return '.' + source
  return '[' + JSON.stringify(source) + ']'
}

/**
 * Parses `input` once and audits every scalar against the built-in CORE, JSON
 * and YAML11 schemas. See {@link AuditResult} for the report shape.
 *
 * @category Audit
 */
function auditSchemaMigration (input: string, options: AuditOptions = {}): AuditResult {
  const source = String(input)
  const filename = options.filename ?? ''
  const schemas = { ...DEFAULT_SCHEMAS, ...options.schemas }

  const events = parseEvents(source, { filename })

  const scalarFindings: ScalarFinding[] = []
  const aliases: AliasFinding[] = []
  const keyConflicts: KeyConflictFinding[] = []
  const errors: AuditError[] = []

  const stack: Frame[] = []
  let anchors = new Map<string, AnchorRecord>()
  let tagHandlers: TagHandlers = Object.create(null)

  const currentPath = (): string => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const frame = stack[i]!
      if (frame.kind === 'doc') return '$'
      if (frame.kind === 'seq') return frame.path + '[' + frame.index + ']'
      if (frame.kind === 'map') {
        if (frame.phase === 'key') return frame.path
        return frame.path + (frame.pendingKey ?? '')
      }
    }
    return '$'
  }

  const recordScalar = (event: ScalarEvent, isKey: boolean) => {
    const value = getScalarValue(source, event)
    const path = currentPath()
    const pos = event.tagStart !== NO_RANGE
      ? event.tagStart
      : event.anchorStart !== NO_RANGE
        ? event.anchorStart
        : event.valueStart
    const { line, column } = lineColumn(source, pos)
    const anchor = event.anchorStart !== NO_RANGE
      ? source.slice(event.anchorStart, event.anchorEnd)
      : null
    const explicitTag = event.tagStart !== NO_RANGE
      ? source.slice(event.tagStart, event.tagEnd)
      : null

    const core = resolveScalar(schemas.core, source, value, event, tagHandlers)
    const json = resolveScalar(schemas.json, source, value, event, tagHandlers)
    const yaml11 = resolveScalar(schemas.yaml11, source, value, event, tagHandlers)

    if (!core.ok || !json.ok || !yaml11.ok) {
      errors.push({
        kind: 'error',
        path,
        line,
        column,
        source: value,
        message: 'explicit tag ' + (explicitTag ?? '') + ' rejected the scalar text'
      })
    }

    if (anchor !== null) {
      anchors.set(anchor, {
        path,
        line,
        column,
        source: value,
        resolutions: { core, json, yaml11 }
      })
    }

    if (isKey) {
      const mapFrame = stack[stack.length - 1] as Extract<Frame, { kind: 'map' }>
      const identity = keyIdentity(yaml11)
      const existing = mapFrame.keys.get(identity)

      if (existing !== undefined && keyIdentity(core) !== keyIdentity(existing.core)) {
        keyConflicts.push({
          kind: 'key-conflict',
          path: mapFrame.path,
          line,
          column,
          entries: [
            {
              path: existing.path,
              line: existing.line,
              column: existing.column,
              source: existing.source,
              core: existing.core.tag,
              json: existing.json.tag,
              yaml11: existing.yaml11.tag,
              identity: existing.identity
            },
            {
              path,
              line,
              column,
              source: value,
              core: core.tag,
              json: json.tag,
              yaml11: yaml11.tag,
              identity
            }
          ]
        })
      } else {
        mapFrame.keys.set(identity, {
          path,
          line,
          column,
          source: value,
          core,
          json,
          yaml11,
          identity
        })
      }

      mapFrame.pendingKey = keySegment(value)
      mapFrame.phase = 'value'
    } else {
      if (stack.length > 0 && stack[stack.length - 1]!.kind === 'map') {
        const mapFrame = stack[stack.length - 1] as Extract<Frame, { kind: 'map' }>
        mapFrame.phase = 'key'
        mapFrame.pendingKey = null
      } else if (stack.length > 0 && stack[stack.length - 1]!.kind === 'seq') {
        ;(stack[stack.length - 1] as Extract<Frame, { kind: 'seq' }>).index++
      }

      const typeChange =
        core.tag !== json.tag || core.tag !== yaml11.tag || json.tag !== yaml11.tag
      const valueChange =
        core.canonical !== json.canonical ||
        core.canonical !== yaml11.canonical ||
        json.canonical !== yaml11.canonical

      if (typeChange || valueChange) {
        scalarFindings.push({
          kind: 'scalar',
          path,
          line,
          column,
          source: value,
          style: STYLE_NAMES[event.style] ?? 'plain',
          anchor,
          explicitTag,
          core,
          json,
          yaml11,
          typeChange,
          valueChange
        })
      }
    }
  }

  for (const event of events) {
    switch (event.type) {
      case EVENT_ID.DOCUMENT:
        anchors = new Map()
        tagHandlers = Object.create(null)
        for (const directive of event.directives) {
          if (directive.kind === 'tag') tagHandlers[directive.handle] = directive.prefix
        }
        stack.push({ kind: 'doc' })
        break

      case EVENT_ID.SEQUENCE: {
        const pos = event.start
        const { line, column } = lineColumn(source, pos)
        const path = currentPath()
        if (event.anchorStart !== NO_RANGE) {
          anchors.set(source.slice(event.anchorStart, event.anchorEnd), {
            path,
            line,
            column,
            source: '',
            resolutions: {
              core: { tag: 'seq', tagName: 'tag:yaml.org,2002:seq', value: null, canonical: '', explicit: false, ok: true },
              json: { tag: 'seq', tagName: 'tag:yaml.org,2002:seq', value: null, canonical: '', explicit: false, ok: true },
              yaml11: { tag: 'seq', tagName: 'tag:yaml.org,2002:seq', value: null, canonical: '', explicit: false, ok: true }
            }
          })
        }
        stack.push({ kind: 'seq', path, index: 0 })
        break
      }

      case EVENT_ID.MAPPING: {
        const pos = event.start
        const { line, column } = lineColumn(source, pos)
        const path = currentPath()
        if (event.anchorStart !== NO_RANGE) {
          anchors.set(source.slice(event.anchorStart, event.anchorEnd), {
            path,
            line,
            column,
            source: '',
            resolutions: {
              core: { tag: 'map', tagName: 'tag:yaml.org,2002:map', value: null, canonical: '', explicit: false, ok: true },
              json: { tag: 'map', tagName: 'tag:yaml.org,2002:map', value: null, canonical: '', explicit: false, ok: true },
              yaml11: { tag: 'map', tagName: 'tag:yaml.org,2002:map', value: null, canonical: '', explicit: false, ok: true }
            }
          })
        }
        stack.push({ kind: 'map', path, phase: 'key', pendingKey: null, keys: new Map() })
        break
      }

      case EVENT_ID.SCALAR: {
        const isKey = stack.length > 0 &&
          stack[stack.length - 1]!.kind === 'map' &&
          (stack[stack.length - 1] as Extract<Frame, { kind: 'map' }>).phase === 'key'
        recordScalar(event, isKey)
        break
      }

      case EVENT_ID.ALIAS: {
        const name = source.slice(event.anchorStart, event.anchorEnd)
        const anchor = anchors.get(name)
        const isKey = stack.length > 0 &&
          stack[stack.length - 1]!.kind === 'map' &&
          (stack[stack.length - 1] as Extract<Frame, { kind: 'map' }>).phase === 'key'
        const path = currentPath()
        const { line, column } = lineColumn(source, event.anchorStart)

        if (anchor !== undefined) {
          aliases.push({
            kind: 'alias',
            path,
            line,
            column,
            anchor: name,
            sourcePath: anchor.path,
            sourceLine: anchor.line,
            sourceColumn: anchor.column,
            source: anchor.source
          })
        } else {
          errors.push({
            kind: 'error',
            path,
            line,
            column,
            source: name,
            message: 'unidentified alias "' + name + '"'
          })
        }

        if (stack.length > 0 && stack[stack.length - 1]!.kind === 'map') {
          const mapFrame = stack[stack.length - 1] as Extract<Frame, { kind: 'map' }>

          if (isKey && anchor !== undefined) {
            // An alias used as a mapping key: resolve through the anchored
            // scalar and track its identity for collision detection.
            const identity = keyIdentity(anchor.resolutions.yaml11)
            const existing = mapFrame.keys.get(identity)

            if (existing !== undefined &&
                keyIdentity(anchor.resolutions.core) !== keyIdentity(existing.core)) {
              keyConflicts.push({
                kind: 'key-conflict',
                path: mapFrame.path,
                line,
                column,
                entries: [
                  {
                    path: existing.path,
                    line: existing.line,
                    column: existing.column,
                    source: existing.source,
                    core: existing.core.tag,
                    json: existing.json.tag,
                    yaml11: existing.yaml11.tag,
                    identity: existing.identity
                  },
                  {
                    path,
                    line,
                    column,
                    source: name,
                    core: anchor.resolutions.core.tag,
                    json: anchor.resolutions.json.tag,
                    yaml11: anchor.resolutions.yaml11.tag,
                    identity
                  }
                ]
              })
            } else {
              mapFrame.keys.set(identity, {
                path,
                line,
                column,
                source: name,
                core: anchor.resolutions.core,
                json: anchor.resolutions.json,
                yaml11: anchor.resolutions.yaml11,
                identity
              })
            }

            mapFrame.pendingKey = keySegment(name)
            mapFrame.phase = 'value'
          } else {
            // An alias used as a value completes the pair; the next scalar
            // is the next key.
            mapFrame.phase = 'key'
            mapFrame.pendingKey = null
          }
        } else if (stack.length > 0 && stack[stack.length - 1]!.kind === 'seq') {
          ;(stack[stack.length - 1] as Extract<Frame, { kind: 'seq' }>).index++
        }
        break
      }

      case EVENT_ID.POP: {
        const frame = stack.pop()!
        if (stack.length > 0) {
          const parent = stack[stack.length - 1]!
          if (parent.kind === 'seq') parent.index++
          else if (parent.kind === 'map') {
            parent.phase = 'key'
            parent.pendingKey = null
          }
        }
        break
      }
    }
  }

  return { filename, scalarFindings, aliases, keyConflicts, errors }
}

const SCHEMA_NAMES = ['core', 'json', 'yaml11'] as const

function resolutionLine (label: string, resolution: ScalarResolution): string {
  const explicit = resolution.explicit ? ' (explicit)' : ''
  const failed = resolution.ok ? '' : ' RESOLUTION FAILED'
  return '  ' + label.padEnd(7) + ' ' + resolution.tag.padEnd(6) + ' ' + (resolution.canonical || '(empty)') + explicit + failed
}

/** Renders an {@link AuditResult} as a human-readable text report. */
function formatAuditReport (result: AuditResult): string {
  const lines: string[] = []
  const file = result.filename || '(input)'

  lines.push('schema migration audit: ' + file)
  lines.push('schemas: core, json, yaml11')
  lines.push('')

  if (result.scalarFindings.length === 0 && result.keyConflicts.length === 0 &&
      result.aliases.length === 0 && result.errors.length === 0) {
    lines.push('no differences found')
    return lines.join('\n') + '\n'
  }

  for (const finding of result.scalarFindings) {
    lines.push('scalar type/value change: ' + finding.path)
    lines.push('  at line ' + finding.line + ', column ' + finding.column + ' (' + finding.style + ' scalar' + (finding.anchor ? ', anchor ' + finding.anchor : '') + (finding.explicitTag ? ', explicit tag ' + finding.explicitTag : '') + ')')
    lines.push('  scalar: ' + JSON.stringify(finding.source))
    lines.push(resolutionLine('core', finding.core))
    lines.push(resolutionLine('json', finding.json))
    lines.push(resolutionLine('yaml11', finding.yaml11))
    if (finding.typeChange) lines.push('  -> tag category changes between schemas')
    if (finding.valueChange) lines.push('  -> canonical value changes between schemas')
    lines.push('')
  }

  for (const conflict of result.keyConflicts) {
    lines.push('key conflict: ' + conflict.path)
    lines.push('  at line ' + conflict.line + ', column ' + conflict.column)
    for (const entry of conflict.entries) {
      lines.push('  key ' + JSON.stringify(entry.source) + ' at line ' + entry.line + ', column ' + entry.column)
      lines.push('    core: ' + entry.core + '  json: ' + entry.json + '  yaml11: ' + entry.yaml11)
      lines.push('    identity under yaml11: ' + entry.identity.replace('\0', ' -> '))
    }
    lines.push('  -> distinct keys under core collapse to one identity under yaml11')
    lines.push('')
  }

  for (const alias of result.aliases) {
    lines.push('alias: ' + alias.path)
    lines.push('  at line ' + alias.line + ', column ' + alias.column)
    lines.push('  alias *' + alias.anchor + ' points to anchor defined at ' + alias.sourcePath + ' (line ' + alias.sourceLine + ', column ' + alias.sourceColumn + ')')
    lines.push('  anchored scalar: ' + JSON.stringify(alias.source))
    lines.push('')
  }

  for (const error of result.errors) {
    lines.push('error: ' + error.path)
    lines.push('  at line ' + error.line + ', column ' + error.column)
    lines.push('  ' + error.message)
    lines.push('')
  }

  return lines.join('\n')
}

export {
  auditSchemaMigration,
  formatAuditReport,
  shortTagName,
  canonicalValue,
  keyIdentity,
  SCHEMA_NAMES,
  type AuditOptions,
  type AuditResult,
  type ScalarFinding,
  type AliasFinding,
  type KeyConflictFinding,
  type KeyConflictEntry,
  type AuditError,
  type ScalarResolution
}
