import { describe, expect, it } from 'vitest';
import {
  canTransition,
  checkLocalName,
  collisionKey,
  DOWNLOAD_STATES,
  isTerminal,
  numberedName,
  SpeedMeter,
  suggestLocalName,
} from '../../src/shared/downloads';

describe('download state machine', () => {
  it('allows only forward transitions; terminal states never change', () => {
    const allowed = DOWNLOAD_STATES.flatMap((f) =>
      DOWNLOAD_STATES.filter((t) => canTransition(f, t)).map((t) => `${f}->${t}`),
    );
    expect(allowed.sort()).toEqual(
      [
        'queued->downloading',
        'queued->cancelled',
        'queued->failed',
        'downloading->completed',
        'downloading->failed',
        'downloading->cancelled',
      ].sort(),
    );
    for (const t of ['completed', 'failed', 'cancelled'] as const) {
      expect(isTerminal(t)).toBe(true);
      // A duplicate completion (or a late failure) is rejected.
      for (const to of DOWNLOAD_STATES) expect(canTransition(t, to)).toBe(false);
    }
  });
});

describe('local file names', () => {
  it('rejects traversal, separators, absolute and control-character names everywhere', () => {
    for (const p of ['linux', 'darwin', 'win32']) {
      for (const bad of [
        '',
        '.',
        '..',
        '../x',
        'a/b',
        'a\\b',
        '/etc/passwd',
        'C:evil',
        'c:\\x',
        'nul\0byte',
        'line\nbreak',
        'tab\there',
        'del\x7f',
        'x'.repeat(256),
      ])
        expect(checkLocalName(bad, p).ok, `${p}: ${JSON.stringify(bad)}`).toBe(false);
      for (const good of [
        'report.pdf',
        '.hidden',
        'Ünïcødé ファイル 📄.txt',
        'a b c',
        '$(touch pwned).sh',
        '<img src=x>.txt'.replace(/[<>]/g, p === 'win32' ? '' : '$&'),
      ])
        expect(checkLocalName(good, p).ok, `${p}: ${good}`).toBe(true);
    }
    expect(checkLocalName('é'.repeat(128), 'linux').ok).toBe(false); // 256 bytes in UTF-8
  });

  it('applies Windows reserved names and characters on Windows only', () => {
    for (const bad of [
      'CON',
      'con.txt',
      'PRN.log',
      'AUX',
      'NUL.tar.gz',
      'COM1',
      'lpt9.txt',
      'a<b',
      'a>b',
      'a:b',
      'a"b',
      'a|b',
      'a?b',
      'a*b',
      'trailing.',
      'trailing ',
    ])
      expect(checkLocalName(bad, 'win32').ok, bad).toBe(false);
    expect(checkLocalName('CON.txt', 'linux').ok).toBe(true);
    expect(checkLocalName('console.txt', 'win32').ok).toBe(true);
    expect(checkLocalName('a:b', 'darwin').ok).toBe(false);
  });

  it('suggests a safe replacement name', () => {
    expect(suggestLocalName('..\\..\\evil.txt', 'linux')).toBe('.._.._evil.txt');
    expect(suggestLocalName('line\nbreak.txt', 'linux')).toBe('line_break.txt');
    expect(suggestLocalName('CON.txt', 'win32')).toBe('_CON.txt');
    expect(suggestLocalName('what?.txt', 'win32')).toBe('what_.txt');
    expect(suggestLocalName('..', 'linux')).toBe('download');
    for (const n of ['a/b', '\0', 'x'.repeat(300), 'CON', 'end. '])
      expect(checkLocalName(suggestLocalName(n, 'win32'), 'win32').ok).toBe(true);
  });

  it('collision keys fold case and Unicode form where the file system does', () => {
    expect(collisionKey('README.txt', 'darwin')).toBe(collisionKey('readme.TXT', 'darwin'));
    expect(collisionKey('e\u0301.txt', 'darwin')).toBe(collisionKey('\u00e9.txt', 'darwin'));
    expect(collisionKey('README.txt', 'win32')).toBe(collisionKey('Readme.txt', 'win32'));
    expect(collisionKey('README.txt', 'linux')).not.toBe(collisionKey('Readme.txt', 'linux'));
  });

  it('numbers names for Keep both', () => {
    expect(numberedName('report.pdf', 1)).toBe('report (1).pdf');
    expect(numberedName('archive.tar.gz', 2)).toBe('archive (2).tar.gz');
    expect(numberedName('.bashrc', 3)).toBe('.bashrc (3)');
    expect(numberedName('.config.json', 1)).toBe('.config (1).json');
    expect(numberedName('Makefile', 1)).toBe('Makefile (1)');
    expect(numberedName('my.final.report.pdf', 4)).toBe('my.final.report (4).pdf');
  });
});

describe('speed meter', () => {
  it('reports bytes per second over a sliding window', () => {
    const m = new SpeedMeter(3000);
    m.add(0, 0);
    expect(m.rate()).toBeNull();
    m.add(1000, 10_000_000);
    expect(m.rate()).toBe(10_000_000);
    m.add(5000, 10_000_000); // stalled: old samples drop out
    expect(m.rate()).toBe(0);
  });

  it('keeps exact byte counts above 4 GiB (no 32-bit truncation)', () => {
    const m = new SpeedMeter();
    const big = 5 * 1024 ** 3 + 7;
    m.add(0, 2 ** 32 - 1);
    m.add(1000, big);
    expect(m.rate()).toBe(big - (2 ** 32 - 1));
    expect(Number.isSafeInteger(big)).toBe(true);
  });
});
