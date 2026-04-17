// ═══════════════════════════════════════════════════
// /api/_store.js — Redis-backed data store
// ═══════════════════════════════════════════════════
// Single source of truth: ข้อมูลทั้งหมดอยู่ใน Upstash Redis
// ไม่พึ่ง in-memory อีกต่อไป — ทุก cold start ข้อมูลยังอยู่ครบ

var config = require('./_config');

// Redis keys
var KEYS = {
  slips: 'store:slips',
  events: 'store:events',
  profiles: 'store:profiles',
  contacts: 'contacts',
};

var MAX_SLIPS = 1500;
var MAX_EVENTS = 500;

// ── Slips ──
async function addSlip(slip) {
  try {
    var raw = await config.kvGet(KEYS.slips);
    var slips = raw ? JSON.parse(raw) : [];
    slips.unshift(slip);
    if (slips.length > MAX_SLIPS) slips = slips.slice(0, MAX_SLIPS);
    await config.kvSet(KEYS.slips, JSON.stringify(slips));
    return true;
  } catch (e) {
    console.error('addSlip error:', e.message);
    return false;
  }
}

async function getSlips(limit) {
  try {
    var raw = await config.kvGet(KEYS.slips);
    var slips = raw ? JSON.parse(raw) : [];
    return limit ? slips.slice(0, limit) : slips;
  } catch (e) {
    return [];
  }
}

// ── Events ──
async function addEvent(ev) {
  try {
    var raw = await config.kvGet(KEYS.events);
    var events = raw ? JSON.parse(raw) : [];
    events.unshift(ev);
    if (events.length > MAX_EVENTS) events = events.slice(0, MAX_EVENTS);
    await config.kvSet(KEYS.events, JSON.stringify(events));
    return true;
  } catch (e) {
    console.error('addEvent error:', e.message);
    return false;
  }
}

async function getEvents(limit) {
  try {
    var raw = await config.kvGet(KEYS.events);
    var events = raw ? JSON.parse(raw) : [];
    return limit ? events.slice(0, limit) : events;
  } catch (e) {
    return [];
  }
}

// ── Profiles ──
async function saveProfile(userId, profile) {
  try {
    var raw = await config.kvGet(KEYS.profiles);
    var profiles = raw ? JSON.parse(raw) : {};
    profiles[userId] = profile;
    await config.kvSet(KEYS.profiles, JSON.stringify(profiles));
    return true;
  } catch (e) {
    return false;
  }
}

async function getProfile(userId) {
  try {
    var raw = await config.kvGet(KEYS.profiles);
    var profiles = raw ? JSON.parse(raw) : {};
    return profiles[userId] || null;
  } catch (e) {
    return null;
  }
}

async function getAllProfiles() {
  try {
    var raw = await config.kvGet(KEYS.profiles);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

// ── Contacts ──
async function getContacts() {
  try {
    var raw = await config.kvGet(KEYS.contacts);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

async function saveContacts(contacts) {
  return await config.kvSet(KEYS.contacts, JSON.stringify(contacts));
}

async function addContact(name, uid) {
  var contacts = await getContacts();
  var existing = contacts.find(function (c) { return c.uid === uid; });
  if (existing) {
    // อัพเดทชื่อถ้าเปลี่ยน
    if (existing.name !== name) {
      existing.name = name;
      await saveContacts(contacts);
    }
    return false; // ไม่ได้เพิ่มใหม่
  }
  contacts.push({ name: name, uid: uid });
  await saveContacts(contacts);
  return true; // เพิ่มใหม่
}

// ── Reset ──
async function resetAll() {
  await config.kvSet(KEYS.slips, '[]');
  await config.kvSet(KEYS.events, '[]');
  return true;
}

// ── Rebuild contacts from profiles AND events (if contacts is missing entries) ──
async function rebuildContactsFromProfiles() {
  try {
    var contacts = await getContacts();
    var profiles = await getAllProfiles();
    var events = await getEvents();
    
    // Build a set of existing contact uids for fast lookup
    var existingUids = {};
    contacts.forEach(function (c) { existingUids[c.uid] = true; });
    
    var added = 0;
    
    // 1) Add from profiles
    var profileKeys = Object.keys(profiles);
    for (var j = 0; j < profileKeys.length; j++) {
      var uid = profileKeys[j];
      if (!existingUids[uid] && profiles[uid].displayName) {
        contacts.push({ name: profiles[uid].displayName, uid: uid });
        existingUids[uid] = true;
        added++;
      }
    }
    
    // 2) Add from events (for users who have events but no profile cached)
    for (var k = 0; k < events.length; k++) {
      var ev = events[k];
      if (ev.userId && ev.userId.startsWith('U') && ev.name && !existingUids[ev.userId]) {
        contacts.push({ name: ev.name, uid: ev.userId });
        existingUids[ev.userId] = true;
        added++;
      }
    }
    
    if (added > 0) {
      await saveContacts(contacts);
      console.log('Rebuilt contacts: added ' + added + ' entries');
    }
    return contacts;
  } catch (e) {
    console.error('rebuildContacts error:', e.message);
    return await getContacts();
  }
}

// ── Summary ──
async function getSummary() {
  var slips = await getSlips();
  var events = await getEvents();
  var profiles = await getAllProfiles();
  // Auto-rebuild contacts from profiles if needed
  var contacts = await rebuildContactsFromProfiles();
  return {
    totalSlips: slips.length,
    totalEvents: events.length,
    totalContacts: contacts.length,
    totalProfiles: Object.keys(profiles).length,
    slips: slips.slice(0, 200),
    events: events.slice(0, 100),
    profiles: profiles,
    contacts: contacts,
  };
}

module.exports = {
  addSlip,
  getSlips,
  addEvent,
  getEvents,
  saveProfile,
  getProfile,
  getAllProfiles,
  getContacts,
  saveContacts,
  addContact,
  rebuildContactsFromProfiles,
  resetAll,
  getSummary,
};
