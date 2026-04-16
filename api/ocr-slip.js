// ═══════════════════════════════════════════════════
// /api/ocr-slip.js — Google Vision OCR for Thai bank slips
// v8.4 — Fixed จาก vs ไปยัง detection
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

var TITLE_RE = /(?:นาย|นาง|นางสาว|น\.ส\.|น\. ?ส\.|MR\.?|MRS\.?|MS\.?|MISS)\s*/i;
var TITLE_NAME_RE = /((?:นาย|นาง|นางสาว|น\.ส\.|น\. ?ส\.|MR\.?|MRS\.?|MS\.?|MISS)\s+[\u0E00-\u0E7FA-Za-z]+(?:\s+[\u0E00-\u0E7FA-Za-z]+){0,3})/gi;

function cleanName(name) {
  if (!name) return '';
  return name
    .replace(/x{2,}[\-]?x*\d*[\-]?\d*/gi, '')
    .replace(/\d{3}[\-]\d[\-][\w]+/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/\d+/g, '')
    .replace(/^[\s\-:,\.]+|[\s\-:,\.]+$/g, '')
    .trim();
}

function extractNameAfter(text, keyword) {
  // Find keyword, then extract Thai name after it
  var re = new RegExp(keyword + '[\\s:]*([^\\n]{2,60})', 'i');
  var m = text.match(re);
  if (m) {
    var raw = m[1];
    // Try to find title+name pattern in the match
    var nameM = raw.match(TITLE_NAME_RE);
    if (nameM) return cleanName(nameM[0]);
    // Fallback: extract Thai text
    var thai = raw.match(/([\u0E00-\u0E7F\.\s]{4,50})/);
    if (thai) return cleanName(thai[1]);
  }
  return '';
}

