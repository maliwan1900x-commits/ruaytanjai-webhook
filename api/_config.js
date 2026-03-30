// ═══════════════════════════════════════════════════
// /api/_config.js — Shared config & KV helpers
// ═══════════════════════════════════════════════════
// Single source of truth สำหรับ tokens, KV access, auth
// ทุกไฟล์ import จากที่นี่ที่เดียว

var KV_URL = process.env.KV_REST_API_URL;
var KV_TOKEN = process.env.KV_REST_API_TOKEN;

// ── KV Redis helpers ──
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    var r = await fetch(KV_URL + '/get/' + key, {
      headers: { Authorization: 'Bearer ' + KV_TOKEN },
    });
    var data = await r.json();
    return data.result || null;
  } catch (e) {
    return null;
  }
}

async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    var r = await fetch(KV_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + KV_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        'SET',
        key,
        typeof value === 'string' ? value : JSON.stringify(value),
      ]),
    });
    var data = await r.json();
    return data.result === 'OK';
  } catch (e) {
    return false;
  }
}

async function kvDel(key) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    await fetch(KV_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + KV_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(['DEL', key]),
    });
    return true;
  } catch (e) {
    return false;
  }
}

// ── Token loaders (KV → env → error) ──
var _cachedSettings = null;
var _cacheTime = 0;
var CACHE_TTL = 30000; // 30 seconds

async function loadAppSettings() {
  var now = Date.now();
  if (_cachedSettings && now - _cacheTime < CACHE_TTL) return _cachedSettings;
  try {
    var raw = await kvGet('appSettings');
    if (raw) {
      _cachedSettings = JSON.parse(raw);
      _cacheTime = now;
      return _cachedSettings;
    }
  } catch (e) {}
  return null;
}

async function getLineToken() {
  var settings = await loadAppSettings();
  if (settings && settings.lineToken) return settings.lineToken;
  if (process.env.LINE_TOKEN) return process.env.LINE_TOKEN;
  throw new Error('LINE_TOKEN not configured — set it in env vars or dashboard settings');
}

async function getThunderKey() {
  var settings = await loadAppSettings();
  if (settings && settings.thunderKey) return settings.thunderKey;
  if (process.env.THUNDER_KEY) return process.env.THUNDER_KEY;
  throw new Error('THUNDER_KEY not configured — set it in env vars or dashboard settings');
}

function getLineChannelSecret() {
  return process.env.LINE_CHANNEL_SECRET || null;
}

// ── Slip footer config ──
var _cachedSlipConfig = null;
var _slipConfigTime = 0;

async function getSlipConfig() {
  var now = Date.now();
  if (_cachedSlipConfig && now - _slipConfigTime < CACHE_TTL) return _cachedSlipConfig;
  try {
    var raw = await kvGet('slipConfig');
    if (raw) {
      _cachedSlipConfig = JSON.parse(raw);
      _slipConfigTime = now;
      return _cachedSlipConfig;
    }
  } catch (e) {}
  return {
    footerText: '🔒 สลิปจริงตรวจสอบโดย ธันเดอร์ โซลูชั่น',
    footerSubText: 'ผู้ให้บริการเช็กสลิปอันดับ 1',
    promoText: '',
    buttons: [],
  };
}

// ── Auth helper ──
function checkAuth(req) {
  var apiKey = process.env.ADMIN_API_KEY;
  if (!apiKey) return true; // ถ้ายังไม่ตั้ง key ให้ผ่านไปก่อน (dev mode)
  var provided = req.headers['x-api-key'] || '';
  return provided === apiKey;
}

// ── CORS helper ──
function setCors(res) {
  var origin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-line-signature, x-api-key');
}

// ── LINE signature verification ──
function verifySignature(body, signature) {
  var secret = getLineChannelSecret();
  if (!secret) return true; // ถ้าไม่ได้ตั้ง secret ให้ผ่าน (dev mode)
  try {
    var crypto = require('crypto');
    var bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    var hash = crypto
      .createHmac('SHA256', secret)
      .update(bodyStr)
      .digest('base64');
    return hash === signature;
  } catch (e) {
    return false;
  }
}

// ── KV ready check ──
function isKvReady() {
  return !!(KV_URL && KV_TOKEN);
}

// ── Invalidate cache (after settings update) ──
function invalidateCache() {
  _cachedSettings = null;
  _cacheTime = 0;
  _cachedSlipConfig = null;
  _slipConfigTime = 0;
}

module.exports = {
  kvGet,
  kvSet,
  kvDel,
  getLineToken,
  getThunderKey,
  getLineChannelSecret,
  getSlipConfig,
  checkAuth,
  setCors,
  verifySignature,
  isKvReady,
  invalidateCache,
  loadAppSettings,
};
