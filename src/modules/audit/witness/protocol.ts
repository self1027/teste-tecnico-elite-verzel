import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { Checkpoint, ExternalAnchor } from '../contracts/anchors.js';
import { canonicalJson } from '../domain/cryptography.js';

export const ZERO_HASH = '0'.repeat(64);
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const hash = /^[a-f0-9]{64}$/;
const sequence = /^[1-9][0-9]{0,77}$/;
export function requireIdentifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !identifier.test(value)) throw new Error('Invalid witness identifier');
}
export function requireCheckpoint(value: unknown): asserts value is Checkpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid checkpoint');
  const checkpoint = value as Record<string, unknown>;
  if (Object.keys(checkpoint).sort().join(',') !== 'auctionId,hash,sequence') throw new Error('Invalid checkpoint fields');
  requireIdentifier(checkpoint.auctionId);
  if (typeof checkpoint.sequence !== 'string' || !sequence.test(checkpoint.sequence)) throw new Error('Invalid checkpoint sequence');
  if (typeof checkpoint.hash !== 'string' || !hash.test(checkpoint.hash)) throw new Error('Invalid checkpoint hash');
}
export function signingBody(anchor: Omit<ExternalAnchor, 'signature'>): Buffer {
  return Buffer.from(`auction-audit-anchor:v1\n${canonicalJson(anchor)}`);
}
export function referenceFor(body: Omit<ExternalAnchor, 'signature' | 'reference'>): string {
  return `sha256:${createHash('sha256').update(`auction-audit-anchor-reference:v1\n${canonicalJson(body)}`).digest('hex')}`;
}
export function pinnedKey(value: string): KeyObject {
  const key = createPublicKey(value);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Witness public key must be Ed25519');
  return key;
}
export function validateAnchor(value: unknown, namespace: string, auctionId: string, publicKey: KeyObject): ExternalAnchor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid anchor');
  const candidate = value as ExternalAnchor;
  const fields = 'auctionId,hash,namespace,previousHash,previousSequence,publishedAt,reference,sequence,signature';
  if (Object.keys(candidate).sort().join(',') !== fields) throw new Error('Invalid anchor fields');
  requireCheckpoint({ auctionId: candidate.auctionId, sequence: candidate.sequence, hash: candidate.hash });
  if (candidate.namespace !== namespace || candidate.auctionId !== auctionId) throw new Error('Witness namespace or auction mismatch');
  if (typeof candidate.previousSequence !== 'string' || !(candidate.previousSequence === '0' || sequence.test(candidate.previousSequence))) throw new Error('Invalid previous sequence');
  if (BigInt(candidate.previousSequence) >= BigInt(candidate.sequence)) throw new Error('Invalid previous sequence');
  if (typeof candidate.previousHash !== 'string' || !hash.test(candidate.previousHash)) throw new Error('Invalid previous hash');
  if (candidate.previousSequence === '0' && candidate.previousHash !== ZERO_HASH) throw new Error('Invalid genesis');
  if (typeof candidate.publishedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(candidate.publishedAt)
    || !Number.isFinite(Date.parse(candidate.publishedAt)) || new Date(candidate.publishedAt).toISOString() !== candidate.publishedAt) throw new Error('Invalid anchor date');
  const { signature, reference, ...body } = candidate;
  if (reference !== referenceFor(body)) throw new Error('Invalid anchor reference');
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)
    || !verify(null, signingBody({ ...body, reference }), publicKey, Buffer.from(signature, 'base64'))) throw new Error('Invalid witness signature');
  return candidate;
}
