import {
  EVENT_ID,
  SCALAR_STYLE,
  type Event,
  type MappingEvent,
  type ScalarEvent,
  type SequenceEvent
} from '../parser/events.ts'
import { getScalarValue } from '../parser/parser_scalar.ts'
import { JSON_SCHEMA } from '../schema.ts'
import { NOT_RESOLVED } from '../tag.ts'
import { YAMLException } from '../common/exception.ts'
import { tagNameFull } from '../common/tagname.ts'
import type { ParserOptions } from '../parser/parser.ts'

const NO_RANGE = -1

const STR_TAG_NAME = 'tag:yaml.org,2002:str'
const SEQ_TAG_NAME = 'tag:yaml.org,2002:seq'
const MAP_TAG_NAME = 'tag:yaml.org,2002:map'

/**
 * Value types representable by the JSON data model
 * (https://www.ecma-international.org/publications-and-standards/standards/ecma-404/).
 *
 * @category Main
 */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

/**
 * Options for {@link loadJson}. Only parser-side controls are accepted: the
 * schema is fixed to the built-in {@link JSON_SCHEMA}, so no custom tags can
 * participate.
 *
 * @category Main
 */
interface LoadJsonOptions extends ParserOptions {}

interface DocumentFrame {
  kind: 'document'
  value: JsonValue | undefined
  hasValue: boolean
}

interface SequenceFrame {
  kind: 'sequence'
  value: JsonValue[]
}

interface MappingFrame {
  kind: 'mapping'
  value: Record<string, JsonValue>
  // Pending key state while alternating key/value events are consumed.
  key: string | undefined
  hasKey: boolean
  // Offset of the pending key, for the error mark.
  keyPosition: number
}

type Frame = DocumentFrame | SequenceFrame | MappingFrame

interface Anchor {
  value: JsonValue
  // Resolved tag of the anchored node, reported when an alias is used as a
  // non-string mapping key.
  tagName: string
  // Anchors pointing at an open collection would create a cycle; aliases into
  // them are rejected as they arrive.
  open: boolean
}

interface JsonLoaderState {
  source: string
  filename: string
  events: Event[]
  eventIndex: number
  position: number
  frames: Frame[]
  anchors: Map<string, Anchor>
  // Names of anchors whose collection is still under construction, for the
  // cycle check on alias resolution.
  openAnchors: Set<string>
  tagHandlers: Record<string, string>
}

function eventPosition (event: Event) {
  if ('tagStart' in event && event.tagStart !== NO_RANGE) return event.tagStart
  if ('anchorStart' in event && event.anchorStart !== NO_RANGE) return event.anchorStart
  if ('valueStart' in event && event.valueStart !== NO_RANGE) return event.valueStart
  if ('start' in event) return event.start
  return 0
}

function throwAt (state: JsonLoaderState, position: number, message: string): never {
  YAMLException.throwAt(state.source, position, message, state.filename)
}

function throwHere (state: JsonLoaderState, message: string): never {
  throwAt(state, state.position, message)
}

// Short, human-readable tag spelling for diagnostics: `!!int` rather than the
// full `tag:yaml.org,2002:int` URI.
function tagLabel (tagName: string) {
  if (tagName.startsWith('tag:yaml.org,2002:')) return `!!${tagName.slice(18)}`
  return `!<${tagName}>`
}

// Deep-copy a finished JSON value. Sharing in YAML input (multiple aliases of
// the same acyclic anchor) is expanded into independent copies, so the result
// never contains reference cycles and can always be handed to JSON.stringify.
function cloneJson (value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(item => cloneJson(item))
  }

  if (value !== null && typeof value === 'object') {
    const copy: Record<string, JsonValue> = {}
    for (const key of Object.keys(value)) copy[key] = cloneJson(value[key])
    return copy
  }

  return value
}

function rawTagName (
  state: JsonLoaderState,
  event: ScalarEvent | SequenceEvent | MappingEvent,
  defaultTagName: string
) {
  const rawTag = event.tagStart === NO_RANGE
    ? ''
    : state.source.slice(event.tagStart, event.tagEnd)

  if (rawTag === '' || rawTag === '!') return defaultTagName
  return tagNameFull(rawTag, state.tagHandlers)
}

