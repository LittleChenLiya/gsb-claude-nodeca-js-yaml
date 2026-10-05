import {
  parseEvents,
  DEFAULT_PARSER_OPTIONS,
  type ParserOptions
} from './parser.ts'
import {
  constructFromEvents,
  DEFAULT_CONSTRUCTOR_OPTIONS,
  type ConstructorOptions
} from './constructor.ts'
import { YAMLException } from '../common/exception.ts'
import { pick } from '../common/object.ts'
import { EVENT_ID, type Event } from './events.ts'

function isEol (ch: number) {
  return ch === 0x0A/* LF */ || ch === 0x0D/* CR */
}

function isWsOrEol (ch: number) {
  return ch === 0x20/* Space */ || ch === 0x09/* Tab */ || isEol(ch)
}

/**
 * Returns the number of UTF-8 bytes needed to encode `str[start..end]`.
 * Handles surrogate pairs correctly.
 */
function utf8ByteLength (str: string, start = 0, end = str.length): number {
  let bytes = 0
  for (let i = start; i < end; i++) {
    const code = str.charCodeAt(i)
    if (code < 0x80) {
      bytes++
    } else if (code < 0x800) {
      bytes += 2
    } else if (code >= 0xD800 && code <= 0xDBFF) {
      // High surrogate; count the pair as one 4-byte sequence.
      bytes += 4
      i++
    } else {
      bytes += 3
    }
  }
  return bytes
}

/** @category Events */
interface DocumentReaderOptions extends ParserOptions, Omit<ConstructorOptions, 'source'> {
  /**
   * Maximum size in bytes of a single document. When exceeded, the reader
   * rejects the document without delivering it. `0` disables the limit.
   *
   * @defaultValue `0`
   */
  maxDocumentSize?: number

  /**
   * Called when a complete document is available. The returned documents are
   * also collected and returned by {@link DocumentReader.write} and
   * {@link DocumentReader.end}.
   */
  onDocument?: (document: IncrementalDocument) => void
}

/** @category Events */
interface IncrementalDocument {
  /** Byte offset of the document start (inclusive). */
  start: number
  /** Byte offset of the document end (exclusive). */
  end: number
  /** Whether the document started with an explicit `---` marker. */
  explicitStart: boolean
  /** Whether the document ended with an explicit `...` marker. */
  explicitEnd: boolean
  /** Parser events for the document. */
  events: Event[]
  /** Constructed JavaScript value of the document. */
  value: unknown
}

type ScanState = 'docStart' | 'normal' | 'single' | 'double' | 'block'

type ScanResult =
  | { kind: 'continue' }
  | { kind: 'incomplete' }
  | { kind: 'boundary', boundary: 'start' | 'end', position: number, endPosition?: number }

/**
 * Incremental, chunked document reader built on top of {@link parseEvents}.
 *
 * Feed UTF-8 bytes (or strings) with {@link DocumentReader.write}; complete
 * documents are returned as soon as a true document boundary is detected,
 * without waiting for the rest of the stream. Only the current document is
 * buffered. Call {@link DocumentReader.end} to flush the final document.
 *
 * Document boundaries (`---` / `...`) are only recognized at column 0 when the
 * parser is not inside a quoted scalar or a block scalar, so a `---` embedded
 * in a literal block or a quoted value never splits a document.
 *
 * @category Events
 */
class DocumentReader {
  private readonly parserOptions: ParserOptions
  private readonly constructorOptions: Omit<ConstructorOptions, 'source'>
  private readonly maxDocumentSize: number
  private readonly onDocument: ((document: IncrementalDocument) => void) | null

  private decoder: TextDecoder
  private readonly encoder = new TextEncoder()

  private buffer = ''
  private scanPos = 0
  private lineStart = 0
  private scanState: ScanState = 'docStart'
  private hasExplicitStart = false

  private docStartByte = 0
  private totalBytes = 0

  private ended = false
  private errored = false
  private readonly pending: IncrementalDocument[] = []

  constructor (options: DocumentReaderOptions = {}) {
    const {
      maxDocumentSize = 0,
      onDocument = null,
      ...rest
    } = options

    this.parserOptions = {
      ...DEFAULT_PARSER_OPTIONS,
      ...pick(rest, ['filename', 'maxDepth'])
    }
    this.constructorOptions = {
      ...DEFAULT_CONSTRUCTOR_OPTIONS,
      ...pick(rest, ['filename', 'schema', 'json', 'maxTotalMergeKeys', 'maxAliases'])
    }
    this.maxDocumentSize = maxDocumentSize
    this.onDocument = onDocument

    this.decoder = new TextDecoder('utf-8', { fatal: true })
  }

