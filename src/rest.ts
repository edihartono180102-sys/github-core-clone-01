// REST API v3. One store, the same one git, GraphQL and MCP read and write.
// Every route the suite exercises is here; shapes follow the GitHub v3 API
// closely enough that a git client or the suite's fetch calls behave as if
// they were talking to the real service.

import { Forge, globalId, type Issue, type IssueComment, type Label, type PullRequest, type Repo } from './store.ts';
import { parseCommit, type GitObject } from './gitpack.ts';

export interface RestRequest {
  readonly forge: Forge;
  readonly method: string;
  readonly segments: string[];
  readonly query: URLSearchParams;
  /** The parsed JSON body, or undefined when the body is absent. */
  readonly body: unknown;
  /** True when a body was sent but was not valid JSON. */
  readonly bodyError: boolean;
  /** The base URL of this server, e.g. http://127.0.0.1:12345. */
  readonly baseUrl: string;
}

export interface RestResult {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

const json = (status: number, body: unknown, headers?: Record<string, string>): RestResult => ({ status, body, headers });
const notFound = (message = 'Not Found'): RestResult => json(404, { message });
const badRequest = (message: string): RestResult => json(400, { message });
const unprocessable = (message: string): RestResult => json(422, { message });
const conflict = (message: string): RestResult => json(409, { message });

// -------------------------------------------------------------------------------------------
// Shape helpers
// -------------------------------------------------------------------------------------------

function userShape(forge: Forge): Record<string, unknown> {
  const viewer = forge.viewer;
  return { login: viewer.login, id: viewer.id, node_id: globalId('User', viewer.id), type: 'User' };
}

function repoUrl(forge: Forge, repo: Repo): string {
  return `${forge.apiRoot()}/repos/${repo.owner}/${repo.name}`;
}

function repoShape(forge: Forge, repo: Repo): Record<string, unknown> {
  const owner = userShape(forge);
  const openIssues = repo.issues.filter((issue) => issue.state === 'open').length;
  const openPulls = repo.pulls.filter((pull) => pull.state === 'open').length;
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner,
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: forge.isoAt(repo.createdSeq),
    updated_at: forge.isoAt(repo.createdSeq),
    pushed_at: forge.isoAt(repo.createdSeq),
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: false,
    has_downloads: true,
    has_wiki: false,
    has_pages: false,
    forks_count: 0,
    open_issues_count: openIssues + openPulls,
    license: null,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    archived: false,
    disabled: false,
    url: repoUrl(forge, repo),
    html_url: `${forge.apiBase()}/${repo.owner}/${repo.name}`,
    clone_url: `${forge.apiBase()}/${repo.owner}/${repo.name}.git`,
    git_url: `git://${forge.apiBase().replace(/^https?:\/\//, '')}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    mirror_url: null,
  };
}

function labelShape(forge: Forge, repo: Repo, label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('Label', label.id),
    name: label.name,
    color: label.color,
    description: label.description,
    url: `${repoUrl(forge, repo)}/labels/${encodeURIComponent(label.name)}`,
    default: false,
  };
}

function issueShape(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  const labels = issue.labels
    .map((name) => repo.labels.get(name))
    .filter((label): label is Label => label !== undefined)
    .map((label) => labelShape(forge, repo, label));
  const commentCount = (repo.comments.get(issue.number) ?? []).length;
  return {
    id: issue.id,
    node_id: globalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: userShape(forge),
    labels,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: commentCount,
    created_at: forge.isoAt(issue.createdSeq),
    updated_at: forge.isoAt(issue.updatedSeq),
    closed_at: issue.state === 'closed' ? forge.isoAt(issue.updatedSeq) : null,
    author_association: 'OWNER',
    html_url: `${forge.apiBase()}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${repoUrl(forge, repo)}/issues/${issue.number}`,
    repository_url: repoUrl(forge, repo),
  };
}

function commentShape(forge: Forge, repo: Repo, issueNumber: number, comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', comment.id),
    body: comment.body,
    user: userShape(forge),
    created_at: forge.isoAt(comment.createdSeq),
    updated_at: forge.isoAt(comment.createdSeq),
    html_url: `${forge.apiBase()}/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    url: `${repoUrl(forge, repo)}/issues/comments/${comment.id}`,
    issue_url: `${repoUrl(forge, repo)}/issues/${issueNumber}`,
  };
}

