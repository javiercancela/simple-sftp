// Pure helpers for the OpenSSH fixture. No sshd binary required.
import { describe, expect, it } from 'vitest';
import {
  isSftpServerCommand,
  sftpServerPathFromSshdT,
  sshdStderrRejectsPerSourcePenalties,
} from '../integration/helpers/sshd';

describe('sshd fixture option and sftp-server detection', () => {
  it('recognises the Ubuntu 24.04 rejection of PerSourcePenalties', () => {
    const stderr =
      '/tmp/sshd_config: line 1: Bad configuration option: PerSourcePenalties\nsshd: terminating\n';
    expect(sshdStderrRejectsPerSourcePenalties(stderr)).toBe(true);
    expect(sshdStderrRejectsPerSourcePenalties('sshd: no hostkeys available -- exiting')).toBe(
      false,
    );
    expect(sshdStderrRejectsPerSourcePenalties('Unsupported option: PerSourcePenalties')).toBe(
      true,
    );
  });

  it('reads an external subsystem path and ignores internal-sftp', () => {
    expect(
      sftpServerPathFromSshdT('port 22\nsubsystem sftp /usr/lib/openssh/sftp-server\npidfile /x\n'),
    ).toBe('/usr/lib/openssh/sftp-server');
    expect(sftpServerPathFromSshdT('subsystem sftp internal-sftp\n')).toBeUndefined();
    expect(sftpServerPathFromSshdT('subsystem sftp internal-sftp -d /tmp/root\n')).toBeUndefined();
    expect(sftpServerPathFromSshdT('')).toBeUndefined();
  });

  it('matches sftp-server by basename, including a full macOS path', () => {
    expect(isSftpServerCommand('sftp-server')).toBe(true);
    expect(isSftpServerCommand('sftp-server -d /tmp/files')).toBe(true);
    expect(isSftpServerCommand('/usr/lib/openssh/sftp-server -d /tmp/files')).toBe(true);
    expect(isSftpServerCommand('/usr/libexec/sftp-server')).toBe(true);
    expect(isSftpServerCommand('sshd-session')).toBe(false);
    expect(isSftpServerCommand('/usr/libexec/sshd-session')).toBe(false);
    expect(isSftpServerCommand('')).toBe(false);
  });
});
