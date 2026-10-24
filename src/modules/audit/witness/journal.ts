import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { constants } from 'node:fs';
import { open, unlink, mkdir, realpath, lstat, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { Checkpoint, ExternalAnchor } from '../contracts/anchors.js';
import { canonicalJson } from '../domain/cryptography.js';
import { referenceFor, requireCheckpoint, signingBody, validateAnchor, ZERO_HASH } from './protocol.js';

async function requireSingleFile(file: FileHandle, path: string): Promise<void> {
  const [active, named] = await Promise.all([file.stat(), lstat(path)]);
  if (!active.isFile() || active.nlink !== 1 || !named.isFile() || named.isSymbolicLink() || named.nlink !== 1
    || active.dev !== named.dev || active.ino !== named.ino) throw new Error('Witness journal or writer lock has an unsafe file alias');
}

export class WitnessConflict extends Error {}
export interface JournalOptions { namespace: string; journalPath: string; privateKey: string }
/** This journal belongs to the independently operated witness, never the audited application. */
export class WitnessJournal {
  private readonly privateKey;
  private readonly publicKey;
  private readonly heads = new Map<string, ExternalAnchor>();
  private readonly receipts = new Map<string, ExternalAnchor>();
  private queue: Promise<unknown> = Promise.resolve();
  private failed = false;
  private closed = false;
  private bytes = 0;
  private constructor(private readonly options: JournalOptions, private readonly file: FileHandle,
    private readonly lock: FileHandle, private readonly lockPath: string, private readonly journalPath: string) {
    this.privateKey = createPrivateKey(options.privateKey);
    if (this.privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Witness private key must be Ed25519');
    this.publicKey = createPublicKey(this.privateKey);
  }
  static async open(options: JournalOptions): Promise<WitnessJournal> {
    const requested = resolve(options.journalPath);
    await mkdir(dirname(requested), { recursive: true, mode: 0o700 });
    const path = join(await realpath(dirname(requested)), basename(requested));
    const lockPath = `${path}.lock`;
    // Never automatically delete a stale lock: PID reuse / shared filesystems can create two writers.
    const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw new Error('Witness journal writer lock exists; operator must verify prior writer stopped'); });
    let file: FileHandle | undefined;
    try {
      await requireSingleFile(lock, lockPath);
      await lock.writeFile(`${String(process.pid)}\n`); await lock.sync();
      // NOFOLLOW blocks leaf symlinks on POSIX; lstat/fstat also checks identity and aliases on Windows.
      const flags = constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
      file = await open(path, flags, 0o600);
      await requireSingleFile(file, path);
      const journal = new WitnessJournal(options, file, lock, lockPath, path);
      const stat = await file.stat();
      if (stat.size > 64 * 1024 * 1024) throw new Error('Witness journal exceeds replay limit');
      journal.bytes = stat.size;
      const content = await file.readFile('utf8');
      if (content && !content.endsWith('\n')) throw new Error('Truncated witness journal');
      const lines = content ? content.slice(0, -1).split('\n') : [];
      for (const line of lines) {
        if (!line || line.length > 16384) throw new Error('Invalid witness journal entry');
        const candidate: unknown = JSON.parse(line);
        const auctionId = (candidate as { auctionId?: unknown } | null)?.auctionId;
        if (typeof auctionId !== 'string') throw new Error('Invalid witness journal auction');
        const receipt = validateAnchor(candidate, options.namespace, auctionId, journal.publicKey);
        journal.checkPrevious(receipt.auctionId, receipt.previousSequence, receipt.previousHash, receipt.sequence);
        if (journal.receipts.has(journal.key(receipt))) throw new Error('Duplicate witness journal sequence');
        journal.remember(receipt);
      }
      await file.sync();
      // Persist the initial directory entry on filesystems supporting directory fsync (POSIX).
      if (process.platform !== 'win32') {
        const directory = await open(dirname(path), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
      return journal;
    } catch (error) {
      await file?.close(); await lock.close(); await unlink(lockPath);
      throw new Error('Witness journal startup failed', { cause: error });
    }
  }
  private key(checkpoint: Checkpoint): string { return `${checkpoint.auctionId}:${checkpoint.sequence}`; }
  private remember(receipt: ExternalAnchor): void {
    this.heads.set(receipt.auctionId, receipt); this.receipts.set(this.key(receipt), receipt);
  }
  private checkPrevious(auctionId: string, previousSequence: string, previousHash: string, sequence: string): void {
    const head = this.heads.get(auctionId);
    if (previousSequence !== (head?.sequence ?? '0') || previousHash !== (head?.hash ?? ZERO_HASH)
      || BigInt(sequence) <= BigInt(previousSequence)) throw new WitnessConflict('Checkpoint CAS conflict');
  }
  latest(auctionId: string): ExternalAnchor | null {
    if (this.failed || this.closed) throw new Error('Witness journal unavailable');
    return this.heads.get(auctionId) ?? null;
  }
  append(checkpoint: Checkpoint, previousValue: unknown): Promise<ExternalAnchor> {
    const operation = this.queue.then(async () => {
      if (this.failed || this.closed) throw new Error('Witness journal unavailable');
      try {
        await Promise.all([requireSingleFile(this.file, this.journalPath), requireSingleFile(this.lock, this.lockPath)]);
      } catch (error) { this.failed = true; throw error; }
      requireCheckpoint(checkpoint);
      const previous = previousValue as { sequence: string; hash: string } | null | undefined;
      if (previous !== null && (!previous || typeof previous !== 'object'
        || Object.keys(previous).sort().join(',') !== 'hash,sequence'
        || typeof previous.sequence !== 'string' || !/^[1-9][0-9]{0,77}$/.test(previous.sequence)
        || typeof previous.hash !== 'string' || !/^[a-f0-9]{64}$/.test(previous.hash))) throw new Error('Invalid previous checkpoint');
      const old = this.receipts.get(this.key(checkpoint));
      if (old) {
        if (old.hash !== checkpoint.hash) throw new WitnessConflict('Checkpoint already published with a different hash');
        return old;
      }
      const previousSequence = previous?.sequence ?? '0';
      const previousHash = previous?.hash ?? ZERO_HASH;
      this.checkPrevious(checkpoint.auctionId, previousSequence, previousHash, checkpoint.sequence);
      const body = { ...checkpoint, namespace: this.options.namespace, previousSequence, previousHash, publishedAt: new Date().toISOString() };
      const unsigned = { ...body, reference: referenceFor(body) };
      const receipt = { ...unsigned, signature: sign(null, signingBody(unsigned), this.privateKey).toString('base64') };
      const line = `${canonicalJson(receipt)}\n`;
      const bytes = Buffer.byteLength(line);
      if (this.bytes + bytes > 64 * 1024 * 1024) throw new Error('Witness journal capacity exceeded');
      try {
        await this.file.writeFile(line); await this.file.sync();
      } catch (error) { this.failed = true; throw error; }
      this.bytes += bytes;
      this.remember(receipt);
      return receipt;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    await this.file.close(); await this.lock.close(); await unlink(this.lockPath);
  }
}
