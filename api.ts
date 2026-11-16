// The three JSON surfaces over the same store: REST v3, GraphQL, and MCP.
// Every handler is synchronous and deterministic; identifiers come from the
// store's counters and dates from the trial clock.

import { parseGlobalId, trialNowIso, viewerLogin, globalId } from './util.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';

export interface RequestContext {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Map<string, string>;
  body: Buffer;
  token: string | undefined;
}

export interface Response {
  status: number;
  headers?: Record<string, string>;
  body: string | Buffer;
}

let requestCounter = 0;

function json(status: number, value: unknown, extra?: Record<string, string>): Response {
  requestCounter += 1;
  return {
    status,
    headers: {
      'content-type': 'application/json',
      'x-github-request-id': `req-${requestCounter}`,
      ...extra,
    },
    body: JSON.stringify(value),
  };
}

function err(status: number, message: string): Response {
  return json(status, { message });
}

function bearer(ctx: RequestContext): string | undefined {
  const h = ctx.headers.get('authorization');
  if (!h) return undefined;
  const m = /^Bearer\s+(.+)$/.exec(h.trim());
  return m ? (m[1] as string) : undefined;
}

function authed(ctx: RequestContext): boolean {
  const token = bearer(ctx);
  return token !== undefined && ctx.token !== undefined && token === ctx.token;
}

function parseJsonBody(ctx: RequestContext): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (ctx.body.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(ctx.body.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

// ------------------------------------------------------------ shapes

function userObject(id: number, login: string): Record<string, unknown> {
  return { id, login, name: `${login}`, email: `${login}@example.invalid`, type: 'User' };
}

function repoObject(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userObject(1000, repo.owner),
    description: repo.description,
    private: repo.isPrivate,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
  };
}

function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: '000000' })),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullObject(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: pull.headSha },
    base: { ref: pull.base, sha: pull.baseSha },
    created_at: pull.createdAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function resolveRepo(store: Store, owner: string, name: string): Repo | undefined {
  return store.getRepo(owner, name);
}

function splitFullName(fullName: string): [string, string] | null {
  const idx = fullName.indexOf('/');
  if (idx <= 0) return null;
  return [fullName.slice(0, idx), fullName.slice(idx + 1)];
}

// ------------------------------------------------------------ REST v3

