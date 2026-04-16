// ═══════════════════════════════════════════════════
// /api/ocr-slip.js — Google Vision OCR for Thai bank slips
// ═══════════════════════════════════════════════════
// Accepts base64 image, returns structured slip data:
//   receiverName, senderName, amount, bank, date, refCode

var config = require('./_config');

var VISION_URL = 'https://vision.googleapis.com/v1/images:annotate';

// ── Thai bank name patterns ──
var BANK_PATTERNS = [
  { pattern: /กสิกร|kbank|kasikorn/i, name: 'กสิกรไทย', code: 'KBANK' },
  { pattern: /ไทยพาณิชย์|scb|siam commercial/i, name: 'ไทยพาณิชย์', code: 'SCB' },
  { pattern: /กรุงเทพ|bbl|bangkok bank/i, name: 'กรุงเทพ', code: 'BBL' },
  { pattern: /กรุงไทย|ktb|krungthai/i, name: 'กรุงไทย', code: 'KTB' },
  { pattern: /ทหารไทยธนชาต|ttb|tmb/i, name: 'ทหารไทยธนชาต', code: 'TTB' },
  { pattern: /กรุงศรี|bay|krungsri|ayudhya/i, name: 'กรุงศรี', code: 'BAY' },
  { pattern: /ออมสิน|gsb|government savings/i, name: 'ออมสิน', code: 'GSB' },
  { pattern: /ธกส|baac/i, name: 'ธ.ก.ส.', code: 'BAAC' },
  { pattern: /ทิสโก้|tisco/i, name: 'ทิสโก้', code: 'TISCO' },
  { pattern: /เกียรตินาคินภัทร|kkp|kiatnakin/i, name: 'เกียรตินาคินภัทร', code: 'KKP' },
  { pattern: /แลนด์|lhbank|land/i, name: 'แลนด์ แอนด์ เฮ้าส์', code: 'LHBANK' },
  { pattern: /ยูโอบี|uob/i, name: 'ยูโอบี', code: 'UOB' },
  { pattern: /ซีไอเอ็มบี|cimb/i, name: 'ซีไอเอ็มบี', code: 'CIMB' },
  { pattern: /พร้อมเพย์|promptpay/i, name: 'พร้อมเพย์', code: 'PPAY' },
];

// ── Parse structured data from OCR text ──
function parseSlipText(fullText) {
  var result = {
    receiverName: '',
    senderName: '',
    amount: '',
    amountNum: 0,
    bank: '',
    bankCode: '',
    date: '',
    refCode: '',
    rawText: fullText,
  };

  if (!fullText) return result;

  var lines = fullText.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);

  // ── Amount: ฿X,XXX.XX or จำนวนเงิน X,XXX.XX ──
  var amountPatterns = [
    /(?:฿|THB|บาท)\s*([\d,]+\.?\d*)/,
    /([\d,]+\.?\d*)\s*(?:฿|THB|บาท)/,
    /จำนวน(?:เงิน)?\s*([\d,]+\.?\d*)/,
    /amount\s*([\d,]+\.?\d*)/i,
  ];
  // Find the largest amount (usually the transfer amount)
  var amounts = [];
  for (var i = 0; i < lines.length; i++) {
    for (var p = 0; p < amountPatterns.length; p++) {
      var m = lines[i].match(amountPatterns[p]);
      if (m) {
        var val = parseFloat(m[1].replace(/,/g, ''));
        if (val > 0 && val < 10000000) amounts.push(val);
      }
    }
  }
  // Also look for standalone large numbers (common in slip center)
  for (var i = 0; i < lines.length; i++) {
    var standalone = lines[i].match(/^([\d,]+\.\d{2})$/);
    if (standalone) {
      var val = parseFloat(standalone[1].replace(/,/g, ''));
      if (val > 0 && val < 10000000) amounts.push(val);
    }
  }
  if (amounts.length) {
    // Pick the largest amount (main transfer)
    result.amountNum = Math.max.apply(null, amounts);
    result.amount = result.amountNum.toFixed(2);
  }

  // ── Receiver name (ไปยัง/ผู้รับ/To/ปลายทาง) ──
  var receiverPatterns = [
    /(?:ไปยัง|ไป\s*ยัง|ผู้รับ|ปลายทาง|โอนให้|to)\s*[:\-]?\s*(.+)/i,
  ];
  for (var i = 0; i < lines.length; i++) {
    for (var p = 0; p < receiverPatterns.length; p++) {
      var m = lines[i].match(receiverPatterns[p]);
      if (m && m[1]) {
        var name = m[1].replace(/[0-9x\-\.\/\(\)]/g, '').trim();
        if (name.length >= 2 && name.length <= 60) {
          result.receiverName = name;
          break;
        }
      }
    }
    if (result.receiverName) break;
  }

  // Fallback: look for Thai name patterns after keywords
  if (!result.receiverName) {
    for (var i = 0; i < lines.length; i++) {
      // Look for line after "ไปยัง" or containing Thai name with title
      var nameMatch = lines[i].match(/(?:นาย|นาง|นางสาว|น\.ส\.|MR\.?|MRS\.?|MS\.?|MISS)\s+(.+)/i);
      if (nameMatch) {
        // Check if previous line or context suggests this is receiver
        var prevLine = i > 0 ? lines[i - 1] : '';
        if (!result.senderName || prevLine.match(/ไปยัง|ผู้รับ|ปลายทาง|to/i)) {
          result.receiverName = lines[i].replace(/[0-9x\-\.\/]/g, '').trim();
        } else if (!result.senderName) {
          result.senderName = lines[i].replace(/[0-9x\-\.\/]/g, '').trim();
        }
      }
    }
  }

  // ── Sender name (จาก/ผู้โอน/From/ต้นทาง) ──
  var senderPatterns = [
    /(?:จาก|ผู้โอน|ต้นทาง|from)\s*[:\-]?\s*(.+)/i,
  ];
  for (var i = 0; i < lines.length; i++) {
    for (var p = 0; p < senderPatterns.length; p++) {
      var m = lines[i].match(senderPatterns[p]);
      if (m && m[1]) {
        var name = m[1].replace(/[0-9x\-\.\/\(\)]/g, '').trim();
        if (name.length >= 2 && name.length <= 60) {
          result.senderName = name;
          break;
        }
      }
    }
    if (result.senderName) break;
  }

  // ── Detect names from context (2-pass: first name after "จาก", second after "ไปยัง") ──
  if (!result.receiverName || !result.senderName) {
    var foundNames = [];
    for (var i = 0; i < lines.length; i++) {
      var thaiName = lines[i].match(/^((?:นาย|นาง|นางสาว|น\.ส\.|MR\.?|MRS\.?|MS\.?|MISS)\s+\S+(?:\s+\S+){0,3})$/i);
      if (thaiName) {
        foundNames.push({ name: thaiName[1].trim(), line: i });
      }
    }
    // If we found 2 names, first is usually sender, second is receiver
    if (foundNames.length >= 2) {
      if (!result.senderName) result.senderName = foundNames[0].name;
      if (!result.receiverName) result.receiverName = foundNames[foundNames.length - 1].name;
    } else if (foundNames.length === 1 && !result.receiverName) {
      result.receiverName = foundNames[0].name;
    }
  }

  // ── Bank detection ──
  for (var i = 0; i < BANK_PATTERNS.length; i++) {
    if (BANK_PATTERNS[i].pattern.test(fullText)) {
      result.bank = BANK_PATTERNS[i].name;
      result.bankCode = BANK_PATTERNS[i].code;
      break;
    }
  }

  // ── Reference code ──
  var refMatch = fullText.match(/(?:รหัสอ้างอิง|เลขที่รายการ|ref(?:erence)?\.?\s*(?:no|code)?\.?)\s*[:\-]?\s*([A-Za-z0-9]{8,30})/i);
  if (refMatch) result.refCode = refMatch[1];

  // ── Date ──
  var dateMatch = fullText.match(/(\d{1,2})\s*(ม\.ค\.|ก\.พ\.|มี\.ค\.|เม\.ย\.|พ\.ค\.|มิ\.ย\.|ก\.ค\.|ส\.ค\.|ก\.ย\.|ต\.ค\.|พ\.ย\.|ธ\.ค\.|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*(\d{2,4})/i);
  if (dateMatch) result.date = dateMatch[0];

  // ── Fallback: detect all "name-like" Thai strings ──
  if (!result.receiverName) {
    for (var i = lines.length - 1; i >= 0; i--) {
      // Look for pure Thai name (2+ Thai words, no numbers)
      if (/^[\u0E00-\u0E7F\s]+$/.test(lines[i]) && lines[i].split(/\s+/).length >= 2 && lines[i].length >= 4 && lines[i].length <= 50) {
        result.receiverName = lines[i].trim();
        break;
      }
    }
  }

  // Clean up names
  result.receiverName = cleanParsedName(result.receiverName);
  result.senderName = cleanParsedName(result.senderName);

  return result;
}

