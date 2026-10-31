import { describe, expect, it } from 'vitest';
import {
  breadcrumbs,
  displayName,
  isSafeEntryName,
  joinRemote,
  normalizeRemotePath,
  parentOf,
  resolveLocationInput,
} from '../../src/shared/remote-path';

describe('remote POSIX paths', () => {
  it.each([
    ['/', '/'],
    ['//', '/'],
    ['/a/b/', '/a/b'],
    ['/a//b', '/a/b'],
    ['/a/./b', '/a/b'],
    ['/a/b/..', '/a'],
    ['/../..', '/'],
    ['/a/../../b', '/b'],
    ['/a\\b', '/a\\b'], // backslash is an ordinary character on POSIX servers
    ['/ü/ファイル', '/ü/ファイル'],
  ])('normalize %j → %j', (input, out) => {
    expect(normalizeRemotePath(input)).toBe(out);
  });

  it('rejects relative paths in normalize', () => {
    expect(() => normalizeRemotePath('a/b')).toThrow();
  });

  it('resolves location input against the current folder', () => {
    expect(resolveLocationInput('  /srv/files/ ', '/home')).toBe('/srv/files');
    expect(resolveLocationInput('docs', '/home/me')).toBe('/home/me/docs');
    expect(resolveLocationInput('..', '/home/me')).toBe('/home');
    expect(resolveLocationInput('', '/home')).toBeNull();
    expect(resolveLocationInput('/a\0b', '/home')).toBeNull();
    expect(resolveLocationInput('/' + 'x'.repeat(5000), '/')).toBeNull();
  });

  it('joins only safe single segments', () => {
    expect(joinRemote('/', 'a')).toBe('/a');
    expect(joinRemote('/a', 'b c')).toBe('/a/b c');
    for (const bad of ['', '.', '..', 'a/b', 'a\0b']) {
      expect(isSafeEntryName(bad)).toBe(false);
      expect(() => joinRemote('/a', bad)).toThrow();
    }
    expect(isSafeEntryName('.hidden')).toBe(true);
    expect(isSafeEntryName('$(rm -rf ~)')).toBe(true); // data, never executed
  });

  it('parent and breadcrumbs', () => {
    expect(parentOf('/a/b')).toBe('/a');
    expect(parentOf('/a')).toBe('/');
    expect(parentOf('/')).toBe('/');
    expect(breadcrumbs('/srv/my files/ü')).toEqual([
      { label: '/', path: '/' },
      { label: 'srv', path: '/srv' },
      { label: 'my files', path: '/srv/my files' },
      { label: 'ü', path: '/srv/my files/ü' },
    ]);
    expect(breadcrumbs('/')).toEqual([{ label: '/', path: '/' }]);
  });

  it('displays control characters visibly, leaves markup as plain text', () => {
    expect(displayName('a\nb\tc\u007f')).toBe('a\u240ab\u2409c\u2421');
    expect(displayName('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
  });
});
