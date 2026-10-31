// Connection lifecycle contract (spec 5.1). Pure.
import type { HostKeyInfo, TransportErrorCode } from './transport-contract';

export const CONNECTION_STATES = [
  'disconnected',
  'connecting',
  'awaitingHostTrust',
  'awaitingPassphrase',
  'connected',
  'disconnecting',
  'failed',
] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

export type Challenge =
  | { kind: 'hostTrust'; challengeId: string; hostKey: HostKeyInfo }
  | { kind: 'passphrase'; challengeId: string; keyFileName: string; retry: boolean };

export interface ConnectionError {
  code: TransportErrorCode | 'PROFILE_NOT_FOUND';
  message: string;
  detail?: string;
  expectedFingerprint?: string;
  receivedFingerprint?: string;
}

export interface ConnectionSnapshot {
  /** Increments on every change so stale events can be dropped. */
  revision: number;
  sessionId: string | null;
  profileId: string | null;
  profileName: string | null;
  state: ConnectionState;
  challenge: Challenge | null;
  error: ConnectionError | null;
  hostKey: HostKeyInfo | null;
  remoteHome: string | null;
}

export type ConnectionEvent =
  | { type: 'CONNECT' }
  | { type: 'NEED_PASSPHRASE' }
  | { type: 'PASSPHRASE_SUBMITTED' }
  | { type: 'HOST_KEY_UNKNOWN' }
  | { type: 'HOST_TRUSTED' }
  | { type: 'READY' }
  | { type: 'FAIL' }
  | { type: 'CANCEL' }
  | { type: 'DISCONNECT' }
  | { type: 'CLOSED' };

/**
 * Allowed transitions. Returns the next state or null when the event is not
 * valid in the current state (callers treat null as a programming error or a
 * stale action and ignore it).
 */
export function transition(
  state: ConnectionState,
  ev: ConnectionEvent['type'],
): ConnectionState | null {
  switch (state) {
    case 'disconnected':
    case 'failed':
      return ev === 'CONNECT' ? 'connecting' : null;
    case 'connecting':
      switch (ev) {
        case 'NEED_PASSPHRASE':
          return 'awaitingPassphrase';
        case 'HOST_KEY_UNKNOWN':
          return 'awaitingHostTrust';
        case 'READY':
          return 'connected';
        case 'FAIL':
          return 'failed';
        case 'CANCEL':
        case 'CLOSED':
          return 'disconnected';
        default:
          return null;
      }
    case 'awaitingPassphrase':
      switch (ev) {
        case 'NEED_PASSPHRASE':
          return 'awaitingPassphrase'; // wrong passphrase: ask again
        case 'PASSPHRASE_SUBMITTED':
          return 'connecting';
        case 'FAIL':
          return 'failed';
        case 'CANCEL':
          return 'disconnected';
        default:
          return null;
      }
    case 'awaitingHostTrust':
      switch (ev) {
        case 'HOST_TRUSTED':
          return 'connecting';
        case 'FAIL':
          return 'failed';
        case 'CANCEL':
        case 'CLOSED':
          return 'disconnected';
        default:
          return null;
      }
    case 'connected':
      switch (ev) {
        case 'DISCONNECT':
          return 'disconnecting';
        case 'CLOSED':
          return 'disconnected';
        default:
          return null;
      }
    case 'disconnecting':
      return ev === 'CLOSED' ? 'disconnected' : null;
  }
}
