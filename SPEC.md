# Simple SFTP Desktop App — Specification

Version: 1.0  
Date: 2026-10-31  
Status: Ready for implementation; transport compatibility must pass the first milestone.

## 1. Purpose

Build a small Electron desktop application for saving connections to several SFTP servers, authenticating with SSH credentials, browsing remote directories, and downloading files.

The priorities are easy launch, easy installation on another computer, and a small, understandable feature set. The installed application must run without Node.js, a terminal, a separately installed SSH client, or a local web server.

## 2. Scope and defaults

| Area | Version 1 requirement |
| --- | --- |
| Platforms | macOS on Apple Silicon and Intel; Windows x64; Linux x64 |
| UI | One desktop window, English interface, system light/dark theme |
| Connections | Multiple saved server profiles; one active connection at a time |
| Authentication | Private key, optionally paired with an OpenSSH user certificate |
| Remote operations | List directories, inspect basic file metadata, download regular files |
| Downloads | Single or multiple selected files, sequential queue, progress, cancellation, retry |
| Storage | Local profiles and preferences; existing credential files referenced by path |
| Updates | Manual installation of a newer build; preserve application data |

Uploads, remote changes, terminal access, recursive folder downloads, synchronization, automatic certificate renewal, SSH configuration import, jump hosts, password login, agent integration, and transfer resumption are outside version 1. Do not add these to the initial UI.

## 3. Authentication terminology and requirements

“SSH certificate” can mean either a private-key file informally, or an actual CA-signed OpenSSH certificate. Support both workflows explicitly:

1. **SSH private key:** select a private-key file, such as `id_ed25519` or a supported PEM key. The server authorizes the corresponding public key.
2. **SSH private key + certificate:** select the private key and its matching OpenSSH user certificate, typically `id_ed25519-cert.pub`. The certificate contains a CA signature and identity constraints; it does not replace the private key. [1]

A plain public key ending in `.pub` is not a user certificate. File extensions must not determine credential type. X.509/TLS certificates and PuTTY `.ppk` keys are not supported in version 1.

Required interoperability: Ed25519 and RSA private keys, including encrypted keys; matching OpenSSH user certificates; RSA authentication using SHA-2 signatures. Do not enable deprecated algorithms as a workaround.

### 3.1 Credential handling

- Use native file pickers for the private key and certificate.
- Save absolute paths, never copies of key material or passphrases.
- Read credential files on every connection attempt so externally renewed certificates take effect without restarting the app.
- If a private key is encrypted, ask for its passphrase when connecting. Keep it only for the attempt and any active transport that requires it; release references when no longer needed. Do not promise guaranteed memory zeroization in JavaScript.
- An incorrect passphrase permits another attempt or cancellation. Never fall back to password login.
- Missing, unreadable, malformed, or unsupported credentials produce a specific error before connecting when locally detectable.
- For certificate mode, verify the credential is a user certificate, matches the selected key, and is currently valid when the transport exposes the necessary parsing. The server remains authoritative for CA trust, principals, critical options, and revocation.
- Never silently fall back to plain-key authentication when a configured certificate fails.

### 3.2 Transport choice: validate before building the UI

Use a bundled, certificate-capable SSH implementation behind an application-owned adapter. The initial candidate is `@electerm/ssh2`, whose documentation exposes a `certificate` connection option alongside `privateKey`. Use its SFTP channel API directly rather than stacking a wrapper that may instantiate a different SSH implementation. [2]

Do not assume upstream `ssh2` or `ssh2-sftp-client` supports OpenSSH certificates. At the time of this specification, upstream certificate support is represented by an open pull request. [3]

Before proceeding beyond the transport milestone:

1. Pin a published transport version and lock its dependencies.
2. Connect to a real OpenSSH test server that trusts a test CA and rejects the equivalent unsigned public key.
3. Authenticate with both required key algorithms, with encrypted keys, and with valid certificates.
4. Reject an expired certificate, wrong principal, wrong CA, and mismatched key/certificate pair.
5. Browse and download through that authenticated connection.
6. Smoke-test the packaged transport on each target OS.

