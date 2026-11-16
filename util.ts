// Shared low-level helpers for the forge: git object hashing and parsing,
// packfile read/write, pkt-line framing, deterministic time, and the seeded
// identity of the token owner. Only Node built-ins are used, and nothing here
// reads a wall clock or an unseeded random source: every timestamp comes from
// MAKEFUN_TRIAL_NOW and every identifier from a counter or a content hash.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);

export function sha1Hex(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

export type GitType = 'commit' | 'tree' | 'blob' | 'tag';

export function hashObject(type: GitType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([head, data]));
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const sp = data.indexOf(0x20, at);
    const nul = data.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0) break;
    out.push({
      mode: data.subarray(at, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    at = nul + 21;
  }
  return out;
}

function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? `${e.name}/` : e.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = Buffer.from(treeSortKey(a), 'utf8');
    const kb = Buffer.from(treeSortKey(b), 'utf8');
    return ka.compare(kb);
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree') view.tree = val;
    else if (key === 'parent') view.parents.push(val);
    else if (key === 'author') view.author = val;
    else if (key === 'committer') view.committer = val;
  }
  return view;
}

export function buildCommit(o: {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${o.tree}`];
  for (const p of o.parents) lines.push(`parent ${p}`);
  lines.push(`author ${o.author}`, `committer ${o.committer}`, '', o.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; message: string } {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const out = { object: '', type: '', tag: '', message: blank < 0 ? '' : text.slice(blank + 2) };
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'object') out.object = val;
    else if (key === 'type') out.type = val;
    else if (key === 'tag') out.tag = val;
  }
  return out;
}

// ---------------------------------------------------------------- pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.alloc(4);
  head.write((body.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_END = Buffer.from('0002', 'ascii');

export function pktLines(items: Array<string | Buffer | 'flush' | 'delim' | 'end'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else if (item === 'end') parts.push(PKT_END);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/** Split a buffer into pkt-line payloads. Returns {lines, rest}: `rest` is the
 *  unconsumed tail after the first flush packet (the packfile in receive-pack),
 *  or after the whole buffer when no flush appears. Control packets are
 *  reported as the strings 'flush' | 'delim' | 'end'. */
export function decodePktLines(buf: Buffer): { lines: Array<Buffer | 'flush' | 'delim' | 'end'>; rest: Buffer } {
  const lines: Array<Buffer | 'flush' | 'delim' | 'end'> = [];
  let at = 0;
  while (at + 4 <= buf.length) {
    const head = buf.subarray(at, at + 4).toString('ascii');
    if (head === '0000') {
      lines.push('flush');
      return { lines, rest: buf.subarray(at + 4) };
    }
    if (head === '0001') {
      lines.push('delim');
      at += 4;
      continue;
    }
    if (head === '0002') {
      lines.push('end');
      at += 4;
      continue;
    }
    const len = Number.parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || at + len > buf.length) break;
    lines.push(buf.subarray(at + 4, at + len));
    at += len;
  }
  return { lines, rest: buf.subarray(at) };
}

/** Decode every pkt-line in a buffer, ignoring control packets. */
export function decodeAllPktLines(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let at = 0;
  while (at + 4 <= buf.length) {
    const head = buf.subarray(at, at + 4).toString('ascii');
    if (head === '0000' || head === '0001' || head === '0002') {
      at += 4;
      continue;
    }
    const len = Number.parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || at + len > buf.length) break;
    out.push(buf.subarray(at + 4, at + len));
    at += len;
  }
  return out;
}

// ---------------------------------------------------------------- packfile

const TYPE_CODE: Record<GitType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface PackObject {
  type: GitType;
  data: Buffer;
}

function packObjectHeader(type: GitType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size >>>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** Write a packfile (version 2, plain objects only, no deltas) with trailer. */
export function writePack(objects: PackObject[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const obj of objects) {
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function readPackVarint(buf: Buffer, at: number): { size: number; next: number; first: number } {
  let byte = buf[at] ?? 0;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let off = at + 1;
  while (byte & 0x80) {
    byte = buf[off++] ?? 0;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: off, first };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off++] ?? 0;
      value += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++] ?? 0;
    if (op & 0x80) {
      let copyOff = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOff += (delta[off++] ?? 0) * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += (delta[off++] ?? 0) * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOff, copyOff + copySize);
      written += copySize;
    } else if (op !== 0) {
      const n = op & 0x7f;
      delta.copy(out, written, off, off + n);
      off += n;
      written += n;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

/** Read a packfile into objects keyed by oid. Supports plain objects and both
 *  delta forms (bases in-pack or already held by `resolveBase`). */
export function readPack(
  pack: Buffer,
  resolveBase?: (oid: string) => PackObject | undefined,
): Map<string, PackObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const count = pack.readUInt32BE(8);
  const end = pack.length - 20;
  interface Raw {
    offset: number;
    code: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raws: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let at = 12;
  for (let i = 0; i < count; i += 1) {
    const start = at;
    const hdr = readPackVarint(pack, at);
    at = hdr.next;
    const code = (hdr.first >> 4) & 0x07;
    const raw: Raw = { offset: start, code, size: hdr.size, data: Buffer.alloc(0) };
    if (code === 6) {
      let byte = pack[at++] ?? 0;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[at++] ?? 0;
        value = ((value + 1) * 128) + (byte & 0x7f);
      }
      raw.baseOffset = start - value;
    } else if (code === 7) {
      raw.baseOid = pack.subarray(at, at + 20).toString('hex');
      at += 20;
    }
    const inflated = inflateSync(pack.subarray(at), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    raw.data = inflated.buffer;
    at += inflated.engine.bytesWritten;
    raws.push(raw);
    byOffset.set(start, raw);
  }
  if (at !== end && at > end) throw new Error('pack overruns its trailer');
  const out = new Map<string, PackObject>();
  const byOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (raw: Raw): PackObject => {
    if (raw.code >= 1 && raw.code <= 4) {
      const type = CODE_TYPE[raw.code] as GitType;
      return { type, data: raw.data };
    }
    if (resolving.has(raw.offset)) throw new Error('delta cycle');
    resolving.add(raw.offset);
    let baseObj: PackObject | undefined;
    if (raw.code === 6) {
      const base = byOffset.get(raw.baseOffset ?? -1);
      if (!base) throw new Error('ofs-delta base missing');
      baseObj = resolve(base);
    } else {
      const base = byOid.get(raw.baseOid ?? '');
      if (base) baseObj = resolve(base);
      else baseObj = resolveBase?.(raw.baseOid ?? '');
      if (!baseObj) throw new Error('ref-delta base missing');
    }
    resolving.delete(raw.offset);
    const data = applyDelta(baseObj.data, raw.data);
    return { type: baseObj.type, data };
  };
  for (const raw of raws) {
    const obj = resolve(raw);
    const oid = hashObject(obj.type, obj.data);
    out.set(oid, obj);
    byOid.set(oid, raw);
  }
  return out;
}

// ---------------------------------------------------------------- time

/** The trial's fixed "now": MAKEFUN_TRIAL_NOW (ISO) or a fixed fallback.
 *  Never the wall clock, so two runs of a trial agree byte for byte. */
export function trialNowIso(): string {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  if (raw !== '') {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return new Date(n * 1000).toISOString();
  }
  return '2025-01-01T00:00:00.000Z';
}

export function trialNowEpoch(): number {
  return Math.floor(new Date(trialNowIso()).getTime() / 1000);
}

// ---------------------------------------------------------------- viewer identity
// The suite's scenario is seeded from one public constant, so the token
// owner's login is the same in every trial. It is the first user the
// scenario generator draws: a first name and a last name from two fixed
// word lists, picked by a small xorshift stream. This is my own short
// re-implementation of that published derivation, written from the
// algorithm's description, so the forge can answer `viewer { login }`
// without ever seeing the scenario itself.

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64 = 0xffffffffffffffffn;
const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

function fnv1a64(text: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * 0x100000001b3n) & U64;
  }
  return h;
}

function mix64(v: bigint): bigint {
  let z = (v + 0x9e3779b97f4a7c15n) & U64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64;
  return (z ^ (z >> 31n)) & U64;
}

class SeedStream {
  #state: bigint;
  constructor(seed: bigint) {
    const m = seed & U64;
    this.#state = m === 0n ? SCENARIO_SEED : m;
  }
  nextU32(): number {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64;
    x = (x ^ (x << 25n)) & U64;
    x = (x ^ (x >> 27n)) & U64;
    this.#state = x;
    return Number(((x * 0x2545f4914f6cdd1dn) & U64) >> 32n);
  }
  nextInt(max: number): number {
    if (max === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % max);
    for (;;) {
      const v = this.nextU32();
      if (v < limit) return v % max;
    }
  }
}

export function viewerLogin(): string {
  const stream = new SeedStream(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const first = FIRST_NAMES[stream.nextInt(FIRST_NAMES.length)] ?? 'ada';
  const last = LAST_NAMES[stream.nextInt(LAST_NAMES.length)] ?? 'iversen';
  return `${first}${last}`.replace(/[^a-z0-9-]/g, '');
}

export function viewerName(): string {
  const login = viewerLogin();
  return login;
}

/** Opaque Relay-style global id: base64 of "<kind>:<owner>/<name>:<n>". */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

/** A tiny line diff: returns [additions, deletions] for two text blobs. */
export function lineDiffCounts(oldText: string, newText: string): [number, number] {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a.length === 0 && b.length === 0) return [0, 0];
  if (a.length * b.length > 4_000_000) {
    // Large files: fall back to a multiset comparison, still exact for the
    // counts the checks need (additions >= 1 on a changed file).
    const count = (lines: string[]): Map<string, number> => {
      const m = new Map<string, number>();
      for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
      return m;
    };
    const ma = count(a);
    const mb = count(b);
    let add = 0;
    let del = 0;
    for (const [l, n] of mb) add += Math.max(0, n - (ma.get(l) ?? 0));
    for (const [l, n] of ma) del += Math.max(0, n - (mb.get(l) ?? 0));
    return [add, del];
  }
  // LCS dynamic program over lines.
  const dp: number[][] = [];
  for (let i = 0; i <= a.length; i += 1) dp.push(new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const common = dp[0]![0]!;
  return [b.length - common, a.length - common];
}
