// ═══════════════════════════════════════════════════
// /api/image.js — Serve uploaded image (public, no auth)
// ═══════════════════════════════════════════════════
// GET /api/image?id=xxx → คืนรูปภาพจริง (ไม่มี auth เพราะ LINE ต้องเข้าถึงได้)

var config = require('./_config');

module.exports = async (req, res) => {
  // ไม่ตรวจ auth — LINE server ต้องดาวน์โหลดรูปได้
  var id = (req.query && req.query.id) || '';
  if (!id) return res.status(400).send('id required');

  try {
    var raw = await config.kvGet('image:' + id);
    if (!raw) return res.status(404).send('not found or expired');

    var data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!data.base64) return res.status(404).send('not found');

    var buf = Buffer.from(data.base64, 'base64');
    res.setHeader('Content-Type', data.contentType || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Content-Length', buf.length);
    return res.status(200).send(buf);
  } catch (e) {
    return res.status(500).send('error: ' + e.message);
  }
};
