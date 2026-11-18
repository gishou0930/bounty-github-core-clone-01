import { createApp } from './app.ts';

const env = process.env.MAKEFUN_ENV_URL?.replace(/\/$/, '');
if (!env) throw new Error('MAKEFUN_ENV_URL is required');
const server = createApp();
await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
const port = server.address().port;
console.log(`Forge listening on ${port}`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let registered = false;
while (!registered) {
  try {
    const response = await fetch(`${env}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port }), signal: AbortSignal.timeout(30000) });
    registered = response.ok || response.status === 409;
    if (response.status === 400 || response.status === 405) throw new Error('Registration contract rejected');
  } catch (err) {
    if (err.message === 'Registration contract rejected') throw err;
  }
  if (!registered) await pause(500);
}
for (;;) {
  try {
    const response = await fetch(`${env}/done`, { signal: AbortSignal.timeout(30000) });
    if (response.ok && (await response.json()).done === true) break;
  } catch { /* Retry a transient environment outage while serving the forge. */ }
  await pause(500);
}
server.closeAllConnections();
await new Promise(resolve => server.close(resolve));
process.exit(0);