  /**
   * Feeds a chunk of UTF-8 input. Returns any documents completed by this
   * chunk. Throws {@link YAMLException} on invalid input, an illegal BOM, or a
   * document exceeding `maxDocumentSize`.
   */
  write (chunk: Uint8Array | string): IncrementalDocument[] {
    if (this.errored) throw new YAMLException('DocumentReader has already errored')
    if (this.ended) throw new YAMLException('DocumentReader has already ended')

    const bytes = typeof chunk === 'string' ? this.encoder.encode(chunk) : chunk
    this.totalBytes += bytes.length

    let decoded: string
    try {
      decoded = this.decoder.decode(bytes, { stream: true })
    } catch (error) {
      this.errored = true
      throw new YAMLException('invalid UTF-8 sequence: ' + (error instanceof Error ? error.message : String(error)))
    }

    if (decoded) this.buffer += decoded

    this.scan()

    if (this.maxDocumentSize > 0 && this.totalBytes - this.docStartByte > this.maxDocumentSize) {
      this.errored = true
      throw new YAMLException(`document exceeds maxDocumentSize (${this.maxDocumentSize} bytes)`)
    }

    return this.pending.splice(0)
  }

  /**
   * Signals end of input and returns the final document(s). Throws
   * {@link YAMLException} if the stream ends in the middle of a multi-byte
   * UTF-8 sequence or inside a quoted scalar.
   */
  end (): IncrementalDocument[] {
    if (this.errored) throw new YAMLException('DocumentReader has already errored')
    if (this.ended) return []
    this.ended = true

    let tail: string
    try {
      tail = this.decoder.decode()
    } catch (error) {
      this.errored = true
      throw new YAMLException('truncated multi-byte character at end of stream: ' + (error instanceof Error ? error.message : String(error)))
    }
    if (tail) this.buffer += tail

    this.resolveIncompleteAtEof()

    if (this.buffer.length > 0) {
      const docSize = this.totalBytes - this.docStartByte
      if (this.maxDocumentSize > 0 && docSize > this.maxDocumentSize) {
        this.errored = true
        throw new YAMLException(`document exceeds maxDocumentSize (${this.maxDocumentSize} bytes)`)
      }
      this.deliverDocument(
        this.buffer,
        this.docStartByte,
        this.docStartByte + utf8ByteLength(this.buffer)
      )
    }

    return this.pending.splice(0)
  }

  // ---------------------------------------------------------------------------

  private scan (): void {
    while (this.scanPos < this.buffer.length) {
      const result = this.scanStep()
      if (result.kind === 'incomplete') return
      if (result.kind === 'boundary') this.emitBoundary(result)
    }
  }

  private scanStep (): ScanResult {
    switch (this.scanState) {
      case 'docStart': return this.scanDocStart()
      case 'normal': return this.scanNormal()
      case 'single': return this.scanSingle()
      case 'double': return this.scanDouble()
      case 'block': return this.scanBlock()
    }
  }

  private consumeLineBreak (): void {
    const ch = this.buffer.charCodeAt(this.scanPos)
    if (ch === 0x0D/* CR */) {
      this.scanPos++
      if (this.buffer.charCodeAt(this.scanPos) === 0x0A/* LF */) this.scanPos++
    } else {
      this.scanPos++
    }
    this.lineStart = this.scanPos
  }

  private skipToEol (): void {
    while (this.scanPos < this.buffer.length && !isEol(this.buffer.charCodeAt(this.scanPos))) {
      this.scanPos++
    }
  }

  // Mirrors the parser's skipSeparationSpace: skips spaces, comments and line
  // breaks, returning the position just after them.
  private skipSeparationSpace (start: number): number {
    let p = start
    while (p < this.buffer.length) {
      const ch = this.buffer.charCodeAt(p)
      if (ch === 0x20/* Space */ || ch === 0x09/* Tab */) {
        p++
        continue
      }
      if (ch === 0x23/* # */) {
        while (p < this.buffer.length && !isEol(this.buffer.charCodeAt(p))) p++
        continue
      }
      if (isEol(ch)) {
        if (ch === 0x0D/* CR */ && p + 1 < this.buffer.length && this.buffer.charCodeAt(p + 1) === 0x0A/* LF */) p += 2
        else p++
        continue
      }
      break
    }
    return p
  }

