// ═══════════════════════════════════════════════════
// /api/withdraw-send.js — Batch send withdraw slips + name lookup
// ═══════════════════════════════════════════════════
// รับสลิปถอน + userId → ส่ง LINE Push ทีเดียวหลายราย
// GET  ?action=lookup → คืนฐานข้อมูล senderName ↔ userId (ไว้ match อัตโนมัติ)
// POST body = { items:[{userId, imageUrl, previewUrl?, amount?, message?}], defaultMessage? }

var config = require('./_config');
var store = require('./_store');

// ── Normalize Thai name for matching ──
// ตัดคำนำหน้า เว้นวรรค สัญลักษณ์ ทำ lowercase เพื่อ match แบบยืดหยุ่น
function normalizeName(name) {
  if (!name) return '';
  var s = String(name);
  // ตัดคำนำหน้า
  s = s.replace(/^(นาย|นาง|นางสาว|น\.ส\.|ด\.ช\.|ด\.ญ\.|mr\.?|mrs\.?|ms\.?|miss)\s*/i, '');
  // ตัด space, จุด, ดอกจัน, ขีด, วงเล็บ
  s = s.replace(/[\s\.\*\-_()]/g, '');
  return s.toLowerCase();
}

// ── Fuzzy match: ชื่อในสลิปถอน ↔ senderName ที่เคยเก็บจากสลิปฝาก ──
// คืน { userId, displayName, confidence } หรือ null
function matchReceiverToContact(receiverName, lookupTable) {
  if (!receiverName) return null;
  var target = normalizeName(receiverName);
  if (!target) return null;

  var best = null;
  var bestScore = 0;

  for (var key in lookupTable) {
    var entry = lookupTable[key];
    
    // เช็ค slipNames ก่อน (ชื่อที่เคยจับคู่แล้ว — ความแม่นสูงสุด)
    var slipNames = entry.slipNames || [];
    for (var sn = 0; sn < slipNames.length; sn++) {
      var snNorm = normalizeName(slipNames[sn]);
      if (!snNorm) continue;
      var snScore = 0;
      if (snNorm === target) snScore = 1.0;
      else if (snNorm.indexOf(target) !== -1 || target.indexOf(snNorm) !== -1) snScore = 0.9;
      if (snScore > bestScore) {
        bestScore = snScore;
        best = {
          userId: entry.userId,
          displayName: entry.displayName,
          senderName: entry.senderName,
          confidence: snScore,
          matchedVia: 'slipName',
        };
      }
    }

    // เช็ค senderName (จากสลิปฝากเดิม)
    var cand = normalizeName(entry.senderName);
    if (!cand) continue;

    var score = 0;
    if (cand === target) score = 1.0;
    else if (cand.indexOf(target) !== -1 || target.indexOf(cand) !== -1) score = 0.85;
    else {
      // prefix/suffix match 6+ chars
      var minLen = Math.min(cand.length, target.length);
      if (minLen >= 6 && cand.substring(0, 6) === target.substring(0, 6)) score = 0.6;
    }

    if (score > bestScore) {
      bestScore = score;
      best = {
        userId: entry.userId,
        displayName: entry.displayName,
        senderName: entry.senderName,
        confidence: score,
        matchedVia: 'senderName',
      };
    }
  }

  return best && bestScore >= 0.6 ? best : null;
}

// ── Build lookup table from slip history ──
// คืน { [userId]: {userId, senderName, displayName, lastSeen} }
// เลือก senderName ล่าสุดของแต่ละ userId
async function buildLookupTable() {
  var slips = await store.getSlips();
  var contacts = await store.getContacts();
  var contactMap = {};
  contacts.forEach(function (c) { contactMap[c.uid] = c.name; });

  var table = {};
  for (var i = 0; i < slips.length; i++) {
    var s = slips[i];
    if (!s.userId || !s.slipInfo || !s.slipInfo.senderName) continue;
    var existing = table[s.userId];
    if (!existing || s.timestamp > existing.timestamp) {
      table[s.userId] = {
        userId: s.userId,
        senderName: s.slipInfo.senderName,
        displayName: s.customerName || contactMap[s.userId] || '',
        timestamp: s.timestamp,
        slipNames: [],
      };
    }
  }

  // เสริมจาก contacts (กรณีไม่มีสลิป แต่มี contact อยู่แล้ว)
  contacts.forEach(function (c) {
    if (!table[c.uid]) {
      table[c.uid] = {
        userId: c.uid,
        senderName: '',
        displayName: c.name,
        timestamp: 0,
        slipNames: [],
      };
    }
  });

  // Load slipNames for each customer
  var uids = Object.keys(table);
  for (var u = 0; u < uids.length; u++) {
    try {
      var sn = await config.kvGet('slipnames:' + uids[u]);
      if (sn) table[uids[u]].slipNames = JSON.parse(sn);
    } catch(e) {}
  }

  return table;
}

// ── Push image message to LINE ──
async function pushImageToUser(userId, imageUrl, previewUrl, textMessage, extraMessages) {
  var token = await config.getLineToken();
  var messages = [];
  if (imageUrl) {
    messages.push({
      type: 'image',
      originalContentUrl: imageUrl,
      previewImageUrl: previewUrl || imageUrl,
    });
  }
  // Support multiple text messages (v8)
  if (extraMessages && Array.isArray(extraMessages) && extraMessages.length) {
    extraMessages.forEach(function(m) {
      if (m && m.trim()) messages.push({ type: 'text', text: m.trim() });
    });
  } else if (textMessage) {
    messages.push({ type: 'text', text: textMessage });
  }
  if (!messages.length) {
    return { ok: false, error: 'no content' };
  }
  // LINE allows max 5 messages per push
  if (messages.length > 5) messages = messages.slice(0, 5);

  var r = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to: userId, messages: messages }),
  });

  if (r.ok) return { ok: true };
  var errBody = '';
  try { errBody = await r.text(); } catch (e) {}
  return { ok: false, error: 'HTTP ' + r.status, detail: errBody };
}

