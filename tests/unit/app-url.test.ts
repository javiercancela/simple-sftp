import { describe, expect, it } from 'vitest';
import { normalizeAppUrl } from '../../src/main/ipc/app-url';

describe('normalizeAppUrl (IPC sender check)', () => {
  it('matches the dev server URL with or without a trailing slash, ignoring the fragment', () => {
    expect(normalizeAppUrl('http://localhost:5173')).toBe(
      normalizeAppUrl('http://localhost:5173/'),
    );
    expect(normalizeAppUrl('file:///app/index.html#/x')).toBe('file:///app/index.html');
  });
  it('does not equate other origins, paths or invalid input', () => {
    const app = normalizeAppUrl('http://localhost:5173');
    expect(normalizeAppUrl('http://localhost:5174/')).not.toBe(app);
    expect(normalizeAppUrl('http://evil.example/')).not.toBe(app);
    expect(normalizeAppUrl('http://localhost:5173/other.html')).not.toBe(app);
    expect(normalizeAppUrl('file:///app/index.html?x=1')).not.toBe('file:///app/index.html');
    expect(normalizeAppUrl('not a url')).toBeNull();
  });
});
