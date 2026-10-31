// App-owned trusted host store (spec 5.2), keyed by normalized host:port.
import path from 'node:path';
import type { HostKeyInfo } from '../../shared/transport-contract';
import {
  TRUST_FILE_VERSION,
  TrustFileSchema,
  trustKeyFor,
  type TrustFile,
  type TrustedHost,
} from '../../shared/trust';
import { VersionedJsonFile, type Recovery } from '../platform/json-file';
import { evaluateHostKey, type TrustEvaluation } from './host-key';

export class TrustStore {
  private readonly file: VersionedJsonFile<typeof TrustFileSchema>;
  private data: TrustFile = { version: TRUST_FILE_VERSION, hosts: {} };
  recovered: Recovery | null = null;

  constructor(
    dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.file = new VersionedJsonFile(
      path.join(dir, 'trusted-hosts.json'),
      TrustFileSchema,
      () => ({
        version: TRUST_FILE_VERSION,
        hosts: {},
      }),
    );
  }

  async load(): Promise<void> {
    const r = await this.file.load();
    this.data = r.data;
    this.recovered = r.recovered;
  }

  evaluate(info: HostKeyInfo): TrustEvaluation {
    return evaluateHostKey(this.data.hosts[trustKeyFor(info.host, info.port)], info);
  }

  list(): Array<TrustedHost & { key: string }> {
    return Object.entries(this.data.hosts).map(([key, h]) => ({ key, ...h }));
  }

  /** Persist trust; only called after explicit user acceptance. Never overwrites. */
  async trust(info: HostKeyInfo): Promise<void> {
    const key = trustKeyFor(info.host, info.port);
    if (this.data.hosts[key]) throw new Error('Host already has a trusted key; remove it first');
    const next: TrustFile = {
      version: TRUST_FILE_VERSION,
      hosts: {
        ...this.data.hosts,
        [key]: {
          host: info.host,
          port: info.port,
          algorithm: info.algorithm,
          fingerprintSha256: info.fingerprintSha256,
          addedAt: this.now().toISOString(),
        },
      },
    };
    await this.file.save(next);
    this.data = next;
  }

  async remove(key: string): Promise<boolean> {
    if (!this.data.hosts[key]) return false;
    const hosts = { ...this.data.hosts };
    delete hosts[key];
    const next: TrustFile = { version: TRUST_FILE_VERSION, hosts };
    await this.file.save(next);
    this.data = next;
    return true;
  }
}