function refShape(forge: Forge, repo: Repo, ref: string, sha: string | undefined): Record<string, unknown> {
  return {
    label: `${repo.owner}:${ref}`,
    ref,
    sha: sha ?? null,
    user: userShape(forge),
    repo: repoShape(forge, repo),
  };
}

function pullShape(forge: Forge, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headSha = forge.resolveRef(repo, pull.head);
  const baseSha = forge.resolveRef(repo, pull.base);
  const mergeable = forge.pullMergeable(repo, pull);
  return {
    id: pull.id,
    node_id: globalId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: userShape(forge),
    head: refShape(forge, repo, pull.head, headSha),
    base: refShape(forge, repo, pull.base, baseSha),
    merged: pull.state === 'closed' && pull.merged,
    mergeable: mergeable === 'MERGEABLE',
    mergeable_state: pull.state === 'open' ? (mergeable === 'MERGEABLE' ? 'clean' : 'dirty') : 'unknown',
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    created_at: forge.isoAt(pull.createdSeq),
    updated_at: forge.isoAt(pull.createdSeq),
    closed_at: pull.state === 'closed' ? forge.isoAt(pull.createdSeq) : null,
    author_association: 'OWNER',
    html_url: `${forge.apiBase()}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${repoUrl(forge, repo)}/pulls/${pull.number}`,
    commits_url: `${repoUrl(forge, repo)}/pulls/${pull.number}/commits`,
    review_comments_url: `${repoUrl(forge, repo)}/pulls/${pull.number}/comments`,
    review_comment_url: `${repoUrl(forge, repo)}/pulls/comments{/number}`,
    comments_url: `${repoUrl(forge, repo)}/issues/${pull.number}/comments`,
    statuses_url: `${repoUrl(forge, repo)}/statuses/${headSha ?? ''}`,
  };
}

function commitShape(forge: Forge, repo: Repo, sha: string, object: GitObject): Record<string, unknown> {
  const parsed = parseCommit(object.data);
  const parseIdentity = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
    if (match === null) return { name: line, email: '', date: forge.isoAt(0) };
    const date = new Date(Number.parseInt(match[3] as string, 10) * 1000).toISOString();
    return { name: match[1] as string, email: match[2] as string, date };
  };
  const author = parseIdentity(parsed.author);
  const committer = parseIdentity(parsed.committer);
  return {
    sha,
    node_id: globalId('Commit', sha),
    commit: {
      message: parsed.message.replace(/\n+$/, ''),
      author,
      committer,
      tree: { sha: parsed.tree, url: `${repoUrl(forge, repo)}/git/trees/${parsed.tree}` },
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned' },
    },
    author: userShape(forge),
    committer: userShape(forge),
    parents: parsed.parents.map((parent) => ({ sha: parent, url: `${repoUrl(forge, repo)}/commits/${parent}` })),
    url: `${repoUrl(forge, repo)}/commits/${sha}`,
    html_url: `${forge.apiBase()}/${repo.owner}/${repo.name}/commit/${sha}`,
    comments_url: `${repoUrl(forge, repo)}/commits/${sha}/comments`,
  };
}

// -------------------------------------------------------------------------------------------
// Pagination
// -------------------------------------------------------------------------------------------

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  return { page, perPage };
}

function paginate<T>(items: readonly T[], query: URLSearchParams, basePath: string): { page: T[]; link: string | undefined } {
  const { page, perPage } = pageParams(query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  let link: string | undefined;
  if (page < totalPages) {
    const params = new URLSearchParams(query);
    params.set('page', String(page + 1));
    link = `<${basePath}?${params.toString()}>; rel="next"`;
  }
  if (page > 1) {
    const params = new URLSearchParams(query);
    params.set('page', String(page - 1));
    const prev = `<${basePath}?${params.toString()}>; rel="prev"`;
    link = link === undefined ? prev : `${prev}, ${link}`;
  }
  return { page: [...slice], link };
}

function linkHeaders(link: string | undefined): Record<string, string> | undefined {
  return link === undefined ? undefined : { Link: link };
}

// -------------------------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------------------------

function bodyObject(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** A repo route only answers for repos owned by the token's login. */
function ownedRepo(forge: Forge, owner: string, name: string): Repo | undefined {
  if (owner !== forge.viewer.login) return undefined;
  return forge.getRepo(owner, name);
}

function resolveBranchRef(forge: Forge, repo: Repo, ref: string | null): string | undefined {
  if (ref === null || ref === '') return forge.resolveRef(repo, repo.defaultBranch);
  const byName = forge.resolveRef(repo, ref);
  if (byName !== undefined) return byName;
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const object = repo.objects.get(ref);
    if (object !== undefined && object.type === 'commit') return ref;
  }
  return undefined;
}

function cleanPath(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+$/, '');
}

