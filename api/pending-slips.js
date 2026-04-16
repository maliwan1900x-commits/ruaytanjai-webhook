// ═══════════════════════════════════════════════════
// /api/pending-slips.js — จัดการ pending slips จาก Telegram
// ═══════════════════════════════════════════════════
// GET              → คืน metadata (ไม่รวมรูป) — เบา เร็ว
// GET ?includeImages=1 → คืน metadata + รูป base64 (ใหญ่ — ใช้เมื่อจะแสดงเท่านั้น)
// GET ?group=1     → แบ่งเป็น batches ตาม time gap (5 นาที)
// GET ?id=xxx      → ดึง 1 รูป (metadata + base64)
// DELETE ?id=xxx   → ลบ slip ที่ใช้แล้ว
// DELETE ?all=1    → ลบทั้งหมด
// POST ?action=mark_used → body { ids:[] } mark slips as used และลบ

var config = require('./_config');

var PENDING_KEY = 'pending:slips';
var PENDING_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
var BATCH_GAP_MS = 5 * 60 * 1000; // 5 นาที — gap เกินนี้ = batch ใหม่

async function loadPendingSlips() {
  try {
    var raw = await config.kvGet(PENDING_KEY);
    if (!raw) return [];
    var list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list;
  } catch (e) {
    return [];
  }
}

async function savePendingSlips(list) {
  return await config.kvSet(PENDING_KEY, JSON.stringify(list));
}

async function loadImageData(slipId) {
  try {
    var raw = await config.kvGet('pending:img:' + slipId);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

async function deleteImageData(slipId) {
  try { return await config.kvDel('pending:img:' + slipId); }
  catch (e) { return false; }
}

// ── ลบ slip ที่หมดอายุ ──
function pruneExpired(list) {
  var cutoff = Date.now() - PENDING_TTL_MS;
  return list.filter(function (s) { return s.timestamp > cutoff; });
}

// ── จัดกลุ่มเป็น batch ตาม time gap ──
function groupIntoBatches(slips) {
  if (!slips.length) return [];
  var sorted = slips.slice().sort(function (a, b) { return a.timestamp - b.timestamp; });

  var batches = [];
  var current = null;

  sorted.forEach(function (s) {
    if (!current) {
      current = { startTs: s.timestamp, endTs: s.timestamp, slips: [s] };
    } else if (s.timestamp - current.endTs > BATCH_GAP_MS) {
      batches.push(current);
      current = { startTs: s.timestamp, endTs: s.timestamp, slips: [s] };
    } else {
      current.slips.push(s);
      current.endTs = s.timestamp;
    }
  });
  if (current) batches.push(current);

  // Reverse — batch ใหม่สุดขึ้นก่อน
  batches.reverse();
  batches.forEach(function (b, i) {
    b.letter = String.fromCharCode(65 + i);
    b.isLatest = (i === 0);
  });
  return batches;
}

function slipToItem(s, imageData) {
  var item = {
    id: s.id,
    timestamp: s.timestamp,
    source: s.source,
    fileSize: s.fileSize,
    width: s.width,
    height: s.height,
    sentBy: s.sentBy,
    caption: s.caption,
    status: s.status,
    ageMinutes: Math.floor((Date.now() - s.timestamp) / 60000),
  };
  if (imageData) {
    item.base64 = imageData.base64;
    item.contentType = imageData.contentType;
    item.dataUrl = 'data:' + (imageData.contentType || 'image/jpeg') + ';base64,' + imageData.base64;
  }
  return item;
}

module.exports = async (req, res) => {
  config.setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!config.checkAuth(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  try {
    // ── GET: list or single ──
    if (req.method === 'GET') {
      // ── GET ?id=xxx: ดึง 1 รูป ──
      var queryId = req.query && req.query.id;
      if (queryId) {
        var list0 = await loadPendingSlips();
        var slip = list0.find(function (s) { return s.id === queryId; });
        if (!slip) return res.status(404).json({ ok: false, error: 'not found' });
        var img = await loadImageData(queryId);
        return res.status(200).json({ ok: true, item: slipToItem(slip, img) });
      }

      // ── GET list ──
      var list = await loadPendingSlips();
      var pruned = pruneExpired(list);

      // ถ้ามีการเปลี่ยนแปลง (หมดอายุ) → บันทึกกลับ + ลบรูปของตัวที่หายไป
      if (pruned.length !== list.length) {
        var remainingIds = {};
        pruned.forEach(function (s) { remainingIds[s.id] = true; });
        var expired = list.filter(function (s) { return !remainingIds[s.id]; });
        // ลบรูปของตัวที่หมดอายุ (ถ้า TTL ไม่ได้ลบเอง)
        for (var e = 0; e < expired.length; e++) {
          try { await deleteImageData(expired[e].id); } catch (err) {}
        }
        await savePendingSlips(pruned);
      }

      var includeImages = req.query && req.query.includeImages === '1';
      var groupByBatch = req.query && req.query.group === '1';

      // ถ้าต้องการรูป → load image data ของแต่ละ slip
      var items = [];
      for (var i = 0; i < pruned.length; i++) {
        var imgData = null;
        if (includeImages) {
          imgData = await loadImageData(pruned[i].id);
        }
        items.push(slipToItem(pruned[i], imgData));
      }

      // ── ส่งแบบ batches ──
      if (groupByBatch) {
        var batches = groupIntoBatches(items).map(function (b) {
          return {
            letter: b.letter,
            isLatest: b.isLatest,
            startTs: b.startTs,
            endTs: b.endTs,
            count: b.slips.length,
            slips: b.slips,
          };
        });
        return res.status(200).json({ ok: true, total: items.length, batches: batches, batchCount: batches.length });
      }

      return res.status(200).json({ ok: true, total: items.length, items: items });
    }

    // ── DELETE ──
    if (req.method === 'DELETE') {
      if (req.query && req.query.all === '1') {
        var allList = await loadPendingSlips();
        // ลบรูปทั้งหมด
        for (var j = 0; j < allList.length; j++) {
          try { await deleteImageData(allList[j].id); } catch (e3) {}
        }
        await savePendingSlips([]);
        return res.status(200).json({ ok: true, deleted: 'all' });
      }
      var id = req.query && req.query.id;
      if (!id) return res.status(400).json({ ok: false, error: 'id required' });

      var list2 = await loadPendingSlips();
      var filtered = list2.filter(function (s) { return s.id !== id; });
      await savePendingSlips(filtered);
      await deleteImageData(id);
      return res.status(200).json({ ok: true, deleted: id, remaining: filtered.length });
    }

    // ── POST ?action=mark_used: ลบหลายตัวพร้อมกัน ──
    if (req.method === 'POST') {
      var action = req.query && req.query.action;
      if (action === 'mark_used') {
        var body = req.body || {};
        var ids = Array.isArray(body.ids) ? body.ids : [];
        if (!ids.length) return res.status(400).json({ ok: false, error: 'ids required' });

        var list3 = await loadPendingSlips();
        var idSet = {};
        ids.forEach(function (id) { idSet[id] = true; });
        var filtered2 = list3.filter(function (s) { return !idSet[s.id]; });
        await savePendingSlips(filtered2);
        // ลบรูปทั้งหมดของ ids ที่ mark_used
        for (var k = 0; k < ids.length; k++) {
          try { await deleteImageData(ids[k]); } catch (e4) {}
        }
        return res.status(200).json({ ok: true, marked: ids.length, remaining: filtered2.length });
      }
      return res.status(400).json({ ok: false, error: 'unknown action' });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
