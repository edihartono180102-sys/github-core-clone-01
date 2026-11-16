// The HTTP server: one Node http server routing health, git smart HTTP, REST v3,
// GraphQL v4 and MCP onto the one Forge store. No framework, no git binary.

import http from 'node:http';
import { Forge } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, type GitResult } from './gitproto.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const MAX_BODY_BYTES = 128 * 1024 * 1024;

export interface ServerOptions {
  /** The shop token the env gave this trial; empty means accept any Bearer token. */
  readonly token: string;
}

function readBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function parseJsonBody(body: Buffer): { value: unknown; error: boolean } {
  if (body.length === 0) return { value: undefined, error: false };
  try {
    return { value: JSON.parse(body.toString('utf8')) as unknown, error: false };
  } catch {
    return { value: undefined, error: true };
  }
}

function jsonResponse(response: http.ServerResponse, requestId: string, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const text = body === null ? '' : JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': requestId,
    ...(extraHeaders ?? {}),
  });
  response.end(text);
}

export function createServer(forge: Forge, options: ServerOptions): http.Server {
  let requestCounter = 0;

  return http.createServer((request, response) => {
    void (async () => {
      requestCounter += 1;
      const requestId = `req-${requestCounter}`;
      try {
        const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
        const method = request.method ?? 'GET';
        const path = url.pathname;
        const baseUrl = `http://${request.headers.host ?? '127.0.0.1'}`;

        // GET /healthz — the boot probe; no auth, no body.
        if (path === '/healthz') {
          if (method !== 'GET') {
            jsonResponse(response, requestId, 404, { message: 'Not Found' });
            return;
          }
          response.writeHead(200, { 'content-type': 'text/plain', 'x-github-request-id': requestId });
          response.end('ok');
          return;
        }

        // Every other route needs a Bearer token.
        const authorization = request.headers.authorization ?? '';
        const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
        const authorized = bearer !== '' && (options.token === '' || bearer === options.token);
        if (!authorized) {
          jsonResponse(response, requestId, 401, { message: 'Requires authentication' });
          return;
        }

        // POST /mcp — JSON-RPC; DELETE /mcp closes a legacy session.
        if (path === '/mcp') {
          if (method === 'DELETE') {
            response.writeHead(204, { 'x-github-request-id': requestId });
            response.end();
            return;
          }
          if (method !== 'POST') {
            jsonResponse(response, requestId, 405, { message: 'Method Not Allowed' });
            return;
          }
          const body = await readBody(request);
          const parsed = parseJsonBody(body);
          const result = handleMcp(forge, parsed.value, parsed.error);
          if (typeof result.body === 'string' && result.body === '') {
            response.writeHead(result.status, { 'x-github-request-id': requestId });
            response.end();
            return;
          }
          jsonResponse(response, requestId, result.status, result.body);
          return;
        }

        // POST /api/graphql — one operation or a batch array.
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            jsonResponse(response, requestId, 405, { message: 'Method Not Allowed' });
            return;
          }
          const body = await readBody(request);
          const parsed = parseJsonBody(body);
          if (parsed.error) {
            jsonResponse(response, requestId, 400, { errors: [{ message: 'Request body is not valid JSON.' }] });
            return;
          }
          forge.setApiBase(baseUrl);
          const result = handleGraphQL(forge, parsed.value);
          jsonResponse(response, requestId, result.status, result.body);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repoName = decodeURIComponent(gitMatch[2] as string);
          const tail = gitMatch[3] as string;
          const repo = owner === forge.viewer.login ? forge.getRepo(owner, repoName) : undefined;
          const gitProtocol = request.headers['git-protocol'] === 'version=2' ? 2 : 0;
          let result: GitResult;
          if (tail === 'info/refs') {
            const service = url.searchParams.get('service');
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              jsonResponse(response, requestId, 400, { message: 'info/refs requires a service parameter' });
              return;
            }
            result = handleInfoRefs(forge, repo, service, gitProtocol);
          } else if (tail === 'git-upload-pack' && method === 'POST') {
            const body = await readBody(request);
            result = handleUploadPack(forge, repo, body, gitProtocol);
          } else if (tail === 'git-receive-pack' && method === 'POST') {
            const body = await readBody(request);
            result = handleReceivePack(forge, repo, body);
          } else {
            jsonResponse(response, requestId, 404, { message: 'Not Found' });
            return;
          }
          response.writeHead(result.status, {
            'content-type': result.contentType,
            'x-github-request-id': requestId,
          });
          response.end(result.body);
          return;
        }

        // REST v3: /api/v3/...
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const restPath = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
          const segments = restPath === '' ? [] : restPath.split('/').map((segment) => decodeURIComponent(segment));
          const body = await readBody(request);
          const parsed = body.length === 0 ? { value: undefined, error: false } : parseJsonBody(body);
          const result = handleRest({
            forge,
            method,
            segments,
            query: url.searchParams,
            body: parsed.value,
            bodyError: parsed.error,
            baseUrl,
          });
          jsonResponse(response, requestId, result.status, result.body, result.headers);
          return;
        }

        jsonResponse(response, requestId, 404, { message: 'Not Found' });
      } catch (error) {
        if (!response.headersSent) {
          jsonResponse(response, requestId, 500, { message: error instanceof Error ? error.message : 'Internal Server Error' });
        } else {
          response.end();
        }
      }
    })();
  });
}
