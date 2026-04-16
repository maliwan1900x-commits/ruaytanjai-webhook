// ═══════════════════════════════════════════════════
// /api/telegram-webhook.js — รับแจ้งเตือนรูปจาก Telegram group
// ═══════════════════════════════════════════════════
// Telegram → POST update → ดาวน์โหลดรูป → เก็บเป็น pending slip ใน Redis
// GET  ?action=setup → ตั้ง webhook URL ให้อัตโนมัติ
// GET  ?action=info  → ดูสถานะ webhook
// POST (Telegram update) → รับรูปใหม่
//
// ENV vars ที่ต้องตั้ง:
//   TELEGRAM_BOT_TOKEN    — token จาก @BotFather
//   TELEGRAM_GROUP_ID     — group chat id (เช่น -1003764117424)
//   TELEGRAM_WEBHOOK_SECRET — secret random string (ป้องกัน webhook ถูกเรียกโดยคนอื่น)

var config = require('./_config');

var TG_API = 'https://api.telegram.org/bot';
var TG_FILE = 'https://api.telegram.org/file/bot';

// ── ดึงค่า env ──
function getTelegramToken() {
  var token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not configured');
  return token;
}

function getGroupId() {
  var id = process.env.TELEGRAM_GROUP_ID;
  if (!id) return null;
  return String(id);
}

function getWebhookSecret() {
  return process.env.TELEGRAM_WEBHOOK_SECRET || '';
}

// ── Pending slip helpers (Redis) ──
// Metadata list: pending:slips → [{ id, timestamp, ... }]  (ไม่มี base64)
// Image data:    pending:img:{id} → { base64, contentType } (TTL 24h auto-expire)
var PENDING_KEY = 'pending:slips';
var PENDING_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
var PENDING_TTL_SEC = 24 * 60 * 60;

async function loadPendingSlips() {
  try {
    var raw = await config.kvGet(PENDING_KEY);
    if (!raw) return [];
    var list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    // กรอง slip ที่หมดอายุ
    var cutoff = Date.now() - PENDING_TTL_MS;
    return list.filter(function (s) { return s.timestamp > cutoff; });
  } catch (e) {
    return [];
  }
}

async function savePendingSlips(list) {
  return await config.kvSet(PENDING_KEY, JSON.stringify(list));
}

async function addPendingSlip(slip, imageData) {
  // ── เก็บรูปแยกจาก metadata เพื่อไม่ให้ list ใหญ่เกินไป ──
  var imgKey = 'pending:img:' + slip.id;
  await config.kvSetEx(imgKey, JSON.stringify(imageData), PENDING_TTL_SEC);

  // ── เก็บ metadata ใน list ──
  var list = await loadPendingSlips();
  list.unshift(slip);
  // จำกัดสูงสุด 200 รูป (metadata ขนาดเล็ก ไม่เปลือง)
  if (list.length > 200) {
    var dropped = list.slice(200);
    list = list.slice(0, 200);
    // ลบ image keys ที่เกิน limit
    for (var d = 0; d < dropped.length; d++) {
      try { await config.kvDel('pending:img:' + dropped[d].id); } catch (e) {}
    }
  }
  await savePendingSlips(list);
  return slip;
}

// ── Telegram API helpers ──
async function tgApi(method, params) {
  var token = getTelegramToken();
  var r = await fetch(TG_API + token + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
  });
  return await r.json();
}

async function tgGetFileUrl(fileId) {
  var res = await tgApi('getFile', { file_id: fileId });
  if (!res.ok || !res.result || !res.result.file_path) {
    throw new Error('getFile failed: ' + JSON.stringify(res).substring(0, 200));
  }
  var token = getTelegramToken();
  return TG_FILE + token + '/' + res.result.file_path;
}

async function downloadFileAsBase64(url) {
  var r = await fetch(url);
  if (!r.ok) throw new Error('download failed HTTP ' + r.status);
  var buf = await r.arrayBuffer();
  var bytes = new Uint8Array(buf);
  // Convert to base64
  var binary = '';
  var chunkSize = 8192;
  for (var i = 0; i < bytes.length; i += chunkSize) {
    var chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, chunk);
  }
  return Buffer.from(binary, 'binary').toString('base64');
}

