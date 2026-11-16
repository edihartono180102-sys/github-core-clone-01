// Git smart HTTP: protocol v2 upload-pack (ls-refs, fetch), v0 upload-pack
// as a fallback, and v0 receive-pack (push). All object work goes through
// the store; packs are plain (no deltas) with a valid trailer checksum.

import {
  ZERO_OID,
  buildTree,
  decodeAllPktLines,
  decodePktLines,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  pktLine,
  pktLines,
  readPack,
  writePack,
  type PackObject,
} from './util.ts';
import type { Repo, Store } from './store.ts';

const AGENT = 'github-core-clone-01/1.0.0';

function sidebandPack(pack: Buffer): Buffer {
  // One sideband packet per 32768 payload bytes, band 1.
  const parts: Buffer[] = [];
  for (let at = 0; at < pack.length; at += 32768) {
    const chunk = pack.subarray(at, Math.min(pack.length, at + 32768));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pktLine(payload));
  }
  if (parts.length === 0) parts.push(pktLine(Buffer.from([1])));
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

function refLines(repo: Repo, peel: boolean): RefLine[] {
  const out: RefLine[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  out.push({ oid: repo.refs.get(headTarget) ?? ZERO_OID, name: 'HEAD', symrefTarget: headTarget });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const line: RefLine = { oid, name };
    if (peel) {
      const obj = repo.objects.get(oid);
      if (obj?.type === 'tag') {
        const target = parseTag(obj.data).object;
        const targetObj = repo.objects.get(target);
        if (targetObj?.type === 'commit') line.peeled = target;
      }
    }
    out.push(line);
  }
  return out;
}

function v0Advertisement(repo: Repo, service: string): Buffer {
  const caps = service === 'git-upload-pack'
    ? `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k thin-pack ofs-delta shallow multi_ack agent=${AGENT}`
    : `symref=HEAD:refs/heads/${repo.defaultBranch} report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = refLines(repo, true);
  if (refs.length === 1) {
    // Empty repository: the capabilities^{} pseudo-ref carries the caps.
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    let first = true;
    for (const ref of refs) {
      if (ref.name === 'HEAD') {
        lines.push(`${ref.oid} HEAD\0${caps}\n`);
        first = false;
        continue;
      }
      void first;
      lines.push(`${ref.oid} ${ref.name}\n`);
      if (ref.peeled) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  return pktLines(lines);
}

function v2Advertisement(service: string): Buffer {
  const lines: Array<string | 'flush'> = [
    `# service=${service}\n`,
    'flush',
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow thin-pack ofs-delta filter\n',
    'object-format=sha1\n',
    'flush',
  ];
  return pktLines(lines);
}

export function gitContentType(service: string, kind: 'advertisement' | 'result'): string {
  return `application/x-${service}-${kind}`;
}

/** GET /{owner}/{repo}.git/info/refs?service=... — returns null when the
 *  repository does not exist (the caller answers 404). */
export function infoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string,
  wantV2: boolean,
): { status: number; contentType: string; body: Buffer } {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return { status: 404, contentType: 'text/plain', body: Buffer.from('repository not found\n') };
  if (service === 'git-upload-pack' && wantV2) {
    return { status: 200, contentType: gitContentType(service, 'advertisement'), body: v2Advertisement(service) };
  }
  return { status: 200, contentType: gitContentType(service, 'advertisement'), body: v0Advertisement(repo, service) };
}

// ------------------------------------------------------------ fetch planning

interface FetchPlan {
  /** Objects to send, in pack order (commits first is not required). */
  objects: PackObject[];
  /** New shallow boundary commits (depth-limited tips). */
  shallow: string[];
  /** Old shallow boundaries that are no longer shallow. */
  unshallow: string[];
  /** Have-commits the server acknowledges. */
  acks: string[];
}

