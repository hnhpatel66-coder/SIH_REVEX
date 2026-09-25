/**
 * Shared MongoDB connection logic used by BOTH entry points
 * (backend/server.js and api/index.js) so they cannot drift apart.
 *
 * Responsibilities:
 *  1. Guarantee the connection string names an explicit database.
 *  2. Never silently fall back to a local MongoDB, which would make the app
 *     "look healthy" while silently writing production data to localhost.
 */
const mongoose = require('mongoose');

const DEFAULT_DB_NAME = 'vroomy';

/**
 * MongoDB connection strings may omit the database name
 * (mongodb+srv://user:pass@cluster.mongodb.net). In that case the driver
 * silently uses "test", which is almost never what an application wants.
 * This injects an explicit database path when one is missing.
 */
function buildMongoUri(uri, dbName) {
  const value = String(uri || '').trim();
  if (!value) return value;
  const database = String(dbName || process.env.MONGODB_DB_NAME || DEFAULT_DB_NAME).trim() || DEFAULT_DB_NAME;

  // Split off any query string (?retryWrites=...) and keep it at the end.
  const queryIndex = value.indexOf('?');
  const base = queryIndex === -1 ? value : value.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : value.slice(queryIndex);

  // base = mongodb+srv://user:pass@host  or  mongodb://host:port[/db]
  const schemeEnd = base.indexOf('://');
  const afterScheme = base.slice(schemeEnd + 3);
  const slash = afterScheme.indexOf('/');
  const host = slash === -1 ? afterScheme : afterScheme.slice(0, slash);
  // Normalise away any trailing slashes so we never emit "...net//vroomy".
  const existingPath = slash === -1 ? '' : afterScheme.slice(slash + 1).replace(/\/+$/, '');

  const name = existingPath || encodeURIComponent(database);
  return `${base.slice(0, schemeEnd + 3)}${host}/${name}${query}`;
}

function describeTarget(uri) {
  try {
    const parsed = new URL(uri.replace(/^mongodb(\+srv)?:\/\//, 'http://'));
    return `${parsed.host}/${String(uri).split('/').pop()}`;
  } catch {
    return '(unparseable uri)';
  }
}

/**
 * Connects to MongoDB Atlas.
 * A local fallback happens ONLY when explicitly enabled via
 * ALLOW_LOCAL_MONGO_FALLBACK=true, and is always logged loudly.
 */
async function connectMongo() {
  const atlasUri = process.env.MONGODB_URI;
  const fallbackUri = process.env.MONGODB_FALLBACK_URI;
  const allowFallback = String(process.env.ALLOW_LOCAL_MONGO_FALLBACK || '').toLowerCase() === 'true';
  const dbName = process.env.MONGODB_DB_NAME || DEFAULT_DB_NAME;

  const primary = buildMongoUri(atlasUri, dbName);
  const options = { serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000, socketTimeoutMS: 20000, family: 4 };

  if (atlasUri) {
    console.log(`[mongo] connecting to Atlas: ${describeTarget(primary)}`);
    try {
      await mongoose.connect(primary, options);
      process.env.ACTIVE_MONGO_MODE = 'atlas';
      console.log(`[mongo] connected. database="${mongoose.connection.name}" mode=atlas`);
      return { mode: 'atlas', database: mongoose.connection.name };
    } catch (error) {
      console.error(`[mongo] Atlas connection FAILED: ${error.name}: ${error.message}`);
      console.error('[mongo] Common causes: (1) this machine IP is not in Atlas > Network Access,');
      console.error('[mongo] (2) the DB user is missing from the NEW cluster, (3) wrong password,');
      console.error('[mongo] (4) special characters in the password must be URL-encoded.');
      if (!allowFallback) {
        throw new Error(`Atlas connection failed and ALLOW_LOCAL_MONGO_FALLBACK is not enabled. Refusing to start so data cannot be written to the wrong database.\n${error.message}`);
      }
    }
  } else {
    console.warn('[mongo] MONGODB_URI is not set.');
  }

  if (allowFallback && fallbackUri) {
    const local = buildMongoUri(fallbackUri, dbName);
    console.warn(`[mongo] ALLOW_LOCAL_MONGO_FALLBACK=true -> using LOCAL MongoDB: ${describeTarget(local)}`);
    console.warn('[mongo] WARNING: this is a different database. Do not use this for production data.');
    await mongoose.connect(local, { ...options, serverSelectionTimeoutMS: 7000 });
    process.env.ACTIVE_MONGO_MODE = 'local';
    console.log(`[mongo] connected. database="${mongoose.connection.name}" mode=local`);
    return { mode: 'local', database: mongoose.connection.name };
  }

  throw new Error('No usable MongoDB connection. Set MONGODB_URI, or explicitly set ALLOW_LOCAL_MONGO_FALLBACK=true for local-only work.');
}

module.exports = { connectMongo, buildMongoUri, DEFAULT_DB_NAME };
