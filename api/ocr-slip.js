// ═══════════════════════════════════════════════════
// /api/ocr-slip.js — Google Vision OCR for Thai bank slips
// v8.4 — Robust parser: จาก/ไปยัง multi-line support
// ═══════════════════════════════════════════════════
var config = require('./_config');
var VISION_URL = 'https://vision.googleapis.com/v1/images:annotate';

var BANK_PATTERNS = [
  { p: /กสิกร|kbank|kasikorn/i, name: 'กสิกรไทย', code: 'KBANK' },
  { p: /ไทยพาณิชย์|scb|siam commercial/i, name: 'ไทยพาณิชย์', code: 'SCB' },
  { p: /กรุงเทพ|bbl|bangkok bank/i, name: 'กรุงเทพ', code: 'BBL' },
  { p: /กรุงไทย|ktb|krungthai/i, name: 'กรุงไทย', code: 'KTB' },
  { p: /ทหารไทยธนชาต|ttb|tmb/i, name: 'ทหารไทยธนชาต', code: 'TTB' },
  { p: /กรุงศรี|bay|krungsri|ayudhya/i, name: 'กรุงศรี', code: 'BAY' },
  { p: /ออมสิน|gsb/i, name: 'ออมสิน', code: 'GSB' },
  { p: /ธกส|baac/i, name: 'ธ.ก.ส.', code: 'BAAC' },
  { p: /ทิสโก้|tisco/i, name: 'ทิสโก้', code: 'TISCO' },
  { p: /เกียรตินาคิน|kkp|kiatnakin/i, name: 'เกียรตินาคินภัทร', code: 'KKP' },
  { p: /แลนด์|lhbank/i, name: 'แลนด์ แอนด์ เฮ้าส์', code: 'LHBANK' },
  { p: /ยูโอบี|uob/i, name: 'ยูโอบี', code: 'UOB' },
  { p: /ซีไอเอ็มบี|cimb/i, name: 'ซีไอเอ็มบี', code: 'CIMB' },
  { p: /พร้อมเพย์|promptpay/i, name: 'พร้อมเพย์', code: 'PPAY' },
];
var FROM_KEYS = ['จาก', 'ผู้โอน', 'ต้นทาง'];
var TO_KEYS = ['ไปยัง', 'ไปที่', 'ไป ยัง', 'ผู้รับ', 'ปลายทาง', 'โอนให้'];
var NOT_NAME_RE = /^(จาก|ไปยัง|ไปที่|ไป ยัง|ผู้โอน|ผู้รับ|ต้นทาง|ปลายทาง|โอนให้|from|to|ค่าธรรมเนียม|เลขที่|รหัสอ้างอิง|วันที่|โอนเงิน|สำเร็จ|ธนาคาร|บัญชี|พร้อมเพย์|promptpay|line bk|scb|kbank|fee|ref|หมายเหตุ|ดาวน์โหลด|qr code)$/i;
var TITLE_RE = /^[\s\(\)\[\]0]*(นาย|นาง(?!สาว)|นางสาว|น\.ส\.|น\. ?ส\.|MR\.?|MRS\.?|MS\.?|MISS)\s+/i;

function cleanName(s) {
  if (!s) return '';
  return s
    .replace(/^\s*[\(\)\[\]0]+\s*/, '')                    // leading (), (0), [0] etc
    .replace(/x{2,}[\-]?[\dx]*[\-]?[\d]*/gi, '')          // xxx-xxx123
    .replace(/\d{3,}[\-]\d[\-][\w]+/g, '')                // 414-4-xxx030
    .replace(/[\d]+/g, '')                                  // remaining digits
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '') // emojis
    .replace(/[\(\)\[\]]/g, '')                              // brackets
    .replace(/^[\s\-:,\.]+|[\s\-:,\.]+$/g, '')              // trim punct
    .trim();
}

function isKeyword(line) {
  var l = line.trim();
  return NOT_NAME_RE.test(l) || FROM_KEYS.indexOf(l) >= 0 || TO_KEYS.indexOf(l) >= 0;
}

function isLikelyName(line) {
  var l = line.trim();
  // Strip leading () (0) before checking
  l = l.replace(/^\s*[\(\)\[\]0]+\s*/, '').trim();
  if (l.length < 3 || l.length > 60) return false;
  if (isKeyword(l)) return false;
  if (/^\d/.test(l)) return false;
  if (/^[\d,\.]+\s*(บาท|THB|฿)?$/.test(l)) return false;
  if (/^[xX\d\-\.]+$/.test(l)) return false;
  if (/ค่าธรรมเนียม|fee|ธนาคาร|bank|บัญชี|สาขา|ref|เลขที่|หมายเหตุ|ดาวน์โหลด|qr|line bk|โอนเงิน|สำเร็จ/i.test(l)) return false;
  if (TITLE_RE.test(l)) return true;
  var thai = l.replace(/[^ก-๙\s\.]/g, '').trim();
  return thai.split(/\s+/).length >= 2 && thai.length >= 4;
}

