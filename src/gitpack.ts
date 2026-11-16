// Git objects, pkt-lines and packfiles, implemented from the wire format alone.
// No git binary anywhere: every hash, tree, pack and delta is built here.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** SHA-1 of `<type> <size>\0<data>`, the object id. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

// -------------------------------------------------------------------------------------------
// trees and commits
// -------------------------------------------------------------------------------------------

/** Tree entries sort by name, with a directory sorting as `name + '/'`. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

/** Build a tree object from its entries (sorted git's way). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree object's entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Parse a commit object into its headers and message. */
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object's bytes. The message is stored verbatim. */
export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// -------------------------------------------------------------------------------------------
// pkt-lines
// -------------------------------------------------------------------------------------------

/** One pkt-line: a 4-hex-digit length (itself included) plus the payload. */
export function encodePktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

/** The flush packet, `0000`. */
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delim packet, `0001`. */
export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  readonly kind: PktKind;
  readonly payload: Buffer;
}

/** Encode a list of lines, flushes and delims into one buffer. */
export function encodePktLines(lines: readonly (string | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktFlush());
    else if (line === 'delim') parts.push(pktDelim());
    else parts.push(encodePktLine(line));
  }
  return Buffer.concat(parts);
}

/**
 * Decode a whole buffer of pkt-lines. Throws on a malformed length, which the
 * caller turns into a 400 while the server stays up.
 */
export function decodePktLines(bytes: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line length');
    const raw = bytes.subarray(offset, offset + 4).toString('ascii');
    const length = parseInt(raw, 16);
    if (Number.isNaN(length) || length < 0 || length > 65520) throw new Error(`bad pkt-line length ${JSON.stringify(raw)}`);
    if (length === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
    } else {
      if (offset + length > bytes.length) throw new Error('truncated pkt-line payload');
      out.push({ kind: 'data', payload: Buffer.from(bytes.subarray(offset + 4, offset + length)) });
      offset += length;
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// packfiles
// -------------------------------------------------------------------------------------------

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] ?? 0;
  let size = byte & 0x0f;
  let shift = 4;
  let next = start + 1;
  while (byte & 0x80) {
    byte = buffer[next] ?? 0;
    next += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  return { size, next, first: buffer[start] ?? 0 };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] ?? 0;
  let baseOffset = byte & 0x7f;
  let next = start + 1;
  while (byte & 0x80) {
    byte = buffer[next] ?? 0;
    next += 1;
    baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
  }
  return { baseOffset, next };
}

/** Apply a git delta to its base bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] ?? 0;
      offset += 1;
      result |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return result;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let built = 0;
  while (offset < delta.length) {
    const op = delta[offset] ?? 0;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          copyOffset |= (delta[offset] ?? 0) << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          copySize |= (delta[offset] ?? 0) << (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      built += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
      built += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || built !== targetSize) throw new Error('delta result size mismatch');
  return result;
}

/** Inflate exactly one zlib stream at `offset`; answer the bytes and how many input bytes it used. */
function inflateOne(pack: Buffer, offset: number): { data: Buffer; consumed: number } {
  // inflateSync throws on truncation, so grow the window exponentially from a
  // small probe, then bisect for the smallest slice that inflates cleanly.
  let probe = Math.min(pack.length, offset + 16);
  let found = -1;
  while (probe <= pack.length) {
    try {
      inflateSync(pack.subarray(offset, probe));
      found = probe;
      break;
    } catch {
      if (probe === pack.length) break;
      probe = Math.min(pack.length, probe * 2);
    }
  }
  if (found < 0) throw new Error('truncated zlib stream in pack');
  let lo = offset + 1;
  let hi = found;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      inflateSync(pack.subarray(offset, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return { data: inflateSync(pack.subarray(offset, hi)), consumed: hi - offset };
}

/**
 * Read a packfile into objects, resolving ofs-delta and ref-delta entries against
 * the pack itself or `resolveBase` (objects the receiver already holds).
 */
export function readPack(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, { type: GitObjectType; data: Buffer; oid: string }>();
  const pending: Array<{ offset: number; kind: 'ofs' | 'ref'; baseOffset?: number; baseOid?: string; data: Buffer }> = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const { size, next, first } = readVarintSize(pack, offset);
    const typeCode = (first >> 4) & 0x07;
    offset = next;
    if (typeCode === 6) {
      // ofs-delta: an offset varint, then the zlib delta stream.
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      const { data, consumed } = inflateOne(pack, offset);
      offset += consumed;
      pending.push({ offset: entryOffset, kind: 'ofs', baseOffset: entryOffset - base.baseOffset, data });
    } else if (typeCode === 7) {
      // ref-delta: a 20-byte base oid, then the zlib delta stream.
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const { data, consumed } = inflateOne(pack, offset);
      offset += consumed;
      pending.push({ offset: entryOffset, kind: 'ref', baseOid, data });
    } else {
      const type = CODE_TYPE[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const { data, consumed } = inflateOne(pack, offset);
      offset += consumed;
      if (data.length !== size) throw new Error('pack object size mismatch');
      const oid = hashObject(type, data);
      const object: GitObject = { type, data };
      objects.set(oid, object);
      byOffset.set(entryOffset, { type, data, oid });
    }
  }
  // Resolve deltas, in pack order (a delta's base precedes it in a well-formed pack).
  for (const entry of pending) {
    let base: GitObject | undefined;
    if (entry.kind === 'ofs') {
      base = byOffset.get(entry.baseOffset ?? -1);
    } else if (entry.baseOid !== undefined) {
      base = objects.get(entry.baseOid) ?? resolveBase?.(entry.baseOid);
    }
    if (base === undefined) throw new Error('delta base not found');
    const data = applyDelta(base.data, entry.data);
    const oid = hashObject(base.type, data);
    const object: GitObject = { type: base.type, data };
    objects.set(oid, object);
    byOffset.set(entry.offset, { type: base.type, data, oid });
  }
  return objects;
}

/** Build a packfile (version 2, no deltas) from plain objects. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const code = TYPE_CODE[object.type];
    const data = object.data;
    let size = data.length;
    let first = (code << 4) | (size & 0x0f);
    size = Math.floor(size / 16);
    const bytes: number[] = [];
    while (size > 0) {
      bytes.push(first | 0x80);
      first = size & 0x7f;
      size = Math.floor(size / 128);
    }
    bytes.push(first);
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Verify a packfile's trailer checksum. */
export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 20) return false;
  const actual = pack.subarray(pack.length - 20).toString('hex');
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  return actual === expected;
}
