function normalizeMediaUrl(value, fallback = '') {
  let text = String(value || '').trim();
  if (!text) return fallback;
  if (/^data:(image\/|application\/pdf)/i.test(text)) return text;

  // Repair legacy values where an absolute base URL was prepended twice.
  const nested = text.match(/https?:\/\/[^/]+\/(?:https?:\/\/[^/]+\/)(.+)$/i);
  if (nested) text = nested[1];

  if (/^https?:\/\//i.test(text)) {
    try {
      const parsed = new URL(text);
      if (['localhost', '127.0.0.1', '0.0.0.0'].includes(parsed.hostname)) return `${parsed.pathname}${parsed.search}`;
      return text;
    } catch {
      return fallback;
    }
  }

  text = text.replace(/^file:\/\//i, '');
  text = text.replace(/^\/+/, '').replace(/^uploads\//i, 'uploads/');
  if (!/^(uploads|images|assets)\//i.test(text)) text = `uploads/${text.replace(/^\/+/, '')}`;
  const clean = text.split('?')[0].split('#')[0];
  if (!/^(uploads|images|assets)\/[A-Za-z0-9._/-]+$/.test(clean) || clean.includes('..')) return fallback;
  return `/${clean}`;
}

module.exports = { normalizeMediaUrl };
