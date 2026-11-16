// MCP: JSON-RPC 2.0 Streamable HTTP over POST /mcp, modern era 2026-07-28 with
// the legacy initialize handshake as a fallback. Plain JSON responses; the six
// tools act on the same store as REST, GraphQL and git.

import { Forge, globalId, type Repo } from './store.ts';

export interface McpResult {
  readonly status: number;
  readonly body: unknown;
}

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28'] as const;
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, Record<string, unknown>>>;
    readonly required?: readonly string[];
    readonly additionalProperties?: boolean;
  };
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

function serverInfo(): { name: string; version: string } {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

function ok(id: unknown, result: unknown): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): McpResult {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { status: 200, body: { jsonrpc: '2.0', id, error } };
}

function toolResult(structured: unknown): Record<string, unknown> {
  const text = JSON.stringify(structured);
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoShape(forge: Forge, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: forge.viewer.id },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: forge.isoAt(repo.createdSeq),
    html_url: `${forge.apiBase()}/${repo.owner}/${repo.name}`,
    url: `${forge.apiRoot()}/repos/${repo.owner}/${repo.name}`,
  };
}

function findRepo(forge: Forge, args: Record<string, unknown>): Repo | null {
  const owner = args.owner;
  const repo = args.repo;
  if (typeof owner !== 'string' || typeof repo !== 'string') return null;
  if (owner !== forge.viewer.login) return null;
  return forge.getRepo(owner, repo) ?? null;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = args.name;
      if (typeof repoName !== 'string' || repoName === '') return toolError('create_repo requires a non-empty name.');
      const repo = forge.createRepo(forge.viewer.login, repoName, {
        description: typeof args.description === 'string' ? args.description : undefined,
        private: args.private === true,
      });
      if (repo === null) return toolError(`Repository ${repoName} already exists.`);
      return toolResult(repoShape(forge, repo));
    }
    case 'get_repo': {
      const repo = findRepo(forge, args);
      if (repo === null) return toolError('Repository not found.');
      return toolResult(repoShape(forge, repo));
    }
    case 'create_issue': {
      const repo = findRepo(forge, args);
      if (repo === null) return toolError('Repository not found.');
      const title = args.title;
      if (typeof title !== 'string' || title === '') return toolError('create_issue requires a non-empty title.');
      const issue = forge.createIssue(repo, title, typeof args.body === 'string' ? args.body : '', []);
      if ('unknownLabel' in issue) return toolError(`Label ${issue.unknownLabel} does not exist.`);
      return toolResult({
        id: issue.id,
        node_id: globalId('Issue', issue.id),
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        html_url: `${forge.apiBase()}/${repo.owner}/${repo.name}/issues/${issue.number}`,
        url: `${forge.apiRoot()}/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
      });
    }
    case 'list_issues': {
      const repo = findRepo(forge, args);
      if (repo === null) return toolError('Repository not found.');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => b.createdSeq - a.createdSeq);
      return toolResult({
        issues: issues.map((issue) => ({
          id: issue.id,
          node_id: globalId('Issue', issue.id),
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          html_url: `${forge.apiBase()}/${repo.owner}/${repo.name}/issues/${issue.number}`,
        })),
      });
    }
    case 'create_pull_request': {
      const repo = findRepo(forge, args);
      if (repo === null) return toolError('Repository not found.');
      const title = args.title;
      const head = args.head;
      const base = args.base;
      if (typeof title !== 'string' || typeof head !== 'string' || typeof base !== 'string') {
        return toolError('create_pull_request requires title, head and base.');
      }
      const pull = forge.createPull(repo, title, typeof args.body === 'string' ? args.body : '', head, base);
      if ('error' in pull) return toolError(pull.error);
      return toolResult({
        id: pull.id,
        node_id: globalId('PullRequest', pull.id),
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: pull.head, sha: forge.resolveRef(repo, pull.head) ?? null },
        base: { ref: pull.base, sha: forge.resolveRef(repo, pull.base) ?? null },
        merged: false,
        html_url: `${forge.apiBase()}/${repo.owner}/${repo.name}/pull/${pull.number}`,
      });
    }
    case 'merge_pull_request': {
      const repo = findRepo(forge, args);
      if (repo === null) return toolError('Repository not found.');
      const number = args.pull_number;
      if (typeof number !== 'number' || !Number.isInteger(number)) return toolError('merge_pull_request requires an integer pull_number.');
      const pull = forge.getPull(repo, number);
      if (pull === undefined) return toolError(`Pull request #${number} does not exist.`);
      if (pull.state !== 'open') return toolError(`Pull request #${number} is not open.`);
      const sha = forge.mergePull(repo, pull);
      if (sha === null) return toolError('Pull request cannot be merged (merge conflict).');
      return toolResult({ number: pull.number, merged: true, state: 'closed', sha });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

/**
 * Handle one POST /mcp body. `body` is the parsed JSON (or undefined when the
 * body was not JSON); `bodyError` is true exactly then.
 */
export function handleMcp(forge: Forge, body: unknown, bodyError: boolean): McpResult {
  if (bodyError) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: the body is not valid JSON.' } } };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: the body must be a JSON-RPC object.' } } };
  }
  const request = body as Record<string, unknown>;
  const id = request.id;
  const method = request.method;
  // A notification has no id: it gets no JSON-RPC answer.
  if (id === undefined) {
    return { status: 202, body: '' };
  }
  if (typeof method !== 'string' || method === '') {
    return rpcError(id, -32600, 'Invalid Request: a method string is required.');
  }
  const params = (request.params ?? {}) as Record<string, unknown>;

  switch (method) {
    case 'server/discover': {
      const info = serverInfo();
      return ok(id, {
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: info,
        _meta: { 'io.modelcontextprotocol/serverInfo': info },
      });
    }
    case 'initialize': {
      const requested = params.protocolVersion;
      const known = [...SUPPORTED_VERSIONS, ...LEGACY_VERSIONS] as readonly string[];
      const negotiated = typeof requested === 'string' && known.includes(requested) ? requested : '2026-07-28';
      return ok(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: serverInfo(),
      });
    }
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      // The same array, serialized the same way, on every call.
      return ok(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string' || name === '') return rpcError(id, -32602, 'tools/call requires a tool name.');
      const tool = TOOLS.find((entry) => entry.name === name);
      if (tool === undefined) return rpcError(id, -32601, `Unknown tool: ${name}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        return rpcError(id, -32602, 'tools/call requires an arguments object.');
      }
      const required = tool.inputSchema.required ?? [];
      const missing = required.filter((key) => args[key] === undefined);
      if (missing.length > 0) {
        return rpcError(id, -32602, `Missing required argument(s): ${missing.join(', ')}`);
      }
      return ok(id, callTool(forge, name, args));
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