  // Checks whether the run of '-' or '.' at `pos` (column 0) is a document
  // separator. Returns 'incomplete' when more bytes are needed to decide.
  private checkSeparator (pos: number): 'separator' | 'incomplete' | 'content' {
    const ch = this.buffer.charCodeAt(pos)
    let run = 0
    while (pos + run < this.buffer.length && this.buffer.charCodeAt(pos + run) === ch) run++
    if (run < 3) {
      if (pos + run >= this.buffer.length) return 'incomplete'
      return 'content'
    }
    if (pos + 3 >= this.buffer.length) return 'separator'
    const following = this.buffer.charCodeAt(pos + 3)
    if (isWsOrEol(following)) return 'separator'
    return 'content'
  }

  private countRun (pos: number, ch: number): number {
    let run = 0
    while (pos + run < this.buffer.length && this.buffer.charCodeAt(pos + run) === ch) run++
    return run
  }

  // A BOM at column 0 in the middle of a document is only legal when it
  // precedes a document marker (`---` / `...`) or a directive (`%`).
  private checkBomLookahead (pos: number): 'legal' | 'incomplete' | 'illegal' {
    let p = pos + 1
    let ls = pos + 1 // line start just after the BOM
    while (p < this.buffer.length && (this.buffer.charCodeAt(p) === 0x20/* Space */ || this.buffer.charCodeAt(p) === 0x09/* Tab */)) p++
    if (p >= this.buffer.length) return 'incomplete'
    if (this.buffer.charCodeAt(p) === 0x23/* # */) {
      while (p < this.buffer.length && !isEol(this.buffer.charCodeAt(p))) p++
      if (p >= this.buffer.length) return 'incomplete'
    }
    if (isEol(this.buffer.charCodeAt(p))) {
      if (this.buffer.charCodeAt(p) === 0x0D/* CR */ && p + 1 < this.buffer.length && this.buffer.charCodeAt(p + 1) === 0x0A/* LF */) p += 2
      else p++
      ls = p
      while (p < this.buffer.length && this.buffer.charCodeAt(p) === 0x20/* Space */) p++
      if (p >= this.buffer.length) return 'incomplete'
    }
    if (p !== ls) return 'illegal'
    const ch = this.buffer.charCodeAt(p)
    if (ch === 0x25/* % */) return 'legal'
    if (ch === 0x2D/* - */ || ch === 0x2E/* . */) {
      const sep = this.checkSeparator(p)
      if (sep === 'separator') return 'legal'
      if (sep === 'incomplete') return 'incomplete'
    }
    return 'illegal'
  }

  private isFirstNonSpaceOfLine (pos: number): boolean {
    let p = this.lineStart
    while (p < pos && this.buffer.charCodeAt(p) === 0x20/* Space */) p++
    return p === pos
  }

  // Matches a block scalar header: `|` or `>` followed by optional chomping
  // and indentation indicators, optional whitespace/comments and a line end.
  private isBlockHeader (pos: number): boolean {
    let p = pos + 1
    while (p < this.buffer.length) {
      const ch = this.buffer.charCodeAt(p)
      if (ch === 0x2D/* - */ || ch === 0x2B/* + */ || (ch >= 0x30/* 0 */ && ch <= 0x39/* 9 */)) p++
      else break
    }
    while (p < this.buffer.length && (this.buffer.charCodeAt(p) === 0x20/* Space */ || this.buffer.charCodeAt(p) === 0x09/* Tab */)) p++
    if (p < this.buffer.length && this.buffer.charCodeAt(p) === 0x23/* # */) {
      while (p < this.buffer.length && !isEol(this.buffer.charCodeAt(p))) p++
    }
    return p >= this.buffer.length || isEol(this.buffer.charCodeAt(p))
  }

  private scanDocStart (): ScanResult {
    if (this.scanPos >= this.buffer.length) return { kind: 'incomplete' }
    const ch = this.buffer.charCodeAt(this.scanPos)
    const column = this.scanPos - this.lineStart

    if (ch === 0xFEFF) {
      this.scanPos++
      return { kind: 'continue' }
    }

    if (ch === 0x23/* # */) {
      this.skipToEol()
      if (this.scanPos >= this.buffer.length) return { kind: 'incomplete' }
      this.consumeLineBreak()
      return { kind: 'continue' }
    }

    if (ch === 0x20/* Space */ || ch === 0x09/* Tab */) {
      this.scanPos++
      return { kind: 'continue' }
    }

    if (isEol(ch)) {
      this.consumeLineBreak()
      return { kind: 'continue' }
    }

    if (column === 0 && ch === 0x25/* % */) {
      this.skipToEol()
      if (this.scanPos >= this.buffer.length) return { kind: 'incomplete' }
      this.consumeLineBreak()
      return { kind: 'continue' }
    }

    if (column === 0 && (ch === 0x2D/* - */ || ch === 0x2E/* . */)) {
      const sep = this.checkSeparator(this.scanPos)
      if (sep === 'incomplete') return { kind: 'incomplete' }
      if (sep === 'separator') {
        if (ch === 0x2D/* - */) {
          if (!this.hasExplicitStart) {
            this.hasExplicitStart = true
            this.scanPos += 3
            return { kind: 'continue' }
          }
          return { kind: 'boundary', boundary: 'start', position: this.scanPos }
        } else {
          if (this.hasExplicitStart) {
            const endPosition = this.skipSeparationSpace(this.scanPos + 3)
            return { kind: 'boundary', boundary: 'end', position: this.scanPos, endPosition }
          }
          this.scanPos += 3
          return { kind: 'continue' }
        }
      }
    }

    this.scanState = 'normal'
    return { kind: 'continue' }
  }