function parseSlipText(fullText) {
  var result = {
    receiverName: '', senderName: '',
    amount: '', amountNum: 0,
    bank: '', bankCode: '', date: '', refCode: '',
    rawText: fullText,
  };
  if (!fullText) return result;

  var lines = fullText.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
  var hasTo = /ไปยัง|ไป\s*ยัง|ผู้รับ|ปลายทาง/i.test(fullText);
  var hasFrom = /จาก|ผู้โอน|ต้นทาง|from/i.test(fullText);

  // ── RECEIVER (ไปยัง) ──
  if (hasTo) {
    result.receiverName = extractNameAfter(fullText, '(?:ไปยัง|ไป\\s*ยัง|ผู้รับ|ปลายทาง)');
    // Also check next line after ไปยัง
    if (!result.receiverName) {
      for (var i = 0; i < lines.length; i++) {
        if (/^(?:ไปยัง|ผู้รับ|ปลายทาง)$/i.test(lines[i]) && i + 1 < lines.length) {
          var next = lines[i + 1];
          if (TITLE_RE.test(next)) {
            result.receiverName = cleanName(next);
            break;
          }
        }
      }
    }
  }

  // ── SENDER (จาก) ──
  if (hasFrom) {
    result.senderName = extractNameAfter(fullText, '(?:จาก|ผู้โอน|ต้นทาง|from)');
    if (!result.senderName) {
      for (var i = 0; i < lines.length; i++) {
        if (/^(?:จาก|ผู้โอน|ต้นทาง|from)$/i.test(lines[i]) && i + 1 < lines.length) {
          var next = lines[i + 1];
          if (TITLE_RE.test(next)) {
            result.senderName = cleanName(next);
            break;
          }
        }
      }
    }
  }

  // ── FALLBACK: find all names with title ──
  if (!result.receiverName && !result.senderName) {
    var allNames = [];
    var mm;
    var re = new RegExp(TITLE_NAME_RE.source, 'gi');
    while ((mm = re.exec(fullText)) !== null) {
      allNames.push(cleanName(mm[0]));
    }
    allNames = allNames.filter(function(n) { return n.length >= 4; });
    if (allNames.length >= 2) {
      result.senderName = allNames[0];
      result.receiverName = allNames[allNames.length - 1];
    } else if (allNames.length === 1) {
      // If only "จาก" context → senderName; if only "ไปยัง" → receiverName
      if (hasFrom && !hasTo) result.senderName = allNames[0];
      else result.receiverName = allNames[0];
    }
  }

  // ── AMOUNT ──
  var amounts = [];
  var amtRe = /(?:฿|THB|บาท)\s*([\d,]+\.?\d*)/g;
  var am;
  while ((am = amtRe.exec(fullText)) !== null) {
    var v = parseFloat(am[1].replace(/,/g, ''));
    if (v > 0 && v < 10000000) amounts.push(v);
  }
  amtRe = /([\d,]+\.?\d*)\s*(?:฿|THB|บาท)/g;
  while ((am = amtRe.exec(fullText)) !== null) {
    var v = parseFloat(am[1].replace(/,/g, ''));
    if (v > 0 && v < 10000000) amounts.push(v);
  }
  amtRe = /จำนวน(?:เงิน)?\s*([\d,]+\.?\d*)/g;
  while ((am = amtRe.exec(fullText)) !== null) {
    var v = parseFloat(am[1].replace(/,/g, ''));
    if (v > 0 && v < 10000000) amounts.push(v);
  }
  // Standalone amount
  lines.forEach(function(l) {
    var sa = l.match(/^([\d,]+\.\d{2})$/);
    if (sa) { var v = parseFloat(sa[1].replace(/,/g, '')); if (v > 0 && v < 10000000) amounts.push(v); }
  });
  if (amounts.length) {
    result.amountNum = Math.max.apply(null, amounts);
    result.amount = result.amountNum.toFixed(2);
  }

  // ── BANK ──
  for (var b = 0; b < BANK_PATTERNS.length; b++) {
    if (BANK_PATTERNS[b].p.test(fullText)) {
      result.bank = BANK_PATTERNS[b].name;
      result.bankCode = BANK_PATTERNS[b].code;
      break;
    }
  }

  // ── REF ──
  var refM = fullText.match(/(?:รหัสอ้างอิง|เลขที่รายการ|ref(?:erence)?\.?\s*(?:no|code)?\.?)\s*[:\-]?\s*([A-Za-z0-9]{8,30})/i);
  if (refM) result.refCode = refM[1];

  // ── DATE ──
  var dateM = fullText.match(/(\d{1,2})\s*(ม\.ค\.|ก\.พ\.|มี\.ค\.|เม\.ย\.|พ\.ค\.|มิ\.ย\.|ก\.ค\.|ส\.ค\.|ก\.ย\.|ต\.ค\.|พ\.ย\.|ธ\.ค\.|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*(\d{2,4})/i);
  if (dateM) result.date = dateM[0];

  return result;
}

module.exports = async (req, res) => {
  config.setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!config.checkAuth(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  try {
    var body = req.body || {};
    var base64 = body.base64 || body.image || '';
    if (!base64) return res.status(400).json({ ok: false, error: 'base64 image required' });

    var imageData = base64;
    var prefix = imageData.match(/^data:[^;]+;base64,/);
    if (prefix) imageData = imageData.substring(prefix[0].length);

    if (imageData.length < 100) return res.status(400).json({ ok: false, error: 'Image too small' });
    if (imageData.length > 5500000) return res.status(400).json({ ok: false, error: 'Image too large' });

    var apiKey = process.env.GOOGLE_VISION_API_KEY;
    if (!apiKey) return res.status(500).json({ ok: false, error: 'GOOGLE_VISION_API_KEY not set' });

    console.log('OCR: sending', Math.round(imageData.length * 0.75 / 1024) + 'KB to Vision');

    var vr = await fetch(VISION_URL + '?key=' + apiKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          image: { content: imageData },
          features: [
            { type: 'TEXT_DETECTION', maxResults: 1 },
            { type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 },
          ],
          imageContext: { languageHints: ['th', 'en'] },
        }],
      }),
    });

    if (!vr.ok) {
      var et = ''; try { et = await vr.text(); } catch(e){}
      console.error('Vision API error:', vr.status, et.substring(0, 200));
      return res.status(502).json({ ok: false, error: 'Vision API error: ' + vr.status });
    }

    var vd = await vr.json();
    var resp = vd.responses && vd.responses[0];
    if (!resp) return res.json({ ok: true, found: false, data: {} });
    if (resp.error) {
      console.error('Vision error:', resp.error.message);
      return res.json({ ok: false, error: resp.error.message });
    }

    var fullText = '';
    if (resp.fullTextAnnotation) fullText = resp.fullTextAnnotation.text;
    else if (resp.textAnnotations && resp.textAnnotations.length) fullText = resp.textAnnotations[0].description || '';

    if (!fullText) return res.json({ ok: true, found: false, data: {} });

    console.log('OCR text:', fullText.substring(0, 200).replace(/\n/g, ' | '));

    var parsed = parseSlipText(fullText);
    return res.json({
      ok: true, found: true,
      data: {
        receiverName: parsed.receiverName,
        senderName: parsed.senderName,
        amount: parsed.amount,
        amountNum: parsed.amountNum,
        bank: parsed.bank,
        bankCode: parsed.bankCode,
        date: parsed.date,
        refCode: parsed.refCode,
        rawText: fullText.substring(0, 500),
      },
    });
  } catch (e) {
    console.error('OCR error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