function planFetch(
  store: Store,
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowIn: string[],
  depth: number | undefined,
): FetchPlan {
  const haveSet = new Set(haves);
  const shallowSet = new Set(shallowIn);
  // A want (or have) may be an annotated tag: the tag object itself must be
  // sent, and the walk follows the tag to its target commit.
  const tagWants = new Set<string>();
  const walkRoots: string[] = [];
  for (const w of wants) {
    const obj = repo.objects.get(w);
    if (obj?.type === 'tag') {
      tagWants.add(w);
      walkRoots.push(parseTag(obj.data).object);
    } else {
      walkRoots.push(w);
    }
  }
  // Objects the client already holds: everything reachable from a have,
  // except that a shallow boundary's parents are NOT held.
  const held = new Set<string>();
  {
    const stack: string[] = [];
    for (const h of haves) {
      const obj = repo.objects.get(h);
      if (obj?.type === 'tag') {
        held.add(h);
        stack.push(parseTag(obj.data).object);
      } else {
        stack.push(h);
      }
    }
    const seenCommits = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ZERO_OID || seenCommits.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      seenCommits.add(oid);
      held.add(oid);
      const treeStack = [parseCommit(obj.data).tree];
      while (treeStack.length > 0) {
        const treeOid = treeStack.pop() as string;
        if (held.has(treeOid)) continue;
        held.add(treeOid);
        const treeObj = repo.objects.get(treeOid);
        if (!treeObj || treeObj.type !== 'tree') continue;
        for (const e of parseTree(treeObj.data)) {
          if (e.mode === '40000') treeStack.push(e.oid);
          else held.add(e.oid);
        }
      }
      if (shallowSet.has(oid)) continue;
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
  }
  // Commits the fetch must cover: from the wants, within `depth` when given.
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const w of walkRoots) {
    if (!dist.has(w)) {
      dist.set(w, 0);
      queue.push(w);
    }
  }
  const covered = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    const d = dist.get(oid) as number;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    covered.add(oid);
    if (depth !== undefined && d + 1 >= depth) continue;
    for (const p of parseCommit(obj.data).parents) {
      if (!dist.has(p)) {
        dist.set(p, d + 1);
        queue.push(p);
      }
    }
  }
  // Send the covered commits' trees and blobs, minus anything already held.
  const sendSet = new Set<string>();
  const objects: PackObject[] = [];
  const addObject = (oid: string): void => {
    if (sendSet.has(oid) || held.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (!obj) return;
    sendSet.add(oid);
    objects.push(obj);
  };
  for (const tagOid of tagWants) addObject(tagOid);
  for (const oid of covered) {
    if (held.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    addObject(oid);
    const stack = [parseCommit(obj.data).tree];
    while (stack.length > 0) {
      const treeOid = stack.pop() as string;
      addObject(treeOid);
      const treeObj = repo.objects.get(treeOid);
      if (!treeObj || treeObj.type !== 'tree') continue;
      for (const e of parseTree(treeObj.data)) {
        if (e.mode === '40000') stack.push(e.oid);
        else addObject(e.oid);
      }
    }
  }
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== undefined) {
    for (const oid of covered) {
      if (held.has(oid)) continue;
      const d = dist.get(oid) as number;
      const obj = repo.objects.get(oid);
      if (d === depth - 1 && obj?.type === 'commit' && parseCommit(obj.data).parents.length > 0) {
        shallow.push(oid);
      }
    }
    for (const boundary of shallowIn) {
      const obj = repo.objects.get(boundary);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      const parentSent = parents.some((p) => sendSet.has(p));
      if (parentSent || sendSet.has(boundary)) unshallow.push(boundary);
    }
  }
  const acks = haves.filter((h) => repo.objects.has(h));
  return { objects, shallow, unshallow, acks };
}

function wantedRefLines(repo: Repo, wants: string[]): string[] {
  const out: string[] = [];
  for (const [name, oid] of repo.refs) {
    if (wants.includes(oid)) out.push(`${oid} ${name}\n`);
  }
  return out;
}

// ------------------------------------------------------------ upload-pack

function parseV2Request(body: Buffer): {
  command: string;
  args: string[];
  prefixes: string[];
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
} {
  const out = {
    command: '',
    args: [] as string[],
    prefixes: [] as string[],
    peel: false,
    symrefs: false,
    unborn: false,
    wants: [] as string[],
    haves: [] as string[],
    shallow: [] as string[],
    depth: undefined as number | undefined,
  };
  const packets = decodeAllPktLines(body);
  for (const packet of packets) {
    const line = packet.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('command=')) {
      out.command = line.slice('command='.length);
      continue;
    }
    if (line === '') continue;
    out.args.push(line);
    if (line === 'peel') out.peel = true;
    else if (line === 'symrefs') out.symrefs = true;
    else if (line === 'unborn') out.unborn = true;
    else if (line.startsWith('ref-prefix ')) out.prefixes.push(line.slice('ref-prefix '.length));
    else if (line.startsWith('want ')) out.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) out.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) out.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) out.depth = Number.parseInt(line.slice(7).trim(), 10);
  }
  // (The ls-refs flags live before the delim in the real wire order; the
  // decoder above drops delim packets, so every line is seen in order.)
  return out;
}