// JSON has no representation for +/-Infinity or NaN. The JSON schema's
// explicit `!!float .inf`/`.nan` forms produce them, so check after resolution.
function assertFiniteNumber (state: JsonLoaderState, value: unknown, tagName: string) {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throwHere(state, `non-finite value of tag ${tagLabel(tagName)} is not representable in JSON`)
  }
}

// Resolves a scalar using the built-in JSON schema exclusively. No user schema
// or custom tag definition is ever consulted.
function constructScalar (
  state: JsonLoaderState,
  event: ScalarEvent
): { value: JsonValue, tagName: string } {
  const source = getScalarValue(state.source, event)

  if (event.tagStart !== NO_RANGE) {
    const rawTag = state.source.slice(event.tagStart, event.tagEnd)

    if (rawTag === '!') {
      return { value: source, tagName: STR_TAG_NAME }
    }

    const tagName = tagNameFull(rawTag, state.tagHandlers)
    const tag = JSON_SCHEMA.lookupScalarTag(tagName)

    if (!tag) {
      // An empty node carrying a collection tag (e.g. `!!map`, `!!seq`)
      // arrives as a scalar event; resolve it into an empty collection.
      if (tagName === MAP_TAG_NAME || tagName === SEQ_TAG_NAME) {
        if (source !== '') throwHere(state, `cannot resolve a node with !<${tagName}> explicit tag`)
        return tagName === MAP_TAG_NAME
          ? { value: {}, tagName }
          : { value: [], tagName }
      }

      throwHere(state, `unknown scalar tag !<${tagName}>`)
    }

    const resolved = tag.resolve(source, true, tagName)

    if (resolved === NOT_RESOLVED) {
      throwHere(state, `cannot resolve a node with !<${tagName}> explicit tag`)
    }

    assertFiniteNumber(state, resolved, tagName)
    return { value: resolved as JsonValue, tagName }
  }

  if (event.style !== SCALAR_STYLE.PLAIN) {
    return { value: source, tagName: STR_TAG_NAME }
  }

  const { value, tag } = JSON_SCHEMA.resolveImplicitScalarTag(source)
  assertFiniteNumber(state, value, tag.tagName)
  return { value: value as JsonValue, tagName: tag.tagName }
}

function rememberAnchor (
  state: JsonLoaderState,
  event: ScalarEvent | SequenceEvent | MappingEvent,
  value: JsonValue,
  tagName: string,
  open: boolean
) {
  if (event.anchorStart === NO_RANGE) return

  const name = state.source.slice(event.anchorStart, event.anchorEnd)
  state.anchors.set(name, { value, tagName, open })
  if (open) state.openAnchors.add(name)
}

function placeValue (state: JsonLoaderState, value: JsonValue, tagName: string) {
  const frame = state.frames[state.frames.length - 1]!

  if (frame.kind === 'document') {
    frame.value = value
    frame.hasValue = true
  } else if (frame.kind === 'sequence') {
    frame.value.push(value)
  } else if (frame.hasKey) {
    // The key slot was proven a string when it arrived: checking there, before
    // the pair is written, means a mapping is never built with a non-string
    // key (no plain-object coercion that would erase its type).
    const key = frame.key as string
    frame.key = undefined
    frame.hasKey = false

    if (Object.prototype.hasOwnProperty.call(frame.value, key)) {
      throwAt(state, frame.keyPosition, 'duplicated mapping key')
    }

    // Define a literal `__proto__` key as an own data property, so it never
    // invokes the prototype setter.
    if (key === '__proto__') {
      Object.defineProperty(frame.value, key, {
        value, enumerable: true, configurable: true, writable: true
      })
    } else {
      frame.value[key] = value
    }
  } else {
    frame.keyPosition = state.position
    if (typeof value !== 'string') {
      throwHere(
        state,
        `mapping keys must be strings for JSON, got ${tagLabel(tagName)} key`)
    }
    frame.key = value
    frame.hasKey = true
  }
}

