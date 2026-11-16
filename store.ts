// The forge's store: one in-memory database for all four surfaces. A trial
// runs in a fresh pod and the suite is the only client, so memory is the
// store — no disk, no fsync, nothing to reconcile on restart. Every mutation
// is synchronous and deterministic: identifiers come from counters, dates
// from the trial clock, object ids from content hashes.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  globalId,
  hashObject,
  lineDiffCounts,
  parseCommit,
  parseTag,
  parseTree,
  trialNowEpoch,
  trialNowIso,
  viewerLogin,
  type GitType,
  type PackObject,
  type TreeEntry,
} from './util.ts';

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Array<{ id: number; body: string; createdAt: string }>;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  createdSeq: number;
  createdAt: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  objects: Map<string, PackObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, { name: string; color: string }>;
  /** One counter for issues and pull requests together, like GitHub. */
  nextNumber: number;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextObjectId = 1;
  private nextCommentId = 1;
  private seq = 0;

  key(owner: string, name: string): string {
    return `${owner}\0${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdAt: trialNowIso(),
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    return out;
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  nextComment(): number {
    const id = this.nextObjectId++;
    this.nextCommentId = id;
    return id;
  }

  viewer(): string {
    return viewerLogin();
  }

  // ------------------------------------------------------------ git objects

  putObject(repo: Repo, type: GitType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  object(repo: Repo, oid: string): PackObject | undefined {
    return repo.objects.get(oid);
  }

  /** All object ids reachable from `tips` (commits, their trees, blobs, tags). */
  reachable(repo: Repo, tips: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const stack = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ZERO_OID || seen.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      seen.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        stack.push(c.tree);
        for (const p of c.parents) stack.push(p);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.oid);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
    return seen;
  }

  /** True when `ancestor` is reachable from `tip` by following parents. */
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ZERO_OID || seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) {
        if (p === ancestor) return true;
        stack.push(p);
      }
    }
    return false;
  }

  /** First common ancestor of two commits (nearest to `a`). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const fromA = new Set<string>();
    const stack = [a];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ZERO_OID || fromA.has(oid)) continue;
      fromA.add(oid);
      const obj = repo.objects.get(oid);
      if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
    const seen = new Set<string>();
    const queue = [b];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (oid === ZERO_OID || seen.has(oid)) continue;
      seen.add(oid);
      if (fromA.has(oid)) return oid;
      const obj = repo.objects.get(oid);
      if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) queue.push(p);
    }
    return null;
  }

  /** Commits reachable from `tip`, newest-first by traversal order. */
  commitList(repo: Repo, tip: string): Array<{ sha: string; message: string }> {
    const out: Array<{ sha: string; message: string }> = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ZERO_OID || seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const c = parseCommit(obj.data);
      out.push({ sha: oid, message: c.message });
      for (const p of c.parents) stack.push(p);
    }
    return out;
  }

  /** Flatten a tree into path -> {oid, mode}. */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, base: string): void => {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'tree') return;
      for (const e of parseTree(obj.data)) {
        const path = base === '' ? e.name : `${base}/${e.name}`;
        if (e.mode === '40000') walk(e.oid, path);
        else out.set(path, { oid: e.oid, mode: e.mode });
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** Build a tree object from a flat path map, creating intermediate trees. */
  treeFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of files) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const dir = parts[i] as string;
        if (!node.dirs.has(dir)) node.dirs.set(dir, make());
        node = node.dirs.get(dir) as Node;
      }
      node.files.set(parts[parts.length - 1] as string, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** The tree oid at `path` inside `treeOid`, or null when it is not a tree. */
  treeAtPath(repo: Repo, treeOid: string, path: string): string | null {
    if (path === '' || path === '/') return treeOid;
    const parts = path.split('/').filter((p) => p !== '');
    let cur = treeOid;
    for (const part of parts) {
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'tree') return null;
      const entry = parseTree(obj.data).find((e) => e.name === part);
      if (!entry || entry.mode !== '40000') return null;
      cur = entry.oid;
    }
    return cur;
  }

  /** Make a commit on `branch` that sets `path` to `content` (or removes it
   *  when content is null). Returns the new commit oid. */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
  ): string {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const files = new Map<string, { oid: string; mode: string }>();
    if (tip !== undefined && tip !== ZERO_OID) {
      const obj = repo.objects.get(tip);
      if (obj?.type === 'commit') {
        const flat = this.flattenTree(repo, parseCommit(obj.data).tree);
        for (const [p, e] of flat) files.set(p, e);
      }
    }
    if (content === null) files.delete(path);
    else files.set(path, { oid: this.putObject(repo, 'blob', content), mode: '100644' });
    const tree = this.treeFromFiles(repo, files);
    const who = `${viewerLogin()} <${viewerLogin()}@example.invalid> ${trialNowEpoch()} +0000`;
    const parents = tip !== undefined && tip !== ZERO_OID ? [tip] : [];
    const commit = this.putObject(
      repo,
      'commit',
      buildCommit({
        tree,
        parents,
        author: who,
        committer: who,
        message: message.endsWith('\n') ? message : `${message}\n`,
      }),
    );
    repo.refs.set(ref, commit);
    return commit;
  }

  /** Diff two trees: changed files with line counts. */
  diffTrees(
    repo: Repo,
    baseTree: string,
    headTree: string,
  ): Array<{ path: string; status: 'added' | 'removed' | 'modified'; oldOid: string | null; newOid: string | null; additions: number; deletions: number }> {
    const base = this.flattenTree(repo, baseTree);
    const head = this.flattenTree(repo, headTree);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: Array<{ path: string; status: 'added' | 'removed' | 'modified'; oldOid: string | null; newOid: string | null; additions: number; deletions: number }> = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) {
        const oldText = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
        const [add, del] = lineDiffCounts(oldText, '');
        out.push({ path, status: 'removed', oldOid: b.oid, newOid: null, additions: add, deletions: del });
      } else if (!b && h) {
        const newText = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
        const [add, del] = lineDiffCounts('', newText);
        out.push({ path, status: 'added', oldOid: null, newOid: h.oid, additions: add, deletions: del });
      } else if (b && h && b.oid !== h.oid) {
        const oldText = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
        const newText = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
        const [add, del] = lineDiffCounts(oldText, newText);
        out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid, additions: add, deletions: del });
      }
    }
    return out;
  }

  /** Would merging this pull request conflict? A file changed on the head
   *  since the merge base AND changed differently on the base since the
   *  merge base is a conflict. */
  pullConflicted(repo: Repo, pull: Pull): boolean {
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    if (!headTip || !baseTip) return false;
    const base = this.mergeBase(repo, headTip, baseTip);
    if (base === null) return false;
    const baseCommit = repo.objects.get(base);
    const headCommit = repo.objects.get(headTip);
    const baseNowCommit = repo.objects.get(baseTip);
    if (!baseCommit || !headCommit || !baseNowCommit) return false;
    const mergeTree = this.flattenTree(repo, parseCommit(baseCommit.data).tree);
    const headTree = this.flattenTree(repo, parseCommit(headCommit.data).tree);
    const baseTree = this.flattenTree(repo, parseCommit(baseNowCommit.data).tree);
    for (const [path, headEntry] of headTree) {
      const atMerge = mergeTree.get(path);
      const atBase = baseTree.get(path);
      if (!atMerge) continue; // file added on head: no conflict with base
      if (headEntry.oid === atMerge.oid) continue; // unchanged on head
      if (!atBase) return true; // deleted on base, changed on head
      if (atBase.oid !== atMerge.oid && atBase.oid !== headEntry.oid) return true;
    }
    // Files deleted on head but changed on base.
    for (const [path, mergeEntry] of mergeTree) {
      if (headTree.has(path)) continue;
      const atBase = baseTree.get(path);
      if (atBase && atBase.oid !== mergeEntry.oid) return true;
    }
    return false;
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge
   *  commit oid, or null when the pull is conflicted. */
  mergePull(repo: Repo, pull: Pull, method: string): string | null {
    if (this.pullConflicted(repo, pull)) return null;
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    if (!headTip || !baseTip) return null;
    const base = this.mergeBase(repo, headTip, baseTip);
    const headCommit = repo.objects.get(headTip);
    const baseNowCommit = repo.objects.get(baseTip);
    if (!headCommit || !baseNowCommit) return null;
    const mergedFiles = this.flattenTree(repo, parseCommit(baseNowCommit.data).tree);
    if (base !== null) {
      const baseCommit = repo.objects.get(base);
      if (baseCommit) {
        const mergeTree = this.flattenTree(repo, parseCommit(baseCommit.data).tree);
        const headTree = this.flattenTree(repo, parseCommit(headCommit.data).tree);
        for (const [path, entry] of headTree) {
          const atMerge = mergeTree.get(path);
          if (!atMerge || atMerge.oid !== entry.oid) mergedFiles.set(path, entry);
        }
        for (const path of mergeTree.keys()) {
          if (!headTree.has(path)) mergedFiles.delete(path);
        }
      }
    }
    const tree = this.treeFromFiles(repo, mergedFiles);
    const who = `${viewerLogin()} <${viewerLogin()}@example.invalid> ${trialNowEpoch()} +0000`;
    const parents = method === 'MERGE' ? [baseTip, headTip] : [baseTip];
    const message = method === 'MERGE'
      ? `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}\n`
      : `${pull.title} (#${pull.number})\n`;
    const commit = this.putObject(
      repo,
      'commit',
      buildCommit({ tree, parents, author: who, committer: who, message }),
    );
    repo.refs.set(`refs/heads/${pull.base}`, commit);
    return commit;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const number = repo.nextNumber++;
    const now = trialNowIso();
    const issue: Issue = {
      id: this.nextObjectId++,
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdSeq: this.nextSeq(),
      createdAt: now,
      updatedAt: now,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull | null {
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) return null;
    const number = repo.nextNumber++;
    const pull: Pull = {
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head,
      base,
      headSha,
      baseSha,
      createdSeq: this.nextSeq(),
      createdAt: trialNowIso(),
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  repoGlobalId(repo: Repo): string {
    return globalId('Repository', `${repo.owner}/${repo.name}`);
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`);
  }

  pullGlobalId(repo: Repo, pull: Pull): string {
    return globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`);
  }
}
