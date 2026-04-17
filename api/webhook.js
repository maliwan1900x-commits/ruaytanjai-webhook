// ═══════════════════════════════════════════════════
// /api/webhook.js — LINE Webhook Handler
// ═══════════════════════════════════════════════════
// รับ events จาก LINE → ตรวจสลิป → ตอบ Flex → เก็บลง Redis

var config = require('./_config');
var store = require('./_store');

var THUNDER_API = 'https://api.thunder.in.th/v2/verify/bank';
var LINE_API = 'https://api.line.me';
var LINE_DATA_API = 'https://api-data.line.me';

// ── LINE Profile ──
async function fetchProfile(userId) {
  var cached = await store.getProfile(userId);
  if (cached) {
    // Always ensure contact exists even if profile is cached
    if (cached.displayName) {
      await store.addContact(cached.displayName, userId);
    }
    return cached;
  }
  try {
    var token = await config.getLineToken();
    var r = await fetch(LINE_API + '/v2/bot/profile/' + userId, {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!r.ok) return null;
    var p = await r.json();
    var profile = { displayName: p.displayName, pictureUrl: p.pictureUrl || null };
    await store.saveProfile(userId, profile);
    // Auto-add to contacts
    await store.addContact(p.displayName, userId);
    return profile;
  } catch (e) {
    return null;
  }
}

// ── Image content ──
async function getImageBuffer(messageId) {
  var token = await config.getLineToken();
  var r = await fetch(LINE_DATA_API + '/v2/bot/message/' + messageId + '/content', {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!r.ok) return null;
  return Buffer.from(await r.arrayBuffer());
}

// ── Thunder slip verify ──
async function verifySlip(imageBuffer) {
  var thunderKey = await config.getThunderKey();
  var boundary = '----FB' + Date.now();
  var body = Buffer.concat([
    Buffer.from(
      '--' + boundary +
      '\r\nContent-Disposition: form-data; name="image"; filename="slip.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'
    ),
    imageBuffer,
    Buffer.from(
      '\r\n--' + boundary +
      '\r\nContent-Disposition: form-data; name="matchAccount"\r\n\r\ntrue\r\n--' +
      boundary +
      '\r\nContent-Disposition: form-data; name="checkDuplicate"\r\n\r\ntrue\r\n--' +
      boundary + '--\r\n'
    ),
  ]);
  var r = await fetch(THUNDER_API, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + thunderKey,
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
    },
    body: body,
  });
  return await r.json();
}

// ── Reply ──
async function replyMessage(replyToken, messages) {
  var token = await config.getLineToken();
  await fetch(LINE_API + '/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ replyToken: replyToken, messages: messages }),
  });
}

// ── Helpers ──
function maskAccount(acc) {
  if (!acc) return '—';
  if (acc.length <= 4) return acc;
  return 'xxx-x-x' + acc.slice(-4) + '-x';
}

function isNotSlipError(result) {
  // Thunder API returns VALIDATION_ERROR when the image is not a slip at all
  // Catch it from every possible field in the response
  if (!result || result.success) return false;
  
  // Check error.code
  var code = (result.error && result.error.code) ? result.error.code : '';
  if (code === 'VALIDATION_ERROR') return true;
  
  // Check error.message (might contain VALIDATION_ERROR as text)
  var errMsg = (result.error && result.error.message) ? result.error.message : '';
  if (errMsg.indexOf('VALIDATION_ERROR') !== -1) return true;
  
  // Check top-level code/message (some API versions put it at root)
  if (result.code === 'VALIDATION_ERROR') return true;
  if (result.message && result.message.indexOf('VALIDATION_ERROR') !== -1) return true;
  
  // Check HTTP-style error format
  if (result.status === 400 && !result.success) {
    // 400 Bad Request with no success = likely validation error for non-slip image
    if (errMsg.toLowerCase().indexOf('valid') !== -1) return true;
  }
  
  return false;
}

