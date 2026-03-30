# รวยทันใจ — Webhook Proxy + Admin Dashboard (v2)

## สิ่งที่แก้ไขจาก v1

### Critical Fixes
- ✅ **ลบ hardcoded API keys/tokens** — ใช้ env vars + KV Redis เท่านั้น
- ✅ **รวม data store เป็นที่เดียว** — ทุกอย่างอยู่ใน Upstash Redis (ลบ global._slipStore + old _store.js)
- ✅ **เพิ่ม auth** — API Key สำหรับ admin endpoints
- ✅ **เพิ่ม LINE signature verification** — ป้องกัน fake webhooks
- ✅ **ลบ SSE (events.js)** — ใช้ polling เท่านั้น (SSE ไม่ทำงานบน Vercel)

### Improvements
- ✅ Contacts sync ผ่าน Redis อย่างเดียว (ลบ localStorage)
- ✅ รวม getLineToken() เป็น shared module (_config.js)
- ✅ ลบ slip-config.js ซ้ำซ้อน
- ✅ ลบ dashboard-preview.html ที่ไม่ได้ใช้
- ✅ CORS จำกัดได้ผ่าน ALLOWED_ORIGIN env var
- ✅ Webhook auto-save contacts เมื่อเจอ user ใหม่

## Environment Variables (ตั้งบน Vercel)

| Variable | จำเป็น | คำอธิบาย |
|----------|--------|----------|
| `KV_REST_API_URL` | ✅ | Upstash Redis REST URL |
| `KV_REST_API_TOKEN` | ✅ | Upstash Redis REST Token |
| `LINE_TOKEN` | ✅ | LINE Channel Access Token (หรือตั้งผ่าน Dashboard) |
| `THUNDER_KEY` | ✅ | Thunder API Key (หรือตั้งผ่าน Dashboard) |
| `LINE_CHANNEL_SECRET` | แนะนำ | LINE Channel Secret สำหรับ verify signature |
| `ADMIN_API_KEY` | แนะนำ | API Key สำหรับป้องกัน Dashboard (ตั้งเป็น random string ยาวๆ) |
| `ALLOWED_ORIGIN` | optional | จำกัด CORS origin (default: *) |

## วิธี Deploy

1. Push code ขึ้น GitHub repo
2. เชื่อม repo กับ Vercel
3. ตั้ง Environment Variables ใน Vercel Dashboard
4. Deploy!
5. ตั้ง Webhook URL ใน LINE Developers Console: `https://your-domain.vercel.app/api/webhook`

## โครงสร้างไฟล์

```
api/
  _config.js    — Shared config, KV helpers, auth, CORS
  _store.js     — Redis-backed data store (single source of truth)
  webhook.js    — LINE webhook handler + slip verification
  kv.js         — Dashboard data management
  profile.js    — LINE profile lookup
  send.js       — Push messages to LINE users
  stats.js      — Summary statistics
public/
  index.html    — Admin Dashboard
vercel.json     — Routing config
```