export function handleRest(store: Store, ctx: RequestContext): Response {
  const path = ctx.path;
  if (path === '/api/v3/' || path === '/api/v3') {
    return json(200, { current_user_url: '/api/v3/user', message: 'ok' }, { 'x-oauth-scopes': 'repo' });
  }
  if (path === '/api/v3/meta') {
    return json(200, { installed_version: '1.0.0', verifiable_password_authentication: false });
  }
  if (!authed(ctx)) return err(401, 'Requires authentication');
  const viewer = viewerLogin();
  const body = parseJsonBody(ctx);
  if (ctx.method === 'POST' || ctx.method === 'PATCH' || ctx.method === 'PUT' || ctx.method === 'DELETE') {
    if (!body.ok) return err(400, 'Problems parsing JSON');
  }
  const payload = body.ok ? body.value : {};
  const segments = path.split('/').filter((s) => s !== '');

  // GET /api/v3/user
  if (ctx.method === 'GET' && path === '/api/v3/user') {
    return json(200, userObject(1000, viewer));
  }
  // /api/v3/user/repos
  if (path === '/api/v3/user/repos') {
    if (ctx.method === 'GET') {
      const perPage = Math.max(1, Number.parseInt(ctx.query.get('per_page') ?? '30', 10) || 30);
      const page = Math.max(1, Number.parseInt(ctx.query.get('page') ?? '1', 10) || 1);
      const all = store.listRepos(viewer);
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      if (start + perPage < all.length) {
        const next = `/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        headers.link = `<${next}>; rel="next"`;
      }
      return json(200, slice.map((r) => repoObject(store, r)), headers);
    }
    if (ctx.method === 'POST') {
      const name = asString(payload.name);
      if (name === '') return err(422, 'name is required');
      if (store.getRepo(viewer, name)) return err(422, 'name already exists on this account');
      const repo = store.createRepo(viewer, name, asString(payload.description), payload.private === true);
      return json(201, repoObject(store, repo));
    }
  }
  // /api/v3/repos/{owner}/{repo}[...]
  if (segments.length >= 4 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'repos') {
    const owner = segments[3] as string;
    const repoName = segments[4] as string;
    const repo = resolveRepo(store, owner, repoName);
    if (!repo) return err(404, 'Not Found');
    const rest = segments.slice(5);
    // Repo itself.
    if (rest.length === 0) {
      if (ctx.method === 'GET') return json(200, repoObject(store, repo));
      if (ctx.method === 'PATCH') {
        if (typeof payload.description === 'string') repo.description = payload.description;
        if (typeof payload.private === 'boolean') repo.isPrivate = payload.private;
        return json(200, repoObject(store, repo));
      }
      if (ctx.method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        return { status: 204, headers: { 'x-github-request-id': `req-${++requestCounter}` }, body: '' };
      }
      return err(404, 'Not Found');
    }
    // Branches.
    if (rest[0] === 'branches') {
      if (rest.length === 1 && ctx.method === 'GET') {
        const out = [...repo.refs.keys()]
          .filter((r) => r.startsWith('refs/heads/'))
          .map((r) => r.slice('refs/heads/'.length))
          .sort()
          .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`) } }));
        return json(200, out);
      }
      if (rest.length === 2 && ctx.method === 'GET') {
        const sha = repo.refs.get(`refs/heads/${rest[1]}`);
        if (!sha) return err(404, 'Branch not found');
        return json(200, { name: rest[1], commit: { sha } });
      }
      return err(404, 'Not Found');
    }
    // Commits.
    if (rest[0] === 'commits' && rest.length === 1 && ctx.method === 'GET') {
      const ref = ctx.query.get('sha') ?? repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${ref}`);
      if (!tip) return err(404, 'Not Found');
      const list = store.commitList(repo, tip).map((c) => ({
        sha: c.sha,
        commit: { message: c.message, author: { name: viewer } },
      }));
      return json(200, list);
    }
    // git/refs.
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (ctx.method === 'POST' && rest.length === 2) {
        const ref = asString(payload.ref);
        const sha = asString(payload.sha);
        if (!ref.startsWith('refs/heads/') || sha === '') return err(422, 'Invalid ref');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        if (!repo.objects.has(sha)) return err(422, 'Object does not exist');
        repo.refs.set(ref, sha);
        return json(201, { ref, object: { sha, type: 'commit' } });
      }
      if (ctx.method === 'GET' && rest.length >= 4 && rest[2] === 'heads') {
        const branch = rest.slice(3).join('/');
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) return err(404, 'Not Found');
        return json(200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
      }
      return err(404, 'Not Found');
    }
    // Contents.
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      const ref = ctx.query.get('ref') ?? repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${ref}`);
      if (ctx.method === 'GET') {
        if (!tip) return err(404, 'Not Found');
        const commit = repo.objects.get(tip);
        if (!commit || commit.type !== 'commit') return err(404, 'Not Found');
        return contentsGet(store, repo, tip, filePath);
      }
      if (ctx.method === 'PUT') {
        const contentB64 = asString(payload.content);
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          return err(400, 'Invalid content');
        }
        const branch = asString(payload.branch) || repo.defaultBranch;
        const message = asString(payload.message) || `Update ${filePath}`;
        const isUpdate = fileExists(store, repo, branch, filePath);
        if (isUpdate) {
          const currentSha = fileSha(store, repo, branch, filePath);
          if (payload.sha !== undefined && payload.sha !== currentSha) return err(409, 'sha does not match');
          const sha = store.commitFile(repo, branch, filePath, content, message);
          return json(200, { content: { sha: fileSha(store, repo, branch, filePath), path: filePath }, commit: { sha } });
        }
        const sha = store.commitFile(repo, branch, filePath, content, message);
        return json(201, { content: { sha: fileSha(store, repo, branch, filePath), path: filePath }, commit: { sha } });
      }
      if (ctx.method === 'DELETE') {
        if (!fileExists(store, repo, repo.defaultBranch, filePath)) return err(404, 'Not Found');
        const branch = asString(payload.branch) || repo.defaultBranch;
        const message = asString(payload.message) || `Delete ${filePath}`;
        const sha = store.commitFile(repo, branch, filePath, null, message);
        return json(200, { commit: { sha } });
      }
      return err(404, 'Not Found');
    }
    // Labels.
    if (rest[0] === 'labels') {
      if (ctx.method === 'POST' && rest.length === 1) {
        const name = asString(payload.name);
        if (name === '') return err(422, 'name is required');
        repo.labels.set(name, { name, color: asString(payload.color) || '000000' });
        return json(201, { name, color: repo.labels.get(name)?.color ?? '000000' });
      }
      if (ctx.method === 'GET' && rest.length === 1) {
        return json(200, [...repo.labels.values()]);
      }
      return err(404, 'Not Found');
    }
    // Issues.
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (ctx.method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          const direction = ctx.query.get('direction') ?? 'desc';
          let list = [...repo.issues.values()];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
          return json(200, list.map((i) => issueObject(repo, i)));
        }
        if (ctx.method === 'POST') {
          const title = asString(payload.title);
          if (title === '') return err(422, 'title is required');
          const labels = asStringArray(payload.labels);
          for (const label of labels) {
            if (!repo.labels.has(label)) return err(422, `unknown label: ${label}`);
          }
          const issue = store.createIssue(repo, title, asString(payload.body), labels);
          return json(201, issueObject(repo, issue));
        }
        return err(404, 'Not Found');
      }
      const number = Number.parseInt(rest[1] as string, 10);
      const issue = repo.issues.get(number);
      if (!issue) return err(404, 'Not Found');
      if (rest.length === 2) {
        if (ctx.method === 'GET') return json(200, issueObject(repo, issue));
        if (ctx.method === 'PATCH') {
          if (payload.state === 'closed' || payload.state === 'open') issue.state = payload.state;
          if (typeof payload.title === 'string') issue.title = payload.title;
          if (typeof payload.body === 'string') issue.body = payload.body;
          issue.updatedAt = trialNowIso();
          return json(200, issueObject(repo, issue));
        }
        return err(404, 'Not Found');
      }
      if (rest[2] === 'comments') {
        if (ctx.method === 'GET') {
          return json(200, issue.comments.map((c) => ({ id: c.id, body: c.body, created_at: c.createdAt })));
        }
        if (ctx.method === 'POST') {
          const commentBody = asString(payload.body);
          if (commentBody === '') return err(422, 'body is required');
          const id = store.nextComment();
          issue.comments.push({ id, body: commentBody, createdAt: trialNowIso() });
          return json(201, { id, body: commentBody, created_at: trialNowIso() });
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }
    // Pulls.
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (ctx.method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          let list = [...repo.pulls.values()];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.createdSeq - a.createdSeq);
          return json(200, list.map((p) => pullObject(repo, p)));
        }
        if (ctx.method === 'POST') {
          const title = asString(payload.title);
          const head = asString(payload.head);
          const base = asString(payload.base) || repo.defaultBranch;
          if (title === '' || head === '') return err(422, 'title and head are required');
          const pull = store.createPull(repo, title, asString(payload.body), head, base);
          if (!pull) return err(422, 'head or base branch does not exist');
          return json(201, pullObject(repo, pull));
        }
        return err(404, 'Not Found');
      }
      const number = Number.parseInt(rest[1] as string, 10);
      const pull = repo.pulls.get(number);
      if (!pull) return err(404, 'Not Found');
      if (rest.length === 2) {
        if (ctx.method === 'GET') return json(200, pullObject(repo, pull));
        if (ctx.method === 'PATCH') {
          if (payload.state === 'closed' || payload.state === 'open') pull.state = payload.state;
          return json(200, pullObject(repo, pull));
        }
        return err(404, 'Not Found');
      }
      if (rest[2] === 'files' && ctx.method === 'GET') {
        const files = pullFiles(store, repo, pull);
        return json(200, files);
      }
      if (rest[2] === 'merge' && ctx.method === 'PUT') {
        if (pull.merged) return json(200, { sha: pull.mergeCommitSha, merged: true, message: 'Pull request already merged' });
        const method = asString(payload.merge_method) === 'merge' ? 'MERGE' : 'SQUASH';
        const sha = store.mergePull(repo, pull, method);
        if (sha === null) return err(405, 'Merge conflict');
        pull.merged = true;
        pull.state = 'closed';
        pull.mergedAt = trialNowIso();
        pull.mergeCommitSha = sha;
        return json(200, { sha, merged: true, message: 'Pull request successfully merged' });
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }
  return err(404, 'Not Found');
}

