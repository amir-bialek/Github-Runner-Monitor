// Streaming tar reader with no dependencies. The caller handles gzip (node:zlib).
// Supports ustar (with prefix), pax extended headers ('x' path and size; 'g'
// ignored), GNU long names ('L', 'K'), octal and base-256 sizes, and verifies
// every header checksum. Any malformed input throws TarError.

const BLOCK = 512;
// Pax headers and GNU long names are small in practice; refuse anything huge.
const MAX_META_BYTES = 1024 * 1024;

export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TarError';
  }
}

export interface TarEntry {
  /** Raw typeflag character ('0', '\0', '5', '2', ...). */
  type: string;
  /** Full entry path (pax path, GNU long name or ustar prefix/name). */
  path: string;
  /** Number of data bytes. */
  size: number;
  /** The entry data. Anything not consumed is skipped when the next entry is read. */
  data: AsyncIterable<Buffer>;
}

class ByteReader {
  private readonly source: AsyncIterator<Buffer>;
  private chunks: Buffer[] = [];
  private buffered = 0;
  private ended = false;

  constructor(source: AsyncIterable<Buffer>) {
    this.source = source[Symbol.asyncIterator]();
  }

  private async fill(n: number): Promise<void> {
    while (this.buffered < n && !this.ended) {
      const next = await this.source.next();
      if (next.done) {
        this.ended = true;
      } else {
        const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
        if (chunk.length > 0) {
          this.chunks.push(chunk);
          this.buffered += chunk.length;
        }
      }
    }
  }

  private take(n: number): Buffer {
    const out = Buffer.allocUnsafe(n);
    let offset = 0;
    while (offset < n) {
      const head = this.chunks[0];
      if (!head) throw new TarError('internal read error');
      const want = n - offset;
      if (head.length <= want) {
        head.copy(out, offset);
        offset += head.length;
        this.chunks.shift();
      } else {
        head.copy(out, offset, 0, want);
        this.chunks[0] = head.subarray(want);
        offset += want;
      }
    }
    this.buffered -= n;
    return out;
  }

  /** Exactly n bytes, or null at a clean end of input. Throws on a short read. */
  async readExact(n: number): Promise<Buffer | null> {
    await this.fill(n);
    if (this.buffered === 0 && this.ended) return null;
    if (this.buffered < n) throw new TarError('unexpected end of archive');
    return this.take(n);
  }

  /** Yields everything left in the input, buffered bytes first. */
  async *rest(): AsyncGenerator<Buffer> {
    for (;;) {
      await this.fill(1);
      if (this.buffered === 0) return;
      yield this.take(this.buffered);
    }
  }

  /** Yields up to n bytes as they arrive. Throws if the input ends early. */
  async *stream(n: number, onRead: (count: number) => void): AsyncGenerator<Buffer> {
    let left = n;
    while (left > 0) {
      await this.fill(1);
      if (this.buffered === 0) throw new TarError('unexpected end of archive');
      const count = Math.min(left, this.buffered, 64 * 1024);
      const chunk = this.take(count);
      left -= count;
      onRead(count);
      yield chunk;
    }
  }

  async skip(n: number): Promise<void> {
    let left = n;
    while (left > 0) {
      await this.fill(1);
      if (this.buffered === 0) throw new TarError('unexpected end of archive');
      const count = Math.min(left, this.buffered);
      this.take(count);
      left -= count;
    }
  }
}

function cString(buf: Buffer, start: number, length: number): string {
  const field = buf.subarray(start, start + length);
  const nul = field.indexOf(0);
  return (nul === -1 ? field : field.subarray(0, nul)).toString('utf8');
}

function parseOctal(buf: Buffer, start: number, length: number, what: string): number {
  const text = buf
    .subarray(start, start + length)
    .toString('latin1')
    .replace(/[\0 ]+$/, '')
    .replace(/^[ ]+/, '');
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarError(`invalid ${what} field`);
  const value = parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new TarError(`invalid ${what} field`);
  return value;
}

function parseSize(header: Buffer): number {
  const first = header[124] ?? 0;
  if ((first & 0x80) === 0) return parseOctal(header, 124, 12, 'size');
  // Base-256 (GNU): big-endian, high bit of the first byte is the marker.
  if ((first & 0x40) !== 0) throw new TarError('negative size field');
  let value = first & 0x3f;
  for (let i = 125; i < 136; i++) {
    value = value * 256 + (header[i] ?? 0);
    if (!Number.isSafeInteger(value)) throw new TarError('invalid size field');
  }
  return value;
}