  private scanNormal (): ScanResult {
    if (this.scanPos >= this.buffer.length) return { kind: 'incomplete' }
    const ch = this.buffer.charCodeAt(this.scanPos)
    const column = this.scanPos - this.lineStart

    if (column === 0) {
      if (ch === 0xFEFF) {
        const result = this.checkBomLookahead(this.scanPos)
        if (result === 'incomplete') return { kind: 'incomplete' }
        if (result === 'legal') {
          return { kind: 'boundary', boundary: 'start', position: this.scanPos }
        }
        this.errored = true
        throw new YAMLException('BOM is only allowed at the start of a document')
      }

      if (ch === 0x25/* % */) {
        return { kind: 'boundary', boundary: 'start', position: this.scanPos }
      }

      if (ch === 0x2D/* - */ || ch === 0x2E/* . */) {
        const sep = this.checkSeparator(this.scanPos)
        if (sep === 'incomplete') return { kind: 'incomplete' }
        if (sep === 'separator') {
          if (ch === 0x2D/* - */) {
            return { kind: 'boundary', boundary: 'start', position: this.scanPos }
          }
          const endPosition = this.skipSeparationSpace(this.scanPos + 3)
          return { kind: 'boundary', boundary: 'end', position: this.scanPos, endPosition }
        }
      }
    }

    if (ch === 0x27/* single-quote */) {
      this.scanState = 'single'
      this.scanPos++
      return { kind: 'continue' }
    }

    if (ch === 0x22/* double-quote */) {
      this.scanState = 'double'
      this.scanPos++
      return { kind: 'continue' }
    }

    if ((ch === 0x7C/* | */ || ch === 0x3E/* > */) && this.isFirstNonSpaceOfLine(this.scanPos)) {
      if (this.isBlockHeader(this.scanPos)) {
        this.scanState = 'block'
        this.scanPos++
        return { kind: 'continue' }
      }
    }

    if (isEol(ch)) {
      this.consumeLineBreak()
      return { kind: 'continue' }
    }

    this.scanPos++
    return { kind: 'continue' }
  }

  private scanSingle (): ScanResult {
    if (this.scanPos >= this.buffer.length) return { kind: 'incomplete' }
    const ch = this.buffer.charCodeAt(this.scanPos)
    const column = this.scanPos - this.lineStart

    if (ch === 0x27/* single-quote */) {
      if (this.buffer.charCodeAt(this.scanPos + 1) === 0x27/* single-quote */) {
        this.scanPos += 2
        return { kind: 'continue' }
      }
      this.scanState = 'normal'
      this.scanPos++
      return { kind: 'continue' }
    }

    if (column === 0 && (ch === 0x2D/* - */ || ch === 0x2E/* . */)) {
      const sep = this.checkSeparator(this.scanPos)
      if (sep === 'incomplete') return { kind: 'incomplete' }
      if (sep === 'separator') {
        this.errored = true
        throw new YAMLException('unexpected end of the document within a single quoted scalar')
      }
    }

    if (isEol(ch)) {
      this.consumeLineBreak()
      return { kind: 'continue' }
    }

    this.scanPos++
    return { kind: 'continue' }
  }

