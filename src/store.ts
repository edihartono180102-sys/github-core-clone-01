// The forge's store: repositories, git objects, issues, pull requests, labels.
// Everything lives in memory; one process, one trial, no outside service.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type TreeEntry,
} from './gitpack.ts';
import { scenarioUsers, type ScenarioUser } from './scenario.ts';

export interface Label {
  readonly id: number;
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly createdSeq: number;
  updatedSeq: number;
  readonly userLogin: string;
}

export interface PullRequest {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly head: string;
  readonly base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly createdSeq: number;
}

export interface IssueComment {
  readonly id: number;
  body: string;
  readonly createdSeq: number;
  readonly userLogin: string;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly createdSeq: number;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, Label>;
  readonly issues: Issue[];
  readonly pulls: PullRequest[];
  readonly comments: Map<number, IssueComment[]>;
  nextNumber: number;
}

export interface FileChange {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly oldOid: string | null;
  readonly newOid: string | null;
  readonly additions: number;
  readonly deletions: number;
}

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** Opaque, stable Relay-style global ids (never the plain number). */
export function globalId(kind: string, ...parts: (string | number)[]): string {
  return base64url(`${kind}:${parts.join(':')}`);
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const split = text.indexOf(':');
    if (split < 0) return null;
    return { kind: text.slice(0, split), parts: text.slice(split + 1).split(':') };
  } catch {
    return null;
  }
}

function countLines(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/** Line additions/deletions between two texts, by common prefix/suffix trim. */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    additions: newLines.length - prefix - suffix,
    deletions: oldLines.length - prefix - suffix,
  };
}

export class Forge {
  readonly viewer: ScenarioUser;
  readonly stranger: ScenarioUser;
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextEntityId = 100000;
  private nextCommentId = 200000;
  private nextLabelId = 300000;
  private seq = 0;
  private readonly baseMs: number;
  /** The public base URL of this forge, set per request from its Host header. */
  private baseUrl = 'http://localhost';

  /** The base URL used to build resource URLs (the REST root, without /api/v3). */
  apiBase(): string {
    return this.baseUrl;
  }

  /** The REST API root (the server root plus /api/v3). */
  apiRoot(): string {
    return `${this.baseUrl}/api/v3`;
  }

  setApiBase(url: string): void {
    this.baseUrl = url;
  }

  constructor() {
    const users = scenarioUsers();
    this.viewer = users[0] as ScenarioUser;
    this.stranger = users[2] as ScenarioUser;
    const now = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const parsed = Date.parse(now);
    this.baseMs = Number.isFinite(parsed) ? parsed : Date.parse('2025-01-01T00:00:00.000Z');
  }

  /** A deterministic timestamp: the trial's now plus one second per event. */
  nowIso(): string {
    const ms = this.baseMs + this.seq * 1000;
    this.seq += 1;
    return new Date(ms).toISOString();
  }

  /** The ISO timestamp for a recorded sequence number (stable across reads). */
  isoAt(seq: number): string {
    return new Date(this.baseMs + seq * 1000).toISOString();
  }

  /** The current logical second (for git commit timestamps). */
  nowEpochSec(): number {
    return Math.floor(this.baseMs / 1000) + this.seq;
  }