function closeAnchorFor (state: JsonLoaderState, value: JsonValue) {
  for (const [name, anchor] of state.anchors) {
    if (anchor.open && anchor.value === value) {
      anchor.open = false
      state.openAnchors.delete(name)
    }
  }
}

// Builds JSON documents from parser events using only the built-in
// {@link JSON_SCHEMA}: no custom tag constructors are ever invoked, non-string
// keys are rejected before they enter a mapping, aliases can never form
// cycles, and any violation throws before a (partial) result is returned.
function constructJsonFromEvents (
  events: Event[],
  source: string,
  filename: string
): JsonValue[] {
  const state: JsonLoaderState = {
    source,
    filename,
    events,
    eventIndex: 0,
    position: 0,
    frames: [],
    anchors: new Map(),
    openAnchors: new Set(),
    tagHandlers: Object.create(null)
  }

  const documents: JsonValue[] = []

  while (state.eventIndex < state.events.length) {
    const event = state.events[state.eventIndex++]
    state.position = eventPosition(event)

    switch (event.type) {
      case EVENT_ID.DOCUMENT:
        state.anchors = new Map()
        state.openAnchors = new Set()
        state.tagHandlers = Object.create(null)
        for (const directive of event.directives) {
          if (directive.kind === 'tag') state.tagHandlers[directive.handle] = directive.prefix
        }
        state.frames.push({ kind: 'document', value: undefined, hasValue: false })
        break

      case EVENT_ID.SCALAR: {
        const { value, tagName } = constructScalar(state, event)
        rememberAnchor(state, event, value, tagName, false)
        placeValue(state, value, tagName)
        break
      }

      case EVENT_ID.SEQUENCE: {
        const tagName = rawTagName(state, event, SEQ_TAG_NAME)
        if (tagName !== SEQ_TAG_NAME) {
          throwHere(state, `JSON loading only supports the !!seq tag, got !<${tagName}>`)
        }

        const value: JsonValue[] = []
        rememberAnchor(state, event, value, tagName, true)
        state.frames.push({ kind: 'sequence', value })
        break
      }

      case EVENT_ID.MAPPING: {
        const tagName = rawTagName(state, event, MAP_TAG_NAME)
        if (tagName !== MAP_TAG_NAME) {
          throwHere(state, `JSON loading only supports the !!map tag, got !<${tagName}>`)
        }

        const value: Record<string, JsonValue> = {}
        rememberAnchor(state, event, value, tagName, true)
        state.frames.push({
          kind: 'mapping',
          value,
          key: undefined,
          hasKey: false,
          keyPosition: state.position
        })
        break
      }

      case EVENT_ID.ALIAS: {
        const name = state.source.slice(event.anchorStart, event.anchorEnd)
        const anchor = state.anchors.get(name)

        if (!anchor) throwHere(state, `unidentified alias "${name}"`)

        if (anchor.open || state.openAnchors.has(name)) {
          throwHere(state, `recursive alias "${name}" is not representable in JSON`)
        }

        // A closed anchor points at an acyclic value; expand each reference
        // into an independent copy so the output is a pure JSON tree.
        placeValue(state, cloneJson(anchor.value), anchor.tagName)
        break
      }

      case EVENT_ID.POP: {
        const frame = state.frames.pop()!

        if (frame.kind === 'mapping' && frame.hasKey) {
          throwAt(state, frame.keyPosition, 'incomplete mapping pair in event stream')
        }

        if (frame.kind === 'document') {
          documents.push(frame.value as JsonValue)
        } else {
          closeAnchorFor(state, frame.value)
          placeValue(
            state,
            frame.value,
            frame.kind === 'sequence' ? SEQ_TAG_NAME : MAP_TAG_NAME)
        }
        break
      }
    }
  }

  return documents
}

export {
  constructJsonFromEvents,
  type JsonValue,
  type LoadJsonOptions
}
