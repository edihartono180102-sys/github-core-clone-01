// HTTP front door: one server, four surfaces. Routes the request to the
// git, REST, GraphQL, or MCP handler, always answering JSON (never HTML)
// on the JSON surfaces and never letting a handler error kill the process.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { infoRefs, receivePack, uploadPackV0, uploadPackV2 } from './git.ts';
import { handleGraphQL, handleMcp, handleRest, type RequestContext, type Response } from './api.ts';

const MAX_BODY_BYTES = 256 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function writeResponse(res: ServerResponse, response: Response): void {
  const body = typeof response.body === 'string' ? Buffer.from(response.body, 'utf8') : response.body;
  res.writeHead(response.status, {
    'content-length': body.length,
    ...(response.headers ?? {}),
  });
  res.end(body);
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  const body = Buffer.from(JSON.stringify({ message }), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length });
  res.end(body);
}

export function createApp(store: Store, token: string | undefined): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const method = req.method ?? 'GET';
      const headers = new Map<string, string>();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers.set(k.toLowerCase(), v);
        else if (Array.isArray(v) && v.length > 0) headers.set(k.toLowerCase(), v[0] as string);
      }
      const body = method === 'GET' || method === 'HEAD' || method === 'DELETE' ? Buffer.alloc(0) : await readBody(req);

      // Health, no auth.
      if (path === '/healthz' && method === 'GET') {
        const out = Buffer.from(JSON.stringify({ ok: true }), 'utf8');
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': out.length });
        res.end(out);
        return;
      }

      const ctx: RequestContext = { method, path, query: url.searchParams, headers, body, token };

      // JSON surfaces.
      if (path.startsWith('/api/v3')) {
        writeResponse(res, handleRest(store, ctx));
        return;
      }
      if (path === '/api/graphql') {
        if (method !== 'POST') {
          jsonError(res, 405, 'Method not allowed');
          return;
        }
        writeResponse(res, handleGraphQL(store, ctx));
        return;
      }
      if (path === '/mcp') {
        writeResponse(res, handleMcp(store, ctx));
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/...
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
      if (gitMatch) {
        const owner = decodeURIComponent(gitMatch[1] as string);
        const repoName = decodeURIComponent(gitMatch[2] as string);
        const tail = gitMatch[3] as string;
        if (tail === 'info/refs' && method === 'GET') {
          const service = url.searchParams.get('service') ?? '';
          if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
            res.writeHead(400, { 'content-type': 'text/plain' });
            res.end('unknown service\n');
            return;
          }
          const wantV2 = service === 'git-upload-pack' && headers.get('git-protocol') === 'version=2';
          const result = infoRefs(store, owner, repoName, service, wantV2);
          const out = result.body;
          res.writeHead(result.status, { 'content-type': result.contentType, 'content-length': out.length });
          res.end(out);
          return;
        }
        const repo = store.getRepo(owner, repoName);
        if (!repo) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('repository not found\n');
          return;
        }
        if (tail === 'git-upload-pack' && method === 'POST') {
          const wantV2 = headers.get('git-protocol') === 'version=2';
          const result = wantV2 ? uploadPackV2(store, repo, body) : uploadPackV0(store, repo, body);
          res.writeHead(result.status, { 'content-type': result.contentType, 'content-length': result.body.length });
          res.end(result.body);
          return;
        }
        if (tail === 'git-receive-pack' && method === 'POST') {
          const result = receivePack(store, repo, body);
          res.writeHead(result.status, { 'content-type': result.contentType, 'content-length': result.body.length });
          res.end(result.body);
          return;
        }
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found\n');
        return;
      }

      // Anything else: JSON 404.
      jsonError(res, 404, 'Not Found');
    } catch (e) {
      // Never crash on a bad request; the suite re-clones after errors.
      try {
        jsonError(res, 500, e instanceof Error ? e.message : 'internal error');
      } catch {
        // The socket is already gone; nothing more to do.
      }
    }
  });
}
