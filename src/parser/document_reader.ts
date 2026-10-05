import { YAMLException } from '../common/exception.ts'
import { EVENT_ID, type Event } from './events.ts'
import { parseEvents } from './parser.ts'

const BOM = 0xFEFF
const BOM_CHAR = '﻿'
const DEFAULT_MAX_DOCUMENT_BYTES = 1024 * 1024

/** @category Streaming */
interface DocumentReaderOptions {
  /**
   * File path used in error messages.
   *
   * @defaultValue `''`
   */
  filename?: string

  /**
   * Maximum size of a single document, in bytes. As soon as the buffered
   * current document grows past this limit the reader rejects it: an error
   * is thrown and no partial document is ever emitted.
   *
   * @defaultValue `1048576` (1 MiB)
   */
  maxDocumentBytes?: number
}

/**
 * A document completed by {@link DocumentReader}, with its byte range in
 * the original stream. Ranges are zero-based and end-exclusive. Separator
 * ownership follows the YAML stream: a `---` marker belongs to the document
 * it opens, a `...` marker belongs to the document it closes.
 *
 * @category Streaming
 */
interface DocumentSlice {
  /** Decoded text of the document, including the markers it owns. */
  text: string
  /** Byte offset of the first document byte in the original stream. */
  start: number
  /** Byte offset one past the last document byte in the original stream. */
  end: number
}

type BomStatus = 'legal' | 'illegal' | 'defer'

function utf8Length (text: string): number {
  let length = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code < 0x80) length += 1
    else if (code < 0x800) length += 2
    else if (code >= 0xD800 && code <= 0xDBFF) { length += 4; index++ } // surrogate pair
    else length += 3
  }
  return length
}

function countDocuments (events: Event[]): number {
  let count = 0
  for (const event of events) if (event.type === EVENT_ID.DOCUMENT) count++
  return count
}

function isSpaceOrBreak (code: number): boolean {
  return code === 0x20/* Space */ || code === 0x09/* Tab */ ||
         code === 0x0A/* LF */ || code === 0x0D/* CR */
}

/**
 * Incremental YAML document reader. Accepts the input stream as small
 * UTF-8 byte chunks and emits each document as soon as it is complete.
 *
 * Document boundaries are real YAML boundaries, not textual `---` lines:
 * every candidate marker is verified with {@link parseEvents}, so markers
 * inside quoted scalars or literal blocks never split a document. Only the
 * current (unfinished) document is kept in memory, bounded by
 * {@link DocumentReaderOptions.maxDocumentBytes}.
 *
 * @category Streaming
 */
class DocumentReader {
  private readonly filename: string
  private readonly maxDocumentBytes: number
  private readonly decoder: TextDecoder
  /** Decoded text of the current, not yet completed document. */
  private buffer: string
  /** `utf8Length(buffer)`, maintained incrementally. */
  private bufferBytes: number
  /** Absolute byte offset of `buffer[0]` in the input stream. */
  private bufferStartByte: number
  /** Line-start index in `buffer`; lines before it are fully scanned. */
  private scanFrom: number
  /** Index in `buffer` up to which BOM positions were checked. */
  private bomScanFrom: number
  /** Line-start BOM whose line is not complete yet, `-1` when none. */
  private deferredBom: number
  private ended: boolean

  constructor (options: DocumentReaderOptions = {}) {
    this.filename = options.filename ?? ''
    this.maxDocumentBytes = options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES
    if (!(this.maxDocumentBytes > 0)) {
      throw new RangeError('maxDocumentBytes must be a positive number')
    }
    this.decoder = new TextDecoder('utf-8', { fatal: true })
    this.buffer = ''
    this.bufferBytes = 0
    this.bufferStartByte = 0
    this.scanFrom = 0
    this.bomScanFrom = 0
    this.deferredBom = -1
    this.ended = false
  }

  /**
   * Feeds the next chunk of UTF-8 bytes. Returns the documents completed
   * by this chunk (possibly none, possibly several).
   */
  write (chunk: Uint8Array): DocumentSlice[] {
    if (this.ended) throw new Error('cannot write() after end()')
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError('write() expects a Uint8Array of UTF-8 bytes')
    }

    let text: string
    try {
      text = this.decoder.decode(chunk, { stream: true })
    } catch {
      throw new YAMLException(`input is not valid UTF-8${this.where()}`)
    }
    if (text.length === 0) return []

    this.buffer += text
    this.bufferBytes += utf8Length(text)
    this.checkBom(false)