  private scanDouble (): ScanResult {
    if (this.scanPos >= this.buffer.length) return { kind: 'incomplete' }
    const ch = this.buffer.charCodeAt(this.scanPos)
    const column = this.scanPos - this.lineStart

    if (ch === 0x5C/* backslash */) {
      this.scanPos++
      if (this.scanPos >= this.buffer.length) return { kind: 'incomplete' }
      const escaped = this.buffer.charCodeAt(this.scanPos)
      if (isEol(escaped)) {
        this.consumeLineBreak()
        while (this.scanPos < this.buffer.length && this.buffer.charCodeAt(this.scanPos) === 0x20/* Space */) this.scanPos++
        if (this.scanPos >= this.buffer.length) return { kind: 'incomplete' }
      } else {
        this.scanPos++
      }
      return { kind: 'continue' }
    }

    if (ch === 0x22/* double-quote */) {
      this.scanState = 'normal'
      this.scanPos++
      return { kind: 'continue' }
    }

    if (column === 0 && (ch === 0x2D/* - */ || ch === 0x2E/* . */)) {
      const sep = this.checkSeparator(this.scanPos)
      if (sep === 'incomplete') return { kind: 'incomplete' }
      if (sep === 'separator') {
        this.errored = true
        throw new YAMLException('unexpected end of the document within a double quoted scalar')
      }
    }

    if (isEol(ch)) {
      this.consumeLineBreak()
      return { kind: 'continue' }
    }

    this.scanPos++
    return { kind: 'continue' }
  }

  private scanBlock (): ScanResult {
    if (this.scanPos >= this.buffer.length) return { kind: 'incomplete' }
    let p = this.scanPos
    while (p < this.buffer.length && this.buffer.charCodeAt(p) === 0x20/* Space */) p++
    if (p >= this.buffer.length) return { kind: 'incomplete' }
    if (isEol(this.buffer.charCodeAt(p))) {
      this.scanPos = p
      this.consumeLineBreak()
      return { kind: 'continue' }
    }
    if (p === this.scanPos) {
      this.scanState = 'normal'
      return { kind: 'continue' }
    }
    while (this.scanPos < this.buffer.length && !isEol(this.buffer.charCodeAt(this.scanPos))) this.scanPos++
    if (this.scanPos >= this.buffer.length) return { kind: 'incomplete' }
    this.consumeLineBreak()
    return { kind: 'continue' }
  }

  // At EOF, an incomplete column-0 run of '-' or '.' is either a real
  // separator (exactly 3 chars) or plain content.
  private resolveIncompleteAtEof (): void {
    if (this.scanPos >= this.buffer.length) return
    const pos = this.scanPos
    const state = this.scanState
    const column = pos - this.lineStart

    if (column === 0) {
      const ch = this.buffer.charCodeAt(pos)
      if (ch === 0x2D/* - */ || ch === 0x2E/* . */) {
        const run = this.countRun(pos, ch)
        if (run >= 3 && pos + 3 >= this.buffer.length) {
          if (state === 'single' || state === 'double') {
            this.errored = true
            throw new YAMLException(state === 'single'
              ? 'unexpected end of the document within a single quoted scalar'
              : 'unexpected end of the document within a double quoted scalar')
          }
          const endPosition = ch === 0x2E/* . */ ? pos + 3 : undefined
          this.emitBoundary({ kind: 'boundary', boundary: ch === 0x2D ? 'start' : 'end', position: pos, endPosition })
          return
        }
      }
    }

    // Treat the remaining content as part of the final document.
    this.scanPos = this.buffer.length
  }

  private emitBoundary (result: ScanResult): void {
    if (result.kind !== 'boundary') return
    const trimPos = result.boundary === 'end' && result.endPosition != null
      ? result.endPosition
      : result.position
    const text = this.buffer.slice(0, trimPos)
    const startByte = this.docStartByte
    const endByte = startByte + utf8ByteLength(text)

    this.deliverDocument(text, startByte, endByte)

    this.buffer = this.buffer.slice(trimPos)
    this.scanPos = 0
    this.lineStart = 0
    this.docStartByte = endByte
    this.scanState = 'docStart'
    this.hasExplicitStart = false
  }

  private deliverDocument (text: string, startByte: number, endByte: number): void {
    const events = parseEvents(text, this.parserOptions)
    const values = constructFromEvents(events, { ...this.constructorOptions, source: text })
    const value = values.length > 0 ? values[0] : undefined

    let explicitStart = false
    let explicitEnd = false
    for (const event of events) {
      if (event.type === EVENT_ID.DOCUMENT) {
        explicitStart = event.explicitStart
        explicitEnd = event.explicitEnd
        break
      }
    }

    const document: IncrementalDocument = {
      start: startByte,
      end: endByte,
      explicitStart,
      explicitEnd,
      events,
      value
    }
    this.pending.push(document)
    this.onDocument?.(document)
  }
}

export {
  DocumentReader,
  utf8ByteLength,
  type DocumentReaderOptions,
  type IncrementalDocument
}
