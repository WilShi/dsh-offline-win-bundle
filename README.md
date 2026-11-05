# Offline Windows build

Produce the Windows NSIS installer (`yarn dist:win`) on a Windows host that
**cannot reach github.com** but **can reach the npm registry**.

This bundles the five GitHub-hosted binaries electron-builder pulls at build
time (the win electron binary, NSIS, nsis-resources, winCodeSign/rcedit, and
7za). Everything else — the npm dependency tree, native prebuilt `.node`
files, the upstream submodule — resolves on the Windows host itself via
`yarn install` (npm is reachable) or is already bundled inside npm packages.

## Why this works (source-verified)

- The four electron-builder tools are recognized by **file existence + sha256**
  at a **deterministic** cache path `…\electron-builder\Cache\<release>\<file>`
  — no hash-named folder, no `.state` marker file
  (`app-builder-lib/out/util/electronGet.js:375-377, 292-312, 429`).
- The electron binary is recognized by `@electron/get` at
  `…\electron\Cache\<sha256(strippedUrl)>\<file>` — file existence + the
  **bundled** `checksums.json` (do **not** set `electron_use_remote_checksums`,
  that would fetch `SHASUMS256.txt` from github and fail offline)
  (`electron/install.js:47-50,60-76`; `@electron/get/Cache.js:39-48`).
- `ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL` covers only **2 of 4**
  tools; `ELECTRON_BUILDER_BINARIES_MIRROR` covers all 4 but needs an HTTP
  server. Pre-placing the archives needs **zero** env vars and is the only
  fully-deterministic path, so that is what `place.ps1` does.
- `.yarnrc.yml` sets `enableScripts: false`, so **no postinstall runs** during
  `yarn install` — the build does not touch the network at install time.
  Native addons (`node-pty`, `koffi`, `sharp`) ship prebuilt `.node` files
  inside their npm packages and are located at runtime, so they work with
  scripts disabled.

## Prerequisites on the Windows host

- Node `^22.19.0 || >=24.0.0` (CI uses 22.23.2)
- Corepack (for Yarn 4.18.0) and Git
- npm registry reachable (public or an internal mirror). github.com need
  **not** be reachable.
- The repo, on the same commit as the dev machine, with the
  `deepseek-harness/` submodule initialized (`git submodule update --init`).

## Step 1 — fetch the binaries (on a machine WITH GitHub access)

Prereq: Node 22+ and `curl` on PATH (macOS ships curl). `fetch.mjs` uses curl
for downloads (its `--retry-all-errors` + `-C -` resume survives flaky proxies
that reset TLS or drop large transfers mid-stream).

```sh
node dsh-plugin-desktop/scripts/offline-win/fetch.mjs
# optional: --out <dir>   (default: ../dsh-offline-win-bundle, a sibling of the repo)
```

`fetch.mjs` downloads the five archives, verifies each sha256 against the
hardcoded value (and the electron zip against the official `SHASUMS256.txt`),
writes `manifest.json`, and prints the bundle directory. It also cross-checks
the four builder-tool constants against the installed `app-builder-lib` source
and fails loudly if they are stale after an electron-builder bump.

Output (default): `../dsh-offline-win-bundle/` containing the five archives +
`manifest.json`. Copy `place.ps1` + this `README.md` into it for a
self-contained transfer bundle.

## Step 2 — transfer to the Windows host

Copy the bundle directory (the five archives + `manifest.json` + `place.ps1`)
to the offline Windows machine — USB, internal file share, etc.

## Step 3 — place the binaries into the caches

From the bundle directory on the Windows host:

```pwsh
pwsh place.ps1
# or: pwsh place.ps1 -BundleDir C:\transfer\dsh-offline-win-bundle
```

`place.ps1` re-verifies each sha256 and copies each archive to:

| archive | destination |
|---|---|
| `electron-v<ver>-win32-x64.zip` | `%LOCALAPPDATA%\electron\Cache\<sha256(strippedUrl)>\` |
| `nsis-3.0.4.1.7z` | `%LOCALAPPDATA%\electron-builder\Cache\nsis-3.0.4.1\` |
| `nsis-resources-3.4.1.7z` | `%LOCALAPPDATA%\electron-builder\Cache\nsis-resources-3.4.1\` |
| `winCodeSign-2.6.0.7z` | `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign-2.6.0\` |
| `7zip-win-x64.tar.gz` | `%LOCALAPPDATA%\electron-builder\Cache\7zip@1.0.0\` |

## Step 4 — build

From the repo root on the Windows host:

```sh
corepack enable
yarn install --immutable
yarn dist:win
```

`yarn dist:win` runs `package-win.ts`: the `check:win-package` gate (build +
typecheck + a Windows test subset), then
`electron-builder --win nsis --x64 --publish never --config.win.signExecutable=false
--config.npmRebuild=false`, then `verify-win-installer.ts`.

Output: `dsh-plugin-desktop/dist/DSH-Desktop-<version>-x64-Setup.exe`
(plus `*-x64.zip` if you also run the portable-zip step from `package.yml`).

## Fallback — electron binary not installed

`place.ps1` pre-populates the `@electron/get` cache, which satisfies
electron-builder's build-time fetch of the win binary. If a future
electron-builder revision instead reads `node_modules/electron/dist/` directly
and reports the binary missing, extract the zip there:

```pwsh
$zip = Join-Path $env:LOCALAPPDATA 'electron\Cache\<subdir>\electron-v43.4.0-win32-x64.zip'
$dist = 'dsh-plugin-desktop\node_modules\electron\dist'
Expand-Archive -LiteralPath $zip -DestinationPath $dist -Force
# install.js checks dist/version + path.txt:
Set-Content (Join-Path $dist 'version') '43.4.0'
Set-Content (Join-Path (Split-Path $dist -Parent) 'path.txt') 'electron.exe'
```

(replace the version/subdir to match your pin; `fetch.mjs` prints the subdir.)

## Regenerating after a pin bump

- **electron version bump** — nothing to do. `fetch.mjs` reads the version from
  `dsh-plugin-desktop/package.json` (`devDependencies.electron`), so the
  electron zip URL, the cache hash, and the `SHASUMS256.txt` lookup update
  automatically. Add the new version's expected cache hash to
  `KNOWN_ELECTRON_HASHES` if you want the self-check.
- **electron-builder bump** — the four `BUILDER_TOOLS` constants
  (release name, filename, sha256) may change. Re-derive from the installed
  source and update `fetch.mjs`:

```sh
grep -nE 'nsis-[0-9]|nsis-resources-[0-9]|winCodeSign-[0-9]|[0-9a-f]{64}' \
  dsh-plugin-desktop/node_modules/app-builder-lib/out/toolsets/windows.js \
  dsh-plugin-desktop/node_modules/app-builder-lib/out/toolsets/7zip.js
```

Match each `(release, filename, sha256)` triple to the literals above
(windows.js holds nsis / nsis-resources / winCodeSign; 7zip.js holds the
7zip release). The cross-check in `fetch.mjs` will already have failed if any
constant is stale, so this is only needed when it does.

---

## Quick start (TL;DR)

```bash
# On a machine that CAN reach github.com:
git clone https://github.com/WilShi/dsh-offline-win-bundle.git
cd dsh-offline-win-bundle
npm run fetch            # downloads the 5 archives, verifies sha256

# Carry this directory to the offline Windows host, then:
pwsh ./place.ps1 -BundleDir .
yarn dist:win
```

The binaries are **not** committed to this repo (~146 MB). `manifest.json` is the
single source of truth: it pins each archive URL plus its sha256, and `fetch.mjs`
reproduces the bundle from it.

## License

[MIT](LICENSE) © 2026 WilShi

