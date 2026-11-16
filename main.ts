// The entrypoint: bind a port, register with the trial environment, answer
// health probes, then wait for the environment to say the trial is done.

import { Forge } from './src/store.ts';
import { createServer } from './src/app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url: string, body: unknown, timeoutMs: number): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { status: response.status, text: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function register(port: number): Promise<boolean> {
  if (envUrl === '') return false;
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const answer = await postJson(`${envUrl}/register`, { port }, 5_000);
      if (answer.status >= 200 && answer.status < 300) return true;
      process.stderr.write(`register answered HTTP ${answer.status}: ${answer.text}\n`);
    } catch (error) {
      process.stderr.write(`register failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    if (Date.now() >= deadline) return false;
    await sleep(1_000);
  }
}

async function waitForDone(): Promise<void> {
  if (envUrl === '') {
    // No environment: run until killed (local development).
    await new Promise(() => undefined);
    return;
  }
  for (;;) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 65_000);
      let done = false;
      try {
        const response = await fetch(`${envUrl}/done`, { signal: controller.signal });
        if (response.ok) {
          const body = (await response.json()) as { done?: unknown };
          done = body.done === true;
        }
      } finally {
        clearTimeout(timer);
      }
      if (done) return;
    } catch {
      // The environment holds the long poll; a dropped poll just restarts.
      await sleep(1_000);
    }
  }
}

async function main(): Promise<void> {
  const forge = new Forge();
  const server = createServer(forge, { token });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the server did not bind a port'));
        return;
      }
      resolve(address.port);
    });
  });
  process.stderr.write(`forge listening on 127.0.0.1:${port}\n`);
  const registered = await register(port);
  if (envUrl !== '' && !registered) {
    process.stderr.write('could not register with the trial environment; exiting\n');
    server.close();
    process.exit(1);
  }
  await waitForDone();
  server.close();
  process.exit(0);
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

main().catch((error) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
