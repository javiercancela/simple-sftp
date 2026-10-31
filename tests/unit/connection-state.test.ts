import { describe, expect, it } from 'vitest';
import {
  CONNECTION_STATES,
  transition,
  type ConnectionEvent,
  type ConnectionState,
} from '../../src/shared/connection';

const EVENTS: ConnectionEvent['type'][] = [
  'CONNECT',
  'NEED_PASSPHRASE',
  'PASSPHRASE_SUBMITTED',
  'HOST_KEY_UNKNOWN',
  'HOST_TRUSTED',
  'READY',
  'FAIL',
  'CANCEL',
  'DISCONNECT',
  'CLOSED',
];

// The complete allowed table; every other (state, event) pair must be rejected.
const ALLOWED: Record<
  ConnectionState,
  Partial<Record<ConnectionEvent['type'], ConnectionState>>
> = {
  disconnected: { CONNECT: 'connecting' },
  failed: { CONNECT: 'connecting' },
  connecting: {
    NEED_PASSPHRASE: 'awaitingPassphrase',
    HOST_KEY_UNKNOWN: 'awaitingHostTrust',
    READY: 'connected',
    FAIL: 'failed',
    CANCEL: 'disconnected',
    CLOSED: 'disconnected',
  },
  awaitingPassphrase: {
    NEED_PASSPHRASE: 'awaitingPassphrase',
    PASSPHRASE_SUBMITTED: 'connecting',
    FAIL: 'failed',
    CANCEL: 'disconnected',
  },
  awaitingHostTrust: {
    HOST_TRUSTED: 'connecting',
    FAIL: 'failed',
    CANCEL: 'disconnected',
    CLOSED: 'disconnected',
  },
  connected: { DISCONNECT: 'disconnecting', CLOSED: 'disconnected' },
  disconnecting: { CLOSED: 'disconnected' },
};

describe('connection state machine', () => {
  for (const state of CONNECTION_STATES) {
    for (const ev of EVENTS) {
      const expected = ALLOWED[state][ev] ?? null;
      it(`${state} --${ev}--> ${expected ?? 'rejected'}`, () => {
        expect(transition(state, ev)).toBe(expected);
      });
    }
  }

  it('happy path with passphrase and first-time trust', () => {
    let s: ConnectionState = 'disconnected';
    for (const ev of [
      'CONNECT',
      'NEED_PASSPHRASE',
      'PASSPHRASE_SUBMITTED',
      'HOST_KEY_UNKNOWN',
      'HOST_TRUSTED',
      'READY',
      'DISCONNECT',
      'CLOSED',
    ] as const) {
      const next = transition(s, ev);
      expect(next, `${s} ${ev}`).not.toBeNull();
      s = next!;
    }
    expect(s).toBe('disconnected');
  });

  it('cannot connect while connected or busy (one active connection)', () => {
    for (const s of [
      'connecting',
      'awaitingHostTrust',
      'awaitingPassphrase',
      'connected',
      'disconnecting',
    ] as const) {
      expect(transition(s, 'CONNECT')).toBeNull();
    }
  });
});