// The contents handlers use parseCommit / parseTree from util.ts.
import { parseCommit as parseCommitData, parseTree as parseTreeFn } from './util.ts';

function fileExists(store: Store, repo: Repo, branch: string, filePath: string): boolean {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip) return false;
  const commit = repo.objects.get(tip);
  if (!commit || commit.type !== 'commit') return false;
  return store.flattenTree(repo, parseCommitData(commit.data).tree).has(filePath);
}

function fileSha(store: Store, repo: Repo, branch: string, filePath: string): string {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip) return '';
  const commit = repo.objects.get(tip);
  if (!commit || commit.type !== 'commit') return '';
  return store.flattenTree(repo, parseCommitData(commit.data).tree).get(filePath)?.oid ?? '';
}

function contentsGet(store: Store, repo: Repo, tip: string, filePath: string): Response {
  const commit = repo.objects.get(tip);
  if (!commit || commit.type !== 'commit') return err(404, 'Not Found');
  const treeOid = parseCommitData(commit.data).tree;
  if (filePath === '') {
    const entries = dirEntries(store, repo, treeOid, '');
    return json(200, entries);
  }
  const flat = store.flattenTree(repo, treeOid);
  const file = flat.get(filePath);
  if (file) {
    const blob = repo.objects.get(file.oid);
    const data = blob?.data ?? Buffer.alloc(0);
    return json(200, {
      type: 'file',
      encoding: 'base64',
      size: data.length,
      name: filePath.split('/').pop(),
      path: filePath,
      content: data.toString('base64'),
      sha: file.oid,
    });
  }
  const dirTree = store.treeAtPath(repo, treeOid, filePath);
  if (dirTree !== null) {
    return json(200, dirEntries(store, repo, dirTree, filePath));
  }
  return err(404, 'Not Found');
}

function dirEntries(store: Store, repo: Repo, treeOid: string, prefix: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const treeObj = repo.objects.get(treeOid);
  if (!treeObj || treeObj.type !== 'tree') return out;
  for (const e of parseTreeFn(treeObj.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    out.push({ type: e.mode === '40000' ? 'dir' : 'file', name: e.name, path, sha: e.oid });
  }
  return out;
}

function pullFiles(store: Store, repo: Repo, pull: Pull): Array<Record<string, unknown>> {
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (!headTip || !baseTip) return [];
  const base = store.mergeBase(repo, headTip, baseTip);
  const headCommit = repo.objects.get(headTip);
  if (!headCommit) return [];
  const baseTree = base !== null
    ? parseCommitData(repo.objects.get(base)?.data ?? Buffer.alloc(0)).tree
    : parseCommitData(repo.objects.get(baseTip)?.data ?? Buffer.alloc(0)).tree;
  const diff = store.diffTrees(repo, baseTree, parseCommitData(headCommit.data).tree);
  return diff.map((d) => ({
    filename: d.path,
    status: d.status === 'modified' ? 'modified' : d.status,
    additions: d.additions,
    deletions: d.deletions,
    changes: d.additions + d.deletions,
    sha: d.newOid ?? d.oldOid,
  }));
}

// ------------------------------------------------------------ GraphQL

interface GqlField {
  alias: string;
  name: string;
  args: Record<string, unknown>;
  children: GqlField[];
  inlineType: string | null;
}

interface GqlOperation {
  kind: 'query' | 'mutation';
  fields: GqlField[];
}

function tokenizeGql(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if ('{}()[]:!=$...'.includes(ch)) {
      if (src.slice(i, i + 3) === '...') {
        tokens.push('...');
        i += 3;
        continue;
      }
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1;
    if (j === i) {
      i += 1;
      continue;
    }
    tokens.push(src.slice(i, j));
    i = j;
  }
  return tokens;
}

class GqlParser {
  private pos = 0;
  private tokens: string[];

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    const t = this.tokens[this.pos] as string;
    this.pos += 1;
    return t;
  }

  expect(t: string): void {
    if (this.next() !== t) throw new Error(`expected ${t}`);
  }

  parseDocument(): GqlOperation[] {
    const ops: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      const tok = this.next();
      if (tok === 'query' || tok === 'mutation') {
        // Optional operation name.
        if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') this.next();
        // Variable definitions.
        if (this.peek() === '(') this.skipBalanced('(', ')');
        ops.push({ kind: tok, fields: this.parseSelectionSet() });
      } else if (tok === '{') {
        this.pos -= 1;
        ops.push({ kind: 'query', fields: this.parseSelectionSet() });
      } else if (tok === 'fragment') {
        // Skip a fragment definition: name, "on Type", selection set.
        this.next();
        this.next();
        this.next();
        this.skipBalanced('{', '}');
      }
    }
    return ops;
  }

  skipBalanced(open: string, close: string): void {
    let depth = 0;
    while (this.pos < this.tokens.length) {
      const t = this.next();
      if (t === open) depth += 1;
      else if (t === close) {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  parseSelectionSet(): GqlField[] {
    this.expect('{');
    const fields: GqlField[] = [];
    while (this.peek() !== '}' && this.pos < this.tokens.length) {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeName = this.next();
          fields.push({ alias: '', name: '', args: {}, children: this.parseSelectionSet(), inlineType: typeName });
        } else {
          // Named fragment spread — the suite's documents do not use them;
          // skip the name.
          this.next();
        }
        continue;
      }
      let name = this.next();
      let alias = name;
      if (this.peek() === ':') {
        this.next();
        name = this.next();
        alias = alias;
      }
      let args: Record<string, unknown> = {};
      if (this.peek() === '(') args = this.parseArguments();
      let children: GqlField[] = [];
      if (this.peek() === '{') children = this.parseSelectionSet();
      fields.push({ alias, name, args, children, inlineType: null });
    }
    this.expect('}');
    return fields;
  }

  parseArguments(): Record<string, unknown> {
    this.expect('(');
    const args: Record<string, unknown> = {};
    while (this.peek() !== ')') {
      const name = this.next();
      this.expect(':');
      args[name] = this.parseValue();
    }
    this.expect(')');
    return args;
  }

  parseValue(): unknown {
    const t = this.next();
    if (t === '$') return { __var: this.next() };
    if (t === '{') {
      const obj: Record<string, unknown> = {};
      while (this.peek() !== '}') {
        const k = this.next();
        this.expect(':');
        obj[k] = this.parseValue();
      }
      this.expect('}');
      return obj;
    }
    if (t === '[') {
      const arr: unknown[] = [];
      while (this.peek() !== ']') arr.push(this.parseValue());
      this.expect(']');
      return arr;
    }
    if (t.startsWith('"')) return JSON.parse(t);
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    const n = Number(t);
    if (!Number.isNaN(n)) return n;
    return { __enum: t };
  }
}