function findNameAfterKeyword(lines, keyList) {
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i].trim();
    for (var k = 0; k < keyList.length; k++) {
      var key = keyList[k];
      var pos = l.indexOf(key);
      if (pos < 0) { var lw = l.replace(/\s+/g, ''); var kw = key.replace(/\s+/g, ''); pos = lw.indexOf(kw); if (pos < 0) continue; }
      var after = l.substring(l.indexOf(key) + key.length).replace(/^[\s:\-]+/, '').trim();

      // If after contains a title name, extract it (handles single-line text)
      if (after) {
        var titleMatch = after.match(/((?:นาย|นาง(?!สาว)|นางสาว|น\.ส\.|น\. ?ส\.)\s+[\u0E00-\u0E7FA-Za-z]+(?:\s+[\u0E00-\u0E7FA-Za-z]+){0,3})/i);
        if (titleMatch) return cleanName(titleMatch[1]);
        if (isLikelyName(after)) return cleanName(after);
      }

      // Check next lines
      for (var j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        var next = lines[j].trim();
        if (isLikelyName(next)) return cleanName(next);
        if (isKeyword(next)) break;
        if (/^[\dxX\-\.]+$/.test(next)) continue;
      }
    }
  }
  return '';
}

function parseSlipText(fullText) {
  var result = { receiverName: '', senderName: '', amount: '', amountNum: 0, bank: '', bankCode: '', date: '', refCode: '', rawText: fullText };
  if (!fullText) return result;
  var lines = fullText.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);

  // ── Owner names (ชื่อเจ้าของบัญชีที่ใช้โอนถอน) ──
  // ถ้า OCR เจอชื่อเหล่านี้ = ผู้โอน (เจ้าของ) ไม่ใช่ลูกค้า
  // โหลดจาก Settings หรือใช้ค่าเริ่มต้น
  var ownerNames = parseSlipText._ownerNames || ['ลดาวรรณ', 'อุรัมย์', 'ปัทมาสน์', 'ปราบมาก', 'กวี', 'สีสมบัติ', 'นภาพร', 'เรไรสระน้อย'];

  function isOwnerName(name) {
    if (!name) return false;
    var n = name.toLowerCase().replace(/[\s\.]/g, '');
    for (var i = 0; i < ownerNames.length; i++) {
      if (n.indexOf(ownerNames[i].toLowerCase()) !== -1) return true;
    }
    return false;
  }

  // Step 1: Try keyword-based extraction
  result.receiverName = findNameAfterKeyword(lines, TO_KEYS);
  result.senderName = findNameAfterKeyword(lines, FROM_KEYS);
  if (result.receiverName && result.senderName && result.receiverName === result.senderName) result.receiverName = '';

  // Step 2: FALLBACK — no keywords found
  if (!result.receiverName && !result.senderName) {
    var foundNames = lines.filter(function(l) { return isLikelyName(l); }).map(cleanName).filter(Boolean);
    if (foundNames.length >= 2) {
      // Use owner detection to assign correctly
      var owner = null, customer = null;
      foundNames.forEach(function(n) {
        if (isOwnerName(n)) { if (!owner) owner = n; }
        else { if (!customer) customer = n; }
      });
      if (owner && customer) {
        result.senderName = owner;
        result.receiverName = customer;
      } else {
        result.senderName = foundNames[0];
        result.receiverName = foundNames[1];
      }
    } else if (foundNames.length === 1) {
      if (isOwnerName(foundNames[0])) result.senderName = foundNames[0];
      else result.receiverName = foundNames[0];
    }
  }

  // Step 3: If only one found via keywords, try to find the other
  if (result.receiverName && !result.senderName) {
    var others = lines.filter(function(l) { return isLikelyName(l) && cleanName(l) !== result.receiverName; }).map(cleanName);
    if (others.length) result.senderName = others[0];
  }
  if (!result.receiverName && result.senderName) {
    var others = lines.filter(function(l) { return isLikelyName(l) && cleanName(l) !== result.senderName; }).map(cleanName);
    if (others.length) result.receiverName = others[others.length - 1];
  }

  // Step 4: SMART FIX — if receiver is actually owner, swap!
  if (result.receiverName && isOwnerName(result.receiverName)) {
    if (result.senderName && !isOwnerName(result.senderName)) {
      var tmp = result.receiverName;
      result.receiverName = result.senderName;
      result.senderName = tmp;
    } else if (!result.senderName) {
      result.senderName = result.receiverName;
      result.receiverName = '';
    }
  }

  // Step 5: if only sender found + sender is NOT owner → it's actually the customer (receiver)!
  // เพราะสลิปส่วนใหญ่ Vision จับคำว่า "จาก" แล้วชื่อถัดไปคือลูกค้า (ผู้ถอน)
  // ไม่ใช่เจ้าของบัญชีที่โอน
  if (result.senderName && !result.receiverName && !isOwnerName(result.senderName)) {
    result.receiverName = result.senderName;
    result.senderName = '';
  }

  // Step 6: if sender is owner + no receiver, that's fine (crop ของเจ้าของ)
  // (ไม่ต้องทำอะไร)

  var amounts = [];
  [/฿\s*([\d,]+\.?\d*)/g, /([\d,]+\.?\d*)\s*(?:฿|THB|บาท)/g, /จำนวน(?:เงิน)?\s*([\d,]+\.?\d*)/g].forEach(function(re) {
    var m; while ((m = re.exec(fullText)) !== null) { var v = parseFloat(m[1].replace(/,/g, '')); if (v > 0 && v < 10000000) amounts.push(v); }
  });
  lines.forEach(function(l) { var m = l.match(/^([\d,]+\.\d{2})$/); if (m) { var v = parseFloat(m[1].replace(/,/g, '')); if (v > 0.01 && v < 10000000) amounts.push(v); } });
  if (amounts.length) { var real = amounts.filter(function(a) { return a > 0.01; }); if (real.length) { result.amountNum = Math.max.apply(null, real); result.amount = result.amountNum.toFixed(2); } }

  for (var b = 0; b < BANK_PATTERNS.length; b++) { if (BANK_PATTERNS[b].p.test(fullText)) { result.bank = BANK_PATTERNS[b].name; result.bankCode = BANK_PATTERNS[b].code; break; } }
  var refM = fullText.match(/(?:รหัสอ้างอิง|เลขที่รายการ|ref(?:erence)?\.?\s*(?:no|code)?\.?)\s*[:\-]?\s*([A-Za-z0-9]{8,30})/i);
  if (refM) result.refCode = refM[1];
  var dateM = fullText.match(/(\d{1,2})\s*(ม\.ค\.|ก\.พ\.|มี\.ค\.|เม\.ย\.|พ\.ค\.|มิ\.ย\.|ก\.ค\.|ส\.ค\.|ก\.ย\.|ต\.ค\.|พ\.ย\.|ธ\.ค\.|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*(\d{2,4})/i);
  if (dateM) result.date = dateM[0];
  return result;
}

