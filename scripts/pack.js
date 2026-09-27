#!/usr/bin/env node
/**
 * PACKAGE THE DELIVERABLE  (scripts/pack.js)
 *
 * Builds `revex_1_3.zip` from this working tree.
 *
 * WHAT IS EXCLUDED, AND WHY IT MATTERS
 *
 *   .env            the developer's real Atlas URI, JWT secret and Razorpay
 *                   keys. Having it in the working tree is normal; having it in
 *                   the delivered archive would be a serious leak.
 *   node_modules    enormous, and `npm install` recreates it byte-for-byte from
 *                   package-lock.json.
 *   uploads/backups user uploads and database dumps, which contain real records.
 *   *.log *.pem …   noise and key material.
 *
 * Nothing is deleted from the working tree; files are only left out of the zip.
 *
 * WHY THE ZIP IS WRITTEN BY HAND
 *
 * `Compress-Archive` (the obvious way to do this) stores entry names with
 * BACKSLASHES. Windows Explorer and `Expand-Archive` cope with that, but macOS
 * Archive Utility, Linux `unzip` and Python's `zipfile` treat a backslash name
 * as ONE filename called "revex_1_3\backend\server.js" and flatten the entire
 * project into a handful of oddly named files. The ZIP specification requires
 * forward slashes, so this script writes the archive itself using Node's
 * built-in zlib. No extra dependency, and it extracts correctly everywhere.
 *
 * WHERE THE FILE GOES
 *
 * Default: %USERPROFILE%\Downloads\revex_1_3.zip
 *
 * Not the Desktop. On this machine Desktop and Documents are redirected into
 * OneDrive, and OneDrive DELETED a delivered zip from the Desktop within
 * minutes of it being written - twice. `C:\Users\DELL\Downloads` is a real local
 * folder that OneDrive does not manage, so the archive survives there. Pass an
 * explicit path to override:
 *
 *   node scripts/pack.js
 *   node scripts/pack.js D:\somewhere\else.zip
 *
 * SHIPPING THE .env (a local build that runs with no setup)
 *
 *   node scripts/pack.js C:\path\to\REVEX_LOCAL.zip --include-env
 *
 * This puts backend/.env - Atlas URI and password, JWT secret, Razorpay keys and
 * the assistant API key - inside the archive, so extracting and running needs no
 * setup at all. It is opt-in and off by default, because the same file sent to
 * somebody else hands over every credential. Only backend/.env is let through;
 * an .env.local or any other env file still stops the build.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const DEFAULT_OUTPUT = path.join(os.homedir(), 'Downloads', 'revex_1_3.zip');
const OUTPUT = path.resolve(process.argv[2] || DEFAULT_OUTPUT);
const FOLDER = 'revex_1_3';

/**
 * --include-env ships the real backend/.env.
 *
 * This is OFF by default and the guard below is deliberately hard to bypass,
 * because the archive then contains live credentials: the Atlas URI and
 * password, the JWT signing secret, the Razorpay key pair and the assistant
 * API key. That is fine for a copy you run on your own machine and catastrophic
 * in a file you send to someone.
 *
 * It exists because "extract and run with no setup" is a real requirement for a
 * local build, and silently editing the exclusion list each time is how secrets
 * end up in a shared archive. Here the intent has to be typed on the command
 * line every single time.
 */
const INCLUDE_ENV = process.argv.includes('--include-env');
if (INCLUDE_ENV && /\.(zip|7z|tar|tgz)$/i.test(OUTPUT) === false) {
  console.error('--include-env must be used with a .zip output path.');
  process.exit(1);
}

/** Directories never packed. */
const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', '.vercel', '.next', 'dist', 'build', 'coverage',
  'uploads', 'backups', 'logs', '.vscode', '.idea'
]);

/** Files never packed. `.env` carries real credentials. */
const EXCLUDED_FILES = new Set([
  '.env', '.env.local', '.env.development.local', '.env.production.local',
  'Thumbs.db', '.DS_Store', 'desktop.ini', 'npm-debug.log', 'yarn-error.log'
]);

/** Extensions never packed. */
const EXCLUDED_EXT = new Set(['.log', '.pem', '.key', '.p12', '.pfx', '.swp']);

/**
 * `.env.example` and friends are TEMPLATES and are meant to be delivered; only a
 * real `.env` is forbidden. Used both when collecting and as a last-ditch guard
 * before anything is written.
 */
const isRealEnv = file => /(^|\/)\.env(\.(?!example|sample|template)[^/]*)?$/i.test(file);

function shouldSkipDir(name) {
  return EXCLUDED_DIRS.has(name);
}

