// ═══════════════════════════════════════════════════
// /api/stats.js — Summary + customer insights + granular reset
// ═══════════════════════════════════════════════════

var config = require('./_config');
var store = require('./_store');

function isToday(ts) {
  var now = new Date();
  var d = new Date(ts);
  return d.getFullYear() === now.getFullYear() &&
         d.getMonth() === now.getMonth() &&
         d.getDate() === now.getDate();
}

function isWithin(ts, days) {
  var cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
  return ts >= cutoff;
}

module.exports = async (req, res) => {
  config.setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!config.checkAuth(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  try {
    // ── DELETE with granular scope ──
    if (req.method === 'DELETE') {
      var scope = (req.query && req.query.scope) || 'slips_events';

      if (scope === 'slips_events' || scope === 'slips' || scope === 'all') {
        await config.kvSet('store:slips', '[]');
      }
      if (scope === 'slips_events' || scope === 'events' || scope === 'all') {
        await config.kvSet('store:events', '[]');
      }
      if (scope === 'profiles' || scope === 'all') {
        await config.kvSet('store:profiles', '{}');
      }
      if (scope === 'contacts' || scope === 'all') {
        await config.kvSet('contacts', '[]');
      }
      if (scope === 'pending' || scope === 'all') {
        await config.kvSet('pending:slips', '[]');
      }

      return res.status(200).json({ ok: true, scope: scope, message: 'reset ' + scope });
    }

    // ── GET ──
    if (req.method === 'GET') {
      var action = (req.query && req.query.action) || '';

      // Customer stats lookup
      if (action === 'customer') {
        var uid = req.query.uid;
        if (!uid) return res.status(400).json({ ok: false, error: 'uid required' });

        var slips = await store.getSlips();
        var customerSlips = slips.filter(function(s) { return s.userId === uid; });

        var today = customerSlips.filter(function(s) { return isToday(s.timestamp); });
        var past7 = customerSlips.filter(function(s) { return isWithin(s.timestamp, 7); });
        var past30 = customerSlips.filter(function(s) { return isWithin(s.timestamp, 30); });

        function computeStats(arr) {
          var pass = arr.filter(function(s) { return s.status === 'pass'; });
          var fail = arr.filter(function(s) { return s.status === 'fail'; });
          var amount = pass.reduce(function(sum, s) { return sum + (s.amount || 0); }, 0);
          return { total: arr.length, pass: pass.length, fail: fail.length, amount: amount };
        }

        var contacts = await store.getContacts();
        var contact = contacts.find(function(c) { return c.uid === uid; });
        var profile = await store.getProfile(uid);

        // Load slipNames (ชื่อในสลิปที่เพิ่มเอง)
        var slipNames = [];
        try { var sn = await config.kvGet('slipnames:' + uid); if (sn) slipNames = JSON.parse(sn); } catch(e) {}

        return res.status(200).json({
          ok: true,
          uid: uid,
          name: (contact && contact.name) || (profile && profile.displayName) || '',
          slipNames: slipNames,
          today: computeStats(today),
          past7: computeStats(past7),
          past30: computeStats(past30),
          total: computeStats(customerSlips),
          recentSlips: customerSlips.slice(0, 20).map(function(s) {
            return {
              timestamp: s.timestamp,
              amount: s.amount,
              status: s.status,
              errorReason: s.errorReason || '',
              senderName: (s.slipInfo && s.slipInfo.senderName) || '',
            };
          }),
        });
      }

      // Save slipNames for a customer
      if (action === 'save_slip_names') {
        var uid = req.query.uid;
        if (!uid) return res.status(400).json({ ok: false, error: 'uid required' });
        var names = (req.query.names || '').split(',').map(function(n) { return n.trim(); }).filter(Boolean);
        await config.kvSet('slipnames:' + uid, JSON.stringify(names));
        return res.status(200).json({ ok: true, slipNames: names });
      }

      // Top customers today
      if (action === 'top_today') {
        var slipsAll = await store.getSlips();
        var todaySlips = slipsAll.filter(function(s) { return isToday(s.timestamp); });

        var byUser = {};
        todaySlips.forEach(function(s) {
          if (!s.userId) return;
          if (!byUser[s.userId]) {
            byUser[s.userId] = {
              userId: s.userId,
              name: s.customerName || '?',
              total: 0,
              pass: 0,
              fail: 0,
              amount: 0,
            };
          }
          var u = byUser[s.userId];
          u.total++;
          if (s.status === 'pass') {
            u.pass++;
            u.amount += (s.amount || 0);
          } else {
            u.fail++;
          }
        });

        var top = Object.values(byUser)
          .sort(function(a, b) {
            if (b.amount !== a.amount) return b.amount - a.amount;
            return b.total - a.total;
          })
          .slice(0, 10);

        return res.status(200).json({ ok: true, top: top });
      }

      // Default — full summary
      var summary = await store.getSummary();
      return res.status(200).json(summary);
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