function cleanParsedName(name) {
  if (!name) return '';
  // Remove bank account patterns
  name = name.replace(/xxx?[-x]?xxx?\d*[-x]?\d*/g, '').trim();
  // Remove emojis and special chars
  name = name.replace(/[\u{1F300}-\u{1FAFF}]/gu, '').trim();
  // Remove trailing/leading punctuation
  name = name.replace(/^[\s\-:,\.]+|[\s\-:,\.]+$/g, '');
  return name;
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

    // Strip data URL prefix if present
    var imageData = base64.replace(/^data:image\/[a-z]+;base64,/, '');

    // Check size (~4MB limit for Vision API)
    if (imageData.length > 5500000) {
      return res.status(400).json({ ok: false, error: 'Image too large (max ~4MB)' });
    }

    var apiKey = process.env.GOOGLE_VISION_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ ok: false, error: 'GOOGLE_VISION_API_KEY not configured' });
    }

    // Call Google Vision API
    var visionRes = await fetch(VISION_URL + '?key=' + apiKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          image: { content: imageData },
          features: [
            { type: 'TEXT_DETECTION', maxResults: 1 },
          ],
          imageContext: {
            languageHints: ['th', 'en'],
          },
        }],
      }),
    });

    if (!visionRes.ok) {
      var errText = await visionRes.text();
      console.error('Vision API error:', visionRes.status, errText);
      return res.status(502).json({ ok: false, error: 'Vision API error: ' + visionRes.status });
    }

    var visionData = await visionRes.json();

    // Extract text
    var annotations = visionData.responses && visionData.responses[0] && visionData.responses[0].textAnnotations;
    if (!annotations || !annotations.length) {
      return res.status(200).json({
        ok: true,
        found: false,
        message: 'No text found in image',
        data: { receiverName: '', senderName: '', amount: '', rawText: '' },
      });
    }

    var fullText = annotations[0].description || '';

    // Parse structured data
    var parsed = parseSlipText(fullText);

    return res.status(200).json({
      ok: true,
      found: true,
      data: {
        receiverName: parsed.receiverName,
        senderName: parsed.senderName,
        amount: parsed.amount,
        amountNum: parsed.amountNum,
        bank: parsed.bank,
        bankCode: parsed.bankCode,
        date: parsed.date,
        refCode: parsed.refCode,
        rawText: fullText.substring(0, 500), // Limit raw text size
      },
    });

  } catch (e) {
    console.error('OCR error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
