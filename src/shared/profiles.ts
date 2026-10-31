// Profile schema and validation. Pure: no Electron/Node imports.
import { z } from 'zod';

export const PROFILES_FILE_VERSION = 1;

const LABEL = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function isIpv6(v: string): boolean {
  if (!/^[0-9A-Fa-f:.]+$/.test(v) || !v.includes(':')) return false;
  const parts = v.split('::');
  if (parts.length > 2) return false;
  const groups = (s: string): string[] => (s === '' ? [] : s.split(':'));
  const all = parts.flatMap(groups);
  const last = all[all.length - 1];
  let count = all.length;
  if (last !== undefined && last.includes('.')) {
    if (!IPV4.test(last)) return false;
    count += 1; // embedded IPv4 takes two groups
    all.pop();
  }
  if (!all.every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g))) return false;
  return parts.length === 2 ? count < 8 : count === 8;
}

/** DNS name, IPv4 or IPv6 (brackets stripped). No scheme, path, user or port. */
export function normalizeHostInput(raw: string): string {
  const v = raw.trim();
  const m = /^\[(.*)\]$/.exec(v);
  return (m?.[1] ?? v).toLowerCase();
}

export function isValidHost(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  if (IPV4.test(host)) return true;
  if (host.includes(':')) return isIpv6(host);
  if (/^\d+(\.\d+)*$/.test(host)) return false; // looks numeric but is not IPv4
  const labels = host.replace(/\.$/, '').split('.');
  return labels.every((l) => LABEL.test(l));
}

/** Absolute local path on POSIX or Windows (checked again in main). */
export function looksAbsoluteLocalPath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

const noControl = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
};

const LocalPath = z
  .string()
  .max(4096)
  .refine(noControl, 'Contains control characters')
  .refine(looksAbsoluteLocalPath, 'Must be an absolute path');

export const AUTH_MODES = ['privateKey', 'privateKeyAndCertificate'] as const;

export const ProfileInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Name is required')
      .max(100)
      .refine(noControl, 'Invalid characters'),
    host: z
      .string()
      .transform(normalizeHostInput)
      .refine(isValidHost, 'Enter a DNS name, IPv4 or IPv6 address (no scheme, user or port)'),
    port: z.number().int('Port must be a whole number').min(1).max(65535),
    username: z
      .string()
      .trim()
      .min(1, 'Username is required')
      .max(128)
      .refine((s) => noControl(s) && !/\s/.test(s), 'Username cannot contain spaces'),
    authMode: z.enum(AUTH_MODES),
    privateKeyPath: LocalPath.refine((s) => s.length > 0, 'Private key is required'),
    certificatePath: LocalPath.nullable(),
    initialRemoteDirectory: z
      .string()
      .max(4096)
      .refine(noControl, 'Contains control characters')
      .refine((s) => s.startsWith('/'), 'Must be an absolute remote path starting with /')
      .nullable(),
    downloadDirectory: LocalPath.nullable(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.authMode === 'privateKeyAndCertificate' && !p.certificatePath) {
      ctx.addIssue({
        code: 'custom',
        path: ['certificatePath'],
        message: 'Certificate is required in certificate mode',
      });
    }
  })
  .transform((p) => ({
    ...p,
    // A certificate path is only kept in certificate mode.
    certificatePath: p.authMode === 'privateKeyAndCertificate' ? p.certificatePath : null,
  }));

export type ProfileInput = z.input<typeof ProfileInputSchema>;
export type ValidProfileInput = z.output<typeof ProfileInputSchema>;

export const ProfileSchema = z
  .object({
    id: z.uuid(),
    createdAt: z.string(),
    updatedAt: z.string(),
    name: z.string(),
    host: z.string(),
    port: z.number().int().min(1).max(65535),
    username: z.string(),
    authMode: z.enum(AUTH_MODES),
    privateKeyPath: z.string(),
    certificatePath: z.string().nullable(),
    initialRemoteDirectory: z.string().nullable(),
    downloadDirectory: z.string().nullable(),
  })
  .strict();
export type Profile = z.infer<typeof ProfileSchema>;

export const ProfilesFileSchema = z
  .object({
    version: z.literal(PROFILES_FILE_VERSION),
    profiles: z.array(ProfileSchema),
  })
  .strict();
export type ProfilesFile = z.infer<typeof ProfilesFileSchema>;

/** Field → message map for form display. */
export function profileFieldErrors(input: unknown): Record<string, string> {
  const r = ProfileInputSchema.safeParse(input);
  if (r.success) return {};
  const out: Record<string, string> = {};
  for (const issue of r.error.issues) {
    const key = String(issue.path[0] ?? 'form');
    out[key] ??= issue.message;
  }
  return out;
}