/**
 * @param {string} name  the file's basename
 * @param {string} rel   its path relative to the project root, with / separators
 */
function shouldSkipFile(name, rel = '') {
  if (EXCLUDED_FILES.has(name)) {
    // With --include-env, backend/.env is the ONE file allowed through, so a
    // local build is runnable with no setup step. Nothing else changes: no
    // .env.local, no .env.production, and never a root .env.
    if (INCLUDE_ENV && rel === 'backend/.env') return false;
    return true;
  }
  return EXCLUDED_EXT.has(path.extname(name).toLowerCase());
}

/** Walks the tree and returns the relative paths to pack. */
function collect(dir = ROOT, base = '', found = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue;
      collect(path.join(dir, entry.name), base ? `${base}/${entry.name}` : entry.name, found);
      continue;
    }
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (shouldSkipFile(entry.name, rel)) continue;
    found.push(rel);
  }
  return found;
}

/* ------------------------------------------------------------------ zip */

/** CRC-32, computed once into a table. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/**
 * DOS date/time, which is what the ZIP format stores. The local timezone is
 * used deliberately: the value is only ever read back as "when was this made".
 */
function dosStamp(date = new Date()) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

function writeArchive(destination, entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, day } = dosStamp();

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    // Store uncompressed when compression did not help (already-compressed
    // assets, tiny files), so nothing in the archive grows.
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);      // local file header signature
    local.writeUInt16LE(20, 4);             // version needed
    local.writeUInt16LE(0x0800, 6);         // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);             // extra field length

    chunks.push(local, nameBytes, payload);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);    // central directory signature
    header.writeUInt16LE(20, 4);            // version made by
    header.writeUInt16LE(20, 6);            // version needed
    header.writeUInt16LE(0x0800, 8);        // flags: UTF-8 names
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(day, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(payload.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt16LE(0, 30);            // extra field length
    header.writeUInt16LE(0, 32);            // comment length
    header.writeUInt16LE(0, 34);            // disk number
    header.writeUInt16LE(0, 36);            // internal attributes
    header.writeUInt32LE(0o644 << 16, 38);  // external attributes
    header.writeUInt32LE(offset, 42);       // relative offset of local header

    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + payload.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);         // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);                 // comment length

  fs.writeFileSync(destination, Buffer.concat([...chunks, centralBuffer, end]));
}

/* ----------------------------------------------------------------- main */

function main() {
  const files = collect();

  /*
   * Last-ditch guard. A real .env is only tolerated when --include-env was
   * typed, and only the single expected path is let through — an .env.local or
   * an .env picked up from a subdirectory still stops the build.
   */
  const dangerous = files.filter(file =>
    (isRealEnv(file) && !(INCLUDE_ENV && file === 'backend/.env')) || file.includes('node_modules'));
  if (dangerous.length) {
    console.error('Refusing to pack: these must never be delivered:');
    dangerous.forEach(file => console.error(`  - ${file}`));
    process.exit(1);
  }

  if (INCLUDE_ENV) {
    if (!files.includes('backend/.env')) {
      console.error('--include-env was passed but backend/.env does not exist.');
      process.exit(1);
    }
    console.warn('');
    console.warn('  ################################################################');
    console.warn('  #  THIS ARCHIVE CONTAINS LIVE CREDENTIALS                    #');
    console.warn('  #                                                              #');
    console.warn('  #  backend/.env holds your MongoDB Atlas URI and password,    #');
    console.warn('  #  the JWT signing secret, the Razorpay key pair and the      #');
    console.warn('  #  assistant API key.                                        #');
    console.warn('  #                                                              #');
    console.warn('  #  It is safe to run locally. DO NOT email it, upload it,     #');
    console.warn('  #  or hand it to somebody else.                              #');
    console.warn('  ################################################################');
    console.warn('');
  }

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  if (fs.existsSync(OUTPUT)) fs.rmSync(OUTPUT);

  writeArchive(OUTPUT, files.map(file => ({
    // Forward slashes, as the ZIP specification requires.
    name: `${FOLDER}/${file.split(path.sep).join('/')}`,
    data: fs.readFileSync(path.join(ROOT, file))
  })));

  const size = (fs.statSync(OUTPUT).size / 1024).toFixed(0);
  console.log(`Packed ${files.length} file(s) into`);
  console.log(`  ${OUTPUT}  (${size} KB)`);
  console.log(INCLUDE_ENV
    ? 'Included backend/.env on request, so the archive runs with no setup. Treat it as a secret.'
    : 'Excluded: node_modules, .env, uploads, backups, logs, key and certificate files.');
  console.log('Entry names use forward slashes, so it extracts correctly on Windows, macOS and Linux.');
}

main();
