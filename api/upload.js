// ═══════════════════════════════════════════════════
// /api/upload.js — Upload slip image → return public URL
// ═══════════════════════════════════════════════════
// รับ multipart/form-data หรือ JSON { base64, contentType }
// เก็บรูปไว้ใน Redis แล้วคืน URL ที่ LINE เข้าถึงได้ (ผ่าน /api/image/:id)
//
// ⚠️ HTTPS REQUIRED: LINE API ต้องการ URL ที่ใช้ HTTPS เท่านั้น
// Vercel deployment มี HTTPS ให้ default อยู่แล้ว → ใช้ได้ทันที

var config = require('./_config');

var MAX_IMAGE_SIZE = 4 * 1024 * 1024; // 4 MB
var IMAGE_TTL_HOURS = 24; // เก็บ 24 ชม.

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

module.exports = async (req, res) => {
  config.setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!config.checkAuth(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    var body = req.body || {};
    var base64 = body.base64;
    var contentType = body.contentType || 'image/jpeg';

    if (!base64) {
      return res.status(400).json({ ok: false, error: 'base64 required' });
    }

    // ตัด data URL prefix ถ้ามี
    var rawBase64 = base64;
    if (rawBase64.indexOf(',') !== -1) {
      var parts = rawBase64.split(',');
      var header = parts[0];
      rawBase64 = parts[1];
      var m = header.match(/data:([^;]+)/);
      if (m) contentType = m[1];
    }

    // ประมาณขนาด
    var approxSize = Math.floor(rawBase64.length * 0.75);
    if (approxSize > MAX_IMAGE_SIZE) {
      return res.status(413).json({ ok: false, error: 'image too large (max 4MB)' });
    }

    // สร้าง id แล้วเก็บใน Redis
    var id = makeId();
    var key = 'image:' + id;
    var data = {
      base64: rawBase64,
      contentType: contentType,
      createdAt: Date.now(),
    };

    var saved = await config.kvSetEx(key, JSON.stringify(data), IMAGE_TTL_HOURS * 3600);
    if (!saved) {
      return res.status(500).json({ ok: false, error: 'failed to save image' });
    }

    // คืน public URL (absolute URL ต้องใช้ https)
    var host = req.headers['x-forwarded-host'] || req.headers.host || '';
    var proto = req.headers['x-forwarded-proto'] || 'https';
    var publicUrl = proto + '://' + host + '/api/image?id=' + id;

    return res.status(200).json({
      ok: true,
      id: id,
      url: publicUrl,
      expiresInHours: IMAGE_TTL_HOURS,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