These are release-blocking checks. A mocked connection or successful plain-key login does not satisfy certificate support. If the candidate fails, replace the adapter with a proven certificate-capable implementation bundled with the app; do not require a user-installed `ssh` executable or reduce the certificate requirement. Review its dependency and licensing implications before adopting the replacement.

## 4. Server profiles

Users can create, edit, duplicate, and delete profiles. Changes persist across restarts.

| Field | Rules |
| --- | --- |
| Name | Required display name |
| Host | Required DNS name, IPv4, or IPv6 address; no URL scheme or credentials |
| Port | Integer from 1–65535; default 22 |
| Username | Required SSH account name |
| Authentication | Private key, or private key + certificate |
| Private-key path | Required local file |
| Certificate path | Required in certificate mode |
| Initial remote directory | Optional absolute remote path; otherwise the server's default directory |
| Download directory | Optional local directory; otherwise use the OS Downloads directory |

Use a stable UUID for each profile. Permit several profiles with the same endpoint and different users or credentials. Deleting a profile must not delete credential files, downloaded files, or trusted host keys.

Editing the active profile applies on its next connection. Profile changes must not alter an existing connection or queued download silently.

## 5. Connection lifecycle and host verification

### 5.1 Connect and disconnect

- Double-click a profile or select it and press Connect.
- Display connection progress and allow cancellation.
- States: disconnected, connecting, awaiting host trust, awaiting passphrase, connected, disconnecting, failed.
- After authentication, open SFTP and navigate to the initial directory. If it is inaccessible, keep the session available and offer the server's default directory.
- Default connection timeout: 20 seconds, excluding time spent awaiting user input. Send a keepalive every 30 seconds and treat three unanswered keepalives as a lost connection.
- On network loss, show Disconnected, fail the active download, and leave remaining jobs queued. Reconnection is explicit; queued jobs remain paused until the user continues them.
- Connecting to another server closes the previous connection. If it has pending downloads, offer Cancel downloads and switch, or Stay connected. Never redirect old jobs to the new server.

### 5.2 Host identity

Verify the server's host key before user authentication. Maintain an app-owned trust store keyed by normalized host and port, separate from profile names and operating-system SSH files.

- First connection: show host, port, host-key algorithm, and SHA-256 fingerprint. Offer Trust and connect or Cancel. Persist trust only after explicit acceptance.
- Subsequent connections: compare against the stored key.
- Changed key: block connection and show expected and received fingerprints. Replacement requires an explicit action in trusted-host settings followed by reconnection; never automatically overwrite trust.
- Cancelling trust must close the transport before sending user credentials.

Host certificates and host-CA trust are outside version 1; reject unsupported host identity types explicitly. User certificates remain mandatory as described above.

## 6. Remote browsing

Use a single remote file browser, not a two-pane local/remote file manager.

- Display current path with an editable location field and clickable breadcrumbs.
- Support opening a directory, parent, back, forward, refresh, and return to the server's default directory.
- Show name, type, file size, and last-modified time. Unknown metadata displays an em dash rather than zero.
- Sort directories first, then by name by default. Allow sorting by name, size, and modified time.
- Provide a current-directory filename filter and a Show hidden files toggle. Do not imply a recursive server search.
- Support single and multiple file selection, standard keyboard selection, and a Download action.
- Double-click directories to navigate. Double-click regular files to start the download flow; never execute or open remote content automatically.
- Symlinks have a distinct icon. Allow explicit navigation through a symlink that resolves to a directory; do not download symlinks or follow them recursively in version 1.
- Empty, loading, permission-denied, not-found, and disconnected states must be distinct.
- Cancelling or superseding a directory request must prevent its late response from replacing the current view.

Remote paths use POSIX semantics independently of the local OS. Treat filenames as data, render them as text, and never interpret remote strings as HTML or shell commands.

## 7. Downloads

### 7.1 Destination and queue