module.exports = async (req, res) => {
  config.setCors(res); if (req.method === 'OPTIONS') return res.status(200).end();
  if (!config.checkAuth(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  try {
    var body = req.body || {};
    var base64 = body.base64 || body.image || '';
    if (!base64) return res.status(400).json({ ok: false, error: 'base64 required' });
    var imageData = base64; var prefix = imageData.match(/^data:[^;]+;base64,/);
    if (prefix) imageData = imageData.substring(prefix[0].length);
    if (imageData.length < 100) return res.status(400).json({ ok: false, error: 'Image too small' });
    if (imageData.length > 5500000) return res.status(400).json({ ok: false, error: 'Image too large' });
    var apiKey = process.env.GOOGLE_VISION_API_KEY;
    if (!apiKey) return res.status(500).json({ ok: false, error: 'GOOGLE_VISION_API_KEY not set' });
    console.log('OCR: sending', Math.round(imageData.length * 0.75 / 1024) + 'KB');

    // Load owner names from settings (if configured), fallback to defaults
    try {
      var ownerRaw = await config.kvGet('ownerNames');
      if (ownerRaw) {
        var customOwners = JSON.parse(ownerRaw);
        if (customOwners.length) parseSlipText._ownerNames = customOwners;
      }
    } catch(e) {}

    var vr = await fetch(VISION_URL + '?key=' + apiKey, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ image: { content: imageData }, features: [{ type: 'TEXT_DETECTION', maxResults: 1 }, { type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }], imageContext: { languageHints: ['th', 'en'] } }] }),
    });
    if (!vr.ok) { var et = ''; try { et = await vr.text(); } catch(e){} console.error('Vision error:', vr.status, et.substring(0, 200)); return res.status(502).json({ ok: false, error: 'Vision API: ' + vr.status }); }
    var vd = await vr.json(); var resp = vd.responses && vd.responses[0];
    if (!resp) return res.json({ ok: true, found: false, data: {} });
    if (resp.error) { console.error('Vision:', resp.error.message); return res.json({ ok: false, error: resp.error.message }); }
    var fullText = '';
    if (resp.fullTextAnnotation) fullText = resp.fullTextAnnotation.text;
    else if (resp.textAnnotations && resp.textAnnotations.length) fullText = resp.textAnnotations[0].description || '';
    if (!fullText) return res.json({ ok: true, found: false, data: {} });
    console.log('OCR text:', fullText.substring(0, 300).replace(/\n/g, ' | '));
    var parsed = parseSlipText(fullText);
    console.log('OCR result: recv=' + (parsed.receiverName||'-') + ' send=' + (parsed.senderName||'-') + ' amt=' + (parsed.amount||'-'));
    return res.json({ ok: true, found: true, data: { receiverName: parsed.receiverName, senderName: parsed.senderName, amount: parsed.amount, amountNum: parsed.amountNum, bank: parsed.bank, bankCode: parsed.bankCode, date: parsed.date, refCode: parsed.refCode, rawText: fullText.substring(0, 500) } });
  } catch (e) { console.error('OCR error:', e.message); return res.status(500).json({ ok: false, error: e.message }); }
};
