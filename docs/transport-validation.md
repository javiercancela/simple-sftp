# Transport validation (spec 3.2, milestone 1)

Date: 2026-10-31 · Box: Debian 13 x64, Node 24.22.1, npm 11.21.1

## Pinned versions

| Component                                | Version                                                              | License                                          |
| ---------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------ |
| @electerm/ssh2 (transport)               | 1.23.0 (exact pin, lockfile) + `patches/@electerm+ssh2+1.23.0.patch` | MIT                                              |
| ↳ asn1 / safer-buffer / iconv-lite       | 0.2.6 / 2.1.2 / 0.7.3                                                | MIT                                              |
| ↳ bcrypt-pbkdf / tweetnacl               | 1.0.2 / 0.14.5                                                       | BSD-3-Clause / Unlicense                         |
| ↳ sm-polyfill → sm-crypto-v2 → @noble/\* | 1.4.0 → 1.16.0 → ciphers 1.3.0, curves 1.9.7, hashes 1.8.0           | MIT                                              |
| Electron                                 | 45.2.1                                                               | MIT (+ Chromium licenses shipped in the package) |
| React / Zod                              | 19.3.1 / 4.6.7                                                       | MIT                                              |
| patch-package (dev only)                 | 8.0.1                                                                | MIT                                              |

All runtime dependencies are pure JavaScript (no native modules). `npm audit
--omit=dev`: 0 vulnerabilities. Dev tooling (Forge/makers, vitest) has
moderate/high advisories in glob, minimatch, image-size, tinypool; none ship in
the app.

## Release-blocking checks

| Check (spec 3.2)                                                 | Result                                | Evidence                                                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1. Pin published version + lockfile                              | PASS                                  | `@electerm/ssh2@1.23.0`, `package-lock.json`                                                                                  |
| 2. Real OpenSSH server, trusts test CA, rejects unsigned key     | PASS                                  | OpenSSH 10.0p2 sshd, `TrustedUserCAKeys` + `AuthorizedPrincipalsFile`, `AuthorizedKeysFile none`; plain key → `AUTH_REJECTED` |
| 3a. Ed25519 + RSA keys (RSA via rsa-sha2-256 and -512)           | PASS                                  | server forced to each algorithm; sshd log shows `attempting public key rsa-sha2-256/512`                                      |
| 3b. Encrypted keys (right / wrong passphrase)                    | PASS                                  | wrong → `PASSPHRASE_INCORRECT`, then retry succeeds                                                                           |
| 3c. Valid certificates, Ed25519                                  | PASS (unpatched and patched)          | sshd: `Accepted certificate ID ... signed by ED25519 CA`                                                                      |
| 3c. Valid certificates, RSA                                      | **FAIL unpatched**, PASS patched      | see below                                                                                                                     |
| 4. Reject expired / wrong principal / wrong CA / mismatched pair | PASS                                  | expired and mismatch blocked locally _and_ proven rejected by the server with the local check bypassed                        |
| 5. Browse + download over the authenticated session              | PASS                                  | list, stat, realpath, symlink, empty dir, not-found vs permission-denied; 0 B, 16 B, 8 MiB downloads SHA-256 verified         |
| 6. Packaged smoke per target OS                                  | Linux x64 PASS; macOS/Windows NOT RUN | zip, deb and packaged dir each run under `xvfb-run`; code ran from `resources/app.asar`                                       |

Host verification (spec 5.2): first-use shows algorithm + SHA-256 fingerprint
(matches `ssh-keygen -lf`); cancel sends no `SERVICE_REQUEST`/`USERAUTH_REQUEST`
(checked in both client debug and sshd log); changed key blocked with expected
and received fingerprints and the stored trust is not overwritten.

## Failure found in @electerm/ssh2 1.23.0: RSA user certificates

`Protocol.authPKCert` chose the RSA signature algorithm from the server's
**host-key** algorithm list instead of the algorithm negotiated from the
server's `server-sig-algs`. Results against OpenSSH 10.0, unpatched:

| Server                                                            | Unpatched                                                                                                                                |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Ed25519 host key only, accepts `rsa-sha2-256-cert`                | FAIL: client offers `ssh-rsa-cert-v01` (SHA-1); sshd: `signature algorithm ssh-rsa-cert-v01@openssh.com not in PubkeyAcceptedAlgorithms` |
| Ed25519 host key only, accepts `rsa-sha2-512-cert`                | FAIL (same)                                                                                                                              |
| Ed25519 + RSA host keys, accepts `rsa-sha2-256-cert`              | PASS                                                                                                                                     |
| Ed25519 + RSA host keys, accepts `rsa-sha2-512-cert`              | FAIL: labels the request `rsa-sha2-256-cert`                                                                                             |
| Ed25519 host key only, OpenSSH defaults, encrypted RSA key + cert | FAIL                                                                                                                                     |