export function uploadPackV2(
  store: Store,
  repo: Repo,
  body: Buffer,
): { status: number; contentType: string; body: Buffer } {
  let req;
  try {
    req = parseV2Request(body);
  } catch {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('bad request\n') };
  }
  if (req.command === 'ls-refs') {
    const refs = refLines(repo, req.peel);
    const out: Array<string | 'flush'> = [];
    const keep = (name: string): boolean =>
      req.prefixes.length === 0 || req.prefixes.some((p) => name.startsWith(p));
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      if (ref.name === 'HEAD') {
        const oid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (oid) {
          out.push(`${oid} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
        } else {
          out.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
        }
        continue;
      }
      let line = `${ref.oid} ${ref.name}`;
      if (req.symrefs && ref.name === 'HEAD') line += ' symref-target:refs/heads/main';
      if (ref.peeled) line += ` peeled:${ref.peeled}`;
      out.push(`${line}\n`);
    }
    out.push('flush');
    return { status: 200, contentType: gitContentType('git-upload-pack', 'result'), body: pktLines(out) };
  }
  if (req.command !== 'fetch') {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('unknown command\n') };
  }
  const plan = planFetch(store, repo, req.wants, req.haves, req.shallow, req.depth);
  const pack = writePack(plan.objects);
  const parts: Array<string | Buffer | 'delim' | 'flush'> = [];
  parts.push('acknowledgments\n');
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(`ACK ${ack}\n`);
    parts.push('ready\n');
  } else {
    parts.push('NAK\n');
  }
  parts.push('delim');
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push('shallow-info\n');
    for (const s of plan.shallow) parts.push(`shallow ${s}\n`);
    for (const s of plan.unshallow) parts.push(`unshallow ${s}\n`);
    parts.push('delim');
  }
  const wanted = wantedRefLines(repo, req.wants);
  if (wanted.length > 0) {
    parts.push('wanted-refs\n');
    for (const w of wanted) parts.push(w);
    parts.push('delim');
  }
  parts.push('packfile\n');
  // Packfile section: sideband packets, then a flush that ends the response.
  const head = pktLines(parts);
  const tail = sidebandPack(pack);
  return { status: 200, contentType: gitContentType('git-upload-pack', 'result'), body: Buffer.concat([head, tail]) };
}

export function uploadPackV0(
  store: Store,
  repo: Repo,
  body: Buffer,
): { status: number; contentType: string; body: Buffer } {
  // v0 fetch has two sections separated by a flush: wants, then haves.
  const first = decodePktLines(body);
  const second = decodePktLines(first.rest);
  const lines = [...first.lines, 'flush' as const, ...second.lines];
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowIn: string[] = [];
  let depth: number | undefined;
  let inSecondSection = false;
  for (const item of lines) {
    if (item === 'flush') {
      inSecondSection = true;
      continue;
    }
    if (typeof item !== 'object') continue;
    const line = item.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('shallow ')) shallowIn.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line === 'done') void inSecondSection;
  }
  const plan = planFetch(store, repo, wants, haves, shallowIn, depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  const head = Buffer.concat(parts);
  return { status: 200, contentType: gitContentType('git-upload-pack', 'result'), body: Buffer.concat([head, sidebandPack(pack)]) };
}

// ------------------------------------------------------------ receive-pack

export function receivePack(
  store: Store,
  repo: Repo,
  body: Buffer,
): { status: number; contentType: string; body: Buffer } {
  const { lines, rest } = decodePktLines(body);
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  for (const item of lines) {
    if (typeof item !== 'object') continue;
    let line = item.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
  }
  const report: Array<{ ref: string; ok: boolean; reason: string }> = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  try {
    if (commands.some((c) => c.newOid !== ZERO_OID)) {
      if (rest.length === 0) throw new Error('missing packfile');
      const objects = readPack(rest, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    }
  } catch (err) {
    unpackOk = false;
    unpackDetail = err instanceof Error ? err.message : 'unpack failed';
  }
  if (unpackOk) {
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined || current !== cmd.oldOid) {
          if (current === undefined) report.push({ ref: cmd.ref, ok: false, reason: 'ref does not exist' });
          else report.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          repo.refs.delete(cmd.ref);
          report.push({ ref: cmd.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (!repo.objects.has(cmd.newOid)) {
        report.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (current === undefined) {
        if (cmd.oldOid !== ZERO_OID) {
          report.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
        repo.refs.set(cmd.ref, cmd.newOid);
        report.push({ ref: cmd.ref, ok: true, reason: '' });
        continue;
      }
      if (cmd.oldOid !== current) {
        report.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      const newObj = repo.objects.get(cmd.newOid);
      if (!newObj || newObj.type !== 'commit') {
        // Updating a ref to a non-commit (e.g. a tag object) is allowed.
        repo.refs.set(cmd.ref, cmd.newOid);
        report.push({ ref: cmd.ref, ok: true, reason: '' });
        continue;
      }
      if (!store.isAncestor(repo, current, cmd.newOid)) {
        report.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      report.push({ ref: cmd.ref, ok: true, reason: '' });
    }
  } else {
    for (const cmd of commands) report.push({ ref: cmd.ref, ok: false, reason: unpackDetail });
  }
  const text: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}`];
  for (const r of report) {
    text.push(r.ok ? `ok ${r.ref}` : `ng ${r.ref} ${r.reason}`);
  }
  const inner = pktLines(text.map((t) => `${t}\n`));
  const banded = pktLine(Buffer.concat([Buffer.from([1]), inner]));
  const bodyOut = Buffer.concat([banded, Buffer.from('0000', 'ascii')]);
  return { status: 200, contentType: gitContentType('git-receive-pack', 'result'), body: bodyOut };
}

/** A repo's refs for the ls-refs / advertisement paths, used by tests. */
export function listRefs(repo: Repo): Array<{ oid: string; name: string }> {
  return refLines(repo, false)
    .filter((r) => r.name !== 'HEAD')
    .map((r) => ({ oid: r.oid, name: r.name }));
}

export function buildTreeExport(): typeof buildTree {
  return buildTree;
}
export { hashObject };
