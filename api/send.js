// ═══════════════════════════════════════════════════
// /api/send.js — Push message to LINE user
// ═══════════════════════════════════════════════════

var config = require('./_config');

module.exports = async (req, res) => {
  config.setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!config.checkAuth(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  var body = req.body || {};
  if (!body.userId) return res.status(400).json({ ok: false, error: 'userId required' });

  var messages = [];
  if (body.flex) {
    messages.push(body.flex);
  } else if (body.message) {
    messages.push({ type: 'text', text: body.message });
  } else {
    return res.status(400).json({ ok: false, error: 'message or flex required' });
  }

  try {
    var token = await config.getLineToken();
    var payload = { to: body.userId, messages: messages };

    var r = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(payload),
    });
    if (r.ok) return res.status(200).json({ ok: true });
    var errBody = '';
    try { errBody = await r.text(); } catch (e2) {}
    return res.status(200).json({ ok: false, error: 'HTTP ' + r.status, detail: errBody });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
};
