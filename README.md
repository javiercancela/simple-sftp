# SimpleSFTP (version 1 candidate: spec section 13 steps 1–5)

Small Electron app for browsing SFTP servers and downloading files with an SSH
private key, optionally paired with an OpenSSH user certificate. See
[`SPEC.md`](SPEC.md). This build covers **spec section 13 steps 1–5**:

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
5. Release validation: acceptance status per criterion in
   [`docs/acceptance.md`](docs/acceptance.md).

Version 2 (outside `SPEC.md`): [image preview](#image-preview-version-2-outside-specmd),
with one documented exception to spec 7.2.

### Browsing keyboard shortcuts

| Keys                                | Action                                    |
| ----------------------------------- | ----------------------------------------- |
| ↑ ↓ Home End PageUp PageDown        | Move the cursor (Shift extends the range) |
| Ctrl/⌘ + arrow, then Ctrl/⌘ + Space | Move without selecting, toggle a row      |
| Ctrl/⌘ + A, Esc                     | Select all visible, clear selection       |
| Enter, double-click                 | Open the folder, or download the file     |
| Space                               | Preview the image (version 2)             |
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

## Image preview (version 2, outside SPEC.md)

Select an image file and press **Preview** (or **Space**). Double-click and
Enter still download, as before. The preview opens in a modal: the image is
fitted to the window, with the file name, format, pixel size, file size and
"n of m". **← / →** (or Prev / Next) step through the images of the current
folder in the table's order (filter and sort apply), **Esc** or Close returns
focus to the file table with the last previewed image selected. **Download**
queues the shown file through the normal download flow.

- **Offered for:** regular files (not links, folders or other types) with a
  `png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`, `bmp`, `ico` or `avif`
  extension. The extension only decides whether the button is enabled; the
  main process decides from the file's first bytes (magic bytes) and refuses
  anything else ("Not a supported image"), whatever the name says.
- **Limit:** 20 MiB. Larger files are refused from `lstat` before reading, and
  the limit is enforced again while reading in case the file grows; the
  preview then offers Download instead.
- **States:** loading (after 120 ms), too large, not a supported image,
  damaged (the bytes start like an image but don't decode), permission
  denied, file not found, not connected. A lost connection closes the preview
  together with the browser and shows the usual reconnect state.
- **Requests:** each preview carries the session ID and a request ID. Stepping
  to another image supersedes the previous request: main stops that read and
  answers it `CANCELLED`, and the renderer ignores any reply that isn't for the
  current request. Only the currently connected session is accepted.
- **Safety:** main reads through the same read-only session (`lstat`, then a
  read stream; nothing else). The renderer shows the bytes from a `blob:` URL
  in an `<img>` element; images loaded that way (including SVG) never run
  scripts and never load external resources. The production CSP changed from
  `img-src 'self' data:` to `img-src 'self' blob:` (nothing used `data:`); no
  other CSP change. Nothing is written to disk: the bytes live in memory only
  and the blob URL is revoked when the image changes or the preview closes.

**Deliberate exception to spec 7.2.** Spec 7.2 says file bytes are never
forwarded through renderer IPC and never loaded whole into memory. The image
preview is the one exception: `remote.previewImage` returns the bytes of one
image, at most 20 MiB, held in memory in main until sent, and in the renderer
while shown. Downloads are unchanged: they stream from SFTP to disk and never
send file bytes to the renderer. The exception is implemented in
`src/main/connections/preview-service.ts` only.

Tests: `tests/unit/preview.test.ts` (extensions, magic bytes incl. every
fixture format, the cap from stat and while streaming, supersede/cancel,
disconnect, renderer request state), `tests/integration/preview-service.test.ts`
(real sshd), `tests/e2e/preview.e2e.test.ts` (the app under xvfb).
Screenshots `docs/screenshots/40-*.png` to `49-*.png`. Fixture images:
`tests/fixtures/images/` (generated with Pillow, committed).

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

## Supported operating systems

The app is pinned to **Electron 45.2.1** (Chromium 156, Node.js 24.22.1). Per
the platform section of that release's README (`node_modules/electron/README.md`)
and the Electron 44/45 breaking-change notes:

| OS                    | Electron 45 minimum                                              | This project                                                                                      |
| --------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| macOS (Apple Silicon) | macOS 13 Ventura or later (macOS 12 was dropped in Electron 44)  | Build target; **not tested**                                                                      |
| macOS (Intel)         | macOS 13 Ventura or later                                        | Build target; **not tested**                                                                      |
| Windows x64           | Windows 10 or later                                              | Build target; **not tested**                                                                      |
| Linux x64             | Major distributions still supported by Chromium and their vendor | Baseline **Ubuntu 24.04 or later** (spec 11); **tested only on Debian 13 (trixie) x64**, headless |

A platform counts as supported only after its packaged build passes
`npm run smoke:packaged` on that OS; so far that is Linux x64 only.

## Requirements (development only)

- Node.js 24 + npm 11 (the installed app needs neither)
- `ssh-keygen` (test credentials are generated at test time)
- An OpenSSH `sshd` binary for integration tests (not a running service; the
  tests start their own unprivileged server on `127.0.0.1`)
- Linux: `zip` and `fakeroot`/`dpkg` (for `npm run make`), `xvfb-run` for
  headless E2E and smoke tests

## Commands

| Command                  | What it does                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                 | Install pinned dependencies; also applies `patches/` (patch-package)                                                         |
| `npm start`              | Run in development (Vite dev server, live reload)                                                                            |
| `npm run typecheck`      | Strict TypeScript check                                                                                                      |
| `npm run lint`           | oxlint (incl. layer boundary rules, spec 9.3) + oxfmt check                                                                  |
| `npm test`               | Unit tests + real OpenSSH integration tests (needs `sshd`, see below)                                                        |
| `npm run test:unit`      | Unit tests only (no `sshd` needed)                                                                                           |
| `npm run test:e2e`       | Electron UI end-to-end tests against real sshd (xvfb on headless Linux); writes `docs/screenshots/`                          |
| `npm run make`           | Build release installers/archives for the current OS into `out/make/`                                                        |
| `npm run smoke:packaged` | Build a smoke-flavored package into `out-smoke/`, run it against a real sshd, and check the release artifacts (after `make`) |
| `npm run notices`        | Regenerate `THIRD_PARTY_NOTICES.md` from the production dependencies (a unit test fails when it is stale)                    |

The E2E tests drive the production renderer/main bundle with the development
Electron binary (the packaged app's fuses block automation, by design). They
stub only the native file/Save/folder dialogs' return values and "Show in
folder"; everything else, including SSH and the local file system, is real.
User data is isolated with `XDG_CONFIG_HOME`.

## Test fixtures

Nothing secret is committed. Tests create throwaway keys, a test CA, user
certificates (valid, expired, wrong principal, wrong CA) and host keys with
`ssh-keygen` under `tests/.tmp/` (gitignored, deleted after the run; set
`KEEP_TEST_TMP=1` to keep them). Each test server is a separate unprivileged
`sshd -D` bound to `127.0.0.1` on a random port, using `TrustedUserCAKeys` +
`AuthorizedPrincipalsFile` (certificate-only) or `authorized_keys`
(plain-key), and `ForceCommand internal-sftp -d <fixture dir>`. Tests stop
their servers and any per-connection `sshd-session` processes afterwards.

`sshd` lookup order: `$SFTP_TEST_SSHD`, `/usr/sbin/sshd`, `/usr/local/sbin/sshd`,
`.tools/openssh/root/usr/sbin/sshd`. Set `SFTP_TEST_SSHD_LD_LIBRARY_PATH` when
the binary needs extra libraries. Ways to get one:

- **Debian/Ubuntu with sudo**: `sudo apt install openssh-server` (the service
  does not need to run; you may `sudo systemctl disable --now ssh`).
- **Debian 13 amd64 without root**: `scripts/fetch-test-sshd-debian.sh`
  downloads the signed Debian packages (release file verified against the
  Debian archive keyring) and extracts them into `.tools/openssh/`. Then:

  ```bash
  export SFTP_TEST_SSHD=$PWD/.tools/openssh/root/usr/sbin/sshd
  export SFTP_TEST_SSHD_LD_LIBRARY_PATH=$PWD/.tools/openssh/root/usr/lib/x86_64-linux-gnu
  ```

- **macOS**: `/usr/sbin/sshd` ships with the OS.

The disk-full test needs unprivileged user namespaces (`unshare -Urm`); it
is skipped where they are unavailable (macOS, Windows, or Linux with
user namespaces disabled), so it only counts where it actually ran.

## Run steps per OS

Verified on this box: a fresh `git clone` followed by exactly `npm ci && npm
start` opens the app's first-run screen (checked headless under xvfb), and the
fixture steps above followed by `npm test` pass in that clone.

### Linux (tested here: Debian 13 x64; baseline Ubuntu 24.04+)

```bash
npm ci
npm start                                  # development
# test fixtures: see "Test fixtures" above
npm run typecheck && npm run lint && npm test
npm run make                               # out/make/deb/x64/*.deb, out/make/zip/linux/x64/*.zip
npm run test:e2e                           # uses xvfb-run automatically when $DISPLAY is unset
npm run smoke:packaged                     # same
```

Install the **unsigned development build**:

- `.deb`: `sudo apt install ./out/make/deb/x64/simple-sftp_1.0.0_amd64.deb`
  (apt asks for your password and pulls GTK/NSS dependencies; there is no
  signature prompt because a local file is not from a signed repository). Start
  it from the applications menu ("SimpleSFTP") or run `simple-sftp`. Remove
  with `sudo apt remove simple-sftp`. The package installs `chrome-sandbox`
  set-uid root, as Electron requires for its sandbox.
- Portable `.zip`: unzip anywhere and run `SimpleSFTP-linux-x64/simple-sftp`.
  On Ubuntu 24.04+, AppArmor restricts unprivileged user namespaces; if the app
  exits with a sandbox error (`The SUID sandbox helper binary was found, but is
  not configured correctly`), either install the `.deb`, or once run
  `sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox`
  inside the extracted folder. (Not reproduced here: Debian 13 allows
  unprivileged user namespaces.)

### macOS 13+ (NOT tested yet)

```bash
npm ci
npm start
npm run typecheck && npm run lint && npm test   # uses /usr/sbin/sshd shipped with macOS
npm run make                                    # out/make/*.dmg and out/make/zip/darwin/<arch>/*.zip
npm run test:e2e
npm run smoke:packaged
```

Build arm64 on Apple Silicon and x64 on an Intel Mac (or the matching CI
runner). Install the **unsigned development build**: open the `.dmg` and drag
SimpleSFTP to Applications. Because it is not signed with a Developer ID or
notarized, Gatekeeper blocks the first launch ("Apple could not verify
“SimpleSFTP” is free of malware…" / "“SimpleSFTP” Not Opened"). On macOS 15
Sequoia and later, open **System Settings → Privacy & Security**, scroll to
the message about SimpleSFTP and click **Open Anyway**, then confirm with your
password; on macOS 13–14, Control-click the app → **Open** also works. If
macOS instead says the app "is damaged and can't be opened", the download
quarantine flag is set on an unsigned arm64 build; remove it with
`xattr -dr com.apple.quarantine /Applications/SimpleSFTP.app`. These prompts
are expected for dev builds only; distribution beyond personal testing needs
signing and notarization (spec 11).

### Windows 10+ x64 (NOT tested yet)

```powershell
npm ci
npm start
npm run typecheck; npm run lint; npm run test:unit
npm run make            # out\make\squirrel.windows\x64\*Setup.exe (unsigned)
```

The OpenSSH integration fixture, E2E tests and packaged smoke test do not run
on Windows yet (no unprivileged sshd fixture), so Windows has unit-test
coverage only. Install the **unsigned development build** by running the
Setup `.exe`: Microsoft Defender SmartScreen shows "Windows protected your
PC"; click **More info → Run anyway**. The Squirrel installer then installs
per user into `%LOCALAPPDATA%\SimpleSFTP` without an administrator prompt,
starts the app, and adds Start menu and desktop shortcuts. Uninstall from
**Settings → Apps**. With Smart App Control enabled (Windows 11), unsigned
apps may be blocked outright with no override; use a signed build or a
machine where it is off.

## CI

`.github/workflows/build.yml` runs the same steps on `ubuntu-24.04`,
`macos-14` (arm64), `macos-15-intel` (x64; GitHub retired `macos-13` in
December 2025) and `windows-latest`, and uploads `out/make/**`. It is
**untested** (no GitHub runner access from the development box).

## Licences and dependency audit

- Third-party notices: [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md),
  generated from the production dependency tree plus Electron, and shipped in
  every package (`resources/THIRD_PARTY_NOTICES.md`). Packages also contain
  Electron's `LICENSE` and `LICENSES.chromium.html`.
- `npm audit --omit=dev` (everything that ships): **0 vulnerabilities**.
- `npm audit` including development tools reports advisories only in build
  tooling (Electron Forge 8 makers and their `glob`/`minimatch`/`temp`/`rimraf`
  dependencies; `appdmg` → `image-size` ICNS parsing, used only when building a
  `.dmg` from this repo's own files). None of it is in the app. npm's suggested
  "fix" is a downgrade to Forge 7, which was not taken. Details:
  [`docs/acceptance.md`](docs/acceptance.md#dependency-audit).
