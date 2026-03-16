require('dotenv').config();

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

/* =========================
   CONFIG
========================= */
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.CHANNEL_SECRET;
const LINE_GROUP_ID = process.env.LINE_GROUP_ID || '';
const BASE_URL = process.env.BASE_URL || '';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

function parseIds(str = '') {
  return str
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const ADMIN_USER_IDS = parseIds(process.env.ADMIN_USER_IDS);
const STAFF_USER_IDS = parseIds(process.env.STAFF_USER_IDS);
const VIEWER_USER_IDS = parseIds(process.env.VIEWER_USER_IDS);

/* =========================
   EXPRESS RAW BODY FOR LINE SIGNATURE
========================= */
app.use('/webhook', express.raw({ type: '*/*' }));
app.use(express.json());

/* =========================
   HELPERS
========================= */
function verifyLineSignature(rawBody, signature) {
  if (!CHANNEL_SECRET) return false;
  const hash = crypto
    .createHmac('SHA256', CHANNEL_SECRET)
    .update(rawBody)
    .digest('base64');
  return hash === signature;
}

function getUserRole(userId) {
  if (ADMIN_USER_IDS.includes(userId)) return 'admin';
  if (STAFF_USER_IDS.includes(userId)) return 'staff';
  if (VIEWER_USER_IDS.includes(userId)) return 'viewer';
  return 'guest';
}

function hasPermission(userId, allowedRoles = []) {
  return allowedRoles.includes(getUserRole(userId));
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatThaiDate(dateValue) {
  if (!dateValue) return '-';
  const d = new Date(dateValue);
  if (isNaN(d.getTime())) return '-';

  const dd = pad(d.getDate());
  const mm = pad(d.getMonth() + 1);
  const yyyy = d.getFullYear();
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());

  return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
}

function getDateKeyBangkok(date = new Date()) {
  const bangkok = new Date(
    date.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' })
  );
  const y = bangkok.getFullYear();
  const m = pad(bangkok.getMonth() + 1);
  const d = pad(bangkok.getDate());
  return `${y}${m}${d}`;
}

async function generateCaseId() {
  const dateKey = getDateKeyBangkok();
  const prefix = `CASE-${dateKey}-`;

  const result = await pool.query(
    `
    SELECT case_id
    FROM cases
    WHERE case_id LIKE $1
    ORDER BY case_id DESC
    LIMIT 1
    `,
    [`${prefix}%`]
  );

  let seq = 1;
  if (result.rows.length > 0) {
    const lastId = result.rows[0].case_id || '';
    const lastSeq = parseInt(lastId.split('-').pop(), 10);
    if (!Number.isNaN(lastSeq)) seq = lastSeq + 1;
  }

  return `${prefix}${String(seq).padStart(3, '0')}`;
}

async function replyText(replyToken, text) {
  if (!replyToken || !CHANNEL_ACCESS_TOKEN) return;
  try {
    await axios.post(
      'https://api.line.me/v2/bot/message/reply',
      {
        replyToken,
        messages: [{ type: 'text', text: text.slice(0, 5000) }]
      },
      {
        headers: {
          Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (err) {
    console.error('replyText error:', err.response?.data || err.message);
  }
}

async function pushText(to, text) {
  if (!to || !CHANNEL_ACCESS_TOKEN) return;
  try {
    await axios.post(
      'https://api.line.me/v2/bot/message/push',
      {
        to,
        messages: [{ type: 'text', text: text.slice(0, 5000) }]
      },
      {
        headers: {
          Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (err) {
    console.error('pushText error:', err.response?.data || err.message);
  }
}

async function getLineProfile(userId) {
  if (!userId || !CHANNEL_ACCESS_TOKEN) return null;
  try {
    const res = await axios.get(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: {
        Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`
      }
    });
    return res.data;
  } catch (err) {
    return null;
  }
}

async function writeCaseLog({
  caseId,
  action,
  actorUserId = null,
  actorName = null,
  note = null
}) {
  try {
    await pool.query(
      `
      INSERT INTO case_logs (case_id, action, actor_user_id, actor_name, note)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [caseId, action, actorUserId, actorName, note]
    );
  } catch (err) {
    console.error('writeCaseLog error:', err.message);
  }
}

function normalizeStatus(text = '') {
  const t = text.trim().toLowerCase();

  if (['ใหม่', 'new'].includes(t)) return 'ใหม่';
  if (['ด่วน', 'urgent'].includes(t)) return 'ด่วน';
  if (
    ['กำลังดำเนินการ', 'ดำเนินการ', 'inprogress', 'in progress', 'processing'].includes(t)
  ) return 'กำลังดำเนินการ';
  if (['รอข้อมูล', 'pending'].includes(t)) return 'รอข้อมูล';
  if (['ปิดเคส', 'ปิด', 'closed', 'done'].includes(t)) return 'ปิดเคส';

  return text.trim();
}

function normalizePriority(text = '') {
  const t = text.trim().toLowerCase();

  if (['ด่วน', 'urgent', 'high'].includes(t)) return 'ด่วน';
  if (['ปกติ', 'normal', 'medium'].includes(t)) return 'ปกติ';
  if (['ต่ำ', 'low'].includes(t)) return 'ต่ำ';

  return text.trim() || 'ปกติ';
}

/* =========================
   DB INIT
========================= */
async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cases (
      id SERIAL PRIMARY KEY,
      case_id VARCHAR(50) UNIQUE NOT NULL,
      full_name VARCHAR(255),
      phone VARCHAR(100),
      province VARCHAR(255),
      help_type VARCHAR(255),
      description TEXT,
      status VARCHAR(100) DEFAULT 'ใหม่',
      priority VARCHAR(100) DEFAULT 'ปกติ',
      assigned_to VARCHAR(255),
      assigned_user_id VARCHAR(100),
      source VARCHAR(100) DEFAULT 'system',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      closed_at TIMESTAMP NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS case_logs (
      id SERIAL PRIMARY KEY,
      case_id VARCHAR(50) NOT NULL,
      action VARCHAR(100) NOT NULL,
      actor_user_id VARCHAR(100),
      actor_name VARCHAR(255),
      note TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_cases_case_id ON cases(case_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_cases_priority ON cases(priority);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_cases_created_at ON cases(created_at);
  `);

  console.log('✅ Database initialized');
}

/* =========================
   CASE FUNCTIONS
========================= */
async function createCase(data = {}) {
  const caseId = await generateCaseId();

  const fullName = data.full_name?.trim() || data.name?.trim() || '';
  const phone = data.phone?.trim() || '';
  const province = data.province?.trim() || '';
  const helpType = data.help_type?.trim() || '';
  const description = data.description?.trim() || '';
  const priority = normalizePriority(data.priority || 'ปกติ');
  const source = data.source?.trim() || 'api';
  const status = normalizeStatus(data.status || (priority === 'ด่วน' ? 'ด่วน' : 'ใหม่'));

  await pool.query(
    `
    INSERT INTO cases
    (case_id, full_name, phone, province, help_type, description, status, priority, source, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())
    `,
    [caseId, fullName, phone, province, helpType, description, status, priority, source]
  );

  await writeCaseLog({
    caseId,
    action: 'create_case',
    note: `สร้างเคสใหม่จาก ${source}`
  });

  return caseId;
}

async function getCaseByCaseId(caseId) {
  const result = await pool.query(
    `SELECT * FROM cases WHERE case_id = $1 LIMIT 1`,
    [caseId]
  );
  return result.rows[0] || null;
}

async function assignCase(caseId, actorUserId, actorName) {
  const existing = await getCaseByCaseId(caseId);
  if (!existing) return { ok: false, message: `ไม่พบเคส ${caseId}` };

  if (existing.status === 'ปิดเคส') {
    return { ok: false, message: `เคส ${caseId} ถูกปิดไปแล้ว` };
  }

  await pool.query(
    `
    UPDATE cases
    SET assigned_to = $1,
        assigned_user_id = $2,
        status = 'กำลังดำเนินการ',
        updated_at = NOW()
    WHERE case_id = $3
    `,
    [actorName || actorUserId, actorUserId, caseId]
  );

  await writeCaseLog({
    caseId,
    action: 'assign_case',
    actorUserId,
    actorName,
    note: 'รับเคส'
  });

  return { ok: true, message: `รับเคส ${caseId} เรียบร้อยแล้ว` };
}

async function closeCase(caseId, actorUserId, actorName) {
  const existing = await getCaseByCaseId(caseId);
  if (!existing) return { ok: false, message: `ไม่พบเคส ${caseId}` };

  if (existing.status === 'ปิดเคส') {
    return { ok: false, message: `เคส ${caseId} ปิดอยู่แล้ว` };
  }

  await pool.query(
    `
    UPDATE cases
    SET status = 'ปิดเคส',
        closed_at = NOW(),
        updated_at = NOW()
    WHERE case_id = $1
    `,
    [caseId]
  );

  await writeCaseLog({
    caseId,
    action: 'close_case',
    actorUserId,
    actorName,
    note: 'ปิดเคส'
  });

  return { ok: true, message: `ปิดเคส ${caseId} เรียบร้อยแล้ว` };
}

async function changeCaseStatus(caseId, newStatus, actorUserId, actorName) {
  const existing = await getCaseByCaseId(caseId);
  if (!existing) return { ok: false, message: `ไม่พบเคส ${caseId}` };

  const status = normalizeStatus(newStatus);
  const closedAt = status === 'ปิดเคส' ? 'NOW()' : 'NULL';

  await pool.query(
    `
    UPDATE cases
    SET status = $1,
        closed_at = ${closedAt},
        updated_at = NOW()
    WHERE case_id = $2
    `,
    [status, caseId]
  );

  await writeCaseLog({
    caseId,
    action: 'change_status',
    actorUserId,
    actorName,
    note: `เปลี่ยนสถานะเป็น ${status}`
  });

  return { ok: true, message: `เปลี่ยนสถานะ ${caseId} เป็น "${status}" เรียบร้อยแล้ว` };
}

function renderCaseDetails(c) {
  return [
    `เลขเคส: ${c.case_id}`,
    `ชื่อ: ${c.full_name || '-'}`,
    `เบอร์: ${c.phone || '-'}`,
    `จังหวัด: ${c.province || '-'}`,
    `ประเภท: ${c.help_type || '-'}`,
    `สถานะ: ${c.status || '-'}`,
    `ความเร่งด่วน: ${c.priority || '-'}`,
    `ผู้รับผิดชอบ: ${c.assigned_to || '-'}`,
    `วันที่สร้าง: ${formatThaiDate(c.created_at)}`,
    `อัปเดตล่าสุด: ${formatThaiDate(c.updated_at)}`,
    '',
    'รายละเอียด:',
    c.description || '-'
  ].join('\n');
}

function renderCaseList(title, rows = []) {
  if (!rows.length) return `${title}\nไม่พบรายการ`;

  const lines = [title];
  rows.forEach((c, idx) => {
    lines.push(
      `${idx + 1}. ${c.case_id} | ${c.help_type || '-'} | ${c.status || '-'} | ${c.priority || '-'}`
    );
  });

  lines.push('');
  lines.push('พิมพ์: ดูเคส CASE-YYYYMMDD-001');
  return lines.join('\n');
}

async function getDailySummaryText() {
  const dateRes = await pool.query(`
    SELECT TO_CHAR((NOW() AT TIME ZONE 'Asia/Bangkok'), 'DD/MM/YYYY') AS thai_date
  `);
  const thaiDate = dateRes.rows[0]?.thai_date || '-';

  const todayNewRes = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM cases
    WHERE DATE(created_at AT TIME ZONE 'Asia/Bangkok') = DATE(NOW() AT TIME ZONE 'Asia/Bangkok')
  `);

  const inProgressRes = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM cases
    WHERE status = 'กำลังดำเนินการ'
  `);

  const closedTodayRes = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM cases
    WHERE status = 'ปิดเคส'
      AND DATE(updated_at AT TIME ZONE 'Asia/Bangkok') = DATE(NOW() AT TIME ZONE 'Asia/Bangkok')
  `);

  const urgentTodayRes = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM cases
    WHERE priority = 'ด่วน'
      AND DATE(created_at AT TIME ZONE 'Asia/Bangkok') = DATE(NOW() AT TIME ZONE 'Asia/Bangkok')
  `);

  const totalRes = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM cases
  `);

  const latestRes = await pool.query(`
    SELECT case_id, help_type, status
    FROM cases
    ORDER BY created_at DESC
    LIMIT 5
  `);

  const lines = [
    '📊 รายงานประจำวัน',
    `วันที่ ${thaiDate}`,
    '',
    `เคสใหม่วันนี้: ${todayNewRes.rows[0]?.count || 0}`,
    `กำลังดำเนินการ: ${inProgressRes.rows[0]?.count || 0}`,
    `ปิดเคสวันนี้: ${closedTodayRes.rows[0]?.count || 0}`,
    `เคสด่วนวันนี้: ${urgentTodayRes.rows[0]?.count || 0}`,
    `เคสสะสมทั้งหมด: ${totalRes.rows[0]?.count || 0}`,
    '',
    '5 เคสล่าสุด'
  ];

  if (!latestRes.rows.length) {
    lines.push('- ยังไม่มีข้อมูล');
  } else {
    latestRes.rows.forEach((r) => {
      lines.push(`- ${r.case_id} | ${r.help_type || '-'} | ${r.status || '-'}`);
    });
  }

  return lines.join('\n');
}

async function sendDailySummaryToGroup() {
  if (!LINE_GROUP_ID) {
    console.log('ℹ️ LINE_GROUP_ID not set, skip daily summary push');
    return;
  }
  const text = await getDailySummaryText();
  await pushText(LINE_GROUP_ID, text);
}

/* =========================
   LINE COMMAND HANDLER
========================= */
async function handleTextMessage(event) {
  const replyToken = event.replyToken;
  const text = (event.message?.text || '').trim();
  const userId = event.source?.userId || '';
  const role = getUserRole(userId);
  const profile = await getLineProfile(userId);
  const displayName = profile?.displayName || 'ทีมงาน';

  // help
  if (['เมนูทีมงาน', 'help', 'ช่วยเหลือทีมงาน'].includes(text.toLowerCase()) || text === 'เมนูทีมงาน') {
    const msg = [
      `สิทธิ์ของคุณ: ${role}`,
      '',
      'คำสั่งที่ใช้ได้:',
      '- ดูเคสใหม่',
      '- ดูเคสด่วน',
      '- ดูเคสวันนี้',
      '- ดูเคส CASE-20260316-001',
      '- รายงานวันนี้',
      '',
      'สำหรับ staff/admin:',
      '- รับเคส CASE-20260316-001',
      '- เปลี่ยนสถานะ CASE-20260316-001 กำลังดำเนินการ',
      '',
      'สำหรับ admin:',
      '- ปิดเคส CASE-20260316-001'
    ].join('\n');

    return replyText(replyToken, msg);
  }

  // ดูเคสใหม่
  if (text === 'ดูเคสใหม่') {
    if (!hasPermission(userId, ['admin', 'staff', 'viewer'])) {
      return replyText(replyToken, 'ขออภัยครับ คำสั่งนี้ใช้ได้เฉพาะทีมงานที่ได้รับสิทธิ์');
    }

    const result = await pool.query(`
      SELECT case_id, help_type, status, priority
      FROM cases
      WHERE status IN ('ใหม่', 'ด่วน')
      ORDER BY created_at DESC
      LIMIT 10
    `);

    return replyText(replyToken, renderCaseList('🆕 เคสใหม่ล่าสุด', result.rows));
  }

  // ดูเคสด่วน
  if (text === 'ดูเคสด่วน') {
    if (!hasPermission(userId, ['admin', 'staff', 'viewer'])) {
      return replyText(replyToken, 'ขออภัยครับ คำสั่งนี้ใช้ได้เฉพาะทีมงานที่ได้รับสิทธิ์');
    }

    const result = await pool.query(`
      SELECT case_id, help_type, status, priority
      FROM cases
      WHERE priority = 'ด่วน' AND status <> 'ปิดเคส'
      ORDER BY created_at DESC
      LIMIT 10
    `);

    return replyText(replyToken, renderCaseList('🚨 เคสด่วน', result.rows));
  }

  // ดูเคสวันนี้
  if (text === 'ดูเคสวันนี้') {
    if (!hasPermission(userId, ['admin', 'staff', 'viewer'])) {
      return replyText(replyToken, 'ขออภัยครับ คำสั่งนี้ใช้ได้เฉพาะทีมงานที่ได้รับสิทธิ์');
    }

    const result = await pool.query(`
      SELECT case_id, help_type, status, priority
      FROM cases
      WHERE DATE(created_at AT TIME ZONE 'Asia/Bangkok') = DATE(NOW() AT TIME ZONE 'Asia/Bangkok')
      ORDER BY created_at DESC
      LIMIT 20
    `);

    return replyText(replyToken, renderCaseList('📅 เคสวันนี้', result.rows));
  }

  // รายงานวันนี้ / สรุปรายวัน
  if (['รายงานวันนี้', 'สรุปรายวัน', 'รายงานเคสวันนี้'].includes(text)) {
    if (!hasPermission(userId, ['admin', 'staff', 'viewer'])) {
      return replyText(replyToken, 'ขออภัยครับ คำสั่งนี้ใช้ได้เฉพาะทีมงานที่ได้รับสิทธิ์');
    }

    const summary = await getDailySummaryText();
    return replyText(replyToken, summary);
  }

  // ดูเคส CASE-...
  if (text.startsWith('ดูเคส ')) {
    if (!hasPermission(userId, ['admin', 'staff', 'viewer'])) {
      return replyText(replyToken, 'ขออภัยครับ คำสั่งนี้ใช้ได้เฉพาะทีมงานที่ได้รับสิทธิ์');
    }

    const caseId = text.replace(/^ดูเคส\s+/i, '').trim();
    const c = await getCaseByCaseId(caseId);

    if (!c) {
      return replyText(replyToken, `ไม่พบเคส ${caseId}`);
    }

    return replyText(replyToken, renderCaseDetails(c));
  }

  // รายละเอียดเคส CASE-...
  if (text.startsWith('รายละเอียดเคส ')) {
    if (!hasPermission(userId, ['admin', 'staff', 'viewer'])) {
      return replyText(replyToken, 'ขออภัยครับ คำสั่งนี้ใช้ได้เฉพาะทีมงานที่ได้รับสิทธิ์');
    }

    const caseId = text.replace(/^รายละเอียดเคส\s+/i, '').trim();
    const c = await getCaseByCaseId(caseId);

    if (!c) {
      return replyText(replyToken, `ไม่พบเคส ${caseId}`);
    }

    return replyText(replyToken, renderCaseDetails(c));
  }

  // รับเคส CASE-...
  if (text.startsWith('รับเคส ')) {
    if (!hasPermission(userId, ['admin', 'staff'])) {
      return replyText(replyToken, 'ขออภัยครับ คำสั่งนี้ใช้ได้เฉพาะ staff / admin');
    }

    const caseId = text.replace(/^รับเคส\s+/i, '').trim();
    const result = await assignCase(caseId, userId, displayName);
    return replyText(replyToken, result.message);
  }

  // ปิดเคส CASE-...
  if (text.startsWith('ปิดเคส ')) {
    if (!hasPermission(userId, ['admin'])) {
      return replyText(replyToken, 'ขออภัยครับ คำสั่งนี้ใช้ได้เฉพาะ admin');
    }

    const caseId = text.replace(/^ปิดเคส\s+/i, '').trim();
    const result = await closeCase(caseId, userId, displayName);
    return replyText(replyToken, result.message);
  }

  // เปลี่ยนสถานะ CASE-... สถานะ...
  if (text.startsWith('เปลี่ยนสถานะ ')) {
    if (!hasPermission(userId, ['admin', 'staff'])) {
      return replyText(replyToken, 'ขออภัยครับ คำสั่งนี้ใช้ได้เฉพาะ staff / admin');
    }

    const match = text.match(/^เปลี่ยนสถานะ\s+(\S+)\s+(.+)$/i);
    if (!match) {
      return replyText(replyToken, 'รูปแบบคำสั่งไม่ถูกต้อง\nตัวอย่าง: เปลี่ยนสถานะ CASE-20260316-001 กำลังดำเนินการ');
    }

    const caseId = match[1].trim();
    const newStatus = match[2].trim();
    const result = await changeCaseStatus(caseId, newStatus, userId, displayName);
    return replyText(replyToken, result.message);
  }

  // ถ้าพิมพ์เลขเคสมาเลย
  if (/^CASE-\d{8}-\d{3}$/i.test(text)) {
    if (!hasPermission(userId, ['admin', 'staff', 'viewer'])) {
      return replyText(replyToken, 'ขออภัยครับ คำสั่งนี้ใช้ได้เฉพาะทีมงานที่ได้รับสิทธิ์');
    }

    const c = await getCaseByCaseId(text.toUpperCase());
    if (!c) return replyText(replyToken, `ไม่พบเคส ${text}`);
    return replyText(replyToken, renderCaseDetails(c));
  }

  return replyText(
    replyToken,
    'รับข้อความแล้วครับ\nพิมพ์ "เมนูทีมงาน" เพื่อดูคำสั่งที่รองรับ'
  );
}

/* =========================
   LINE WEBHOOK
========================= */
app.post('/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-line-signature'];
    const rawBody = req.body;

    if (!verifyLineSignature(rawBody, signature)) {
      return res.status(401).send('Invalid signature');
    }

    const bodyText = rawBody.toString('utf8');
    const body = JSON.parse(bodyText);

    res.status(200).send('OK');

    for (const event of body.events || []) {
      try {
        if (event.type === 'message' && event.message?.type === 'text') {
          await handleTextMessage(event);
        }
      } catch (err) {
        console.error('Event handling error:', err);
      }
    }
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).send('Webhook error');
  }
});

/* =========================
   PUBLIC API: CREATE CASE
========================= */
app.post('/api/cases', async (req, res) => {
  try {
    const {
      full_name,
      phone,
      province,
      help_type,
      description,
      priority,
      source
    } = req.body || {};

    if (!full_name && !phone && !description) {
      return res.status(400).json({
        ok: false,
        message: 'กรุณาส่งข้อมูลอย่างน้อย full_name หรือ phone หรือ description'
      });
    }

    const caseId = await createCase({
      full_name,
      phone,
      province,
      help_type,
      description,
      priority,
      source: source || 'web_form'
    });

    return res.json({
      ok: true,
      case_id: caseId,
      message: 'สร้างเคสเรียบร้อย'
    });
  } catch (err) {
    console.error('/api/cases error:', err);
    return res.status(500).json({
      ok: false,
      message: 'สร้างเคสไม่สำเร็จ'
    });
  }
});

/* =========================
   DASHBOARD API (พื้นฐาน)
========================= */
app.get('/api/dashboard/summary', async (req, res) => {
  try {
    const todayNewRes = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM cases
      WHERE DATE(created_at AT TIME ZONE 'Asia/Bangkok') = DATE(NOW() AT TIME ZONE 'Asia/Bangkok')
    `);

    const inProgressRes = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM cases
      WHERE status = 'กำลังดำเนินการ'
    `);

    const urgentOpenRes = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM cases
      WHERE priority = 'ด่วน' AND status <> 'ปิดเคส'
    `);

    const closedThisMonthRes = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM cases
      WHERE status = 'ปิดเคส'
        AND DATE_TRUNC('month', updated_at AT TIME ZONE 'Asia/Bangkok')
            = DATE_TRUNC('month', NOW() AT TIME ZONE 'Asia/Bangkok')
    `);

    res.json({
      ok: true,
      today_new: todayNewRes.rows[0]?.count || 0,
      in_progress: inProgressRes.rows[0]?.count || 0,
      urgent_open: urgentOpenRes.rows[0]?.count || 0,
      closed_this_month: closedThisMonthRes.rows[0]?.count || 0
    });
  } catch (err) {
    console.error('/api/dashboard/summary error:', err);
    res.status(500).json({ ok: false, message: 'โหลด summary ไม่สำเร็จ' });
  }
});

app.get('/api/dashboard/recent-cases', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT case_id, full_name, phone, province, help_type, status, priority, assigned_to, created_at
      FROM cases
      ORDER BY created_at DESC
      LIMIT 20
    `);

    res.json({ ok: true, items: result.rows });
  } catch (err) {
    console.error('/api/dashboard/recent-cases error:', err);
    res.status(500).json({ ok: false, message: 'โหลด recent cases ไม่สำเร็จ' });
  }
});

app.get('/api/dashboard/daily-chart', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        TO_CHAR((created_at AT TIME ZONE 'Asia/Bangkok')::date, 'YYYY-MM-DD') AS day,
        COUNT(*)::int AS total
      FROM cases
      WHERE (created_at AT TIME ZONE 'Asia/Bangkok')::date >= ((NOW() AT TIME ZONE 'Asia/Bangkok')::date - INTERVAL '6 days')
      GROUP BY 1
      ORDER BY 1 ASC
    `);

    res.json({ ok: true, items: result.rows });
  } catch (err) {
    console.error('/api/dashboard/daily-chart error:', err);
    res.status(500).json({ ok: false, message: 'โหลด daily chart ไม่สำเร็จ' });
  }
});