function blobSize(repo: Repo, oid: string): number {
  const object = repo.objects.get(oid);
  return object === undefined ? 0 : object.data.length;
}

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, oid]) => ({ name, oid }));
}

// -------------------------------------------------------------------------------------------
// The router
// -------------------------------------------------------------------------------------------

export function handleRest(request: RestRequest): RestResult {
  const { forge, method, segments, query, baseUrl } = request;
  forge.setApiBase(baseUrl);
  if (request.bodyError) return badRequest('Invalid JSON body');

  // GET /api/v3/ — the service root.
  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return json(200, {
      current_user_url: `${baseUrl}/api/v3/user`,
      authorizations_url: `${baseUrl}/api/v3/authorizations`,
      emojis_url: `${baseUrl}/api/v3/emojis`,
      events_url: `${baseUrl}/api/v3/events`,
      feeds_url: `${baseUrl}/api/v3/feeds`,
      gists_url: `${baseUrl}/api/v3/gists{/gist_id}`,
      meta_url: `${baseUrl}/api/v3/meta`,
      repository_url: `${baseUrl}/api/v3/repos/{owner}/{repo}`,
      user_url: `${baseUrl}/api/v3/user`,
      user_repositories_url: `${baseUrl}/api/v3/user/repos`,
    }, { 'X-OAuth-Scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return notFound();
    return json(200, { installed_version: '1.0.0', forge: 'github-core-clone', verifiable_password_authentication: true });
  }

  // GET /api/v3/user
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return notFound();
    return json(200, { ...userShape(forge), name: forge.viewer.name, email: forge.viewer.email });
  }

  // /api/v3/user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const repos = forge.listRepos(forge.viewer.login);
      const { page, link } = paginate(repos, query, `${baseUrl}/api/v3/user/repos`);
      return json(200, page.map((repo) => repoShape(forge, repo)), linkHeaders(link));
    }
    if (method === 'POST') {
      const body = bodyObject(request.body);
      if (body === null) return badRequest('A JSON object body is required');
      const name = asString(body.name);
      if (name === undefined || name === '') return unprocessable('name is required');
      const repo = forge.createRepo(forge.viewer.login, name, {
        description: asString(body.description) ?? undefined,
        private: body.private === true,
      });
      if (repo === null) return unprocessable(`Repository ${name} already exists`);
      return json(201, repoShape(forge, repo));
    }
    return notFound();
  }

  // /api/v3/repos/{owner}/{name}/...
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const rest = segments.slice(3);

    // GET/PATCH/DELETE /api/v3/repos/{owner}/{name}
    if (rest.length === 0) {
      const repo = ownedRepo(forge, owner, name);
      if (repo === undefined) return notFound();
      if (method === 'GET') return json(200, repoShape(forge, repo));
      if (method === 'DELETE') {
        forge.deleteRepo(owner, name);
        return json(204, null);
      }
      if (method === 'PATCH') {
        const body = bodyObject(request.body);
        if (body === null) return badRequest('A JSON object body is required');
        if (body.description !== undefined) repo.description = asString(body.description) ?? '';
        if (body.private !== undefined) repo.private = body.private === true;
        return json(200, repoShape(forge, repo));
      }
      return notFound();
    }

    const repo = ownedRepo(forge, owner, name);
    if (repo === undefined) return notFound();
    const base = repoUrl(forge, repo);

    // GET /repos/{o}/{r}/branches and /branches/{branch}
    if (rest[0] === 'branches') {
      if (rest.length === 1) {
        if (method !== 'GET') return notFound();
        const branches = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha, url: `${base}/commits/${sha}` }, protected: false }));
        const { page, link } = paginate(branches, query, `${base}/branches`);
        return json(200, page, linkHeaders(link));
      }
      if (rest.length === 2) {
        if (method !== 'GET') return notFound();
        const branch = rest[1] as string;
        const sha = forge.resolveRef(repo, branch);
        if (sha === undefined) return notFound();
        return json(200, { name: branch, commit: { sha, url: `${base}/commits/${sha}` }, protected: false, protection: { enabled: false } });
      }
      return notFound();
    }

    // GET /repos/{o}/{r}/commits
    if (rest[0] === 'commits' && rest.length === 1) {
      if (method !== 'GET') return notFound();
      const tip = resolveBranchRef(forge, repo, query.get('sha'));
      if (tip === undefined) return notFound();
      const commits = forge.listCommits(repo, tip);
      const { page, link } = paginate(commits, query, `${base}/commits`);
      const shaped = page.map((sha) => {
        const object = repo.objects.get(sha);
        if (object === undefined) return { sha };
        return commitShape(forge, repo, sha, object);
      });
      return json(200, shaped, linkHeaders(link));
    }

    // POST /repos/{o}/{r}/git/refs and GET /git/refs[/heads/{branch}]
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2) {
        if (method === 'POST') {
          const body = bodyObject(request.body);
          if (body === null) return badRequest('A JSON object body is required');
          const ref = asString(body.ref);
          const sha = asString(body.sha);
          if (ref === undefined || sha === undefined) return unprocessable('ref and sha are required');
          if (!ref.startsWith('refs/')) return unprocessable('ref must start with refs/');
          if (repo.refs.has(ref)) return unprocessable(`Reference ${ref} already exists`);
          if (!repo.objects.has(sha)) return unprocessable(`Object ${sha} does not exist`);
          repo.refs.set(ref, sha);
          return json(201, { ref, node_id: globalId('Ref', ref), object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `${base}/git/refs/${ref}` } });
        }
        if (method === 'GET') {
          const refs = sortedRefs(repo);
          return json(200, refs.map((ref) => ({ ref: ref.name, node_id: globalId('Ref', ref.name), object: { sha: ref.oid, type: repo.objects.get(ref.oid)?.type ?? 'commit', url: `${base}/git/refs/${ref.name}` } })));
        }
        return notFound();
      }
      if (rest.length === 4 && rest[2] === 'heads') {
        if (method !== 'GET') return notFound();
        const ref = `refs/heads/${rest[3] as string}`;
        const sha = repo.refs.get(ref);
        if (sha === undefined) return notFound();
        return json(200, { ref, node_id: globalId('Ref', ref), object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `${base}/git/refs/${ref}` } });
      }
      return notFound();
    }

    // Contents: GET/PUT/DELETE /repos/{o}/{r}/contents[/{path}]
    if (rest[0] === 'contents') {
      const path = cleanPath(rest.slice(1).join('/'));
      if (method === 'GET') {
        const tip = resolveBranchRef(forge, repo, query.get('ref'));
        if (tip === undefined) return notFound();
        const tree = forge.commitTree(repo, tip);
        if (tree === null) return notFound();
        const flat = forge.flattenTree(repo, tree);
        if (path === '') {
          // Root directory listing.
          const entries = new Map<string, { type: 'file' | 'dir'; oid: string; size: number }>();
          for (const [file, entry] of flat) {
            const first = file.split('/')[0] as string;
            if (file.includes('/')) {
              if (!entries.has(first)) entries.set(first, { type: 'dir', oid: '', size: 0 });
            } else {
              entries.set(first, { type: 'file', oid: entry.oid, size: blobSize(repo, entry.oid) });
            }
          }
          const list = [...entries.entries()].map(([entryName, entry]) => ({
            type: entry.type,
            size: entry.size,
            name: entryName,
            path: entryName,
            sha: entry.oid,
            url: `${base}/contents/${encodeURIComponent(entryName)}`,
            git_url: `${base}/git/blobs/${entry.oid}`,
            html_url: `${forge.apiBase()}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${entryName}`,
            download_url: entry.type === 'file' ? `${base}/contents/${encodeURIComponent(entryName)}` : null,
          }));
          return json(200, list);
        }
        const file = flat.get(path);
        if (file !== undefined) {
          const object = repo.objects.get(file.oid);
          const content = object !== undefined ? object.data.toString('base64') : '';
          return json(200, {
            type: 'file',
            encoding: 'base64',
            size: blobSize(repo, file.oid),
            name: path.split('/').pop() ?? path,
            path,
            content,
            sha: file.oid,
            url: `${base}/contents/${encodeURIComponent(path)}`,
            git_url: `${base}/git/blobs/${file.oid}`,
            html_url: `${forge.apiBase()}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
            download_url: `${base}/contents/${encodeURIComponent(path)}`,
          });
        }
        // A directory under the path.
        const prefix = `${path}/`;
        const children = new Map<string, { type: 'file' | 'dir'; oid: string; size: number }>();
        for (const [file, entry] of flat) {
          if (!file.startsWith(prefix)) continue;
          const restOf = file.slice(prefix.length);
          const first = restOf.split('/')[0] as string;
          if (restOf.includes('/')) {
            if (!children.has(first)) children.set(first, { type: 'dir', oid: '', size: 0 });
          } else {
            children.set(first, { type: 'file', oid: entry.oid, size: blobSize(repo, entry.oid) });
          }
        }
        if (children.size === 0) return notFound();
        const list = [...children.entries()].map(([childName, entry]) => ({
          type: entry.type,
          size: entry.size,
          name: childName,
          path: `${path}/${childName}`,
          sha: entry.oid,
          url: `${base}/contents/${encodeURIComponent(`${path}/${childName}`)}`,
          git_url: `${base}/git/blobs/${entry.oid}`,
          html_url: `${forge.apiBase()}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}/${childName}`,
          download_url: entry.type === 'file' ? `${base}/contents/${encodeURIComponent(`${path}/${childName}`)}` : null,
        }));
        return json(200, list);
      }
      if (method === 'PUT') {
        const body = bodyObject(request.body);
        if (body === null) return badRequest('A JSON object body is required');
        const contentB64 = asString(body.content);
        const message = asString(body.message) ?? `Update ${path}`;
        const branch = asString(body.branch) ?? repo.defaultBranch;
        if (contentB64 === undefined) return unprocessable('content is required');
        const content = Buffer.from(contentB64, 'base64');
        if (content.length === 0 && contentB64 !== '') return badRequest('content is not valid base64');
        // A stale sha is a conflict.
        const expectedSha = asString(body.sha);
        if (expectedSha !== undefined) {
          const tip = forge.resolveRef(repo, branch);
          const tree = tip === undefined ? null : forge.commitTree(repo, tip);
          const current = tree === null ? undefined : forge.flattenTree(repo, tree).get(path);
          if (current !== undefined && current.oid !== expectedSha) return conflict('sha does not match the current file');
        }
        const result = forge.commitFile(repo, { path, content, message, branch });
        const status = result.created ? 201 : 200;
        return json(status, {
          content: {
            type: 'file',
            encoding: 'base64',
            size: content.length,
            name: path.split('/').pop() ?? path,
            path,
            content: contentB64,
            sha: result.contentSha,
            url: `${base}/contents/${encodeURIComponent(path)}`,
            git_url: `${base}/git/blobs/${result.contentSha}`,
            html_url: `${forge.apiBase()}/${repo.owner}/${repo.name}/blob/${branch}/${path}`,
            download_url: `${base}/contents/${encodeURIComponent(path)}`,
          },
          commit: { sha: result.commitSha, message, url: `${base}/commits/${result.commitSha}` },
        });
      }
      if (method === 'DELETE') {
        const body = bodyObject(request.body);
        if (body === null) return badRequest('A JSON object body is required');
        const message = asString(body.message) ?? `Delete ${path}`;
        const branch = asString(body.branch) ?? repo.defaultBranch;
        const expectedSha = asString(body.sha);
        if (expectedSha !== undefined) {
          const tip = forge.resolveRef(repo, branch);
          const tree = tip === undefined ? null : forge.commitTree(repo, tip);
          const current = tree === null ? undefined : forge.flattenTree(repo, tree).get(path);
          if (current === undefined) return notFound();
          if (current.oid !== expectedSha) return conflict('sha does not match the current file');
        }
        const result = forge.deleteFile(repo, { path, message, branch });
        if (result === null) return notFound();
        return json(200, { commit: { sha: result.commitSha, message, url: `${base}/commits/${result.commitSha}` } });
      }
      return notFound();
    }

    // Labels: GET/POST /repos/{o}/{r}/labels
    if (rest[0] === 'labels' && rest.length === 1) {
      if (method === 'GET') {
        return json(200, [...repo.labels.values()].map((label) => labelShape(forge, repo, label)));
      }
      if (method === 'POST') {
        const body = bodyObject(request.body);
        if (body === null) return badRequest('A JSON object body is required');
        const name = asString(body.name);
        if (name === undefined || name === '') return unprocessable('name is required');
        const label = forge.createLabel(repo, name, asString(body.color) ?? 'ededed', asString(body.description) ?? '');
        return json(201, labelShape(forge, repo, label));
      }
      return notFound();
    }

    // Issues: POST/GET /repos/{o}/{r}/issues, GET/PATCH /issues/{n}, comments
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = bodyObject(request.body);
          if (body === null) return badRequest('A JSON object body is required');
          const title = asString(body.title);
          if (title === undefined || title === '') return unprocessable('title is required');
          const labelNames = Array.isArray(body.labels) ? body.labels.filter((value): value is string => typeof value === 'string') : [];
          const issue = forge.createIssue(repo, title, asString(body.body) ?? '', labelNames);
          if ('unknownLabel' in issue) return unprocessable(`Label ${issue.unknownLabel} does not exist`);
          return json(201, issueShape(forge, repo, issue));
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let issues = [...repo.issues];
          if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          if (sort === 'created') issues.sort((a, b) => a.createdSeq - b.createdSeq);
          if (direction === 'desc') issues.reverse();
          const { page, link } = paginate(issues, query, `${base}/issues`);
          return json(200, page.map((issue) => issueShape(forge, repo, issue)), linkHeaders(link));
        }
        return notFound();
      }
      const number = Number.parseInt(rest[1] as string, 10);
      if (!Number.isInteger(number)) return notFound();
      const issue = forge.getIssue(repo, number);
      if (issue === undefined) return notFound();
      if (rest.length === 2) {
        if (method === 'GET') return json(200, issueShape(forge, repo, issue));
        if (method === 'PATCH') {
          const body = bodyObject(request.body);
          if (body === null) return badRequest('A JSON object body is required');
          if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
          if (body.title !== undefined) {
            const title = asString(body.title);
            if (title !== undefined && title !== '') issue.title = title;
          }
          if (body.body !== undefined) issue.body = asString(body.body) ?? '';
          issue.updatedSeq = forge.nextSeq();
          return json(200, issueShape(forge, repo, issue));
        }
        return notFound();
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          const comments = repo.comments.get(number) ?? [];
          return json(200, comments.map((comment) => commentShape(forge, repo, number, comment)));
        }
        if (method === 'POST') {
          const body = bodyObject(request.body);
          if (body === null) return badRequest('A JSON object body is required');
          const text = asString(body.body);
          if (text === undefined || text === '') return unprocessable('body is required');
          const comment = forge.createComment(repo, number, text);
          if (comment === null) return notFound();
          return json(201, commentShape(forge, repo, number, comment));
        }
        return notFound();
      }
      return notFound();
    }

    // Pulls: POST/GET /repos/{o}/{r}/pulls, GET /pulls/{n}, GET /pulls/{n}/files, PUT /pulls/{n}/merge
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = bodyObject(request.body);
          if (body === null) return badRequest('A JSON object body is required');
          const title = asString(body.title);
          const head = asString(body.head);
          const baseBranch = asString(body.base);
          if (title === undefined || head === undefined || baseBranch === undefined) {
            return unprocessable('title, head and base are required');
          }
          const stripOwner = (ref: string): string => (ref.includes(':') ? (ref.split(':').slice(1).join(':') as string) : ref);
          const pull = forge.createPull(repo, title, asString(body.body) ?? '', stripOwner(head), stripOwner(baseBranch));
          if ('error' in pull) return unprocessable(pull.error);
          return json(201, pullShape(forge, repo, pull));
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let pulls = [...repo.pulls];
          if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          if (sort === 'created') pulls.sort((a, b) => a.createdSeq - b.createdSeq);
          if (direction === 'desc') pulls.reverse();
          const { page, link } = paginate(pulls, query, `${base}/pulls`);
          return json(200, page.map((pull) => pullShape(forge, repo, pull)), linkHeaders(link));
        }
        return notFound();
      }
      const number = Number.parseInt(rest[1] as string, 10);
      if (!Number.isInteger(number)) return notFound();
      const pull = forge.getPull(repo, number);
      if (pull === undefined) return notFound();
      if (rest.length === 2) {
        if (method === 'GET') return json(200, pullShape(forge, repo, pull));
        return notFound();
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (method !== 'GET') return notFound();
        const files = forge.pullFiles(repo, pull);
        return json(200, files.map((file) => ({
          sha: file.newOid ?? file.oldOid ?? '',
          filename: file.path,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.additions + file.deletions,
        })));
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (method !== 'PUT') return notFound();
        if (pull.state !== 'open') return json(405, { message: 'Pull request is not open' });
        const sha = forge.mergePull(repo, pull);
        if (sha === null) return json(405, { message: 'Merge conflict' });
        return json(200, { sha, merged: true, message: 'Pull request successfully merged' });
      }
      return notFound();
    }
  }

  return notFound();
}
