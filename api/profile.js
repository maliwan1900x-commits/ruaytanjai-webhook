// ═══════════════════════════════════════════════════
// /api/profile.js — Fetch LINE user profile
// ═══════════════════════════════════════════════════

var config = require('./_config');

module.exports = async (req, res) => {
  config.setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!config.checkAuth(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  var userId = req.query && req.query.userId ? req.query.userId : null;
  if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });

  try {
    var token = await config.getLineToken();
    var r = await fetch('https://api.line.me/v2/bot/profile/' + userId, {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!r.ok) return res.status(200).json({ ok: false, status: r.status });
    var p = await r.json();
    return res.status(200).json({
      ok: true, userId: userId,
      name: p.displayName, picture: p.pictureUrl || null,
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
};
