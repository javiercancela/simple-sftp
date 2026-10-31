# SimpleSFTP (milestones 1–2: transport, profiles and connection UI)

Small Electron app for browsing SFTP servers and downloading files with an SSH
private key, optionally paired with an OpenSSH user certificate. See
[`SPEC.md`](SPEC.md). This build covers **spec section 13 steps 1 and 2**:

1. Transport adapter, real OpenSSH tests, packaged smoke test.
2. Saved server profiles (create, edit, duplicate, delete), native file
   pickers, trusted host keys, and the connection lifecycle with host-trust
   and passphrase dialogs. Once connected, the app shows the server's default
   folder. **File browsing and downloads are not built yet** (step 3).

Transport validation results and the dependency patch: [`docs/transport-validation.md`](docs/transport-validation.md).

## What is stored where

All app data is in Electron's `userData` folder (Linux `~/.config/SimpleSFTP`,
macOS `~/Library/Application Support/SimpleSFTP`, Windows `%APPDATA%\SimpleSFTP`):

| File                 | Contents                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `profiles.json`      | Versioned list of profiles: names, hosts, ports, usernames, **paths** to key/certificate files |
| `trusted-hosts.json` | Accepted host keys keyed by `host:port` (SHA-256 fingerprint + algorithm)                      |
| `settings.json`      | Theme, sidebar width, window geometry, last selected profile                                   |

No passwords, passphrases or key contents are ever written. Files are written
atomically (temp file, fsync, rename). An unreadable or invalid file is kept as
`<file>.corrupt-<timestamp>` and the app starts clean with a visible notice.

## Smoke hook (`SFTP_CLIENT_TRANSPORT_SMOKE`)

Release builds (`npm run make`, `out/`) do **not** contain the transport smoke
hook: it is compiled in only when `SFTP_CLIENT_SMOKE_BUILD=1`, and
`npm run smoke:packaged` builds that flavor separately into `out-smoke/`. The
smoke test also checks each release artifact: its `app.asar` has no hook code,
and with `SFTP_CLIENT_TRANSPORT_SMOKE` set it still starts to the normal UI
(checked over a localhost-only DevTools connection).

Transport validation results and the dependency patch: [`docs/transport-validation.md`](docs/transport-validation.md).

## Requirements (development only)

- Node.js 24 + npm 11 (the installed app needs neither)
- `ssh-keygen` (test credentials are generated at test time)
- An OpenSSH `sshd` binary for integration tests (not a running service; the
  tests start their own unprivileged server on `127.0.0.1`)
- Linux: `zip` (portable archive), `xvfb-run` for headless smoke tests

## Commands

| Command                  | What it does                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                 | Install pinned dependencies; also applies `patches/` (patch-package)                                                         |
| `npm start`              | Run in development (Vite dev server)                                                                                         |
| `npm run typecheck`      | Strict TypeScript check                                                                                                      |
| `npm run lint`           | oxlint (incl. layer boundary rules, spec 9.3) + oxfmt check                                                                  |
| `npm test`               | Unit tests + real OpenSSH integration tests                                                                                  |
| `npm run test:unit`      | Unit tests only                                                                                                              |
| `npm run test:e2e`       | Electron UI end-to-end tests against real sshd (xvfb on headless Linux); writes `docs/screenshots/`                          |
| `npm run make`           | Build release installers/archives into `out/make/`                                                                           |
| `npm run smoke:packaged` | Build a smoke-flavored package into `out-smoke/`, run it against a real sshd, and check the release artifacts (after `make`) |

The E2E tests drive the production renderer/main bundle with the development
Electron binary (the packaged app's fuses block automation, by design). They
stub only the native file dialog's return value; everything else, including
SSH, is real. User data is isolated with `XDG_CONFIG_HOME`.

## Test fixtures

Nothing secret is committed. Tests create throwaway keys, a test CA, user
certificates (valid, expired, wrong principal, wrong CA) and host keys with
`ssh-keygen` under `tests/.tmp/` (gitignored, deleted after the run; set
`KEEP_TEST_TMP=1` to keep them). Each test server is a separate unprivileged
`sshd -D` bound to `127.0.0.1` on a random port, using `TrustedUserCAKeys` +
`AuthorizedPrincipalsFile` (certificate-only) or `authorized_keys`
(plain-key), and `ForceCommand internal-sftp -d <fixture dir>`.

`sshd` lookup order: `$SFTP_TEST_SSHD`, `/usr/sbin/sshd`, `/usr/local/sbin/sshd`,
`.tools/openssh/root/usr/sbin/sshd`. Set `SFTP_TEST_SSHD_LD_LIBRARY_PATH` when
the binary needs extra libraries.

## Run steps per OS

### Linux (tested here: Debian 13 x64)

```bash
npm ci
# Either install openssh-server (sudo apt install openssh-server; the service
# does not need to run), or fetch an unprivileged copy without root:
scripts/fetch-test-sshd-debian.sh          # Debian 13 amd64 only
npm run typecheck && npm run lint && npm test
npm run make                               # out/make/deb/x64/*.deb, out/make/zip/linux/x64/*.zip
npm run test:e2e                           # uses xvfb-run automatically when $DISPLAY is unset
npm run smoke:packaged                     # same
```

Install: `sudo apt install ./out/make/deb/x64/simple-sftp_1.0.0_amd64.deb`, or
unzip the portable archive and run `SimpleSFTP-linux-x64/simple-sftp`.

### macOS (NOT tested yet)

```bash
npm ci
npm run typecheck && npm run lint && npm test   # uses /usr/sbin/sshd shipped with macOS
npm run make                                    # .dmg + .zip for the host arch
npm run test:e2e
npm run smoke:packaged
```

Build arm64 on Apple Silicon and x64 on an Intel Mac (or the matching CI
runner). Builds are unsigned: first launch needs right-click → Open (or
System Settings → Privacy & Security → Open Anyway).

### Windows (NOT tested yet)

```powershell
npm ci
npm run typecheck; npm run lint; npm run test:unit
npm run make            # out\make\squirrel.windows\x64\SimpleSFTP Setup.exe (unsigned)
```

The OpenSSH integration fixture and packaged smoke test do not run on Windows
yet (no unprivileged sshd fixture). SmartScreen will warn on the unsigned
installer ("More info" → "Run anyway").

CI: `.github/workflows/build.yml` builds on matching runners. It is
**untested**.