function verifyChecksum(header: Buffer): void {
  const stored = parseOctal(header, 148, 8, 'checksum');
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const byte = i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  if (stored !== unsigned && stored !== signed) throw new TarError('bad header checksum');
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false;
  return true;
}

function padding(size: number): number {
  const rest = size % BLOCK;
  return rest === 0 ? 0 : BLOCK - rest;
}

interface PaxValues {
  path?: string;
  size?: number;
}

function parsePax(buf: Buffer): PaxValues {
  const values: PaxValues = {};
  let pos = 0;
  while (pos < buf.length) {
    // Trailing NUL padding is tolerated.
    if (buf[pos] === 0) break;
    const space = buf.indexOf(0x20, pos);
    if (space === -1) throw new TarError('invalid pax header');
    const lenText = buf.subarray(pos, space).toString('latin1');
    if (!/^[0-9]+$/.test(lenText)) throw new TarError('invalid pax header');
    const len = parseInt(lenText, 10);
    const end = pos + len;
    if (len <= space - pos + 1 || end > buf.length || buf[end - 1] !== 0x0a) {
      throw new TarError('invalid pax header');
    }
    const record = buf.subarray(space + 1, end - 1);
    const eq = record.indexOf(0x3d);
    if (eq === -1) throw new TarError('invalid pax header');
    const key = record.subarray(0, eq).toString('utf8');
    const value = record.subarray(eq + 1).toString('utf8');
    if (key === 'path') {
      values.path = value;
    } else if (key === 'size') {
      if (!/^[0-9]+$/.test(value)) throw new TarError('invalid pax size');
      const size = parseInt(value, 10);
      if (!Number.isSafeInteger(size)) throw new TarError('invalid pax size');
      values.size = size;
    }
    pos = end;
  }
  return values;
}

export interface ReadTarOptions {
  /** Called with the byte count of every chunk of entry data read (written or skipped). */
  onDataBytes?: (count: number) => void;
}

/**
 * Reads tar entries from a stream of Buffers. Each entry's data is skipped
 * automatically if the consumer does not read it before asking for the next one.
 */
export async function* readTar(
  source: AsyncIterable<Buffer>,
  options: ReadTarOptions = {},
): AsyncGenerator<TarEntry> {
  const reader = new ByteReader(source);
  const onData = options.onDataBytes ?? ((): void => {});
  let pending: PaxValues = {};
  let longName: string | undefined;

  const readMeta = async (size: number): Promise<Buffer> => {
    if (size > MAX_META_BYTES) throw new TarError('extended header too large');
    onData(size);
    const data = size === 0 ? Buffer.alloc(0) : await reader.readExact(size);
    if (!data) throw new TarError('unexpected end of archive');
    await reader.skip(padding(size));
    return data;
  };

  for (;;) {
    const header = await reader.readExact(BLOCK);
    if (!header) throw new TarError('archive ended without end marker');
    if (isZeroBlock(header)) {
      // End of archive. Read the input to its end (so a gzip trailer gets
      // checked); only zero padding may follow, and it counts as data bytes.
      for await (const chunk of reader.rest()) {
        onData(chunk.length);
        if (!isZeroBlock(chunk)) throw new TarError('data after end of archive');
      }
      return;
    }
    verifyChecksum(header);

    const type = String.fromCharCode(header[156] ?? 0);
    let size = parseSize(header);

    if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
      const data = await readMeta(size);
      if (type === 'x') pending = { ...pending, ...parsePax(data) };
      if (type === 'L') longName = cString(data, 0, data.length);
      // 'g' (global pax) and 'K' (long link name) are not used.
      continue;
    }

    let path: string;
    if (pending.path !== undefined) {
      path = pending.path;
    } else if (longName !== undefined) {
      path = longName;
    } else {
      const name = cString(header, 0, 100);
      const magic = header.subarray(257, 263).toString('latin1');
      const prefix = magic === 'ustar\0' ? cString(header, 345, 155) : '';
      path = prefix ? `${prefix}/${name}` : name;
    }
    if (pending.size !== undefined) size = pending.size;
    pending = {};
    longName = undefined;

    let consumed = 0;
    const entrySize = size;
    const data: AsyncIterable<Buffer> = {
      [Symbol.asyncIterator]: () =>
        reader.stream(entrySize - consumed, (count) => {
          consumed += count;
          onData(count);
        }),
    };

    yield { type, path, size, data };

    if (consumed < size) {
      const left = size - consumed;
      // Count skipped bytes too so a huge dropped entry still hits the budget.
      for await (const chunk of reader.stream(left, onData)) void chunk;
      consumed = size;
    }
    await reader.skip(padding(size));
  }
}
