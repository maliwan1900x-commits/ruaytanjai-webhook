// ═══════════════════════════════════════════════════
// /api/kv.js — Unified data management endpoint
// ═══════════════════════════════════════════════════
// Dashboard ใช้ endpoint นี้สำหรับทุกอย่าง: contacts, config, settings

var config = require('./_config');
var store = require('./_store');

module.exports = async (req, res) => {
  config.setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!config.checkAuth(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  var action = req.query.action || '';

  // ─── GET: Load data ───
  if (req.method === 'GET') {
    if (action === 'status') {
      return res.status(200).json({ ok: true, kvReady: config.isKvReady() });
    }

    var contacts = await store.getContacts();
    var slipConfig = await config.getSlipConfig();
    var appSettings = await config.loadAppSettings();

    // Load prize config
    var prizeConfig = null;
    try {
      var pcRaw = await config.kvGet('prizeConfig');
      if (pcRaw) prizeConfig = JSON.parse(pcRaw);
    } catch (e) {}

    return res.status(200).json({
      ok: true,
      kvReady: config.isKvReady(),
      contacts: contacts,
      slipConfig: slipConfig || {},
      prizeConfig: prizeConfig || null,
      appSettings: appSettings ? { lineToken: appSettings.lineToken ? '••••••' : '', thunderKey: appSettings.thunderKey ? '••••••' : '' } : {},
    });
  }

  // ─── POST: Save data ───
  if (req.method === 'POST') {
    var body = req.body || {};

    if (action === 'contacts') {
      var ok = await store.saveContacts(body.contacts || []);
      return res.status(200).json({ ok: ok });
    }

    if (action === 'slipConfig') {
      var ok2 = await config.kvSet('slipConfig', JSON.stringify(body.config || {}));
      config.invalidateCache();
      return res.status(200).json({ ok: ok2 });
    }

    if (action === 'prizeConfig') {
      var ok4 = await config.kvSet('prizeConfig', JSON.stringify(body.config || {}));
      return res.status(200).json({ ok: ok4 });
    }

    if (action === 'appSettings') {
      // ดึง settings เก่ามา merge กับใหม่
      var currentSettings = (await config.loadAppSettings()) || {};
      var newSettings = body.settings || {};

      // ถ้าส่งมาเป็น '••••••' แปลว่าไม่ได้แก้ ใช้ค่าเดิม
      if (newSettings.lineToken === '••••••') newSettings.lineToken = currentSettings.lineToken;
      if (newSettings.thunderKey === '••••••') newSettings.thunderKey = currentSettings.thunderKey;

      var merged = { ...currentSettings, ...newSettings };
      var ok3 = await config.kvSet('appSettings', JSON.stringify(merged));
      config.invalidateCache();
      return res.status(200).json({ ok: ok3 });
    }

    return res.status(400).json({ ok: false, error: 'unknown action: ' + action });
  }

  return res.status(405).json({ error: 'GET or POST only' });
};
