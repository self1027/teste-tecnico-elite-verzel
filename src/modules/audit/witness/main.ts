import { readFile } from 'node:fs/promises';
import { createWitnessServer } from './server.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
async function main(): Promise<void> {
  const port = Number(process.env.WITNESS_PORT ?? '8081');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid WITNESS_PORT');
  const witness = await createWitnessServer({
    namespace: required('WITNESS_NAMESPACE'), journalPath: required('WITNESS_JOURNAL_PATH'),
    privateKey: await readFile(required('WITNESS_PRIVATE_KEY_FILE'), 'utf8'), publishToken: required('WITNESS_PUBLISH_TOKEN'),
  });
  const server = witness.app.listen(port, process.env.WITNESS_HOST ?? '0.0.0.0');
  server.on('error', () => { console.error('Witness HTTP startup failed'); process.exitCode = 1; void witness.close().catch(() => {}); });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { server.close(() => { void witness.close().catch(() => { process.exitCode = 1; }); }); });
  }
}
main().catch(() => { console.error('Witness startup failed; verify journal, key file and required WITNESS_* configuration'); process.exitCode = 1; });
