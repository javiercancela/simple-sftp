import type { TransportErrorCode } from '../../shared/transport-contract';

/** Application-owned error with a stable code and a sanitized message. */
export class TransportError extends Error {
  readonly code: TransportErrorCode;
  /** Sanitized technical detail; never contains key material or passphrases. */
  readonly detail: string | undefined;

  constructor(code: TransportErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
    this.detail = detail;
  }
}

export function isTransportError(err: unknown): err is TransportError {
  return err instanceof TransportError;
}
