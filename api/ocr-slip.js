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
var TITLE_RE = /^(นาย|นาง(?!สาว)|นางสาว|น\.ส\.|น\. ?ส\.|MR\.?|MRS\.?|MS\.?|MISS)\s+/i;

function cleanName(s) {
  if (!s) return '';
  return s.replace(/x{2,}[\-]?[\dx]*[\-]?[\d]*/gi, '').replace(/\d{3,}[\-]\d[\-][\w]+/g, '').replace(/[\d]+/g, '').replace(/[\u{1F300}-\u{1FAFF}]/gu, '').replace(/^[\s\-:,\.]+|[\s\-:,\.]+$/g, '').trim();
}

function isKeyword(line) {
  var l = line.trim();
  return NOT_NAME_RE.test(l) || FROM_KEYS.indexOf(l) >= 0 || TO_KEYS.indexOf(l) >= 0;
}

function isLikelyName(line) {
  var l = line.trim();
  if (l.length < 3 || l.length > 60) return false;
  if (isKeyword(l)) return false;
  // Exclude lines that are clearly not names
  if (/^\d/.test(l)) return false;                    // starts with digit
  if (/^[\d,\.]+\s*(บาท|THB|฿)?$/.test(l)) return false;  // amount
  if (/^[xX\d\-\.]+$/.test(l)) return false;          // account number
  if (/ค่าธรรมเนียม|fee|ธนาคาร|bank|บัญชี|สาขา|ref|เลขที่|หมายเหตุ|ดาวน์โหลด|qr/i.test(l)) return false;
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
      if (after && isLikelyName(after)) return cleanName(after);
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

  result.receiverName = findNameAfterKeyword(lines, TO_KEYS);
  result.senderName = findNameAfterKeyword(lines, FROM_KEYS);
  if (result.receiverName && result.senderName && result.receiverName === result.senderName) result.receiverName = '';

  // FALLBACK: if no keywords found (จาก/ไปยัง not in OCR text), find names by position
  // In Thai slips: first name = sender (จาก), second name = receiver (ไปยัง)
  if (!result.receiverName && !result.senderName) {
    var foundNames = lines.filter(function(l) { return isLikelyName(l); });
    if (foundNames.length >= 2) {
      result.senderName = cleanName(foundNames[0]);
      result.receiverName = cleanName(foundNames[1]);
    } else if (foundNames.length === 1) {
      // Only 1 name: assume it's sender (ลูกค้า) since that's more useful for matching
      result.senderName = cleanName(foundNames[0]);
    }
  }
  // If only receiver found but not sender, also scan for extra name
  if (result.receiverName && !result.senderName) {
    var names = lines.filter(function(l) { return isLikelyName(l) && cleanName(l) !== result.receiverName; });
    if (names.length) result.senderName = cleanName(names[0]);
  }
  if (!result.receiverName && result.senderName) {
    var names = lines.filter(function(l) { return isLikelyName(l) && cleanName(l) !== result.senderName; });
    if (names.length) result.receiverName = cleanName(names[names.length - 1]);
  }

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
