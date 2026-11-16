// Git smart HTTP: info/refs, upload-pack (protocol v2 and v0) and receive-pack
// (v0). The suite's client is the only speaker; this implements the exact wire
// it sends and reads, on the store in store.ts.

import {
  ZERO_OID,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  pktDelim,
  pktFlush,
  readPack,
  verifyPackChecksum,
  writePack,
  type GitObject,
} from './gitpack.ts';
import { Forge, type Repo } from './store.ts';

const AGENT = 'forge/1.0';

export interface GitResult {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

function ok(contentType: string, body: Buffer): GitResult {
  return { status: 200, contentType, body };
}

function err(status: number, message: string): GitResult {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

/** All refs of a repo, sorted, with HEAD first when it has a tip. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    out.push({ name, oid });
  }
  return out;
}

function peel(forge: Forge, repo: Repo, oid: string): string | null {
  return forge.peelToCommit(repo, oid);
}

function v0Capabilities(service: 'git-upload-pack' | 'git-receive-pack'): string {
  const common = `symref=HEAD:refs/heads/main agent=${AGENT}`;
  if (service === 'git-upload-pack') {
    return `${common} side-band-64k thin-pack ofs-delta shallow multi_ack multi_ack_detailed`;
  }
  return `${common} report-status side-band-64k delete-refs`;
}

/**
 * The v0 ref advertisement: the service preamble, a flush, then one line per
 * ref (`<oid> <name>`, capabilities after a NUL on the first line), peeled
 * tags as `<oid> <name>^{}>`, and a final flush.
 */
function v0Advertisement(forge: Forge, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), pktFlush()];
  const caps = v0Capabilities(service);
  const refs = sortedRefs(repo);
  const mainTip = repo.refs.get('refs/heads/main');
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = mainTip ?? ZERO_OID;
    parts.push(encodePktLine(`${headOid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.name.startsWith('refs/tags/')) {
        const peeled = peel(forge, repo, ref.oid);
        if (peeled !== null && peeled !== ref.oid) parts.push(encodePktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The protocol v2 capability advertisement for upload-pack. */
function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}

// -------------------------------------------------------------------------------------------
// info/refs
// -------------------------------------------------------------------------------------------

export function handleInfoRefs(
  forge: Forge,
  repo: Repo | undefined,
  service: 'git-upload-pack' | 'git-receive-pack',
  gitProtocolVersion: 2 | 0,
): GitResult {
  if (repo === undefined) return err(404, 'Not Found');
  if (service === 'git-upload-pack' && gitProtocolVersion === 2) {
    return ok('application/x-git-upload-pack-advertisement', v2Advertisement());
  }
  return ok(`application/x-${service}-advertisement`, v0Advertisement(forge, repo, service));
}

// -------------------------------------------------------------------------------------------
// upload-pack
// -------------------------------------------------------------------------------------------

interface FetchPlan {
  /** Objects to send, in a stable order. */
  objects: GitObject[];
  /** The new shallow boundary commits (depth-limited fetches). */
  shallow: string[];
  /** Previously shallow commits that are no longer shallow. */
  unshallow: string[];
}

/**
 * The generation of `target` from `wants` (0 for a want itself), or null when
 * it is not an ancestor of any want. Used to turn a relative deepen into an
 * absolute depth: the client's current depth is its deepest boundary's
 * generation + 1.
 */
function generationOf(forge: Forge, repo: Repo, wants: readonly string[], target: string): number | null {
  const seen = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  for (const want of wants) {
    const commit = forge.peelToCommit(repo, want);
    if (commit !== null) queue.push([commit, 0]);
  }
  while (queue.length > 0) {
    const [oid, gen] = queue.shift() as [string, number];
    if (seen.has(oid)) continue;
    seen.set(oid, gen);
    if (oid === target) return gen;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push([parent, gen + 1]);
  }
  return null;
}

/**
 * Turn a requested depth into the absolute generation limit from the wants.
 * A bare `deepen N` is already absolute (the suite's client); `deepen N`
 * with `deepen-relative` (real git) adds N to the client's current depth.
 */
function absoluteDepth(
  forge: Forge,
  repo: Repo,
  wants: readonly string[],
  shallow: readonly string[],
  deepen: number | undefined,
  deepenRelative: boolean,
): number | undefined {
  if (deepen === undefined) return undefined;
  if (!deepenRelative) return deepen;
  let base = 0;
  for (const boundary of shallow) {
    const gen = generationOf(forge, repo, wants, boundary);
    if (gen !== null) base = Math.max(base, gen + 1);
  }
  return base + deepen;
}
function planFetch(
  forge: Forge,
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | undefined,
): FetchPlan {
  // The commits the fetch covers, with their generation from the wants.
  const included = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  for (const want of wants) {
    const commit = forge.peelToCommit(repo, want);
    if (commit !== null) queue.push([commit, 0]);
  }
  while (queue.length > 0) {
    const [oid, gen] = queue.shift() as [string, number];
    const known = included.get(oid);
    if (known !== undefined && known <= gen) continue;
    included.set(oid, gen);
    if (depth !== undefined && gen + 1 >= depth) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push([parent, gen + 1]);
  }
  // What the client already holds: the closure of its haves, minus everything
  // below its shallow boundary (a shallow commit's parents are not held).
  const held = forge.collectReachable(repo, haves);
  for (const boundary of clientShallow) {
    const object = repo.objects.get(boundary);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      for (const oid of forge.collectReachable(repo, [parent])) held.delete(oid);
    }
  }
  // The objects to send: the closure of the included commits (plus the wanted
  // tag objects themselves), minus what the client holds.
  const sendRoots: string[] = [...included.keys()];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object !== undefined && object.type === 'tag') sendRoots.push(want);
  }
  const closure = forge.collectReachable(repo, sendRoots);
  // With a depth limit, drop commits (and their exclusive trees) past the cut:
  // only the included commits' trees and blobs travel.
  let wanted: Set<string>;
  if (depth === undefined) {
    wanted = closure;
  } else {
    wanted = new Set<string>();
    for (const oid of included.keys()) {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      wanted.add(oid);
      const tree = parseCommit(object.data).tree;
      for (const entry of forge.collectReachable(repo, [tree])) wanted.add(entry);
    }
    for (const want of wants) {
      const object = repo.objects.get(want);
      if (object !== undefined && object.type === 'tag') wanted.add(want);
    }
  }
  const objects: GitObject[] = [];
  for (const oid of [...wanted].sort()) {
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  // Shallow bookkeeping: the boundary is an included commit whose parents were
  // cut off by the depth; unshallow is an old boundary now fully included.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== undefined) {
    for (const oid of included.keys()) {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      const cut = parents.some((parent) => !included.has(parent));
      if (parents.length > 0 && cut) shallow.push(oid);
    }
    for (const boundary of clientShallow) {
      if (!included.has(boundary)) continue;
      const object = repo.objects.get(boundary);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length === 0 || parents.every((parent) => included.has(parent))) unshallow.push(boundary);
    }
  }
  return { objects, shallow: shallow.sort(), unshallow: unshallow.sort() };
}

/** One sideband data packet: a band byte plus up to 65515 bytes of pack. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65500;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) parts.push(encodePktLine(Buffer.from([1])));
  return parts;
}

function lsRefsResponse(
  forge: Forge,
  repo: Repo,
  options: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] },
): Buffer {
  const keep = (name: string): boolean =>
    options.prefixes.length === 0 || options.prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  if (keep('HEAD')) {
    if (mainTip !== undefined) {
      const symref = options.symrefs ? ' symref-target:refs/heads/main' : '';
      parts.push(encodePktLine(`${mainTip} HEAD${symref}\n`));
    } else if (options.unborn) {
      const symref = options.symrefs ? ' symref-target:refs/heads/main' : '';
      parts.push(encodePktLine(`unborn HEAD${symref}\n`));
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (options.peel && ref.name.startsWith('refs/tags/')) {
      const peeled = peel(forge, repo, ref.oid);
      if (peeled !== null && peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    parts.push(encodePktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/**
 * The v2 fetch response, as sections. Sections are separated by a delim
 * (0001); only the response's last packet is a flush (0000). `ack` is the
 * acknowledgments section's lines, or null for no such section; when
 * `includePack` is false the response ends after the acknowledgments (the
 * client re-requests with `done` to get the pack).
 */
function fetchV2Response(forge: Forge, repo: Repo, plan: FetchPlan, ack: readonly string[] | null, includePack: boolean): Buffer {
  const sections: Buffer[][] = [];
  if (ack !== null) {
    sections.push([encodePktLine('acknowledgments\n'), ...ack.map((line) => encodePktLine(`${line}\n`))]);
  }
  if (includePack) {
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      const lines: Buffer[] = [encodePktLine('shallow-info\n')];
      for (const oid of plan.shallow) lines.push(encodePktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) lines.push(encodePktLine(`unshallow ${oid}\n`));
      sections.push(lines);
    }
    sections.push([encodePktLine('packfile\n'), ...sidebandPackets(writePack(plan.objects))]);
  }
  const parts: Buffer[] = [];
  sections.forEach((section, index) => {
    parts.push(...section);
    parts.push(index === sections.length - 1 ? pktFlush() : pktDelim());
  });
  return Buffer.concat(parts);
}

function fetchV0Response(forge: Forge, repo: Repo, plan: FetchPlan): Buffer {
  // Protocol v0 always answers an ACK/NAK line first: git's fetch-pack reads
  // it unconditionally, haves or none.
  const parts: Buffer[] = [encodePktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPackets(writePack(plan.objects)));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const packets = decodePktLines(body);
  const lines: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  void seenDelim;
  const first = (lines[0] ?? '').trim();
  const command = first.startsWith('command=') ? first.slice('command='.length) : '';
  return { command, args: lines.slice(1) };
}

export function handleUploadPack(
  forge: Forge,
  repo: Repo | undefined,
  body: Buffer,
  gitProtocolVersion: 2 | 0,
): GitResult {
  if (repo === undefined) return err(404, 'Not Found');
  try {
    if (gitProtocolVersion === 2) {
      const { command, args } = parseV2Request(body);
      if (command === 'ls-refs') {
        let peel = false;
        let symrefs = false;
        let unborn = false;
        const prefixes: string[] = [];
        for (const arg of args) {
          const line = arg.trim();
          if (line === 'peel') peel = true;
          else if (line === 'symrefs') symrefs = true;
          else if (line === 'unborn') unborn = true;
          else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
        }
        return ok('application/x-git-upload-pack-result', lsRefsResponse(forge, repo, { peel, symrefs, unborn, prefixes }));
      }
      if (command === 'fetch') {
        const wants: string[] = [];
        const haves: string[] = [];
        const shallow: string[] = [];
        let depth: number | undefined;
        let deepenRelative = false;
        let done = false;
        for (const arg of args) {
          const line = arg.trim();
          if (line.startsWith('want ')) wants.push(line.slice(5).trim());
          else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
          else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
          else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
          else if (line === 'deepen-relative') deepenRelative = true;
          else if (line === 'done') done = true;
        }
        const absolute = absoluteDepth(forge, repo, wants, shallow, depth, deepenRelative);
        const plan = planFetch(forge, repo, wants, haves, shallow, absolute);
        if (haves.length > 0 && !done) {
          // A negotiation round: answer the acks, and send the pack only when
          // a common have covers a want (ready). Otherwise the client
          // re-requests with `done`.
          const common = haves.filter((have) => {
            const object = repo.objects.get(have);
            return object !== undefined && object.type === 'commit';
          });
          let readyHave: string | undefined;
          for (const have of common) {
            for (const want of wants) {
              const wantCommit = forge.peelToCommit(repo, want);
              if (wantCommit !== null && forge.isAncestor(repo, have, wantCommit)) {
                readyHave = have;
                break;
              }
            }
            if (readyHave !== undefined) break;
          }
          if (readyHave !== undefined) {
            return ok('application/x-git-upload-pack-result', fetchV2Response(forge, repo, plan, [`ACK ${readyHave}`, 'ready'], true));
          }
          const ack = common.length > 0 ? [`ACK ${common[0] as string}`] : ['NAK'];
          return ok('application/x-git-upload-pack-result', fetchV2Response(forge, repo, plan, ack, false));
        }
        // No haves, or the client already sent `done`: straight to the pack.
        return ok('application/x-git-upload-pack-result', fetchV2Response(forge, repo, plan, null, true));
      }
      return err(400, `unknown upload-pack command ${JSON.stringify(command)}`);
    }
    // Protocol v0: wants (with shallow/deepen) in the first section, then
    // haves and done in the second, each section ended by a flush.
    const packets = decodePktLines(body);
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | undefined;
    let section = 0;
    for (const packet of packets) {
      if (packet.kind === 'flush') {
        section += 1;
        continue;
      }
      if (packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8').trim();
      if (section === 0) {
        if (line.startsWith('want ')) {
          // The first want may carry capabilities after a space (real git) or
          // a NUL; the oid is always the first token.
          const rest = line.slice(5);
          const token = rest.split(/[\s\0]/)[0] as string;
          wants.push(token.trim());
        } else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
      } else if (line.startsWith('have ')) {
        haves.push(line.slice(5).trim());
      }
    }
    if (wants.length === 0) return err(400, 'no want lines in upload-pack request');
    const plan = planFetch(forge, repo, wants, haves, shallow, depth);
    return ok('application/x-git-upload-pack-result', fetchV0Response(forge, repo, plan));
  } catch (error) {
    return err(400, error instanceof Error ? error.message : 'malformed upload-pack request');
  }
}

// -------------------------------------------------------------------------------------------
// receive-pack
// -------------------------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

export function handleReceivePack(forge: Forge, repo: Repo | undefined, body: Buffer): GitResult {
  if (repo === undefined) return err(404, 'Not Found');
  try {
    // Walk the command section pkt-line by pkt-line until its flush; the
    // bytes after it are the raw pack, not pkt-lines.
    const commands: PushCommand[] = [];
    let cursor = 0;
    let packStart = -1;
    for (;;) {
      if (cursor + 4 > body.length) throw new Error('missing flush after receive-pack commands');
      const raw = body.subarray(cursor, cursor + 4).toString('ascii');
      const length = parseInt(raw, 16);
      if (Number.isNaN(length) || length < 0 || length > 65520) throw new Error(`bad pkt-line length ${JSON.stringify(raw)}`);
      if (length === 0) {
        packStart = cursor + 4;
        break;
      }
      if (length < 4) throw new Error('bad pkt-line in receive-pack commands');
      const line = body.subarray(cursor + 4, cursor + length).toString('utf8').trim();
      const nul = line.indexOf('\0');
      const head = nul >= 0 ? line.slice(0, nul) : line;
      const parts = head.split(' ');
      if (parts.length < 3) throw new Error('bad receive-pack command line');
      const [oldOid, newOid, ref] = parts as [string, string, string];
      if (!isObjectId(oldOid) || !isObjectId(newOid)) throw new Error('bad object id in receive-pack command');
      commands.push({ oldOid, newOid, ref });
      cursor += length;
    }
    const packBytes = packStart < body.length ? body.subarray(packStart) : Buffer.alloc(0);
    // Unpack first: the objects land in the store whatever the ref verdicts.
    let unpackOk = true;
    let unpackDetail = 'ok';
    if (packBytes.length > 0) {
      try {
        if (!verifyPackChecksum(packBytes)) throw new Error('pack checksum mismatch');
        const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
        for (const [oid, object] of objects) {
          if (hashObject(object.type, object.data) !== oid) throw new Error(`pack object ${oid} fails its hash`);
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      } catch (error) {
        unpackOk = false;
        unpackDetail = error instanceof Error ? error.message : 'unpack error';
      }
    }
    // Apply each command in order; a refused ref does not move.
    const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? ZERO_OID;
      let verdict: { ok: true } | { ok: false; reason: string } | null = null;
      if (command.oldOid !== current) {
        verdict = { ok: false, reason: 'old value does not match the current ref' };
      } else if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === ZERO_OID) verdict = { ok: false, reason: 'ref does not exist' };
        else {
          repo.refs.delete(command.ref);
          verdict = { ok: true };
        }
      } else if (command.newOid === current) {
        verdict = { ok: true };
      } else if (current === ZERO_OID) {
        // Create: the object must be in the store now.
        if (!repo.objects.has(command.newOid)) verdict = { ok: false, reason: 'object not found' };
        else {
          repo.refs.set(command.ref, command.newOid);
          verdict = { ok: true };
        }
      } else {
        // Update: must fast-forward (the new tip descends from the old one).
        const object = repo.objects.get(command.newOid);
        if (object === undefined) {
          verdict = { ok: false, reason: 'object not found' };
        } else if (object.type !== 'commit' && object.type !== 'tag') {
          verdict = { ok: false, reason: 'new value is not a commit or tag' };
        } else {
          const newCommit = forge.peelToCommit(repo, command.newOid);
          const oldCommit = forge.peelToCommit(repo, current);
          if (newCommit === null || oldCommit === null) {
            verdict = { ok: false, reason: 'object not found' };
          } else if (!forge.isAncestor(repo, oldCommit, newCommit)) {
            verdict = { ok: false, reason: 'non-fast-forward' };
          } else {
            repo.refs.set(command.ref, command.newOid);
            verdict = { ok: true };
          }
        }
      }
      if (!unpackOk) verdict = { ok: false, reason: unpackDetail };
      if (verdict.ok) reportLines.push(`ok ${command.ref}\n`);
      else reportLines.push(`ng ${command.ref} ${verdict.reason}\n`);
    }
    // The report travels inside sideband band 1, itself pkt-line framed, and
    // ends with a flush pkt-line *inside* band 1 (git's receive_status reads
    // the report until that flush; the outer flush only ends the stream).
    const inner = Buffer.concat([encodePktLines(reportLines), pktFlush()]);
    const outer: Buffer[] = [];
    const CHUNK = 65500;
    for (let at = 0; at < inner.length; at += CHUNK) {
      outer.push(encodePktLine(Buffer.concat([Buffer.from([1]), inner.subarray(at, Math.min(inner.length, at + CHUNK))])));
    }
    outer.push(pktFlush());
    return ok('application/x-git-receive-pack-result', Buffer.concat(outer));
  } catch (error) {
    return err(400, error instanceof Error ? error.message : 'malformed receive-pack request');
  }
}
