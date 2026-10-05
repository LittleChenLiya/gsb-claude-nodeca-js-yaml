import { YAMLException } from './common/exception.ts'
import { pick } from './common/object.ts'
import { constructFromEvents } from './parser/constructor.ts'
import {
  parseEvents,
  DEFAULT_PARSER_OPTIONS,
  type ParserOptions
} from './parser/parser.ts'
import { JSON_SCHEMA } from './schema.ts'

// `source` is supplied by `loadJSONDocuments` itself, not by the public caller.
/** @category Main */
interface LoadJSONOptions extends ParserOptions {}

/** @inline */
type LoadJSONAllIterator = (document: unknown) => void

const DEFAULT_LOAD_JSON_OPTIONS: Required<LoadJSONOptions> = {
  ...DEFAULT_PARSER_OPTIONS
}

function loadJSONDocuments (input: string, options: LoadJSONOptions = {}) {
  const opts = { ...DEFAULT_LOAD_JSON_OPTIONS, ...options }
  const source = String(input)

  const PARSER_OPT_KEYS = Object.keys(DEFAULT_PARSER_OPTIONS) as
    (keyof typeof DEFAULT_PARSER_OPTIONS)[]

  const events = parseEvents(source, pick(opts, PARSER_OPT_KEYS))

  // The JSON loader is strict by construction: it uses only the built-in JSON
  // Schema (no custom tags), tolerates duplicate keys like `JSON.parse`, and
  // asks the constructor to reject non-string keys, cyclic aliases and
  // non-finite numbers before any mapping is built.
  return constructFromEvents(events, {
    source,
    filename: opts.filename,
    schema: JSON_SCHEMA,
    json: true,
    jsonStrict: true
  })
}

/**
 * Parses `string` as a single YAML document, enforcing the strict subset of
 * YAML that is representable as JSON. Throws {@link YAMLException} on error.
 *
 * Unlike {@link load}, this entry point:
 *
 * - uses only the built-in {@link JSON_SCHEMA} (custom tags are never called);
 * - rejects non-string mapping keys before they are stringified into keys, so
 *   a numeric key reports the key tag and its line/column instead of silently
 *   becoming `"1"`;
 * - rejects reference cycles (self-references and mutual recursion), which
 *   JSON cannot represent;
 * - rejects non-finite numbers (`!!float .inf`, `!!float .nan`);
 * - never returns a partial result: the first violation throws.
 *
 * Shared, acyclic references (`a: &x [1, 2]`, `b: *x`) are expanded normally.
 *
 * @example
 *
 * ```javascript
 * import { loadJSON } from 'js-yaml'
 *
 * loadJSON('"1": x')        // { '1': 'x' } — the quoted key is a string
 * loadJSON('1: x')          // throws: JSON mapping keys must be strings (1:1)
 * loadJSON('a: &x [1, 2]\nb: *x') // { a: [1, 2], b: [1, 2] }
 * loadJSON('a: &x [1, *x]') // throws: cyclic alias "x" is not representable in JSON
 * ```
 *
 * @category Main
 */
function loadJSON (input: string, options?: LoadJSONOptions) {
  const documents = loadJSONDocuments(input, options)

  if (documents.length === 0) throw new YAMLException('expected a document, but the input is empty')
  if (documents.length === 1) return documents[0]

  throw new YAMLException('expected a single document in the stream, but found more')
}

/**
 * Same as {@link loadJSON}, but understands multi-document sources. Returns an
 * array of documents.
 *
 * @category Main
 */
function loadJSONAll (input: string, options?: LoadJSONOptions): unknown[]

/**
 * @deprecated Iterator is not supported.
 */
function loadJSONAll (input: string, iterator: null, options?: LoadJSONOptions): unknown[]

/**
 * @deprecated Iterator is not supported.
 */
function loadJSONAll (input: string, iterator: LoadJSONAllIterator, options?: LoadJSONOptions): void
function loadJSONAll (
  input: string,
  iteratorOrOptions?: LoadJSONAllIterator | LoadJSONOptions | null,
  options?: LoadJSONOptions
) {
  let iterator: LoadJSONAllIterator | null = null

  if (typeof iteratorOrOptions === 'function') {
    iterator = iteratorOrOptions
  } else if (iteratorOrOptions !== null && typeof iteratorOrOptions === 'object') {
    options = iteratorOrOptions
  }

  const documents = loadJSONDocuments(input, options)

  if (iterator === null) return documents
  for (const document of documents) iterator(document)
}

export {
  loadJSON,
  loadJSONAll,
  type LoadJSONOptions
}