- Single-file Download opens a native Save dialog, initialized to the profile's download directory and the remote filename.
- Multi-file Download opens a native directory picker and creates one queue entry per selected regular file.
- Download jobs capture profile ID, session ID, remote path, initial metadata, and a main-process-approved destination. Queue one active transfer at a time.
- The queue shows filename, destination, status, bytes transferred, total size when known, approximate speed, and error details. Unknown sizes use indeterminate progress.
- States: queued, downloading, completed, failed, cancelled. Duplicate completion events must not duplicate jobs or change a terminal state.
- Offer Cancel for active and queued jobs, Retry for failed/cancelled jobs, and Show in folder for completed jobs. Retry starts from byte zero.

### 7.2 Filesystem behavior

- Stream data directly from SFTP to disk with backpressure; never load an entire file into memory or forward file bytes through renderer IPC.
- Create an exclusive, uniquely named `.part` file in the destination directory. Close it successfully before promoting it to the final name.
- Never silently overwrite an existing file. Offer Replace, Keep both, or Skip. Recheck the destination at finalization; if it has changed since approval, request a fresh decision.
- Keep both selects an unused numbered filename and must avoid overwriting a file created concurrently.
- On failure or cancellation, remove the application's partial file after streams close. Preserve the pre-existing destination. If cleanup fails, report its path and provide a retry cleanup action.
- A failed final rename leaves the partial file identifiable and does not mark the job completed. Retrying the download still starts from zero.
- Validate all remote-derived local filenames. Reject path traversal, separators, absolute names, and unsupported local filenames; offer a local rename. Never silently map distinct remote names to the same local path.
- Do not write through an existing local symlink or outside the destination approved through the native dialog. Reserve and finalize destinations with race-resistant platform filesystem operations.
- Zero-byte files are valid. Large-file byte counters must not truncate to 32 bits. Treat metadata as optional and avoid unsafe numeric precision conversions.
- Compare expected size and, when available, modification time before and after transfer. If the source changes, fail with “Remote file changed during download” rather than claiming a consistent snapshot. This is not a cryptographic integrity guarantee.

### 7.3 Closing the application

While downloads are pending, closing or quitting offers Keep downloading or Cancel downloads and quit. There is no hidden tray/background mode. Otherwise, closing the only window exits the app on all platforms and releases connections.

Do not resume transfers automatically after a restart. Detect only app-owned orphan partial files recorded in a small local transfer journal and offer cleanup; never delete unrelated `.part` files.

## 8. User interface

The default window contains:

1. **Left sidebar:** saved profiles, Add server, Edit, Duplicate, Delete, and Settings.
2. **Top bar:** active server, connection status, Connect/Disconnect, and remote navigation.
3. **Main panel:** remote directory table, filename filter, hidden-file toggle, and Download selection.
4. **Bottom panel:** download queue and progress; collapsible when empty.

Profile configuration opens in a compact dialog. Host trust and passphrase prompts are focused dialogs. Errors provide a concise explanation and a relevant next action, with expandable sanitized technical details.

Preserve window geometry, theme preference, sidebar width, and last selected profile. Launch disconnected. The empty state prompts Add server. Use labeled controls, visible keyboard focus, native dialogs, and platform-appropriate shortcuts. Restore focus after dialogs close.

## 9. Electron architecture and implementation rules

### 9.1 Stack

| Layer | Choice |
| --- | --- |
| Desktop runtime | Current stable Electron at implementation time |
| UI | React + TypeScript, built with Vite |
| Packaging | Electron Forge with the Vite/TypeScript template [6] |
| SSH/SFTP | Adapter over the certificate-capable transport validated in section 3.2 |
| Validation | Zod schemas for IPC input and persisted configuration |
| Persistence | Versioned JSON under Electron `app.getPath('userData')` |
| Verification | TypeScript checks, focused unit tests, real OpenSSH integration tests, packaged smoke tests |

Use strict TypeScript. Pin versions in the lockfile. Keep this as one repository and one application; a monorepo framework and database are unnecessary.

