#!/usr/bin/env node
/**
 * fetch.mjs - materialize the offline electron-builder bundle.
 *
 * Downloads the five GitHub-hosted archives listed in manifest.json into a
 * bundle directory and verifies every sha256. The result is the directory
 * place.ps1 expects on the offline Windows host.
 *
 * Run this on a machine that CAN reach github.com (macOS / Linux / Windows),
 * then carry the resulting directory to the host that cannot.
 *
 *   node fetch.mjs                 # bundle into this directory (idempotent)
 *   node fetch.mjs --check         # verify only, no network, no writes
 *   node fetch.mjs --out <dir>     # bundle into another directory
 *   node fetch.mjs --help
 *
 * Zero third-party dependencies: node:crypto for sha256, global fetch
 * (Node 18+) for HTTP, with resume + retry for the flaky proxies that reset
 * TLS or drop large transfers mid-stream.
 *
 * manifest.json is the single source of truth (filename, sha256, and the
 * electron-builder cache layout). This script never invents hashes: it only
 * verifies downloads against the manifest, so updating a pin means editing
 * manifest.json, then re-running "npm run fetch".
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const USER_AGENT = 'dsh-offline-win-bundle-fetch'
const MAX_ATTEMPTS = 5
const PROGRESS_STEP = 32 * 1024 * 1024
const CACHE_KINDS = new Set(['electron', 'builder'])
const SHA256_RE = /^[0-9a-f]{64}$/

const HELP = [
  'Usage: node fetch.mjs [options]',
  '',
  'Downloads every archive listed in manifest.json into the bundle directory',
  'and verifies each sha256 against the manifest. A file that is already',
  'present and correct is skipped, so re-running is cheap and idempotent.',
  '',
  'Options:',
  '  --out <dir>           Bundle directory (default: this directory)',
  '  --manifest <file>     Manifest to read (default: ./manifest.json)',
  '  --check               Verify existing files only; no network, no writes',
  '  --force               Re-download even when a valid file is present',
  '  --only <names>        Comma-separated filenames to process',
  '  --cache-subdir <url>  Print the @electron/get cache subdir for a release',
  '                        URL (sha256 of the URL without the file name) and exit',
  '  -h, --help            Show this help',
  '',
  'Exit code 0 means every selected archive is present and matches its sha256.',
].join('\n')

function fmtBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return (unit === 0 ? String(value) : value.toFixed(1)) + ' ' + units[unit]
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function parseArgs(argv) {
  const opts = {
    out: HERE,
    manifest: join(HERE, 'manifest.json'),
    check: false,
    force: false,
    only: null,
    cacheSubdirUrl: null,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = () => {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error('missing value for ' + arg + ' (see --help)')
      }
      i += 1
      return next
    }
    switch (arg) {
      case '--out':
        opts.out = resolve(value())
        break
      case '--manifest':
        opts.manifest = resolve(value())
        break
      case '--check':
        opts.check = true
        break
      case '--force':
        opts.force = true
        break
      case '--only':
        opts.only = new Set(value().split(',').map((name) => name.trim()).filter(Boolean))
        break
      case '--cache-subdir':
        opts.cacheSubdirUrl = value()
        break
      case '-h':
      case '--help':
        opts.help = true
        break
      default:
        throw new Error('unknown argument: ' + arg + ' (see --help)')
    }
  }
  return opts
}

async function statOrNull(target) {
  try {
    return await stat(target)
  } catch {
    return null
  }
}

function sha256File(target) {
  return new Promise((done, fail) => {
    const hash = createHash('sha256')
    createReadStream(target)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => done(hash.digest('hex')))
      .on('error', fail)
  })
}

// @electron/get caches the electron binary at
// <cache>/<sha256(strippedUrl)>/<filename>, where strippedUrl is the release
// URL without the trailing file segment.
function electronCacheSubdir(url) {
  return createHash('sha256').update(url.replace(/\/[^/]+$/, '')).digest('hex')
}

async function loadManifest(manifestPath) {
  let raw
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch (err) {
    throw new Error('cannot read manifest ' + manifestPath + ': ' + err.message)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error('manifest ' + manifestPath + ' is not valid JSON: ' + err.message)
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('manifest ' + manifestPath + ' must be a non-empty JSON array of archive entries')
  }
  const seen = new Set()
  return parsed.map((entry, index) => {
    const where = 'manifest[' + index + ']'
    for (const key of ['filename', 'sha256', 'cacheKind', 'subdir', 'url']) {
      if (typeof entry?.[key] !== 'string' || entry[key].length === 0) {
        throw new Error(where + ': missing non-empty string field "' + key + '"')
      }
    }
    if (basename(entry.filename) !== entry.filename) {
      throw new Error(where + ': filename must be a bare file name (got "' + entry.filename + '")')
    }
    if (!SHA256_RE.test(entry.sha256)) {
      throw new Error(where + ': sha256 must be 64 lowercase hex characters (got "' + entry.sha256 + '")')
    }
    if (!CACHE_KINDS.has(entry.cacheKind)) {
      throw new Error(where + ': cacheKind must be "electron" or "builder" (got "' + entry.cacheKind + '")')
    }
    if (basename(entry.subdir) !== entry.subdir) {
      throw new Error(where + ': subdir must be a single cache directory name (got "' + entry.subdir + '")')
    }
    if (!/^https?:\/\//i.test(entry.url)) {
      throw new Error(where + ': url must be an http(s) URL (got "' + entry.url + '")')
    }
    if (seen.has(entry.filename)) {
      throw new Error(where + ': duplicate filename "' + entry.filename + '"')
    }
    seen.add(entry.filename)
    if (entry.cacheKind === 'electron') {
      const expected = electronCacheSubdir(entry.url)
      if (entry.subdir !== expected) {
        throw new Error(
          where + ': electron cache subdir does not match the url. manifest has "' + entry.subdir +
          '", url implies "' + expected + '". subdir must be sha256(url without the file name); ' +
          'derive it with: node fetch.mjs --cache-subdir ' + entry.url,
        )
      }
    }
    return entry
  })
}

// One transfer attempt. Resumes from <dest>.part via a Range request, so a
// dropped 144 MB electron zip continues instead of restarting from zero.
async function downloadOnce(url, part) {
  let offset = 0
  const existing = await statOrNull(part)
  if (existing && existing.size > 0) offset = existing.size

  const headers = { 'user-agent': USER_AGENT, accept: 'application/octet-stream' }
  if (offset > 0) headers.range = 'bytes=' + offset + '-'

  let res
  try {
    res = await fetch(url, { headers, redirect: 'follow' })
  } catch (err) {
    throw new Error('GET ' + url + ' failed: ' + (err && err.message ? err.message : String(err)))
  }
  if (res.status === 416) {
    // The partial file is longer than the remote object: stale, start over.
    await rm(part, { force: true })
    throw new Error('stale partial file for ' + url + ', restarting from scratch')
  }
  if (!res.ok) {
    const err = new Error('GET ' + url + ' -> HTTP ' + res.status + ' ' + res.statusText)
    // 4xx (except timeout / rate limit) will not fix itself: fail fast.
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) err.fatal = true
    throw err
  }
  if (!res.body) throw new Error('GET ' + url + ' returned an empty body')

  const resumed = res.status === 206 && offset > 0
  if (offset > 0 && !resumed) offset = 0

  let received = offset
  let lastReport = offset
  const started = Date.now()
  const counter = new Transform({
    transform(chunk, _encoding, done) {
      received += chunk.length
      if (process.stdout.isTTY && received - lastReport >= PROGRESS_STEP) {
        lastReport = received
        process.stdout.write('        ' + fmtBytes(received) + '\n')
      }
      done(null, chunk)
    },
  })

  await pipeline(
    Readable.fromWeb(res.body),
    counter,
    createWriteStream(part, { flags: resumed ? 'a' : 'w' }),
  )
  return { bytes: received, seconds: (Date.now() - started) / 1000, resumed }
}

async function downloadAndVerify(entry, dest, part) {
  let lastNote = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const info = await downloadOnce(entry.url, part)
      const actual = await sha256File(part)
      if (actual !== entry.sha256) {
        await rm(part, { force: true })
        lastNote = 'sha256 mismatch: expected ' + entry.sha256 + ', got ' + actual
        console.warn('  warn: ' + entry.filename + ': ' + lastNote + ' (attempt ' + attempt + '/' + MAX_ATTEMPTS + ')')
      } else {
        // rename over an existing file is not atomic on Windows: remove first.
        await rm(dest, { force: true })
        await rename(part, dest)
        return { bytes: info.bytes, seconds: info.seconds, sha256: actual }
      }
    } catch (err) {
      if (err && err.fatal) throw err
      lastNote = err && err.message ? err.message : String(err)
      console.warn('  warn: ' + entry.filename + ': ' + lastNote + ' (attempt ' + attempt + '/' + MAX_ATTEMPTS + ')')
    }
    if (attempt < MAX_ATTEMPTS) await sleep(Math.min(attempt * 2000, 15000))
  }
  throw new Error(
    'could not fetch ' + entry.filename + ' from ' + entry.url + ' after ' + MAX_ATTEMPTS + ' attempts' +
    (lastNote ? ' (last error: ' + lastNote + ')' : ''),
  )
}

async function processEntry(entry, opts) {
  const dest = join(opts.out, entry.filename)
  const part = dest + '.part'
  const existing = await statOrNull(dest)

  if (opts.check) {
    if (!existing) throw new Error('missing ' + dest + ' (run: npm run fetch)')
    const actual = await sha256File(dest)
    if (actual !== entry.sha256) {
      throw new Error('sha256 mismatch for ' + dest + ': expected ' + entry.sha256 + ', got ' + actual)
    }
    console.log('ok    ' + entry.filename + '  ' + fmtBytes(existing.size) + '  sha256 ' + actual)
    return { bytes: existing.size }
  }

  if (existing && !opts.force) {
    const actual = await sha256File(dest)
    if (actual === entry.sha256) {
      console.log('ok    ' + entry.filename + '  ' + fmtBytes(existing.size) + '  (already present)')
      return { bytes: existing.size }
    }
    console.log('redo  ' + entry.filename + '  ' + fmtBytes(existing.size) + '  (sha256 mismatch in bundle dir)')
    await rm(dest, { force: true })
  }

  if (opts.force) await rm(part, { force: true })
  console.log('get   ' + entry.filename)
  const result = await downloadAndVerify(entry, dest, part)
  console.log('ok    ' + entry.filename + '  ' + fmtBytes(result.bytes) + '  ' + result.seconds.toFixed(1) + 's  sha256 ' + result.sha256)
  return result
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(HELP)
    return 0
  }
  if (opts.cacheSubdirUrl) {
    console.log(electronCacheSubdir(opts.cacheSubdirUrl))
    return 0
  }
  if (typeof fetch !== 'function') {
    throw new Error('this Node.js (' + process.version + ') has no global fetch; Node 20+ is required')
  }

  const manifest = await loadManifest(opts.manifest)
  let selected = manifest
  if (opts.only) {
    const known = new Set(manifest.map((entry) => entry.filename))
    const unknown = [...opts.only].filter((name) => !known.has(name))
    if (unknown.length > 0) throw new Error('--only: not in manifest: ' + unknown.join(', '))
    selected = manifest.filter((entry) => opts.only.has(entry.filename))
  }

  if (!opts.check) await mkdir(opts.out, { recursive: true })
  console.log('manifest: ' + opts.manifest + '  (' + manifest.length + ' archives' + (opts.only ? ', ' + selected.length + ' selected' : '') + ')')
  console.log('bundle:   ' + opts.out + (opts.check ? '  [check only]' : ''))
  console.log('')

  const failures = []
  let totalBytes = 0
  for (const entry of selected) {
    try {
      const result = await processEntry(entry, opts)
      totalBytes += result.bytes || 0
    } catch (err) {
      failures.push(entry.filename + ': ' + (err && err.message ? err.message : String(err)))
    }
  }

  // place.ps1 reads manifest.json from the bundle directory, so keep a copy
  // there whenever --out points somewhere else.
  if (!opts.check && resolve(opts.out) !== resolve(dirname(opts.manifest))) {
    const copied = join(opts.out, 'manifest.json')
    await copyFile(opts.manifest, copied)
    console.log('')
    console.log('manifest.json -> ' + copied)
  }

  console.log('')
  if (failures.length > 0) {
    for (const failure of failures) console.error('FAIL  ' + failure)
    console.error(failures.length + ' of ' + selected.length + ' archives failed.')
    return 1
  }
  console.log('All ' + selected.length + ' archives OK (' + fmtBytes(totalBytes) + ') in ' + opts.out + '.')
  if (opts.check) {
    console.log('Bundle is complete. Copy it to the offline Windows host and run: pwsh ./place.ps1 -BundleDir .')
  } else {
    console.log('Next: copy this directory to the offline Windows host, then: pwsh ./place.ps1 -BundleDir .')
  }
  return 0
}

try {
  process.exitCode = await main()
} catch (err) {
  console.error('error: ' + (err && err.message ? err.message : String(err)))
  process.exitCode = 1
}
