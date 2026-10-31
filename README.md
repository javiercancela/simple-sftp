# SimpleSFTP (milestones 1–4: transport, profiles, connection UI, browsing, downloads)

Small Electron app for browsing SFTP servers and downloading files with an SSH
private key, optionally paired with an OpenSSH user certificate. See
[`SPEC.md`](SPEC.md). This build covers **spec section 13 steps 1–4**:

1. Transport adapter, real OpenSSH tests, packaged smoke test.
2. Saved server profiles (create, edit, duplicate, delete), native file
   pickers, trusted host keys, and the connection lifecycle with host-trust
   and passphrase dialogs.
3. Read-only remote browsing (spec 6): location field, breadcrumbs, back /
   forward / parent / refresh / server default folder, a sortable virtualized
   file table (name, type, size, modified), filter, "Show hidden files",
   multi-selection, symlink handling, and distinct empty, loading,
   permission-denied, not-found and disconnected states.
4. Downloads (spec 7): see below.

### Browsing keyboard shortcuts

| Keys                                | Action                                    |
| ----------------------------------- | ----------------------------------------- |
| ↑ ↓ Home End PageUp PageDown        | Move the cursor (Shift extends the range) |
| Ctrl/⌘ + arrow, then Ctrl/⌘ + Space | Move without selecting, toggle a row      |
| Ctrl/⌘ + A, Esc                     | Select all visible, clear selection       |
| Enter, double-click                 | Open the folder, or download the file     |
| Alt + ← / → / ↑, Backspace          | Back, forward, parent folder              |
| F5 or Ctrl/⌘ + R                    | Refresh                                   |
| Ctrl/⌘ + L, Ctrl/⌘ + F              | Focus location field, focus filter        |
| Esc while loading                   | Cancel the listing                        |

The browser is read-only: the main process only calls `readdir`, `stat`,
`lstat` and `realpath`. Every listing carries a session ID and request ID; a
reply for a cancelled or superseded request, or for an old session, is dropped
in both the main process and the renderer, so it never replaces the current
view. 10,000-entry measurements: [`docs/e2e-browse-metrics.json`](docs/e2e-browse-metrics.json).

## Downloads

- **Destination is chosen in the main process.** One file: the native Save
  dialog, opened at the profile's download folder (else the system Downloads
  folder) with the remote file name. Several files: the native folder picker.
  The renderer only ever sends remote paths; it never supplies a local path.
- **Only regular files.** Folders, links and special files in a selection are
  skipped with a reason.
- **Names are checked before anything is queued**: traversal, `/` or `\`,
  absolute or drive paths, control characters, names over 255 bytes, Windows
  reserved names and characters (on Windows), and two remote names that would
  land on one local name (case/Unicode-insensitive on macOS and Windows). Such
  files get a rename offer (a safe suggestion is pre-filled; main validates it
  again). Existing files get **Replace / Keep both / Rename / Skip**; nothing is
  overwritten silently.
- **Queue**: one active transfer; states queued → downloading → completed /
  failed / cancelled. Terminal states never change. Each job is bound to the
  profile, session and host key it was created for and never moves to another
  server. Cancel works for active and queued jobs (also against a frozen
  server); Retry creates a new job that starts from zero; completed jobs have
  Show in folder. The bottom panel is collapsed while empty and opens when files
  are added.
- **Writing**: SFTP read stream → byte counter → write stream with
  backpressure (bounded memory). Data goes to an exclusively created
  `<name>.<random>.part` file in the approved folder. The folder is approved by
  real path plus device/inode and re-verified before writing and before
  finalizing; nothing is written through a symlink or outside it. Size and
  modification time are checked before and after; a difference fails the job
  with "Remote file changed during download".
- **Finalizing**: a new file is published with `link()` + `unlink()` (fails if
  the name was taken meanwhile; falls back to an exclusive placeholder + rename
  on file systems without hard links). Replace renames over the target only if
  it is still the exact file the user approved. Keep both picks the first free
  "name (n).ext" atomically. If the destination changed after approval, the app
  asks again.
- **Failures** remove the partial file (an existing file being replaced is never
  touched). If removing it fails, the row offers **Delete partial file**. A
  failed finalization keeps the complete data in the `.part` file and says so.
  Error classes: remote permission denied, remote file missing, remote file
  changed, connection lost, file transfer service stopped, local permission
  denied, disk full, invalid file name, download folder changed, finalization
  failed.
- **Connection loss** fails the active job and pauses the rest. **Continue
  downloads** is enabled after reconnecting to the same server (same profile and
  host key). Switching servers or disconnecting with pending downloads asks
  **Cancel downloads and switch / Stay connected**; closing or quitting asks
  **Keep downloading / Cancel downloads and quit**.
- **Transfer journal** (`transfer-journal.json`): the app records each partial
  file it creates (path + device/inode). After a crash, startup offers to delete
  only those files (**Delete partial files / Keep them**). Unrelated `.part`
  files are never touched. Downloads never resume after a restart.

Measurements: [`docs/download-metrics.json`](docs/download-metrics.json)
(service-level, including a 4 GiB + 5 MiB file),
[`docs/e2e-download-metrics.json`](docs/e2e-download-metrics.json) (in the app),
[`docs/download-diskfull.json`](docs/download-diskfull.json).

**How faults are tested** (all real, no mocks): network loss = SIGKILL of the
server's per-connection processes; frozen server = SIGSTOP; SFTP subsystem
stopping = SIGKILL of an external `sftp-server`; missing subsystem = an sshd
with no SFTP subsystem; remote change = rewriting/truncating the file
mid-download; failed finalization = removing write permission on the folder;
disk full = an unprivileged user + mount namespace (`unshare -Urm`) with an
8 MiB tmpfs mounted over the download folder, so the kernel returns a real
`ENOSPC`; crash = SIGKILL of the Electron app mid-download.

**Known limits**: macOS/Windows are untested. On macOS and Windows the native
Save dialog may already confirm an overwrite, and the app then still shows its
own Replace / Keep both choice. If the approved folder itself is moved away
after the partial file was created, the partial file stays inside the moved
folder (the journal still offers it for cleanup at the next start). On file
systems without hard links (e.g. FAT), publishing a new file uses an exclusive
placeholder + rename, which is safe against overwriting but not against a
second writer replacing the placeholder in between.

### Release menu

Linux and Windows have no application menu; macOS has a minimal app / Edit /
Window menu. There is no reload or DevTools entry or shortcut, and DevTools are
disabled in packaged builds. Ctrl/⌘ + R and F5 refresh the current folder.

Transport validation results and the dependency patch: [`docs/transport-validation.md`](docs/transport-validation.md).

## What is stored where

All app data is in Electron's `userData` folder (Linux `~/.config/SimpleSFTP`,
macOS `~/Library/Application Support/SimpleSFTP`, Windows `%APPDATA%\SimpleSFTP`):

| File                    | Contents                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `profiles.json`         | Versioned list of profiles: names, hosts, ports, usernames, **paths** to key/certificate files |
| `trusted-hosts.json`    | Accepted host keys keyed by `host:port` (SHA-256 fingerprint + algorithm)                      |
| `settings.json`         | Theme, sidebar width, window geometry, last selected profile                                   |
| `transfer-journal.json` | Partial files of downloads in progress (path, device/inode), for cleanup after a crash         |

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
stub only the native file/Save/folder dialogs' return values and "Show in
folder"; everything else, including SSH and the local file system, is real. User data is isolated with `XDG_CONFIG_HOME`.

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