    const documents = this.scan(false)
    this.enforceLimit()
    return documents
  }

  /**
   * Flushes the stream end. Fails on a truncated multi-byte character or
   * a malformed trailing document; otherwise completes and returns the
   * remaining documents.
   */
  end (): DocumentSlice[] {
    if (this.ended) throw new Error('cannot call end() twice')
    this.ended = true

    let tail: string
    try {
      tail = this.decoder.decode()
    } catch {
      throw new YAMLException(
        `input ends in the middle of a multi-byte UTF-8 character${this.where()}`)
    }
    if (tail.length > 0) {
      this.buffer += tail
      this.bufferBytes += utf8Length(tail)
    }
    this.checkBom(true)

    const documents = this.scan(true)

    if (this.buffer.length > 0) {
      // A malformed trailing document must fail here, not be dropped.
      const events = parseEvents(this.buffer, { filename: this.filename })
      if (countDocuments(events) > 0) documents.push(this.emit(this.buffer.length))
      this.consume(this.buffer.length)
    }

    return documents
  }

  private where (): string {
    return this.filename === '' ? '' : ` in "${this.filename}"`
  }

  private throwBom (): never {
    throw new YAMLException(
      `byte order mark (BOM) is only allowed at the start of a document${this.where()}`)
  }

  private enforceLimit (): void {
    if (this.bufferBytes > this.maxDocumentBytes) {
      throw new YAMLException(
        `document exceeds the limit of ${this.maxDocumentBytes} bytes${this.where()}`)
    }
  }

  /** Builds the slice for `buffer[0, endIndex)`; throws if it is too large. */
  private emit (endIndex: number): DocumentSlice {
    const text = this.buffer.slice(0, endIndex)
    const bytes = utf8Length(text)
    if (bytes > this.maxDocumentBytes) {
      throw new YAMLException(
        `document of ${bytes} bytes exceeds the limit of ${this.maxDocumentBytes} bytes${this.where()}`)
    }
    const start = this.bufferStartByte
    return { text, start, end: start + bytes }
  }

  /** Drops `buffer[0, endIndex)`; only the current document stays cached. */
  private consume (endIndex: number): void {
    const bytes = utf8Length(this.buffer.slice(0, endIndex))
    this.buffer = this.buffer.slice(endIndex)
    this.bufferBytes -= bytes
    this.bufferStartByte += bytes
    this.scanFrom = 0
    this.bomScanFrom = Math.max(0, this.bomScanFrom - endIndex)
    if (this.deferredBom !== -1) {
      this.deferredBom = this.deferredBom >= endIndex ? this.deferredBom - endIndex : -1
    }
  }

  private tryParse (text: string): Event[] | null {
    try {
      return parseEvents(text, { filename: this.filename })
    } catch (error) {
      if (error instanceof YAMLException) return null
      throw error
    }
  }

  private bomStatus (index: number, final: boolean): BomStatus {
    // The buffer always starts at a document start, where a BOM is legal.
    if (index === 0) return 'legal'

    const previous = this.buffer.charCodeAt(index - 1)
    if (previous !== 0x0A/* LF */ && previous !== 0x0D/* CR */) return 'illegal'

    // A line-start BOM is only legal when it introduces a document boundary
    // (a `---` marker or a `%` directive), mirroring the parser.
    const rest = this.buffer.slice(index + 1)
    if (rest.charCodeAt(0) === 0x25/* % */) return 'legal'
    if (rest.startsWith('---')) {
      if (rest.length === 3) return final ? 'legal' : 'defer'
      return isSpaceOrBreak(rest.charCodeAt(3)) ? 'legal' : 'illegal'
    }
    // The line may still grow into a `---` marker; at EOF the parser skips a
    // trailing line-start BOM between documents, so accept it there.
    if (rest === '' || rest === '-' || rest === '--') return final ? 'legal' : 'defer'
    return 'illegal'
  }

  private checkBom (final: boolean): void {
    if (this.deferredBom !== -1) {
      const status = this.bomStatus(this.deferredBom, final)
      if (status === 'illegal') this.throwBom()
      if (status !== 'defer') this.deferredBom = -1
    }

    let index = this.buffer.indexOf(BOM_CHAR, this.bomScanFrom)
    while (index !== -1) {
      if (index !== this.deferredBom) {
        const status = this.bomStatus(index, final)
        if (status === 'illegal') this.throwBom()
        if (status === 'defer') this.deferredBom = index
      }
      this.bomScanFrom = index + 1
      index = this.buffer.indexOf(BOM_CHAR, this.bomScanFrom)
    }
  }

  /**
   * Returns `'start'` / `'end'` when the line `buffer[lineStart, lineEnd)`
   * is a document marker line. Only called for complete lines (or at EOF),
   * so a marker at the very end of the line is always terminated.
   */
  private markerAt (lineStart: number, lineEnd: number): 'start' | 'end' | null {
    let pos = lineStart
    let bomPrefixed = false
    if (this.buffer.charCodeAt(pos) === BOM) { pos++; bomPrefixed = true }

    const rest = this.buffer.slice(pos, lineEnd)
    if (rest.startsWith('---')) {
      if (rest.length === 3 || isSpaceOrBreak(rest.charCodeAt(3))) return 'start'
    } else if (!bomPrefixed && rest.startsWith('...')) {
      if (rest.length === 3 || isSpaceOrBreak(rest.charCodeAt(3))) return 'end'
    }
    return null
  }

  /**
   * Scans the buffer for document boundaries. Returns the documents
   * completed during this scan and consumes them from the buffer.
   */
  private scan (final: boolean): DocumentSlice[] {
    const documents: DocumentSlice[] = []
    let lineStart = this.scanFrom

    while (lineStart < this.buffer.length) {
      let lineEnd = lineStart
      while (lineEnd < this.buffer.length &&
             this.buffer.charCodeAt(lineEnd) !== 0x0A &&
             this.buffer.charCodeAt(lineEnd) !== 0x0D) lineEnd++

      const hasBreak = lineEnd < this.buffer.length
      if (!hasBreak && !final) break // wait for the line to complete
      // A CR at the end of the buffer may yet be joined by its LF.
      if (!final && hasBreak &&
          this.buffer.charCodeAt(lineEnd) === 0x0D &&
          lineEnd + 1 === this.buffer.length) break

      let lineBreakEnd = lineEnd
      if (hasBreak) {
        lineBreakEnd = lineEnd + 1
        if (this.buffer.charCodeAt(lineEnd) === 0x0D &&
            this.buffer.charCodeAt(lineBreakEnd) === 0x0A) lineBreakEnd++
      }

      const marker = this.markerAt(lineStart, lineEnd)

      if (marker === 'start') {
        const cut = this.tryStartBoundary(lineStart, documents)
        if (cut > 0) {
          this.consume(cut)
          lineStart = 0
        } else {
          lineStart = lineBreakEnd
        }
      } else if (marker === 'end') {
        const cut = this.tryEndBoundary(lineBreakEnd, documents)
        if (cut >= 0) {
          this.consume(cut)
          lineStart = 0
        } else {
          lineStart = lineBreakEnd
        }
      } else {
        lineStart = lineBreakEnd
      }
    }

    this.scanFrom = lineStart
    return documents
  }

  /**
   * Handles a `---` candidate at `lineStart`. Returns the index up to which
   * the buffer is consumed when the marker is a real boundary, or `-1` when
   * the marker belongs to the current document's content.
   */
  private tryStartBoundary (lineStart: number, documents: DocumentSlice[]): number {
    const prefixEvents = this.tryParse(this.buffer.slice(0, lineStart))
    if (prefixEvents === null) {
      // The text before the marker does not parse as a complete stream, so
      // the marker cannot be a boundary: it belongs to the current document
      // (e.g. an unterminated quoted scalar), or the input is invalid, which
      // surfaces as a parse error no later than end().
      return -1
    }

    // The text before the marker is a complete stream on its own, so the
    // marker opens the next document (and belongs to it).
    if (countDocuments(prefixEvents) > 0) documents.push(this.emit(lineStart))
    return lineStart
  }

  /**
   * Handles a `...` candidate whose line ends at `lineBreakEnd`. Returns
   * the consumed index when the marker really closes the current document
   * (the marker line belongs to it), or `-1` otherwise.
   */
  private tryEndBoundary (lineBreakEnd: number, documents: DocumentSlice[]): number {
    const events = this.tryParse(this.buffer.slice(0, lineBreakEnd))
    if (events === null) return -1
    if (countDocuments(events) > 0) documents.push(this.emit(lineBreakEnd))
    return lineBreakEnd
  }
}

export {
  DocumentReader,
  DEFAULT_MAX_DOCUMENT_BYTES,
  type DocumentReaderOptions,
  type DocumentSlice
}