// ── Handle incoming Telegram photo ──
async function handlePhoto(message) {
  var photos = message.photo;
  if (!Array.isArray(photos) || !photos.length) return { skipped: 'no photo' };

  // photo array เรียงจากเล็ก → ใหญ่ → เอาตัวใหญ่สุด
  var largest = photos[photos.length - 1];
  if (!largest || !largest.file_id) return { skipped: 'no file_id' };

  // เช็คว่าขนาดไม่เกิน 4MB
  if (largest.file_size && largest.file_size > 4 * 1024 * 1024) {
    return { skipped: 'too large', size: largest.file_size };
  }

  try {
    var fileUrl = await tgGetFileUrl(largest.file_id);
    var base64 = await downloadFileAsBase64(fileUrl);

    var slipId = 'tg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    var sender = message.from || {};
    var senderName = [sender.first_name, sender.last_name].filter(Boolean).join(' ') || sender.username || 'unknown';

    // Metadata (เก็บใน list — ขนาดเล็ก)
    var slip = {
      id: slipId,
      timestamp: Date.now(),
      source: 'telegram',
      fileSize: largest.file_size || 0,
      width: largest.width || 0,
      height: largest.height || 0,
      messageId: message.message_id,
      chatId: message.chat && message.chat.id,
      sentBy: senderName,
      sentById: sender.id,
      caption: message.caption || '',
      status: 'pending',
    };

    // Image data (เก็บแยก — key: pending:img:{id})
    var imageData = {
      base64: base64,
      contentType: 'image/jpeg',
    };

    await addPendingSlip(slip, imageData);
    return { ok: true, slipId: slipId };
  } catch (e) {
    console.error('handlePhoto error:', e.message);
    return { error: e.message };
  }
}

// ── Main handler ──
module.exports = async (req, res) => {
  config.setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: admin actions ──
  if (req.method === 'GET') {
    var action = (req.query && req.query.action) || '';

    // ── ตรวจสิทธิ์สำหรับ admin actions ──
    if (!config.checkAuth(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });

    try {
      if (action === 'info') {
        var info = await tgApi('getWebhookInfo');
        return res.status(200).json(info);
      }

      if (action === 'setup') {
        // ตั้ง webhook ชี้ไปที่ endpoint นี้
        var host = req.headers['x-forwarded-host'] || req.headers.host;
        var proto = req.headers['x-forwarded-proto'] || 'https';
        var webhookUrl = proto + '://' + host + '/api/telegram-webhook';

        var params = {
          url: webhookUrl,
          allowed_updates: ['message'],
          drop_pending_updates: true,
        };
        var secret = getWebhookSecret();
        if (secret) params.secret_token = secret;

        var result = await tgApi('setWebhook', params);
        return res.status(200).json({ ok: result.ok, webhookUrl: webhookUrl, result: result });
      }

      if (action === 'delete') {
        var del = await tgApi('deleteWebhook', { drop_pending_updates: true });
        return res.status(200).json(del);
      }

      if (action === 'test') {
        // ทดสอบว่า env vars ครบและเข้าถึง bot ได้ไหม
        var me = await tgApi('getMe');
        var groupId = getGroupId();
        return res.status(200).json({
          ok: me.ok,
          bot: me.result,
          groupConfigured: !!groupId,
          groupId: groupId,
          secretConfigured: !!getWebhookSecret(),
        });
      }

      return res.status(400).json({ ok: false, error: 'unknown GET action (use ?action=info|setup|delete|test)' });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // ── POST: Telegram update ──
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  try {
    // ── ตรวจ secret token (ป้องกัน webhook ถูกเรียกโดยคนอื่น) ──
    var expectedSecret = getWebhookSecret();
    if (expectedSecret) {
      var receivedSecret = req.headers['x-telegram-bot-api-secret-token'] || '';
      if (receivedSecret !== expectedSecret) {
        return res.status(401).json({ ok: false, error: 'invalid secret' });
      }
    }

    var update = req.body || {};
    var message = update.message;
    if (!message) return res.status(200).json({ ok: true, skipped: 'no message' });

    // ── กรองเฉพาะ group ที่กำหนด ──
    var allowedGroupId = getGroupId();
    if (allowedGroupId) {
      var chatId = message.chat && String(message.chat.id);
      if (chatId !== allowedGroupId) {
        return res.status(200).json({ ok: true, skipped: 'wrong chat', chatId: chatId });
      }
    }

    // ── จัดการเฉพาะ photo ──
    if (message.photo) {
      var result = await handlePhoto(message);
      return res.status(200).json({ ok: true, handled: result });
    }

    return res.status(200).json({ ok: true, skipped: 'not a photo' });
  } catch (e) {
    console.error('telegram webhook error:', e);
    // ต้องตอบ 200 เพื่อไม่ให้ Telegram retry ซ้ำ
    return res.status(200).json({ ok: false, error: e.message });
  }
};