function isSlipPending(result) {
  // Bangkok Bank slips transferred within last 5 minutes may not be verifiable yet
  if (!result || result.success) return false;
  var code = (result.error && result.error.code) || result.code || '';
  var msg = ((result.error && result.error.message) || result.message || '').toLowerCase();
  return code === 'SLIP_PENDING' || msg.indexOf('slip_pending') !== -1 || msg.indexOf('pending') !== -1;
}

function isSlipNotFound(result) {
  // QR code not found in image — could be a real slip without QR (e.g. Bangkok Bank)
  if (!result || result.success) return false;
  var code = (result.error && result.error.code) || result.code || '';
  var msg = ((result.error && result.error.message) || result.message || '').toLowerCase();
  return code === 'SLIP_NOT_FOUND' || msg.indexOf('slip_not_found') !== -1 || msg.indexOf('no qr') !== -1 || msg.indexOf('ไม่พบ') !== -1;
}

function buildPendingFlex(slipConfig) {
  var cfg = slipConfig || {};
  return {
    type: 'flex', altText: '⏳ กรุณารอสักครู่แล้วส่งสลิปอีกครั้ง',
    contents: {
      type: 'bubble', size: 'kilo',
      header: {
        type: 'box', layout: 'horizontal', paddingAll: '14px', backgroundColor: '#F59E0B',
        contents: [
          {
            type: 'box', layout: 'vertical', width: '38px', height: '38px', cornerRadius: '19px',
            backgroundColor: '#FFFFFF33', justifyContent: 'center', alignItems: 'center', flex: 0,
            contents: [{ type: 'text', text: '⏳', align: 'center', gravity: 'center', size: 'lg' }],
          },
          { type: 'text', text: 'กรุณารอสักครู่', weight: 'bold', size: 'lg', color: '#FFFFFF', gravity: 'center', margin: 'lg', flex: 1 },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '16px', backgroundColor: '#FFFFFF',
        contents: [
          { type: 'text', text: 'สลิปธนาคารกรุงเทพอาจใช้เวลา 5-10 นาทีในการประมวลผล', size: 'sm', color: '#485C6D', wrap: true },
          { type: 'text', text: 'กรุณารอสักครู่แล้วส่งสลิปเข้ามาอีกครั้ง 🙏', size: 'sm', color: '#485C6D', wrap: true, margin: 'md' },
        ],
      },
      footer: buildCustomFooter(cfg),
      styles: { footer: { separator: false } },
    },
  };
}

function buildNoQrFlex(slipConfig) {
  var cfg = slipConfig || {};
  return {
    type: 'flex', altText: '⚠️ ไม่พบ QR Code บนสลิป',
    contents: {
      type: 'bubble', size: 'kilo',
      header: {
        type: 'box', layout: 'horizontal', paddingAll: '14px', backgroundColor: '#F59E0B',
        contents: [
          {
            type: 'box', layout: 'vertical', width: '38px', height: '38px', cornerRadius: '19px',
            backgroundColor: '#FFFFFF33', justifyContent: 'center', alignItems: 'center', flex: 0,
            contents: [{ type: 'text', text: '⚠️', align: 'center', gravity: 'center', size: 'lg' }],
          },
          { type: 'text', text: 'ไม่พบ QR Code', weight: 'bold', size: 'lg', color: '#FFFFFF', gravity: 'center', margin: 'lg', flex: 1 },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '16px', backgroundColor: '#FFFFFF',
        contents: [
          { type: 'text', text: 'ไม่พบ QR Code บนสลิป ไม่สามารถตรวจสอบได้', size: 'sm', color: '#485C6D', wrap: true },
          { type: 'text', text: 'กรุณาส่งสลิปที่มี QR Code ชัดเจน หรือหากเป็นสลิปกรุงเทพ กรุณารอ 5-10 นาทีแล้วส่งอีกครั้ง', size: 'sm', color: '#485C6D', wrap: true, margin: 'md' },
        ],
      },
      footer: buildCustomFooter(cfg),
      styles: { footer: { separator: false } },
    },
  };
}

function classifyError(result) {
  if (!result) return 'อ่านไม่ได้';
  if (result.success && result.data) {
    if (result.data.isDuplicate) return 'สลิปซ้ำ';
    if (!result.data.matchedAccount) return 'บัญชีไม่ตรง';
    return null;
  }
  var msg = result.error && result.error.message ? result.error.message.toLowerCase() : '';
  if (msg.includes('duplicate') || msg.includes('ซ้ำ')) return 'สลิปซ้ำ';
  if (msg.includes('account') || msg.includes('บัญชี')) return 'บัญชีไม่ตรง';
  return 'อ่านไม่ได้';
}

function extractAmount(result) {
  if (!result || !result.success || !result.data || !result.data.rawSlip) return 0;
  var amt = result.data.rawSlip.amount;
  return amt && amt.amount ? parseFloat(amt.amount) || 0 : 0;
}

function extractSlipInfo(result) {
  if (!result || !result.success || !result.data || !result.data.rawSlip) return {};
  var slip = result.data.rawSlip;
  var sender = slip.sender || {};
  var receiver = slip.receiver || {};
  return {
    senderName: sender.account && sender.account.name
      ? sender.account.name.th || sender.account.name.en || ''
      : '',
    receiverName: receiver.account && receiver.account.name
      ? receiver.account.name.th || receiver.account.name.en || ''
      : '',
    senderBank: sender.bank ? sender.bank.name : '',
    receiverBank: receiver.bank ? receiver.bank.name : '',
    date: slip.date || null,
    transRef: slip.transRef || null,
  };
}

// ── Flex Builders ──
function sep() {
  return {
    type: 'box', layout: 'vertical', margin: 'sm', height: '1px',
    backgroundColor: '#F0F0F0', contents: [{ type: 'filler' }],
  };
}

function makeInfoRow(label, value, valueColor) {
  return {
    type: 'box', layout: 'horizontal', margin: 'lg',
    contents: [
      { type: 'text', text: label, size: 'xxs', color: '#8891A0', flex: 2 },
      { type: 'text', text: value, size: 'xxs', color: valueColor || '#485C6D', weight: 'bold', flex: 5, align: 'end', wrap: true },
    ],
  };
}

function buildCustomFooter(cfg) {
  cfg = cfg || {};
  var contents = [];

  contents.push({
    type: 'box', layout: 'horizontal', spacing: 'sm',
    contents: [
      {
        type: 'box', layout: 'vertical', width: '18px', height: '18px',
        justifyContent: 'center', alignItems: 'center', flex: 0,
        contents: [{ type: 'text', text: '🔒', size: 'xxs', align: 'center' }],
      },
      {
        type: 'box', layout: 'vertical', flex: 1,
        contents: [
          { type: 'text', text: cfg.footerText || 'ตรวจสอบโดย ธันเดอร์ โซลูชั่น', size: 'xxs', color: '#1E2D5C', weight: 'bold', wrap: true },
          { type: 'text', text: cfg.footerSubText || '', size: 'xxs', color: '#8891A0', wrap: true },
        ].filter(function (t) { return t.text; }),
      },
    ],
  });

  if (cfg.promoText) {
    contents.push({
      type: 'box', layout: 'vertical', margin: 'md',
      paddingAll: '8px', cornerRadius: '8px', backgroundColor: '#FFF8E1',
      contents: [
        { type: 'text', text: cfg.promoText, size: 'xxs', color: '#B45309', wrap: true, align: 'center' },
      ],
    });
  }

  var enabledBtns = (cfg.buttons || []).filter(function (b) { return b.enabled; });
  enabledBtns.forEach(function (btn) {
    var action;
    if (btn.url && (btn.url.startsWith('http://') || btn.url.startsWith('https://') || btn.url.startsWith('line://'))) {
      action = { type: 'uri', label: btn.label, uri: btn.url };
    } else {
      action = { type: 'message', label: btn.label, text: btn.label };
    }
    contents.push({
      type: 'button', style: 'primary', height: 'sm', margin: 'sm',
      color: btn.color || '#555555', action: action,
    });
  });

  return {
    type: 'box', layout: 'vertical', paddingAll: '10px', spacing: 'none',
    backgroundColor: '#F6FAF6', contents: contents,
  };
}

var THUNDER_QR_LOGO = 'https://www.thunder.in.th/assets/images/thunder-qr-logo.png';

function getHeroImages(slipConfig) {
  var cfg = slipConfig || {};
  return {
    pass: cfg.heroPass || '',
    duplicate: cfg.heroDup || '',
    mismatch: cfg.heroFail || '',
    error: cfg.heroFail || '',
  };
}

// Bank logos - self-hosted PNG on Vercel
var BANK_ICON_BASE = '';
var BANK_LOGOS = {
  'กสิกรไทย': 'KBANK', 'Kasikorn': 'KBANK', 'KBANK': 'KBANK',
  'ไทยพาณิชย์': 'SCB', 'Siam Commercial': 'SCB', 'SCB': 'SCB',
  'กรุงเทพ': 'BBL', 'Bangkok Bank': 'BBL', 'BBL': 'BBL',
  'กรุงไทย': 'KTB', 'Krungthai': 'KTB', 'KTB': 'KTB',
  'กรุงศรี': 'BAY', 'Krungsri': 'BAY', 'BAY': 'BAY',
  'ทหารไทยธนชาต': 'TTB', 'TMBThanachart': 'TTB', 'TTB': 'TTB',
  'ออมสิน': 'GSB', 'GSB': 'GSB',
  'ธ.ก.ส.': 'BAAC', 'BAAC': 'BAAC',
  'ซีไอเอ็มบี': 'CIMB', 'CIMB': 'CIMB',
  'ยูโอบี': 'UOB', 'UOB': 'UOB',
  'แลนด์ แอนด์ เฮ้าส์': 'LHB', 'LHBANK': 'LHB', 'LHB': 'LHB',
  'ทิสโก้': 'TISCO', 'TISCO': 'TISCO',
  'เกียรตินาคินภัทร': 'KKP', 'KKP': 'KKP',
  'อิสลาม': 'IBANK', 'IBANK': 'IBANK',
  'ธอส': 'GHB', 'GHB': 'GHB',
  'ซิตี้แบงก์': 'CITI', 'CITI': 'CITI',
  'HSBC': 'HSBC',
  'ICBC': 'ICBC',
};

function getBankLogoUrl(bankName) {
  if (!bankName) return null;
  for (var key in BANK_LOGOS) {
    if (bankName.includes(key)) return BANK_ICON_BASE + BANK_LOGOS[key] + '.png';
  }
  return null;
}

function buildBankSection(label, name, bankName, acctLine, iconEmoji) {
  var logoUrl = getBankLogoUrl(bankName);
  var iconContent;

  if (logoUrl) {
    iconContent = {
      type: 'box', layout: 'vertical', width: '28px', height: '28px', cornerRadius: '14px',
      backgroundColor: '#FFFFFF', justifyContent: 'center', alignItems: 'center', flex: 0,
      borderWidth: '1px', borderColor: '#E0E0E0',
      contents: [{ type: 'image', url: logoUrl, size: '22px', aspectMode: 'fit', aspectRatio: '1:1' }],
    };
  } else {
    iconContent = {
      type: 'box', layout: 'vertical', width: '28px', height: '28px', cornerRadius: '14px',
      backgroundColor: '#E8E8E8', justifyContent: 'center', alignItems: 'center', flex: 0,
      contents: [{ type: 'text', text: iconEmoji, size: 'xxs', align: 'center', gravity: 'center' }],
    };
  }

  return {
    type: 'box', layout: 'horizontal', margin: 'md', spacing: 'sm',
    contents: [
      iconContent,
      {
        type: 'box', layout: 'vertical', flex: 1, justifyContent: 'center',
        contents: [
          { type: 'text', text: label, size: 'xxs', color: '#8891A0' },
          { type: 'text', text: name, size: 'xs', weight: 'bold', color: '#1E2D5C', wrap: true },
          { type: 'text', text: acctLine, size: 'xxs', color: '#8891A0', wrap: true },
        ],
      },
    ],
  };
}

function buildFlex(data, slipConfig) {
  var slip = data.rawSlip || {};
  var amt = slip.amount
    ? Number(slip.amount.amount).toLocaleString('th-TH', { minimumFractionDigits: 0 })
    : '—';
  var sender = slip.sender || {};
  var receiver = slip.receiver || {};
  var sName = sender.account && sender.account.name
    ? sender.account.name.th || sender.account.name.en || '—'
    : '—';
  var sBankFull = sender.bank ? sender.bank.name : '';
  var sAcct = sender.account && sender.account.bank ? maskAccount(sender.account.bank.account) : '—';
  var sBankLine = sBankFull ? sBankFull + '  •  ' + sAcct : sAcct;
  var rName = receiver.account && receiver.account.name
    ? receiver.account.name.th || receiver.account.name.en || '—'
    : '—';
  var rBankFull = receiver.bank ? receiver.bank.name : '';
  var rAcct = receiver.account && receiver.account.bank ? maskAccount(receiver.account.bank.account) : '—';
  var rBankLine = rBankFull ? rBankFull + '  •  ' + rAcct : rAcct;
  var d = slip.date ? new Date(slip.date) : null;
  var dateStr = d
    ? d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'Asia/Bangkok' }) +
      ', ' +
      d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' }) +
      ' น.'
    : '—';

  var isDup = data.isDuplicate;
  var matched = data.matchedAccount ? true : false;
  var heroImages = getHeroImages(slipConfig);
  var headBg, statusText, statusIcon, heroUrl;
  if (isDup) { headBg = '#F59E0B'; statusText = 'สลิปซ้ำ'; statusIcon = '⚠️'; heroUrl = heroImages.duplicate; }
  else if (!matched) { headBg = '#EF4444'; statusText = 'บัญชีไม่ตรง'; statusIcon = '❌'; heroUrl = heroImages.mismatch; }
  else { headBg = '#22C55E'; statusText = 'สลิปถูกต้อง'; statusIcon = '✅'; heroUrl = heroImages.pass; }

  // ── Header: Use hero image if URL provided, otherwise fallback to text header ──
  var useHero = heroUrl && heroUrl.startsWith('https://');
  var headerSection, heroSection;

  if (useHero) {
    // Hero image banner (like Thunder official)
    heroSection = {
      type: 'image', url: heroUrl, size: 'full', aspectMode: 'cover', aspectRatio: '54:10',
    };
    headerSection = null;
  } else {
    // Fallback: text-based header
    var headerContents = [
      {
        type: 'box', layout: 'vertical', width: '38px', height: '38px', cornerRadius: '19px',
        backgroundColor: '#FFFFFF33', justifyContent: 'center', alignItems: 'center', flex: 0,
        contents: [{ type: 'text', text: statusIcon, align: 'center', gravity: 'center', size: 'lg' }],
      },
      { type: 'text', text: statusText, weight: 'bold', size: 'xl', color: '#FFFFFF', gravity: 'center', margin: 'lg', flex: 1 },
    ];
    if (!isDup && matched) {
      headerContents.push({
        type: 'box', layout: 'vertical', width: '32px', height: '32px', cornerRadius: '16px',
        backgroundColor: '#16A34A', justifyContent: 'center', alignItems: 'center', flex: 0,
        borderWidth: '2px', borderColor: '#FFFFFF55',
        contents: [{ type: 'text', text: '✓', align: 'center', gravity: 'center', size: 'lg', color: '#FFFFFF', weight: 'bold' }],
      });
    }
    headerSection = {
      type: 'box', layout: 'horizontal', paddingAll: '14px',
      backgroundColor: headBg, contents: headerContents,
    };
    heroSection = null;
  }

  // ── Body: Compact like Thunder ──
  var bodyContents = [
    { type: 'text', text: '฿' + amt, weight: 'bold', size: 'xxl', color: '#1E2D5C', align: 'center' },
    { type: 'text', text: dateStr, size: 'xxs', color: '#8891A0', align: 'center', margin: 'xs' },
    sep(),
    buildBankSection('ผู้โอน', sName, sBankFull, sBankLine, '💳'),
    sep(),
    buildBankSection('ผู้รับ', rName, rBankFull, rBankLine, '🏦'),
  ];

  // Status warnings
  if (isDup) bodyContents.push(sep(), makeInfoRow('สถานะ', 'พบ transRef ซ้ำในระบบ', '#F59E0B'));
  else if (!matched) bodyContents.push(sep(), makeInfoRow('สถานะ', 'บัญชีผู้รับไม่ตรงกับที่ลงทะเบียน', '#EF4444'));

  // ── Footer: Thunder-style with QR logo ──
  var footerContents = [];
  var cfg = slipConfig || {};

  // Thunder verification badge with QR logo
  footerContents.push({
    type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center',
    contents: [
      {
        type: 'box', layout: 'vertical', width: '28px', height: '28px', flex: 0,
        contents: [{
          type: 'image', url: THUNDER_QR_LOGO, size: 'full', aspectMode: 'fit', aspectRatio: '1:1',
        }],
      },
      {
        type: 'box', layout: 'vertical', flex: 1,
        contents: [
          { type: 'text', text: cfg.footerText || 'สลิปจริงตรวจสอบโดย ธันเดอร์ โซลูชั่น', size: 'xxs', color: '#1E2D5C', weight: 'bold', wrap: true },
          { type: 'text', text: cfg.footerSubText || 'ผู้ให้บริการเช็กสลิปอันดับ 1', size: 'xxs', color: '#8891A0', wrap: true },
        ].filter(function (t) { return t.text; }),
      },
    ],
  });

  // Promo text
  if (cfg.promoText) {
    footerContents.push({
      type: 'box', layout: 'vertical', margin: 'sm',
      paddingAll: '6px', cornerRadius: '6px', backgroundColor: '#FFF8E1',
      contents: [
        { type: 'text', text: cfg.promoText, size: 'xxs', color: '#B45309', wrap: true, align: 'center' },
      ],
    });
  }

  // Custom buttons
  var enabledBtns = (cfg.buttons || []).filter(function (b) { return b.enabled; });
  enabledBtns.forEach(function (btn) {
    var action;
    if (btn.url && (btn.url.startsWith('http://') || btn.url.startsWith('https://') || btn.url.startsWith('line://'))) {
      action = { type: 'uri', label: btn.label, uri: btn.url };
    } else {
      action = { type: 'message', label: btn.label, text: btn.label };
    }
    footerContents.push({
      type: 'button', style: 'primary', height: 'sm', margin: 'sm',
      color: btn.color || '#555555', action: action,
    });
  });

  var bubble = {
    type: 'bubble', size: 'kilo',
    body: {
      type: 'box', layout: 'vertical', paddingAll: '14px', spacing: 'none',
      backgroundColor: '#FFFFFF', contents: bodyContents,
    },
    footer: {
      type: 'box', layout: 'vertical', paddingAll: '10px', spacing: 'none',
      backgroundColor: '#F6FAF6', contents: footerContents,
    },
    styles: { footer: { separator: false } },
  };

  // Add hero image or header
  if (useHero) {
    bubble.hero = heroSection;
  } else {
    bubble.header = headerSection;
  }

  return {
    type: 'flex',
    altText: statusIcon + ' ' + statusText + ' ฿' + amt,
    contents: bubble,
  };
}