function resolveVars(value: unknown, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) return value.map((v) => resolveVars(v, variables));
    const rec = value as Record<string, unknown>;
    if ('__var' in rec) return variables[rec.__var as string];
    if ('__enum' in rec) return rec.__enum;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) out[k] = resolveVars(v, variables);
    return out;
  }
  return value;
}

interface TypeInfo {
  kind: 'OBJECT' | 'ENUM';
  fields: string[];
  enumValues?: string[];
}

const TYPE_INFO: Record<string, TypeInfo> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'labels', 'comments', 'url', 'createdAt', 'author'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'url', 'createdAt', 'author'],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description'],
  },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER'] },
  Viewer: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email'] },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  FileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  ChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changeType'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'] },
  BranchRef: { kind: 'OBJECT', fields: ['name'] },
};

function encodeCursor(n: number): string {
  return Buffer.from(`cursor:${n}`).toString('base64');
}

function decodeCursor(cursor: string | undefined): number | null {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(-?\d+)$/.exec(text);
    return m ? Number.parseInt(m[1] as string, 10) : null;
  } catch {
    return null;
  }
}

class GraphQLExecutor {
  readonly errors: Array<{ message: string }> = [];
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  executeOperation(op: GqlOperation, variables: Record<string, unknown>): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (const field of op.fields) {
      data[field.alias || field.name] = this.resolveRoot(field, variables);
    }
    return data;
  }

  private resolveRoot(field: GqlField, variables: Record<string, unknown>): unknown {
    const args = resolveVars(field.args, variables) as Record<string, unknown>;
    switch (field.name) {
      case 'viewer':
        return this.resolveFields('Viewer', { login: viewerLogin(), id: 1000, name: viewerLogin(), email: `${viewerLogin()}@example.invalid` }, field.children, variables);
      case 'repository': {
        const repo = this.store.getRepo(asString(args.owner), asString(args.name));
        if (!repo) return null;
        return this.resolveRepository(repo, field.children, variables);
      }
      case 'node': {
        const parsed = parseGlobalId(asString(args.id));
        if (!parsed) return null;
        if (parsed.kind === 'Repository') {
          const parts = splitFullName(parsed.key);
          if (!parts) return null;
          const repo = this.store.getRepo(parts[0], parts[1]);
          if (!repo) return null;
          return this.resolveRepository(repo, field.children, variables);
        }
        return null;
      }
      case '__type': {
        const info = TYPE_INFO[asString(args.name)];
        if (!info) return null;
        const out: Record<string, unknown> = { name: args.name, kind: info.kind };
        for (const child of field.children) {
          if (child.name === 'fields') {
            out.fields = info.fields.map((name) => ({ name }));
          } else if (child.name === 'enumValues') {
            out.enumValues = (info.enumValues ?? []).map((name) => ({ name }));
          } else if (child.name === 'name') out.name = args.name;
          else if (child.name === 'kind') out.kind = info.kind;
        }
        return out;
      }
      case '__schema':
        return { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } };
      case 'createIssue': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(asString(input.repositoryId));
        if (!parsed) return { issue: null };
        const parts = splitFullName(parsed.key);
        if (!parts) return { issue: null };
        const repo = this.store.getRepo(parts[0], parts[1]);
        if (!repo) return { issue: null };
        const issue = this.store.createIssue(repo, asString(input.title), asString(input.body), []);
        return this.resolveFields('CreateIssuePayload', { __issue: issue, __repo: repo }, field.children, variables, repo);
      }
      case 'closeIssue': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(asString(input.issueId));
        if (!parsed) return { issue: null };
        const parts = splitFullName(parsed.key);
        if (!parts) return { issue: null };
        const repo = this.store.getRepo(parts[0], parts[1]);
        if (!repo) return { issue: null };
        const num = Number.parseInt(parsed.key.split('#')[1] ?? '', 10);
        const issue = repo.issues.get(num);
        if (!issue) return { issue: null };
        issue.state = 'closed';
        issue.updatedAt = trialNowIso();
        return this.resolveFields('CloseIssuePayload', { __issue: issue, __repo: repo }, field.children, variables, repo);
      }
      case 'createPullRequest': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(asString(input.repositoryId));
        if (!parsed) return { pullRequest: null };
        const parts = splitFullName(parsed.key);
        if (!parts) return { pullRequest: null };
        const repo = this.store.getRepo(parts[0], parts[1]);
        if (!repo) return { pullRequest: null };
        const pull = this.store.createPull(
          repo,
          asString(input.title),
          asString(input.body),
          asString(input.headRefName),
          asString(input.baseRefName),
        );
        if (!pull) return { pullRequest: null };
        return this.resolveFields('CreatePullRequestPayload', { __pull: pull, __repo: repo }, field.children, variables, repo);
      }
      case 'mergePullRequest': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(asString(input.pullRequestId));
        if (!parsed) return { pullRequest: null };
        const parts = splitFullName(parsed.key);
        if (!parts) return { pullRequest: null };
        const repo = this.store.getRepo(parts[0], parts[1]);
        if (!repo) return { pullRequest: null };
        const num = Number.parseInt(parsed.key.split('#')[1] ?? '', 10);
        const pull = repo.pulls.get(num);
        if (!pull) return { pullRequest: null };
        const method = asString(input.mergeMethod) === 'MERGE' ? 'MERGE' : 'SQUASH';
        const sha = this.store.mergePull(repo, pull, method);
        if (sha === null) {
          this.errors.push({ message: 'Merge conflict' });
          return { pullRequest: null };
        }
        pull.merged = true;
        pull.state = 'closed';
        pull.mergedAt = trialNowIso();
        pull.mergeCommitSha = sha;
        return this.resolveFields('MergePullRequestPayload', { __pull: pull, __repo: repo }, field.children, variables, repo);
      }
      case 'addComment': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(asString(input.subjectId));
        if (!parsed) return { commentEdge: null };
        const parts = splitFullName(parsed.key);
        if (!parts) return { commentEdge: null };
        const repo = this.store.getRepo(parts[0], parts[1]);
        if (!repo) return { commentEdge: null };
        const num = Number.parseInt(parsed.key.split('#')[1] ?? '', 10);
        const issue = repo.issues.get(num);
        if (!issue) return { commentEdge: null };
        const id = this.store.nextComment();
        const comment = { id, body: asString(input.body), createdAt: trialNowIso() };
        issue.comments.push(comment);
        const node = { id: globalId('IssueComment', `${parsed.key}/c${id}`), body: comment.body };
        return { commentEdge: { node } };
      }
      default:
        this.errors.push({ message: `Cannot query field "${field.name}" on type "Query".` });
        return null;
    }
  }

  private resolveRepository(repo: Repo, children: GqlField[], variables: Record<string, unknown>): Record<string, unknown> {
    const base: Record<string, unknown> = {
      __typename: 'Repository',
      id: this.store.repoGlobalId(repo),
      databaseId: repo.id,
      name: repo.name,
      nameWithOwner: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner, id: 1000 },
      defaultBranchRef: repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { name: repo.defaultBranch } : null,
      viewerPermission: 'ADMIN',
      hasIssuesEnabled: true,
      description: repo.description,
      url: `https://example.invalid/${repo.owner}/${repo.name}`,
      __repo: repo,
    };
    return this.resolveFields('Repository', base, children, variables, repo);
  }

  private issueFields(repo: Repo, issue: Issue): Record<string, unknown> {
    return {
      __typename: 'Issue',
      id: this.store.issueGlobalId(repo, issue),
      number: issue.number,
      title: issue.title,
      state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
      body: issue.body,
      labels: { nodes: issue.labels.map((name) => ({ name })) },
      comments: { totalCount: issue.comments.length, nodes: issue.comments.map((c) => ({ id: c.id, body: c.body })) },
      url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
      createdAt: issue.createdAt,
      author: { login: viewerLogin() },
      __issue: issue,
      __repo: repo,
    };
  }

  private pullFields(repo: Repo, pull: Pull): Record<string, unknown> {
    const conflicted = this.store.pullConflicted(repo, pull);
    return {
      __typename: 'PullRequest',
      id: this.store.pullGlobalId(repo, pull),
      number: pull.number,
      title: pull.title,
      state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
      body: pull.body,
      headRefName: pull.head,
      baseRefName: pull.base,
      mergeable: conflicted ? 'CONFLICTING' : 'MERGEABLE',
      merged: pull.merged,
      url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
      createdAt: pull.createdAt,
      author: { login: viewerLogin() },
      __pull: pull,
      __repo: repo,
    };
  }

  private resolveFields(
    typeName: string,
    source: Record<string, unknown>,
    children: GqlField[],
    variables: Record<string, unknown>,
    repo?: Repo,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const allowed = TYPE_INFO[typeName]?.fields;
    for (const child of children) {
      if (child.inlineType !== null) {
        const typeMatches =
          child.inlineType === typeName ||
          (child.inlineType === 'Repository' && source.__typename === 'Repository') ||
          (child.inlineType === 'Issue' && source.__typename === 'Issue') ||
          (child.inlineType === 'PullRequest' && source.__typename === 'PullRequest');
        if (typeMatches) {
          const nested = this.resolveFields(typeName, source, child.children, variables, repo);
          Object.assign(out, nested);
        }
        continue;
      }
      const key = child.alias || child.name;
      // Payload wrappers (createIssue -> issue, etc.).
      if (child.name === 'issue' && source.__issue) {
        const issue = source.__issue as Issue;
        const r = (source.__repo ?? repo) as Repo;
        out[key] = this.resolveFields('Issue', this.issueFields(r, issue), child.children, variables, r);
        continue;
      }
      if (child.name === 'pullRequest' && source.__pull) {
        const pull = source.__pull as Pull;
        const r = (source.__repo ?? repo) as Repo;
        out[key] = this.resolveFields('PullRequest', this.pullFields(r, pull), child.children, variables, r);
        continue;
      }
      if (child.name === 'commentEdge' && source.__commentEdge) {
        out[key] = source.__commentEdge;
        continue;
      }
      if (child.name === '__typename') {
        out[key] = source.__typename ?? typeName;
        continue;
      }
      if (allowed && !allowed.includes(child.name) && !child.name.startsWith('__')) {
        this.errors.push({ message: `Cannot query field "${child.name}" on type "${typeName}".` });
        out[key] = null;
        continue;
      }
      const args = resolveVars(child.args, variables) as Record<string, unknown>;
      // Repository-level fields that need the store.
      if (typeName === 'Repository' && repo) {
        if (child.name === 'issue') {
          const issue = repo.issues.get(Number(args.number));
          out[key] = issue ? this.resolveFields('Issue', this.issueFields(repo, issue), child.children, variables, repo) : null;
          continue;
        }
        if (child.name === 'issues') {
          out[key] = this.issuesConnection(repo, args, child.children, variables);
          continue;
        }
        if (child.name === 'pullRequest') {
          const pull = repo.pulls.get(Number(args.number));
          out[key] = pull ? this.resolveFields('PullRequest', this.pullFields(repo, pull), child.children, variables, repo) : null;
          continue;
        }
        if (child.name === 'pullRequests') {
          out[key] = this.pullsConnection(repo, args, child.children, variables);
          continue;
        }
        if (child.name === 'owner') {
          out[key] = this.resolveFields('User', { login: repo.owner, id: 1000, name: repo.owner, email: `${repo.owner}@example.invalid` }, child.children, variables, repo);
          continue;
        }
        if (child.name === 'defaultBranchRef') {
          const ref = source.defaultBranchRef as Record<string, unknown> | null;
          out[key] = ref ? this.resolveFields('BranchRef', ref, child.children, variables, repo) : null;
          continue;
        }
      }
      if (typeName === 'PullRequest' && repo && child.name === 'files') {
        out[key] = this.filesConnection(repo, source.__pull as Pull, args, child.children, variables);
        continue;
      }
      if (typeName === 'Issue' && repo && child.name === 'labels') {
        const issue = source.__issue as Issue;
        out[key] = { nodes: issue.labels.map((name) => ({ name })) };
        continue;
      }
      if (typeName === 'Issue' && repo && child.name === 'comments') {
        const issue = source.__issue as Issue;
        out[key] = { totalCount: issue.comments.length, nodes: issue.comments.map((c) => ({ id: c.id, body: c.body })) };
        continue;
      }
      // Plain scalar / nested object from the source record.
      const raw = source[child.name];
      if (raw !== undefined && child.children.length > 0 && raw !== null && typeof raw === 'object') {
        out[key] = this.resolveFields(child.name, raw as Record<string, unknown>, child.children, variables, repo);
      } else {
        out[key] = raw ?? null;
      }
    }
    return out;
  }

  private issuesConnection(
    repo: Repo,
    args: Record<string, unknown>,
    children: GqlField[],
    variables: Record<string, unknown>,
  ): Record<string, unknown> {
    const states = asStringArray(args.states);
    const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
    const first = typeof args.first === 'number' ? args.first : undefined;
    const after = decodeCursor(asString(args.after) || undefined);
    let list = [...repo.issues.values()];
    if (states.length > 0) {
      const wanted = new Set(states.map((s) => (s === 'OPEN' ? 'open' : s === 'CLOSED' ? 'closed' : s)));
      list = list.filter((i) => wanted.has(i.state));
    }
    const desc = String(orderBy.direction ?? 'DESC').toUpperCase() === 'DESC';
    list.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
    if (after !== null) {
      list = list.filter((i) => (desc ? i.number < after : i.number > after));
    }
    const total = list.length;
    const page = first !== undefined ? list.slice(0, first) : list;
    const hasNextPage = first !== undefined && total > page.length;
    const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]?.number ?? 0) : null;
    const out: Record<string, unknown> = {};
    for (const child of children) {
      if (child.name === 'nodes') {
        out.nodes = page.map((i) => this.resolveFields('Issue', this.issueFields(repo, i), child.children, variables, repo));
      } else if (child.name === 'edges') {
        out.edges = page.map((i) => ({
          node: this.resolveFields('Issue', this.issueFields(repo, i), child.children, variables, repo),
          cursor: encodeCursor(i.number),
        }));
      } else if (child.name === 'pageInfo') {
        out.pageInfo = { hasNextPage, endCursor, hasPreviousPage: false, startCursor: page.length > 0 ? encodeCursor(page[0]?.number ?? 0) : null };
      } else if (child.name === 'totalCount') {
        out.totalCount = total;
      }
    }
    return out;
  }

  private pullsConnection(
    repo: Repo,
    args: Record<string, unknown>,
    children: GqlField[],
    variables: Record<string, unknown>,
  ): Record<string, unknown> {
    const first = typeof args.first === 'number' ? args.first : undefined;
    const after = decodeCursor(asString(args.after) || undefined);
    let list = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
    if (after !== null) list = list.filter((p) => p.number < after);
    const total = list.length;
    const page = first !== undefined ? list.slice(0, first) : list;
    const hasNextPage = first !== undefined && total > page.length;
    const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]?.number ?? 0) : null;
    const out: Record<string, unknown> = {};
    for (const child of children) {
      if (child.name === 'nodes') {
        out.nodes = page.map((p) => this.resolveFields('PullRequest', this.pullFields(repo, p), child.children, variables, repo));
      } else if (child.name === 'pageInfo') {
        out.pageInfo = { hasNextPage, endCursor, hasPreviousPage: false, startCursor: page.length > 0 ? encodeCursor(page[0]?.number ?? 0) : null };
      } else if (child.name === 'totalCount') {
        out.totalCount = total;
      }
    }
    return out;
  }

  private filesConnection(
    repo: Repo,
    pull: Pull,
    args: Record<string, unknown>,
    children: GqlField[],
    variables: Record<string, unknown>,
  ): Record<string, unknown> {
    const first = typeof args.first === 'number' ? args.first : undefined;
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    let files: Array<{ path: string; additions: number; deletions: number }> = [];
    if (headTip && baseTip) {
      const base = this.store.mergeBase(repo, headTip, baseTip);
      const headCommit = repo.objects.get(headTip);
      const baseCommit = base !== null ? repo.objects.get(base) : repo.objects.get(baseTip);
      if (headCommit && baseCommit) {
        files = this.store
          .diffTrees(repo, parseCommitData(baseCommit.data).tree, parseCommitData(headCommit.data).tree)
          .map((d) => ({ path: d.path, additions: d.additions, deletions: d.deletions }));
      }
    }
    const total = files.length;
    const page = first !== undefined ? files.slice(0, first) : files;
    const out: Record<string, unknown> = {};
    for (const child of children) {
      if (child.name === 'nodes') {
        out.nodes = page.map((f) => {
          const node: Record<string, unknown> = {};
          for (const fc of child.children) node[fc.alias || fc.name] = (f as Record<string, unknown>)[fc.name] ?? null;
          return node;
        });
      } else if (child.name === 'pageInfo') {
        out.pageInfo = { hasNextPage: first !== undefined && total > page.length, endCursor: null, hasPreviousPage: false, startCursor: null };
      } else if (child.name === 'totalCount') {
        out.totalCount = total;
      }
    }
    return out;
  }
}