### 9.2 Process boundaries

- **Renderer:** presentation, selection, and UI state only.
- **Preload:** small, typed `contextBridge` API with one explicit operation per IPC channel. Strip Electron event objects and return unsubscribe functions for event listeners. [4]
- **Main process:** application lifecycle, native dialogs, trusted-host decisions, profile persistence, connection and download services. Use asynchronous I/O throughout.
- Run SSH/SFTP and streaming operations asynchronously in main for version 1. If measured work blocks the event loop, move that work into an Electron utility process without changing the renderer API.

Production loads packaged UI assets and opens no HTTP listener. The renderer uses `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`. Apply a restrictive production CSP and block unexpected navigation/new windows. [5]

### 9.3 Repository layout

| Location | Responsibility |
| --- | --- |
| `src/main/profiles/` | Profile validation and persistence |
| `src/main/connections/` | Sessions, transport adapter, credentials, host verification |
| `src/main/downloads/` | Queue, streaming, cancellation, safe destination handling |
| `src/main/ipc/` | Allowlisted IPC handlers and sender checks |
| `src/main/platform/` | Native dialogs, paths, application lifecycle |
| `src/preload/` | Typed bridge implementation |
| `src/renderer/` | React components and UI state |
| `src/shared/` | Pure contracts, schemas, and serializable DTOs |
| `tests/integration/` | OpenSSH fixtures and real transfer tests |

Shared code imports neither Electron nor Node APIs. Renderer imports only renderer/shared code. Preload imports shared contracts and the minimum Electron bridge APIs. Main may import main/shared code, never renderer components. Enforce these boundaries with lint rules.

### 9.4 IPC contract

Expose semantic operations such as `profiles.list/save/delete`, `credentials.chooseFile`, `connections.connect/cancel/disconnect`, `trust.accept/reject`, `remote.list`, `downloads.chooseDestinationAndEnqueue/cancel/retry/reveal`, and typed connection/download events.

- Validate sender, payload shape, ownership, and current state in main.
- Use opaque session, challenge, download, and destination IDs. Do not accept a generic filesystem operation, arbitrary channel, or executable command from the renderer.
- Bind trust/passphrase replies to the outstanding challenge; invalidate them on cancellation.
- Local destination authorization comes from main-owned native dialogs, not a renderer-supplied arbitrary write path.
- Include session/request IDs on events and listings so stale responses are ignored.
- Use a consistent result envelope with stable error codes and sanitized messages; do not serialize raw transport objects or stack traces by default.

The transport adapter exposes only connect/disconnect, host verification, list/stat/realpath, and read operations. Do not expose remote write, delete, rename, shell, or exec capabilities.

## 10. Local data and errors

Persist profiles, settings, trusted hosts, and app-owned partial-file journal records with explicit schema versions and atomic writes. Store SSH secrets only in transient connection memory. Do not use browser storage for credentials. Keep all data under the OS application data directory, not the installation directory.

Validate files on load. If configuration is corrupt, preserve the original, show a recovery message, and allow a clean configuration; never silently discard profiles or bypass host verification.

Classify connection failures as DNS/network, timeout, host-key mismatch, invalid credentials, passphrase failure, authentication rejected, or SFTP unavailable when reliably identifiable. Do not describe every server rejection as an expired certificate. Download failures distinguish permission denied, remote missing/changed, network loss, local permission denied, disk full, invalid filename, and finalization failure.

Keep diagnostic logs local and bounded. Exclude credential contents, passphrases, and file payloads. No analytics, account registration, telemetry, or external backend is required.

## 11. Packaging and portability