function buildErrorFlex(errMsg, slipConfig) {
  var cfg = slipConfig || {};
  return {
    type: 'flex', altText: '❌ ' + errMsg,
    contents: {
      type: 'bubble', size: 'kilo',
      header: {
        type: 'box', layout: 'horizontal', paddingAll: '14px', backgroundColor: '#EF4444',
        contents: [
          {
            type: 'box', layout: 'vertical', width: '38px', height: '38px', cornerRadius: '19px',
            backgroundColor: '#FFFFFF33', justifyContent: 'center', alignItems: 'center', flex: 0,
            contents: [{ type: 'text', text: '❌', align: 'center', gravity: 'center', size: 'lg' }],
          },
          { type: 'text', text: 'ตรวจสลิปไม่สำเร็จ', weight: 'bold', size: 'lg', color: '#FFFFFF', gravity: 'center', margin: 'lg', flex: 1 },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '16px', backgroundColor: '#FFFFFF',
        contents: [{ type: 'text', text: errMsg, size: 'sm', color: '#485C6D', wrap: true }],
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'none',
        backgroundColor: '#F6FAF6',
        contents: [{
          type: 'box', layout: 'horizontal', spacing: 'md', alignItems: 'center',
          contents: [
            {
              type: 'box', layout: 'vertical', width: '36px', height: '36px', flex: 0,
              contents: [{ type: 'image', url: THUNDER_QR_LOGO, size: 'full', aspectMode: 'fit', aspectRatio: '1:1' }],
            },
            {
              type: 'box', layout: 'vertical', flex: 1,
              contents: [
                { type: 'text', text: cfg.footerText || 'สลิปจริงตรวจสอบโดย ธันเดอร์ โซลูชั่น', size: 'xs', color: '#1E2D5C', weight: 'bold', wrap: true },
                { type: 'text', text: cfg.footerSubText || 'ผู้ให้บริการเช็กสลิปอันดับ 1', size: 'xxs', color: '#8891A0', wrap: true },
              ].filter(function (t) { return t.text; }),
            },
          ],
        }],
      },
      styles: { footer: { separator: false } },
    },
  };
}

// ════════════════════════════════════════════════════
//  Webhook Handler
// ════════════════════════════════════════════════════
module.exports = async (req, res) => {
  config.setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Set bank icon base URL
  var reqHost = req.headers.host || 'ruaytanjaiwebhook.vercel.app';
  BANK_ICON_BASE = 'https://' + reqHost + '/banks/';

  // ── GET: Dashboard reads data ──
  if (req.method === 'GET') {
    if (!config.checkAuth(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    var summary = await store.getSummary();
    return res.status(200).json({ ok: true, ...summary });
  }

  // ── DELETE: Reset data ──
  if (req.method === 'DELETE') {
    if (!config.checkAuth(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    await store.resetAll();
    return res.status(200).json({ ok: true, message: 'reset' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST, GET, or DELETE only' });

  // ── POST: LINE webhook events ──
  // Verify LINE signature
  var signature = req.headers['x-line-signature'] || '';
  if (!config.verifySignature(req.body, signature)) {
    console.log('Invalid LINE signature');
    return res.status(401).json({ error: 'invalid signature' });
  }

  var body = req.body || {};
  if (!body.events || !Array.isArray(body.events)) return res.status(200).json({ ok: true });

  // Load slip config once for this request
  var slipConfig = await config.getSlipConfig();

  for (var i = 0; i < body.events.length; i++) {
    var ev = body.events[i];
    var uid = ev.source && ev.source.userId ? ev.source.userId : 'unknown';
    var replyToken = ev.replyToken;
    var displayName = uid.slice(-8);

    if (uid !== 'unknown') {
      var profile = await fetchProfile(uid);
      if (profile && profile.displayName) displayName = profile.displayName;
    }

    // ── Image (slip) ──
    if (ev.message && ev.message.type === 'image' && replyToken) {
      // ── Rate limit: 5 สลิป/นาที/user ──
      var rateLimitKey = 'ratelimit:' + uid;
      try {
        var rlRaw = await config.kvGet(rateLimitKey);
        var rlData = rlRaw ? JSON.parse(rlRaw) : { count: 0, resetAt: 0 };
        var rlNow = Date.now();
        if (rlNow > rlData.resetAt) { rlData = { count: 0, resetAt: rlNow + 60000 }; }
        rlData.count++;
        await config.kvSetEx(rateLimitKey, JSON.stringify(rlData), 120);
        if (rlData.count > 5) {
          console.log('Rate limit hit: ' + uid + ' (' + rlData.count + ' slips/min)');
          await store.addEvent({
            id: Date.now().toString(36), timestamp: Date.now(), source: 'line',
            userId: uid, name: displayName, text: 'rate-limited', type: 'message',
          });
          continue;
        }
      } catch (rlErr) { /* ถ้า rate limit check พัง ให้ผ่านไปก่อน */ }

      var result = null;
      var slipRecord = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        timestamp: Date.now(),
        userId: uid,
        customerName: displayName,
        status: 'pending',
        errorReason: null,
        amount: 0,
        slipInfo: {},
        raw: null,
      };

      try {
        var imgBuf = await getImageBuffer(ev.message.id);
        if (!imgBuf) {
          slipRecord.status = 'fail';
          slipRecord.errorReason = 'อ่านไม่ได้';
          await store.addSlip(slipRecord);
          await replyMessage(replyToken, [buildErrorFlex('ไม่สามารถดึงรูปภาพได้', slipConfig)]);
          await store.addEvent({
            id: slipRecord.id, timestamp: Date.now(), source: 'line',
            userId: uid, name: displayName, text: 'img-fail', type: 'slip',
          });
          continue;
        }

        result = await verifySlip(imgBuf);
        slipRecord.raw = result ? { success: result.success, error: result.error || null } : null;
        
        // ── Debug: Log Thunder API response for troubleshooting ──
        console.log('Thunder API response:', JSON.stringify({
          success: result.success,
          errorCode: result.error && result.error.code,
          errorMsg: result.error && result.error.message,
          keys: Object.keys(result),
        }));

        if (result.success) {
          // ── สลิปตรวจสำเร็จ → ตอบ Flex ──
          var errReason = classifyError(result);
          slipRecord.status = errReason ? 'fail' : 'pass';
          slipRecord.errorReason = errReason;
          slipRecord.amount = extractAmount(result);
          slipRecord.slipInfo = extractSlipInfo(result);
          await replyMessage(replyToken, [buildFlex(result.data, slipConfig)]);
          await store.addSlip(slipRecord);
          await store.addEvent({
            id: slipRecord.id, timestamp: Date.now(), source: 'line',
            userId: uid, name: displayName, text: 'slip', type: 'slip',
            slipStatus: slipRecord.status, slipAmount: slipRecord.amount,
            slipError: slipRecord.errorReason,
          });
        } else {
          // ── ตรวจไม่สำเร็จ → แยกกรณี ──
          if (isSlipPending(result)) {
            await replyMessage(replyToken, [buildPendingFlex(slipConfig)]);
            await store.addEvent({
              id: slipRecord.id, timestamp: Date.now(), source: 'line',
              userId: uid, name: displayName, text: 'slip-pending', type: 'slip',
            });
          } else if (isSlipNotFound(result)) {
            await replyMessage(replyToken, [buildNoQrFlex(slipConfig)]);
            await store.addEvent({
              id: slipRecord.id, timestamp: Date.now(), source: 'line',
              userId: uid, name: displayName, text: 'slip-no-qr', type: 'slip',
            });
          } else {
            // ไม่ใช่สลิป (VALIDATION_ERROR, รูปทั่วไป) → เงียบ ไม่ตอบ
            await store.addEvent({
              id: slipRecord.id, timestamp: Date.now(), source: 'line',
              userId: uid, name: displayName,
              text: 'image-skip (' + ((result.error && result.error.code) || (result.error && result.error.message) || 'unknown') + ')',
              type: 'message',
            });
          }
        }
      } catch (e) {
        slipRecord.status = 'fail';
        slipRecord.errorReason = 'อ่านไม่ได้';
        await store.addSlip(slipRecord);
        try { await replyMessage(replyToken, [buildErrorFlex(e.message, slipConfig)]); } catch (e2) {}
        await store.addEvent({
          id: slipRecord.id, timestamp: Date.now(), source: 'line',
          userId: uid, name: displayName, text: 'error', type: 'slip', error: e.message,
        });
      }
      continue;
    }

    // ── Text / other message ──
    await store.addEvent({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      timestamp: ev.timestamp || Date.now(),
      source: 'line', userId: uid, name: displayName,
      text: ev.message && ev.message.text ? ev.message.text : 'event',
      type: 'message',
    });
  }

  return res.status(200).json({ ok: true });
};