app.get('/api/dashboard/type-chart', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT help_type, COUNT(*)::int AS total
      FROM cases
      GROUP BY help_type
      ORDER BY total DESC
      LIMIT 10
    `);

    res.json({ ok: true, items: result.rows });
  } catch (err) {
    console.error('/api/dashboard/type-chart error:', err);
    res.status(500).json({ ok: false, message: 'โหลด type chart ไม่สำเร็จ' });
  }
});

/* =========================
   HEALTH / HOME
========================= */
app.get('/', (req, res) => {
  res.send(`
    <h2>Foundation Case System Running</h2>
    <p>Webhook: <code>/webhook</code></p>
    <p>Create case API: <code>POST /api/cases</code></p>
    <p>Dashboard summary: <code>/api/dashboard/summary</code></p>
  `);
});

app.get('/health', async (req, res) => {
  try {
    const db = await pool.query('SELECT NOW()');
    return res.json({
      ok: true,
      app: 'running',
      db_time: db.rows[0]?.now || null
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      message: err.message
    });
  }
});

/* =========================
   DAILY SUMMARY CRON
========================= */
// ส่งทุกวัน 18:00 เวลาไทย
cron.schedule(
  '0 18 * * *',
  async () => {
    try {
      console.log('⏰ Running daily summary cron...');
      await sendDailySummaryToGroup();
    } catch (err) {
      console.error('daily summary cron error:', err.message);
    }
  },
  { timezone: 'Asia/Bangkok' }
);

/* =========================
   START
========================= */
(async () => {
  try {
    await initDatabase();
    app.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
      console.log(`✅ BASE_URL: ${BASE_URL || '(not set)'}`);
    });
  } catch (err) {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
  }
})();