- Build a macOS `.dmg` for arm64 and x64, a Windows x64 installer, and a Linux x64 `.deb` plus a portable archive containing the app launcher.
- Produce platform-specific artifacts in CI on matching OS runners. Verify any native dependencies against the bundled Electron runtime and target architecture.
- Users install/extract, then launch using the app icon. No package manager, compiler, Node.js, system SSH installation, or environment variables are required.
- Linux support means a documented desktop distribution baseline, initially Ubuntu 24.04 or later; it does not promise identical behavior on every distribution. Test another representative desktop distribution before claiming broader support.
- Sign/notarize macOS releases and sign Windows installers when distributing beyond personal testing. Unsigned development artifacts must be labeled, with installation instructions that accurately describe OS prompts.
- Document supported OS versions for the pinned Electron release. A release is supported only after its packaged build passes the platform smoke test.
- Moving between machines means installing the correct build and recreating profiles/selecting local credential files. Cross-device credential synchronization and profile export are not version 1 features.

Provide `npm ci`, `npm start`, `npm run typecheck`, `npm run lint`, `npm test`, and `npm run make`, with a short README explaining development, test fixtures, and release builds.

## 12. Acceptance criteria

| ID | Required evidence |
| --- | --- |
| A1 | Install and launch each supported packaged build on a machine without developer tools or an SSH client. |
| A2 | Create two profiles, restart, and connect to either without losing settings. |
| A3 | Connect using an encrypted private key; wrong passphrase is recoverable; no passphrase is persisted. |
| A4 | Connect to a certificate-only OpenSSH server; reject unsigned, expired, wrong-CA, wrong-principal, and mismatched credentials. |
| A5 | Replace a certificate file externally, reconnect, and use the renewed certificate without restarting. |
| A6 | First-use trust requires acceptance; cancellation sends no user authentication; changed host keys block connection. |
| A7 | Browse nested directories, Unicode/spaced filenames, hidden files, empty directories, and permission-denied paths. |
| A8 | Download zero-byte, ordinary, and greater-than-4-GiB files; verify downloaded hashes against fixture hashes. Memory must remain bounded independently of file size. |
| A9 | Queue several files; progress stays responsive; cancel active/queued jobs; retry starts from zero. |
| A10 | Existing files survive failed/cancelled replacements; all collision choices work; destination changes are detected. |
| A11 | Simulate network loss, disk full, unavailable SFTP, remote mutation, and failed finalization; never report false completion. |
| A12 | Malicious remote names, local symlink destinations, malformed IPC, and stale events cannot write outside an authorized destination or affect another session. |
| A13 | Closing with pending downloads offers the specified choice; quitting leaves no active connection or child process. |
| A14 | A directory with 10,000 entries remains navigable and filterable; use virtualized rows if necessary. Slow server listing shows a responsive loading state. |

Use real OpenSSH fixtures for authentication and SFTP interoperability. Use focused unit tests for path validation, trust matching, queue transitions, IPC validation, and destination collision logic. Exercise the packaged UI on each target OS; a development build alone is insufficient.

## 13. Implementation order

1. **Prove transport and packaging:** certificate-only authentication, encrypted keys, host verification, one listing/download, packaged transport smoke tests.
2. **Build profiles and connection UI:** persistence, credential selection, trust/passphrase dialogs, lifecycle.
3. **Build browsing:** navigation, metadata, filtering, keyboard behavior, stale-response handling.
4. **Build downloads:** native destinations, queue, streaming, collision handling, cleanup, retry.
5. **Complete release validation:** fault cases, IPC/path tests, target-platform packaging, installation README.

Finish version 1 when the acceptance criteria pass. Keep implementation choices behind the defined service boundaries and defer additional features.

## 14. Technical references

These references support the technical choices; behavior above is the application contract. Library compatibility must be verified against the exact pinned version used for implementation.

1. [OpenSSH configuration: CertificateFile and IdentityFile](https://man.openbsd.org/ssh_config)
2. [@electerm/ssh2 package documentation: SSH Certificate Login](https://www.npmjs.com/package/@electerm/ssh2)
3. [Upstream ssh2 certificate authentication pull request #1495](https://github.com/mscdex/ssh2/pull/1495)
4. [Electron context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)
5. [Electron security recommendations](https://www.electronjs.org/docs/latest/tutorial/security)
6. [Electron Forge: packaging and distribution](https://www.electronforge.io/)
