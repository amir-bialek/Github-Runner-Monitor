// In-test tar writer for invented fixtures: ustar headers with checksum, pax
// extended headers, GNU long names and any typeflag.

const BLOCK = 512;

export interface HeaderFields {
  name: string;
  type?: string;
  size?: number;
  linkname?: string;
  prefix?: string;
  /** Write the size field in base-256 instead of octal. */
  base256Size?: boolean;
  /** Add this to the computed checksum to make it wrong. */
  checksumDelta?: number;
}

function writeString(buf: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) throw new Error(`fixture field too long: ${value}`);
  bytes.copy(buf, offset);
}

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  writeString(buf, offset, length, value.toString(8).padStart(length - 1, '0') + '\0');
}

export function header(fields: HeaderFields): Buffer {
  const buf = Buffer.alloc(BLOCK);
  const size = fields.size ?? 0;
  writeString(buf, 0, 100, fields.name);
  writeOctal(buf, 100, 8, fields.type === '5' ? 0o755 : 0o644);
  writeOctal(buf, 108, 8, 1000);
  writeOctal(buf, 116, 8, 1000);
  if (fields.base256Size) {
    buf[124] = 0x80;
    let rest = size;
    for (let i = 135; i > 124; i--) {
      buf[i] = rest % 256;
      rest = Math.floor(rest / 256);
    }
  } else {
    writeOctal(buf, 124, 12, size);
  }
  writeOctal(buf, 136, 12, 1700000000);
  buf.write(fields.type ?? '0', 156, 'latin1');
  if (fields.linkname) writeString(buf, 157, 100, fields.linkname);
  buf.write('ustar\0', 257, 'latin1');
  buf.write('00', 263, 'latin1');
  if (fields.prefix) writeString(buf, 345, 155, fields.prefix);
  buf.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of buf) sum += byte;
  sum += fields.checksumDelta ?? 0;
  writeString(buf, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
  return buf;
}

function padded(data: Buffer): Buffer {
  const rest = data.length % BLOCK;
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(BLOCK - rest)]);
}

/** A header plus its data, padded to whole blocks. */
export function entry(fields: HeaderFields, data: Buffer | string = Buffer.alloc(0)): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return Buffer.concat([header({ ...fields, size: fields.size ?? body.length }), padded(body)]);
}

export function file(name: string, content: string, extra: Partial<HeaderFields> = {}): Buffer {
  return entry({ name, type: '0', ...extra }, content);
}

export function dir(name: string): Buffer {
  return entry({ name, type: '5' });
}

export function link(name: string, type: string, linkname = 'target'): Buffer {
  return entry({ name, type, linkname });
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return `${len}${body}`;
}

/** A pax extended header ('x', or 'g' for global) with the given records. */
export function pax(records: Record<string, string>, type: 'x' | 'g' = 'x'): Buffer {
  const text = Object.entries(records)
    .map(([k, v]) => paxRecord(k, v))
    .join('');
  return entry({ name: 'PaxHeader', type }, text);
}

/** A GNU long name ('L') entry; the next entry gets this name. */
export function gnuLongName(name: string): Buffer {
  return entry({ name: '././@LongLink', type: 'L' }, `${name}\0`);
}

export function tar(...parts: Buffer[]): Buffer {
  return Buffer.concat([...parts, Buffer.alloc(BLOCK * 2)]);
}
