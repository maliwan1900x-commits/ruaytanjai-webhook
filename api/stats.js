// ═══════════════════════════════════════════════════
// /api/stats.js — Summary statistics
// ═══════════════════════════════════════════════════

var config = require('./_config');
var store = require('./_store');

module.exports = async (req, res) => {
  config.setCors(res);
  if (!config.checkAuth(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  if (req.method === 'DELETE') {
    await store.resetAll();
    return res.status(200).json({ ok: true, message: 'reset' });
  }

  var summary = await store.getSummary();
  return res.status(200).json(summary);
};