export function handleGraphQL(store: Store, ctx: RequestContext): Response {
  if (!authed(ctx)) return err(401, 'Requires authentication');
  let bodyJson: unknown;
  try {
    bodyJson = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return json(400, { errors: [{ message: 'Problems parsing JSON' }] });
  }
  const operations = Array.isArray(bodyJson) ? bodyJson : [bodyJson];
  const results: unknown[] = [];
  for (const opBody of operations) {
    const rec = (opBody ?? {}) as Record<string, unknown>;
    const query = asString(rec.query);
    const variables = (rec.variables ?? {}) as Record<string, unknown>;
    let ops: GqlOperation[];
    try {
      ops = new GqlParser(tokenizeGql(query)).parseDocument();
    } catch (e) {
      results.push({ errors: [{ message: e instanceof Error ? e.message : 'Parse error' }] });
      continue;
    }
    const executor = new GraphQLExecutor(store);
    const data: Record<string, unknown> = {};
    for (const op of ops) {
      Object.assign(data, executor.executeOperation(op, variables));
    }
    if (executor.errors.length > 0) {
      results.push({ data, errors: executor.errors });
    } else {
      results.push({ data });
    }
  }
  return json(200, Array.isArray(bodyJson) ? results : results[0]);
}

// ------------------------------------------------------------ MCP

interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required: string[] };
}

const MCP_TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'owner/repo' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'owner/repo' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
        labels: { type: 'array', description: 'Label names' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'owner/repo' },
        state: { type: 'string', description: 'open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'owner/repo' },
        number: { type: 'number', description: 'Issue number' },
        issue_number: { type: 'number', description: 'Issue number' },
      },
      required: ['owner', 'repo', 'number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'owner/repo' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'owner/repo' },
        pull_number: { type: 'number', description: 'Pull request number' },
        number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_repos',
    description: 'List repositories owned by the viewer.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

function mcpResult(id: unknown, result: unknown): Response {
  return json(200, { jsonrpc: '2.0', id: id ?? null, result });
}

function mcpError(id: unknown, code: number, message: string, httpStatus = 200): Response {
  return json(httpStatus, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function toolTextResult(obj: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    structuredContent: obj,
    ...(isError ? { isError: true } : {}),
  };
}

function resolveOwnerRepo(args: Record<string, unknown>): [string, string] | null {
  const owner = asString(args.owner);
  const repo = asString(args.repo);
  if (owner !== '' && repo !== '') return [owner, repo];
  const full = asString(args.full_name);
  if (full !== '') {
    const parts = splitFullName(full);
    if (parts) return parts;
  }
  return null;
}

export function handleMcp(store: Store, ctx: RequestContext): Response {
  if (ctx.method === 'DELETE') {
    return { status: 204, headers: { 'x-github-request-id': `req-${++requestCounter}` }, body: '' };
  }
  if (ctx.method !== 'POST') return err(405, 'Method not allowed');
  if (!authed(ctx)) return err(401, 'Requires authentication');
  let payload: unknown;
  try {
    payload = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const rec = (payload ?? {}) as Record<string, unknown>;
  const id = rec.id ?? null;
  const method = asString(rec.method);
  const params = (rec.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return mcpResult(id, {
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone-01', version: '1.0.0' },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'github-core-clone-01', version: '1.0.0' } },
    });
  }
  if (method === 'initialize') {
    const requested = asString((params.protocolVersion as string | undefined) ?? '') || '2026-07-28';
    const resp = mcpResult(id, {
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone-01', version: '1.0.0' },
    });
    resp.headers = { ...resp.headers, 'mcp-session-id': 'session-1' };
    return resp;
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, headers: { 'x-github-request-id': `req-${++requestCounter}` }, body: '' };
  }
  if (method === 'ping') return mcpResult(id, {});
  if (method === 'tools/list') {
    return mcpResult(id, { tools: MCP_TOOLS });
  }
  if (method === 'tools/call') {
    const name = asString(params.name);
    const args = ((params.arguments ?? {}) as Record<string, unknown>);
    const tool = MCP_TOOLS.find((t) => t.name.toLowerCase() === name.toLowerCase() || name.toLowerCase().endsWith(t.name.toLowerCase()));
    if (!tool) return mcpError(id, -32602, `Unknown tool: ${name}`);
    for (const required of tool.inputSchema.required) {
      if (args[required] === undefined || args[required] === null || args[required] === '') {
        // A full_name may stand in for owner/repo.
        if ((required === 'owner' || required === 'repo') && asString(args.full_name) !== '') continue;
        if (required === 'pull_number' && args.number !== undefined) continue;
        if (required === 'number' && args.pull_number !== undefined) continue;
        if (required === 'number' && args.issue_number !== undefined) continue;
        return mcpResult(id, toolTextResult({ error: `Missing required argument: ${required}` }, true));
      }
    }
    const viewer = viewerLogin();
    try {
      switch (tool.name) {
        case 'create_repo': {
          const repoName = asString(args.name);
          if (store.getRepo(viewer, repoName)) {
            return mcpResult(id, toolTextResult({ error: 'name already exists on this account' }, true));
          }
          const repo = store.createRepo(viewer, repoName, asString(args.description), args.private === true);
          return mcpResult(id, toolTextResult(repoObject(store, repo)));
        }
        case 'get_repo': {
          const pair = resolveOwnerRepo(args);
          if (!pair) return mcpResult(id, toolTextResult({ error: 'owner and repo are required' }, true));
          const repo = store.getRepo(pair[0], pair[1]);
          if (!repo) return mcpResult(id, toolTextResult({ error: 'Not Found' }, true));
          return mcpResult(id, toolTextResult(repoObject(store, repo)));
        }
        case 'create_issue': {
          const pair = resolveOwnerRepo(args);
          if (!pair) return mcpResult(id, toolTextResult({ error: 'owner and repo are required' }, true));
          const repo = store.getRepo(pair[0], pair[1]);
          if (!repo) return mcpResult(id, toolTextResult({ error: 'Not Found' }, true));
          const labels = asStringArray(args.labels);
          for (const label of labels) {
            if (!repo.labels.has(label)) repo.labels.set(label, { name: label, color: '000000' });
          }
          const issue = store.createIssue(repo, asString(args.title), asString(args.body), labels);
          return mcpResult(id, toolTextResult(issueObject(repo, issue)));
        }
        case 'list_issues': {
          const pair = resolveOwnerRepo(args);
          if (!pair) return mcpResult(id, toolTextResult({ error: 'owner and repo are required' }, true));
          const repo = store.getRepo(pair[0], pair[1]);
          if (!repo) return mcpResult(id, toolTextResult({ error: 'Not Found' }, true));
          const state = asString(args.state) || 'open';
          let list = [...repo.issues.values()];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          list.sort((a, b) => b.createdSeq - a.createdSeq);
          return mcpResult(id, toolTextResult({ issues: list.map((i) => issueObject(repo, i)) }));
        }
        case 'get_issue': {
          const pair = resolveOwnerRepo(args);
          if (!pair) return mcpResult(id, toolTextResult({ error: 'owner and repo are required' }, true));
          const repo = store.getRepo(pair[0], pair[1]);
          if (!repo) return mcpResult(id, toolTextResult({ error: 'Not Found' }, true));
          const number = Number(args.number ?? args.issue_number);
          const issue = repo.issues.get(number);
          if (!issue) return mcpResult(id, toolTextResult({ error: 'Not Found' }, true));
          return mcpResult(id, toolTextResult(issueObject(repo, issue)));
        }
        case 'create_pull_request': {
          const pair = resolveOwnerRepo(args);
          if (!pair) return mcpResult(id, toolTextResult({ error: 'owner and repo are required' }, true));
          const repo = store.getRepo(pair[0], pair[1]);
          if (!repo) return mcpResult(id, toolTextResult({ error: 'Not Found' }, true));
          const pull = store.createPull(repo, asString(args.title), asString(args.body), asString(args.head), asString(args.base));
          if (!pull) return mcpResult(id, toolTextResult({ error: 'head or base branch does not exist' }, true));
          return mcpResult(id, toolTextResult(pullObject(repo, pull)));
        }
        case 'merge_pull_request': {
          const pair = resolveOwnerRepo(args);
          if (!pair) return mcpResult(id, toolTextResult({ error: 'owner and repo are required' }, true));
          const repo = store.getRepo(pair[0], pair[1]);
          if (!repo) return mcpResult(id, toolTextResult({ error: 'Not Found' }, true));
          const number = Number(args.pull_number ?? args.number);
          const pull = repo.pulls.get(number);
          if (!pull) return mcpResult(id, toolTextResult({ error: 'Not Found' }, true));
          if (pull.merged) return mcpResult(id, toolTextResult({ sha: pull.mergeCommitSha, merged: true, number: pull.number }));
          const sha = store.mergePull(repo, pull, 'SQUASH');
          if (sha === null) return mcpResult(id, toolTextResult({ error: 'Merge conflict' }, true));
          pull.merged = true;
          pull.state = 'closed';
          pull.mergedAt = trialNowIso();
          pull.mergeCommitSha = sha;
          return mcpResult(id, toolTextResult({ sha, merged: true, number: pull.number }));
        }
        case 'list_repos': {
          return mcpResult(id, toolTextResult({ repos: store.listRepos(viewer).map((r) => repoObject(store, r)) }));
        }
        default:
          return mcpError(id, -32602, `Unknown tool: ${name}`);
      }
    } catch (e) {
      return mcpResult(id, toolTextResult({ error: e instanceof Error ? e.message : 'tool failed' }, true));
    }
  }
  return mcpError(id, -32601, `Method not found: ${method}`);
}
