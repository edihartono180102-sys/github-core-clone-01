// Entry point: bind an ephemeral port, register it with the suite, then
// long-poll the done endpoint until the trial ends and exit cleanly.

import { createApp } from './app.ts';
import { Store } from './store.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function postJson(url: string, payload: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, text: await res.text() };
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json() as Promise<unknown>;
}

async function main(): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (!envUrl) {
    console.error('MAKEFUN_ENV_URL is not set');
    process.exit(1);
  }
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  const store = new Store();
  const server = createApp(store, token);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    console.error('could not bind a port');
    process.exit(1);
  }
  const port = address.port;

  // Register with the suite, retrying until the suite answers.
  let registered = false;
  for (let attempt = 0; attempt < 120 && !registered; attempt += 1) {
    try {
      const { status } = await postJson(`${envUrl}/register`, { port });
      if (status >= 200 && status < 300) registered = true;
    } catch {
      // The suite may not be listening yet; keep trying.
    }
    if (!registered) await sleep(500);
  }
  if (!registered) {
    console.error('could not register with the suite');
    process.exit(1);
  }

  // Long-poll until the trial is done.
  for (;;) {
    try {
      const done = (await getJson(`${envUrl}/done`)) as { done?: boolean };
      if (done.done === true) break;
    } catch {
      // A transient failure is not the end of the trial.
    }
    await sleep(500);
  }
  server.close();
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