Fix applied: a small patch (one branch in `authPKCert`) (`patches/@electerm+ssh2+1.23.0.patch`, applied by
`npm ci` via patch-package) that uses the negotiated `rsa-sha2-256`/`-512`
algorithm when the caller passes one. With it, all five cases pass, and the
packaged smoke test proves the patched code is the one bundled (RSA certificate
login against an Ed25519-only host).

This is a patch on the pinned candidate, not the "replace with a proven
alternative" route in spec 3.2. Alternatives considered, not built:

- Upstream `ssh2`: no certificate support (PR #1495 still open).
- libssh through a native binding: LGPL-2.1, native builds per OS/arch.
- russh (Rust) through napi: MIT/Apache-2.0, native builds per OS/arch, much more work.
- Bundling OpenSSH `sftp` binaries per OS: large and heavy to maintain.

## Other findings

- **Throughput**: @electerm/ssh2 does not set `TCP_NODELAY`. Sequential SFTP
  reads stalled on Nagle/delayed-ACK: 1.4 MiB/s on localhost. With
  `client.setNoDelay(true)` in the adapter: about 160 MiB/s. The integration
  test now fails below 8 MiB/s.
- @electerm/ssh2 takes key material only as Buffer/string + passphrase, not as
  a parsed key. The adapter parses the key itself for local checks, then hands
  the raw file bytes + passphrase to the library for that attempt. The library
  keeps the parsed key inside the `Client` for the session's lifetime.
- OpenSSH ≥ 9.8 `PerSourcePenalties`: after several failed auths, a real
  server drops new connections from that address. The adapter currently
  reports that as `NETWORK`. The test servers disable penalties.
- A plain RSA key against a server that advertises no `server-sig-algs` may
  fall back to SHA-1 `ssh-rsa` inside the library. This was not tested; modern
  OpenSSH rejects it anyway.

## Milestone 2 additions

- **PerSourcePenalties / early drops.** When OpenSSH accepts TCP and closes the
  connection before the SSH handshake (OpenSSH >= 9.8 `PerSourcePenalties`, or
  `MaxStartups`), the transport now reports `SERVER_REFUSED` with a "wait and
  try again" message instead of a generic `NETWORK` error. Proven in
  `tests/integration/connection-manager.test.ts` against a real sshd with
  `PerSourcePenalties authfail:30s noauth:30s min:1s`: one rejected login, then
  the next attempt is `SERVER_REFUSED`.
- **Connection lost.** Errors or a close after the session is ready are
  `CONNECTION_LOST` (unless the user disconnected). Proven by freezing the
  server's session processes (SIGSTOP) with a 500 ms keepalive: the app reports
  `CONNECTION_LOST` after the missed keepalives. Production uses 30 s × 3.
- **Timeouts.** 20 s connect timeout, paused while the passphrase or host-trust
  dialog is open (proven with a 1.5 s timeout and 2.5 s waits in each dialog).

## Milestone 3 additions (browsing)

- **In-flight SFTP requests hung forever when the connection closed.**
  `@electerm/ssh2` does not always fail pending SFTP callbacks when the channel
  goes away. Every session request (`readdir`, `stat`, `lstat`, `realpath`) now
  goes through a guard that rejects it with the close error (or `DISCONNECTED`)
  when the session closes. Proven in `tests/integration/browse-service.test.ts`
  (freeze the server with SIGSTOP, start a listing, disconnect: the listing
  fails and the disconnect finishes in under 6 s).
- **Disconnect from an unresponsive server never finished.** ssh2's
  `Client.destroy()` is a no-op once `end()` has half-closed the socket, so the
  3 s hard stop did nothing. The hard stop now destroys the underlying socket.
  Measured in the E2E suite: user disconnect from a frozen server completes in
  about 3.4 s.
- **Symlinks.** Listings use `readdir` (lstat semantics); link targets are
  resolved with one `stat` per link (16 at a time) to tell links to folders,
  links to files and broken links apart. Links are never followed implicitly;
  opening a link to a folder is an explicit navigation.

## Milestone 4 additions (downloads)

- **Large files**: the library's read stream requests 64 KiB at a time and
  computes 64-bit offsets, so reads past 4 GiB are correct. A 4 GiB + 5 MiB
  sparse file with random blocks at 0, across the 4 GiB boundary and at the end
  downloads with a matching SHA-256 (see `docs/download-metrics.json`). Sizes
  from the server above 2^53 (not exactly representable) are treated as
  unknown instead of being rounded.
- **SFTP subsystem stopping while SSH stays up**: when the server's
  `sftp-server` process dies, the library ends the SFTP channel and fails pending
  requests with "No response from server". The session now notices the channel
  ending (150 ms grace so a normal disconnect is not misread), reports
  `SFTP_UNAVAILABLE` "The server's file transfer service stopped.", and closes
  the SSH connection. Tested with an external `sftp-server` killed
  mid-transfer, and with a server that has no SFTP subsystem at all.
