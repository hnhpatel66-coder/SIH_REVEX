const { app, connectMongo, ensureAdmin } = require('../backend/server');

let readyPromise;

async function prepare() {
  if (!readyPromise) {
    readyPromise = connectMongo().then(() => ensureAdmin());
  }
  await readyPromise;
}

module.exports = async (req, res) => {
  try {
    // Vercel normally keeps /api in the request path. If it strips it,
    // add it back so the existing Express routes continue to work.
    if (!req.url.startsWith('/api')) {
      req.url = '/api' + (req.url.startsWith('/') ? req.url : '/' + req.url);
    }

    await prepare();
    return app(req, res);
  } catch (err) {
    console.error('API startup failed:', err);
    return res.status(500).json({
      message: 'Backend service is unavailable.',
    });
  }
};
