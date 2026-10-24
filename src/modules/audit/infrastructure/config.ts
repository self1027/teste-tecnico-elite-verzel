import { z } from 'zod';

export function readAuditConfig(env: Record<string, string | undefined>) {
  if (!env.AUDIT_WITNESS_URL) {
    if (env.AUDIT_WITNESS_NAMESPACE || env.AUDIT_WITNESS_PUBLIC_KEY_FILE || env.AUDIT_WITNESS_PUBLISH_TOKEN) throw new Error('Incomplete audit witness configuration');
    return null;
  }
  const value = z.object({
    AUDIT_WITNESS_URL: z.url().refine((url) => ['http:', 'https:'].includes(new URL(url).protocol)),
    AUDIT_WITNESS_NAMESPACE: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    AUDIT_WITNESS_PUBLIC_KEY_FILE: z.string().min(1),
    AUDIT_WITNESS_PUBLISH_TOKEN: z.string().min(16).optional(),
    AUDIT_WITNESS_TIMEOUT_MS: z.coerce.number().int().min(1).max(30000).default(5000),
    AUDIT_ANCHOR_POLL_MS: z.coerce.number().int().min(100).max(3600000).default(5000),
  }).parse(env);
  return { baseUrl: value.AUDIT_WITNESS_URL, namespace: value.AUDIT_WITNESS_NAMESPACE,
    publicKeyFile: value.AUDIT_WITNESS_PUBLIC_KEY_FILE, publishToken: value.AUDIT_WITNESS_PUBLISH_TOKEN,
    timeoutMs: value.AUDIT_WITNESS_TIMEOUT_MS, pollMs: value.AUDIT_ANCHOR_POLL_MS };
}
