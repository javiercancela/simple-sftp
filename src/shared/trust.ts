import { z } from 'zod';

export const TRUST_FILE_VERSION = 1;

export const TrustedHostSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    algorithm: z.string().min(1),
    fingerprintSha256: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
    addedAt: z.string(),
  })
  .strict();
export type TrustedHost = z.infer<typeof TrustedHostSchema>;

export const TrustFileSchema = z
  .object({
    version: z.literal(TRUST_FILE_VERSION),
    hosts: z.record(z.string(), TrustedHostSchema),
  })
  .strict();
export type TrustFile = z.infer<typeof TrustFileSchema>;

/** Normalized trust-store key: host lowercased, IPv6 bracketed, plus port. */
export function trustKeyFor(host: string, port: number): string {
  const h = host
    .trim()
    .replace(/^\[(.*)\]$/, '$1')
    .toLowerCase();
  return h.includes(':') ? `[${h}]:${port}` : `${h}:${port}`;
}