  /** The identity line for commits the forge writes itself. */
  identity(): string {
    return `${this.viewer.name} <${this.viewer.email}> ${this.nowEpochSec()} +0000`;
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  // -----------------------------------------------------------------------------------------
  // repositories
  // -----------------------------------------------------------------------------------------

  static repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, options: { private?: boolean; description?: string }): Repo | null {
    const key = Forge.repoKey(owner, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: 'main',
      createdSeq: this.nextSeq(),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      comments: new Map(),
      nextNumber: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(Forge.repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(Forge.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  // -----------------------------------------------------------------------------------------
  // git objects and refs
  // -----------------------------------------------------------------------------------------

  putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** Resolve a branch name, a full ref or a bare oid to a commit oid. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (repo.refs.has(ref)) return repo.refs.get(ref);
    const headed = `refs/heads/${ref}`;
    if (repo.refs.has(headed)) return repo.refs.get(headed);
    if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
    return undefined;
  }

  /** The commit graph: every commit reachable from `roots` (parents walked). */
  collectCommits(repo: Repo, roots: readonly string[]): Set<string> {
    const seen = new Set<string>();
    const queue = [...roots];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      seen.add(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return seen;
  }

  /** Every object reachable from `roots` (commits, trees, blobs, tags). */
  collectReachable(repo: Repo, roots: readonly string[]): Set<string> {
    const seen = new Set<string>();
    const queue = [...roots];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        for (const parent of commit.parents) queue.push(parent);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      }
    }
    return seen;
  }

  /** Commits reachable from `tip`, newest first (breadth-first over parents). */
  listCommits(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      seen.add(oid);
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return out;
  }

  /** The best common ancestor of two commits (lowest sum of depths). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const depthOf = (root: string): Map<string, number> => {
      const depths = new Map<string, number>();
      const queue: Array<[string, number]> = [[root, 0]];
      while (queue.length > 0) {
        const [oid, depth] = queue.shift() as [string, number];
        if (depths.has(oid)) continue;
        const object = repo.objects.get(oid);
        if (object === undefined || object.type !== 'commit') continue;
        depths.set(oid, depth);
        for (const parent of parseCommit(object.data).parents) queue.push([parent, depth + 1]);
      }
      return depths;
    };
    const da = depthOf(a);
    const db = depthOf(b);
    let best: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const [oid, depth] of da) {
      const other = db.get(oid);
      if (other === undefined) continue;
      const score = depth + other;
      if (score < bestScore) {
        bestScore = score;
        best = oid;
      }
    }
    return best;
  }

  /** Is `ancestor` an ancestor of (or equal to) `tip`? */
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    return this.collectCommits(repo, [tip]).has(ancestor);
  }

  /** Peel a tag (or any object) to its commit. */
  peelToCommit(repo: Repo, oid: string): string | null {
    let current = oid;
    for (let i = 0; i < 16; i += 1) {
      const object = repo.objects.get(current);
      if (object === undefined) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  /** Flatten a tree into path -> {oid, mode}. */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** The file changes between two trees (by flattened path). */
  diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): FileChange[] {
    const base = baseTreeOid === null ? new Map() : this.flattenTree(repo, baseTreeOid);
    const head = headTreeOid === null ? new Map() : this.flattenTree(repo, headTreeOid);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: FileChange[] = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b !== undefined && h === undefined) {
        const oldText = this.blobText(repo, b.oid);
        out.push({ path, status: 'removed', oldOid: b.oid, newOid: null, additions: 0, deletions: countLines(oldText) });
      } else if (b === undefined && h !== undefined) {
        const newText = this.blobText(repo, h.oid);
        out.push({ path, status: 'added', oldOid: null, newOid: h.oid, additions: countLines(newText), deletions: 0 });
      } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
        const diff = lineDiff(this.blobText(repo, b.oid), this.blobText(repo, h.oid));
        out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid, additions: diff.additions, deletions: diff.deletions });
      }
    }
    return out;
  }

  blobText(repo: Repo, oid: string): string {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'blob') return '';
    return object.data.toString('utf8');
  }

  /**
   * Build a new tree from `baseTreeOid` with `changes` applied (path -> new blob
   * bytes, or null to delete). Intermediate trees are stored in the repo.
   */
  applyToTree(repo: Repo, baseTreeOid: string | null, changes: ReadonlyMap<string, Buffer | null>): string {
    // Work on a flattened map, then rebuild the tree hierarchy bottom-up.
    const flat = baseTreeOid === null ? new Map<string, { oid: string; mode: string }>() : this.flattenTree(repo, baseTreeOid);
    for (const [path, content] of changes) {
      if (content === null) flat.delete(path);
      else flat.set(path, { oid: this.putObject(repo, 'blob', content), mode: '100644' });
    }
    // Group paths by directory and build trees recursively.
    const buildDir = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const subdirs = new Map<string, string[]>();
      for (const [path, entry] of flat) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          entries.push({ mode: entry.mode, name: rest, oid: entry.oid });
        } else {
          const dir = rest.slice(0, slash);
          const list = subdirs.get(dir) ?? [];
          list.push(path);
          subdirs.set(dir, list);
        }
      }
      for (const [dir, paths] of [...subdirs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        void paths;
        const childPrefix = `${prefix}${dir}/`;
        const childOid = buildDir(childPrefix);
        entries.push({ mode: '40000', name: dir, oid: childOid });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return buildDir('');
  }

  /** Create a commit object and store it; answer its oid. */
  createCommit(
    repo: Repo,
    treeOid: string,
    parents: readonly string[],
    message: string,
  ): string {
    const text = message.endsWith('\n') ? message : `${message}\n`;
    const identity = this.identity();
    const data = buildCommit({ tree: treeOid, parents, author: identity, committer: identity, message: text });
    return this.putObject(repo, 'commit', data);
  }

  /** The tree oid of a commit, or null. */
  commitTree(repo: Repo, commitOid: string): string | null {
    const object = repo.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  // -----------------------------------------------------------------------------------------
  // contents
  // -----------------------------------------------------------------------------------------

  /**
   * Write one file on `branch` (creating the branch from the default tip when it
   * does not exist yet, and the default branch itself when the repo is unborn).
   * Returns the new commit and blob shas.
   */
  commitFile(
    repo: Repo,
    options: { path: string; content: Buffer; message: string; branch?: string },
  ): { commitSha: string; contentSha: string; created: boolean } {
    const branch = options.branch ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    const baseTree = tip === undefined ? null : this.commitTree(repo, tip);
    const before = baseTree === null ? undefined : this.flattenTree(repo, baseTree).get(options.path);
    const treeOid = this.applyToTree(repo, baseTree, new Map([[options.path, options.content]]));
    const parents = tip === undefined ? [] : [tip];
    const commitSha = this.createCommit(repo, treeOid, parents, options.message);
    repo.refs.set(ref, commitSha);
    const contentSha = this.putObject(repo, 'blob', options.content);
    return { commitSha, contentSha, created: before === undefined };
  }

  /** Delete one file on the default branch (or `branch`); null when the file is absent. */
  deleteFile(
    repo: Repo,
    options: { path: string; message: string; branch?: string },
  ): { commitSha: string } | null {
    const branch = options.branch ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined) return null;
    const baseTree = this.commitTree(repo, tip);
    if (baseTree === null) return null;
    if (!this.flattenTree(repo, baseTree).has(options.path)) return null;
    const treeOid = this.applyToTree(repo, baseTree, new Map([[options.path, null]]));
    const commitSha = this.createCommit(repo, treeOid, [tip], options.message);
    repo.refs.set(ref, commitSha);
    return { commitSha };
  }

  // -----------------------------------------------------------------------------------------
  // issues, labels, comments
  // -----------------------------------------------------------------------------------------

  createLabel(repo: Repo, name: string, color: string, description: string): Label {
    const existing = repo.labels.get(name);
    if (existing !== undefined) return existing;
    const label: Label = { id: this.nextLabelId, name, color, description };
    this.nextLabelId += 1;
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labels: readonly string[]): Issue | { unknownLabel: string } {
    for (const name of labels) {
      if (!repo.labels.has(name)) return { unknownLabel: name };
    }
    const issue: Issue = {
      id: this.nextEntityId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdSeq: this.nextSeq(),
      updatedSeq: this.seq,
      userLogin: this.viewer.login,
    };
    this.nextEntityId += 1;
    repo.nextNumber += 1;
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  createComment(repo: Repo, issueNumber: number, body: string): IssueComment | null {
    const issue = this.getIssue(repo, issueNumber);
    if (issue === undefined) return null;
    const comment: IssueComment = { id: this.nextCommentId, body, createdSeq: this.nextSeq(), userLogin: this.viewer.login };
    this.nextCommentId += 1;
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }

  // -----------------------------------------------------------------------------------------
  // pull requests
  // -----------------------------------------------------------------------------------------

  createPull(
    repo: Repo,
    title: string,
    body: string,
    head: string,
    base: string,
  ): PullRequest | { error: string } {
    const headTip = this.resolveRef(repo, head);
    const baseTip = this.resolveRef(repo, base);
    if (headTip === undefined) return { error: `head branch ${head} does not exist` };
    if (baseTip === undefined) return { error: `base branch ${base} does not exist` };
    for (const pull of repo.pulls) {
      if (pull.head === head && pull.state === 'open') return { error: `a pull request from ${head} is already open` };
    }
    const pull: PullRequest = {
      id: this.nextEntityId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      head,
      base,
      headSha: headTip,
      baseSha: baseTip,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: this.nextSeq(),
    };
    this.nextEntityId += 1;
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  /** Whether a pull request merges cleanly (MERGEABLE) or conflicts (CONFLICTING). */
  pullMergeable(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const headTip = this.resolveRef(repo, pull.head);
    const baseTip = this.resolveRef(repo, pull.base);
    if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
    return this.mergeConflict(repo, headTip, baseTip) ? 'CONFLICTING' : 'MERGEABLE';
  }

  /**
   * True when the head's changes (since the merge base) collide with the base
   * tip's changes on the same path with different bytes.
   */
  mergeConflict(repo: Repo, headTip: string, baseTip: string): boolean {
    const base = this.mergeBase(repo, headTip, baseTip);
    const baseTree = base === null ? null : this.commitTree(repo, base);
    const headTree = this.commitTree(repo, headTip);
    const tipTree = this.commitTree(repo, baseTip);
    if (headTree === null || tipTree === null) return true;
    const headChanges = this.diffTrees(repo, baseTree, headTree);
    const tipChanges = this.diffTrees(repo, baseTree, tipTree);
    const tipByPath = new Map(tipChanges.map((change) => [change.path, change]));
    for (const change of headChanges) {
      const other = tipByPath.get(change.path);
      if (other === undefined) continue;
      if (change.newOid !== other.newOid) return true;
    }
    return false;
  }

  /**
   * Squash-merge an open pull request onto its base branch. Returns the merge
   * commit sha, or null when the pull is conflicted or not open.
   */
  mergePull(repo: Repo, pull: PullRequest): string | null {
    if (pull.state !== 'open') return null;
    const headTip = this.resolveRef(repo, pull.head);
    const baseTip = this.resolveRef(repo, pull.base);
    if (headTip === undefined || baseTip === undefined) return null;
    if (this.mergeConflict(repo, headTip, baseTip)) return null;
    const base = this.mergeBase(repo, headTip, baseTip);
    const baseTree = base === null ? null : this.commitTree(repo, base);
    const headTree = this.commitTree(repo, headTip);
    const tipTree = this.commitTree(repo, baseTip);
    if (headTree === null || tipTree === null) return null;
    // Apply the head's changes (since the merge base) onto the base tip's tree.
    const changes = new Map<string, Buffer | null>();
    for (const change of this.diffTrees(repo, baseTree, headTree)) {
      if (change.newOid === null) changes.set(change.path, null);
      else {
        const object = repo.objects.get(change.newOid);
        changes.set(change.path, object?.data ?? Buffer.alloc(0));
      }
    }
    const mergedTree = this.applyToTree(repo, tipTree, changes);
    const message = `Merge pull request #${pull.number} from ${pull.head}`;
    const mergeSha = this.createCommit(repo, mergedTree, [baseTip], message);
    repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.nowIso();
    pull.mergeCommitSha = mergeSha;
    pull.baseSha = mergeSha;
    return mergeSha;
  }

  /** The files a pull request changes (merge base -> head). */
  pullFiles(repo: Repo, pull: PullRequest): FileChange[] {
    const headTip = this.resolveRef(repo, pull.head);
    const baseTip = this.resolveRef(repo, pull.base);
    if (headTip === undefined || baseTip === undefined) return [];
    const base = this.mergeBase(repo, headTip, baseTip);
    const baseTree = base === null ? null : this.commitTree(repo, base);
    const headTree = this.commitTree(repo, headTip);
    if (headTree === null) return [];
    return this.diffTrees(repo, baseTree, headTree);
  }

  /** The empty-tree oid (used when a repository has no commits yet). */
  emptyTreeOid(repo: Repo): string {
    return this.putObject(repo, 'tree', buildTree([]));
  }

  static emptyTree(): Buffer {
    return buildTree([]);
  }
}