module.exports = async (req, res) => {
  config.setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!config.checkAuth(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  // ── GET: คืนฐานข้อมูล senderName ↔ userId สำหรับ frontend match ──
  if (req.method === 'GET') {
    var action = (req.query && req.query.action) || '';
    if (action === 'lookup') {
      try {
        var table = await buildLookupTable();
        var list = Object.values(table).map(function (e) {
          return {
            userId: e.userId,
            senderName: e.senderName || '',
            displayName: e.displayName || '',
            slipNames: e.slipNames || [],
            lastSeen: e.timestamp,
          };
        });
        // เรียงตาม lastSeen มาล่าสุดก่อน
        list.sort(function (a, b) { return b.lastSeen - a.lastSeen; });
        return res.status(200).json({ ok: true, items: list, total: list.length });
      } catch (e) {
        return res.status(200).json({ ok: false, error: e.message });
      }
    }
    return res.status(400).json({ ok: false, error: 'unknown GET action' });
  }

  // ── POST: ส่งสลิปถอนเป็น batch หรือ save match ──
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  var body = req.body || {};
  var action = (req.query && req.query.action) || body.action || '';

  // ── save_match: จำการจับคู่ชื่อในสลิป ↔ userId ──
  if (action === 'save_match') {
    try {
      var userId = body.userId;
      var slipName = body.slipName;
      if (!userId || !slipName) return res.status(400).json({ ok: false, error: 'userId and slipName required' });

      // โหลด slipNames เดิมของ user นี้
      var existing = [];
      try {
        var raw = await config.kvGet('slipnames:' + userId);
        if (raw) existing = JSON.parse(raw);
      } catch(e) {}

      // Normalize แล้วเช็คว่ามีอยู่แล้วไหม
      var normNew = normalizeName(slipName);
      var alreadyExists = existing.some(function(n) { return normalizeName(n) === normNew; });
      if (!alreadyExists) {
        existing.push(slipName);
        // จำกัดสูงสุด 20 ชื่อต่อ user
        if (existing.length > 20) existing = existing.slice(existing.length - 20);
        await config.kvSet('slipnames:' + userId, JSON.stringify(existing));
      }

      return res.status(200).json({ ok: true, userId: userId, slipNames: existing });
    } catch(e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  var items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return res.status(400).json({ ok: false, error: 'items required' });

  var defaultMessage = body.defaultMessage || '';
  var results = [];
  var successCount = 0;
  var failCount = 0;

  // ส่งทีละราย (LINE ไม่มี batch push สำหรับ userId หลายคน + รูปไม่เหมือนกัน)
  // แต่ละราย await ทีละตัวเพื่อเลี่ยง rate limit
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (!it.userId || !it.imageUrl) {
      results.push({ index: i, userId: it.userId || null, ok: false, error: 'missing userId or imageUrl' });
      failCount++;
      continue;
    }

    // Validate userId format (LINE userIds start with 'U' + 32 hex chars)
    if (!/^U[0-9a-f]{32}$/i.test(it.userId)) {
      results.push({ index: i, userId: it.userId, ok: false, error: 'invalid userId format' });
      failCount++;
      continue;
    }

    // Validate imageUrl is HTTPS
    if (it.imageUrl.indexOf('https://') !== 0) {
      results.push({ index: i, userId: it.userId, ok: false, error: 'imageUrl must be HTTPS' });
      failCount++;
      continue;
    }

    var msg = it.message || defaultMessage;
    // แทนตัวแปรในข้อความ
    if (msg && it.amount) {
      msg = msg.replace(/\{amount\}/g, Number(it.amount).toLocaleString('en-US'));
    }
    if (msg && it.name) {
      msg = msg.replace(/\{name\}/g, it.name);
    }

    // v8: Support multiple messages
    var msgArray = it.messages || body.defaultMessages || null;
    if (msgArray && Array.isArray(msgArray) && msgArray.length) {
      msgArray = msgArray.map(function(m) {
        if (it.amount) m = m.replace(/\{amount\}/g, Number(it.amount).toLocaleString('en-US'));
        if (it.name) m = m.replace(/\{name\}/g, it.name);
        return m;
      }).filter(function(m) { return m && m.trim(); });
    }

    try {
      var r = await pushImageToUser(it.userId, it.imageUrl, it.previewUrl || it.imageUrl, msg, msgArray);
      if (r.ok) {
        successCount++;
        results.push({ index: i, userId: it.userId, ok: true });
        // บันทึก event
        try {
          await store.addEvent({
            id: 'w' + Date.now().toString(36) + i,
            timestamp: Date.now(),
            source: 'admin',
            userId: it.userId,
            name: it.name || '',
            text: 'withdraw-slip-sent' + (it.amount ? ' (' + it.amount + ')' : ''),
            type: 'withdraw',
          });
        } catch (e2) {}
      } else {
        failCount++;
        results.push({ index: i, userId: it.userId, ok: false, error: r.error, detail: r.detail });
      }
    } catch (e) {
      failCount++;
      results.push({ index: i, userId: it.userId, ok: false, error: e.message });
    }

    // Small delay to avoid hitting LINE rate limit (2000 push/sec แต่เผื่อไว้)
    if (i < items.length - 1) {
      await new Promise(function (resolve) { setTimeout(resolve, 50); });
    }
  }

  return res.status(200).json({
    ok: true,
    total: items.length,
    success: successCount,
    fail: failCount,
    results: results,
  });
};
