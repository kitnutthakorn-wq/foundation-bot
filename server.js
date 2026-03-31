// PRODUCTION LOCKED BASELINE
require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const { createClient } = require("@supabase/supabase-js");

const upload = multer({ storage: multer.memoryStorage() });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const userStates = {};
const caseFollowupTracker = {};
const fetch = globalThis.fetch;

const app = express();
const PORT = process.env.PORT || 3000;



const PUBLIC_WEB_ORIGINS = [
  process.env.APP_ORIGIN,
  process.env.PUBLIC_SITE_URL,
  process.env.NETLIFY_SITE_URL,
  process.env.URL
].filter(Boolean);

function resolvePublicOrigin(req) {
  const requestOrigin = String(req.headers.origin || "").trim();
  if (!requestOrigin) {
    return PUBLIC_WEB_ORIGINS[0] || "*";
  }
  if (!PUBLIC_WEB_ORIGINS.length || PUBLIC_WEB_ORIGINS.includes(requestOrigin)) {
    return requestOrigin;
  }
  return PUBLIC_WEB_ORIGINS[0] || "*";
}

function applyPublicCors(req, res) {
  const allowOrigin = resolvePublicOrigin(req);
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Cache-Control, Last-Event-ID, Accept"
  );
}


const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.CHANNEL_SECRET || "";
const SUPABASE_URL = process.env.SUPABASE_URL;


const TEAM_GROUP_ID = process.env.TEAM_GROUP_ID || "";
const LINE_GROUP_ID = process.env.LINE_GROUP_ID || "";
const EFFECTIVE_TEAM_GROUP_ID = TEAM_GROUP_ID || LINE_GROUP_ID;

/* =========================
   TEAM GROUP GUARD (SAFE PATCH)
========================= */
const TEAM_GROUP_ENABLED = true;
const ALLOWED_TEAM_GROUP_ID = EFFECTIVE_TEAM_GROUP_ID;
const TEAM_COMMANDS = [
  "เมนูทีมงาน",
  "เปิดเมนูทีมงาน",
  "รีเฟรชเมนูทีมงาน",
  "ดูเคสใหม่",
  "เคสใหม่",
  "ดูเคสด่วน",
  "เคสด่วน",
  "เคสวันนี้",
  "ค้นหาเคส",
  "รับเคส",
  "ปิดเคส",
  "เปลี่ยนสถานะ",
  "อัปเดตเคส"
];

const CASE_UPDATE_STAGES = [
  "รับมอบหมายแล้ว",
  "นัดหมายลงพื้นที่แล้ว",
  "ลงพื้นที่แล้ว",
  "อยู่ระหว่างตรวจสอบข้อมูล",
  "รอเอกสาร/ข้อมูลเพิ่มเติม",
  "ส่งผลสำรวจแล้ว",
  "ส่งเข้าพิจารณาแล้ว"
];

const CASE_UPDATE_PROGRESS_MAP = {
  "รับมอบหมายแล้ว": 10,
  "นัดหมายลงพื้นที่แล้ว": 25,
  "ลงพื้นที่แล้ว": 50,
  "อยู่ระหว่างตรวจสอบข้อมูล": 70,
  "รอเอกสาร/ข้อมูลเพิ่มเติม": 80,
  "ส่งผลสำรวจแล้ว": 95,
  "ส่งเข้าพิจารณาแล้ว": 100
};

const CASE_UPDATE_WAITING_FOR_MAP = {
  "รับมอบหมายแล้ว": "รอการนัดหมายลงพื้นที่",
  "นัดหมายลงพื้นที่แล้ว": "รอวันลงพื้นที่",
  "ลงพื้นที่แล้ว": "รอตรวจสอบข้อมูลเพิ่มเติม",
  "อยู่ระหว่างตรวจสอบข้อมูล": "รอสรุปผลสำรวจ",
  "รอเอกสาร/ข้อมูลเพิ่มเติม": "รอเอกสารจากผู้ร้อง",
  "ส่งผลสำรวจแล้ว": "รอผู้บริหารพิจารณา",
  "ส่งเข้าพิจารณาแล้ว": "รอผลการตัดสินใจ"
};

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const LINE_OA_ID = process.env.LINE_OA_ID || process.env.LINE_OFFICIAL_ACCOUNT_ID || "";

/* =========================
   ACCESS CONTROL
========================= */
function parseIds(str) {
  return (str || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const ADMIN_IDS = parseIds(process.env.ADMIN_USER_IDS);
const STAFF_IDS = parseIds(process.env.STAFF_USER_IDS);
const VIEWER_IDS = parseIds(process.env.VIEWER_USER_IDS);

const roleCache = new Map();
const ROLE_CACHE_TTL = 5 * 60 * 1000; // 5 นาที

/* =========================
   SAFE PATCH: LINE RECOVERY
========================= */
const LINE_SAFE_PATCH = {
  EVENT_DEDUPE_ENABLED: true,
  EVENT_DEDUPE_TTL_MS: 5 * 60 * 1000,
};
const processedEventCache = new Map();

function buildEventDedupKey(event = {}) {
  return [
    event?.source?.type || "unknown",
    event?.source?.userId || event?.source?.groupId || event?.source?.roomId || "unknown",
    event?.type || "unknown",
    event?.message?.id || "no_message_id",
    event?.timestamp || Date.now(),
  ].join(":");
}

function hasProcessedEvent(eventKey = "") {
  if (!eventKey) return false;
  const found = processedEventCache.get(eventKey);
  if (!found) return false;
  return Date.now() - found.ts < LINE_SAFE_PATCH.EVENT_DEDUPE_TTL_MS;
}

function markEventProcessed(eventKey = "") {
  if (!eventKey) return;
  processedEventCache.set(eventKey, { ts: Date.now() });
}

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of processedEventCache.entries()) {
    if (!value || now - value.ts > LINE_SAFE_PATCH.EVENT_DEDUPE_TTL_MS) {
      processedEventCache.delete(key);
    }
  }
}, 60 * 1000);


async function getUserRole(userId) {
  try {
    if (!userId) return "guest";

    const cached = roleCache.get(userId);
    if (cached && Date.now() - cached.ts < ROLE_CACHE_TTL) {
      return cached.role;
    }

    // fallback จาก env เดิม
    if (ADMIN_IDS.includes(userId)) {
      roleCache.set(userId, { role: "admin", ts: Date.now() });
      return "admin";
    }
    if (STAFF_IDS.includes(userId)) {
      roleCache.set(userId, { role: "staff", ts: Date.now() });
      return "staff";
    }
    if (VIEWER_IDS.includes(userId)) {
      roleCache.set(userId, { role: "viewer", ts: Date.now() });
      return "viewer";
    }

   const { data, error } = await supabase
  .from("line_user_roles")
  .select("role, is_active")
  .eq("line_user_id", userId)
  .maybeSingle();

if (error) {
  console.error("GET ROLE ERROR:", error);
  return "guest";
}

if (!data || data.is_active === false) {
  roleCache.set(userId, { role: "guest", ts: Date.now() });
  return "guest";
}

const role = data.role || "guest";
roleCache.set(userId, { role, ts: Date.now() });
return role;
  } catch (err) {
    console.error("GET ROLE CATCH:", err);
    return "guest";
  }
}

async function isStaff(userId) {
  const role = await getUserRole(userId);
  return role === "admin" || role === "staff";
}

async function isViewer(userId) {
  const role = await getUserRole(userId);
  return role === "admin" || role === "staff" || role === "viewer";
}

function isGroupEvent(event) {
  return event?.source?.type === "group";
}

function isAllowedTeamGroup(event) {
  if (!ALLOWED_TEAM_GROUP_ID) return false;
  return event?.source?.groupId === ALLOWED_TEAM_GROUP_ID;
}

function isTeamCommandText(text = "") {
  const normalized = String(text || "").trim();
  if (!normalized) return false;
  return TEAM_COMMANDS.some((cmd) => normalized === cmd || normalized.startsWith(`${cmd} `));
}

async function guardTeamCommand({ event, userId, text, role = null }) {
  if (!TEAM_GROUP_ENABLED) return { pass: true };

  if (!isGroupEvent(event)) {
    return { pass: true };
  }

  if (!isTeamCommandText(text)) {
    return { pass: true };
  }

  if (!isAllowedTeamGroup(event)) {
    return { pass: false, reason: "not_allowed_group" };
  }

  const effectiveRole = role || (await getUserRole(userId));
  if (!["admin", "staff", "viewer"].includes(effectiveRole)) {
    return { pass: false, reason: "no_permission" };
  }

  return { pass: true, role: effectiveRole };
}

async function replyGuardError(replyToken, reason) {
  let text = "คุณไม่มีสิทธิ์ใช้งานคำสั่งนี้";

  if (reason === "not_allowed_group") {
    text = "คำสั่งนี้ใช้ได้เฉพาะในกลุ่มทีมงานที่ได้รับอนุญาตเท่านั้น";
  } else if (reason === "no_permission") {
    text = "คุณยังไม่มีสิทธิ์ใช้งานคำสั่งทีมงาน\nกรุณาติดต่อผู้ดูแลระบบ";
  }

  await safeReply(replyToken, [{ type: "text", text }]);
}

async function setLineUserRole(lineUserId, role) {
  const allowedRoles = ["admin", "staff", "viewer", "guest"];
  if (!lineUserId) throw new Error("line_user_id is required");
  if (!allowedRoles.includes(role)) throw new Error("Invalid role");

  const { data, error } = await supabase
    .from("line_user_roles")
    .upsert({ line_user_id: lineUserId, role }, { onConflict: "line_user_id" })
    .select()
    .single();

  if (error) throw error;

  roleCache.set(lineUserId, { role, ts: Date.now() });
  return data;
}
async function isAdmin(userId) {
  const role = await getUserRole(userId);
  return role === "admin";
}

function parseAddTeamCommand(text = "") {
  const normalized = String(text || "").trim();
  const match = normalized.match(/^เพิ่มทีม\s+(U[a-zA-Z0-9]+)\s+(admin|staff|viewer)$/);
  if (!match) return null;

  return {
    targetUserId: match[1],
    role: match[2],
  };
}

function parseRemoveTeamCommand(text = "") {
  const normalized = String(text || "").trim();
  const match = normalized.match(/^ลบทีม\s+(U[a-zA-Z0-9]+)$/);
  if (!match) return null;

  return {
    targetUserId: match[1],
  };
}

async function countActiveAdmins() {
  const { count, error } = await supabase
    .from("line_user_roles")
    .select("*", { count: "exact", head: true })
    .eq("role", "admin")
    .eq("is_active", true);

  if (error) {
    console.error("COUNT ACTIVE ADMINS ERROR:", error);
    return 0;
  }

  return count || 0;
}

async function softDisableLineUserRole(lineUserId) {
  const { data, error } = await supabase
    .from("line_user_roles")
    .update({ is_active: false })
    .eq("line_user_id", lineUserId)
    .select()
    .single();

  if (error) throw error;

  roleCache.delete(lineUserId);
  return data;
}

function getCaseUpdateState(userId) {
  return userStates[userId]?.caseUpdate || null;
}

function setCaseUpdateState(userId, payload) {
  userStates[userId] = userStates[userId] || {};
  userStates[userId].caseUpdate = payload;
}

function clearCaseUpdateState(userId) {
  if (userStates[userId]?.caseUpdate) {
    delete userStates[userId].caseUpdate;
  }
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function toNullableText(value) {
  const s = cleanText(value);
  return s || null;
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toImageArray(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.map((item) => String(item || "").trim()).filter(Boolean);
  }
  if (typeof input === "string") {
    const raw = input.trim();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item || "").trim()).filter(Boolean);
      }
    } catch (_) {}
    return raw.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function normalizeCaseUpdateRecord(row = {}) {
  return {
    ...row,
    status: row.status || row.status_after || null,
    note: row.note || row.latest_note || row.message || null,
    images: Array.isArray(row.images) ? row.images : toImageArray(row.images),
  };
}

async function getHelpRequestByIdOrCode(caseIdOrCode = "") {
  const lookup = String(caseIdOrCode || "").trim();
  if (!lookup) return null;

  const { data, error } = await supabase
    .from("help_requests")
    .select("*")
    .or(`id.eq.${lookup},case_code.eq.${lookup}`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getHelpRequestByCaseCode(caseCode = "") {
  const lookup = cleanText(caseCode);
  if (!lookup) return null;

  const { data, error } = await supabase
    .from("help_requests")
    .select("*")
    .eq("case_code", lookup)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function insertCaseUpdateLog(payload = {}) {
  const row = {
    case_id: payload.case_id || null,
    case_code: toNullableText(payload.case_code),
    status: toNullableText(payload.status),
    status_after: toNullableText(payload.status_after || payload.status),
    current_step: toNullableText(payload.current_step),
    waiting_for: toNullableText(payload.waiting_for),
    progress_percent: toNumberOrNull(payload.progress_percent),
    note: toNullableText(payload.note),
    latest_note: toNullableText(payload.latest_note || payload.note || payload.message),
    message: toNullableText(payload.message),
    updated_by: toNullableText(payload.updated_by),
    updated_by_user_id: toNullableText(payload.updated_by_user_id),
    updated_by_role: toNullableText(payload.updated_by_role),
    updater_name: toNullableText(payload.updater_name),
    updater_user_id: toNullableText(payload.updater_user_id),
    location_text: toNullableText(payload.location_text),
    latitude: toNumberOrNull(payload.latitude),
    longitude: toNumberOrNull(payload.longitude),
    images: toImageArray(payload.images),
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from("case_updates")
    .insert([row])
    .select()
    .single();

  if (error) throw error;
  return normalizeCaseUpdateRecord(data || row);
}

async function upsertCaseUpdateLegacy({
  caseCode,
  updateStage,
  detail,
  updatedBy
}) {
  const progressPercent = CASE_UPDATE_PROGRESS_MAP[updateStage] || 0;
  const waitingFor = CASE_UPDATE_WAITING_FOR_MAP[updateStage] || "รอการอัปเดต";
  const helpRequest = await getHelpRequestByCaseCode(caseCode);

  const inserted = await insertCaseUpdateLog({
    case_id: helpRequest?.id || null,
    case_code: caseCode,
    status: helpRequest?.status || "in_progress",
    current_step: updateStage,
    waiting_for: waitingFor,
    progress_percent: progressPercent,
    note: detail,
    latest_note: detail,
    message: detail,
    updated_by: updatedBy,
    updated_by_user_id: updatedBy,
    updater_name: updatedBy
  });

  const syncPatch = {
    last_action_at: inserted.updated_at || new Date().toISOString(),
    latest_note: inserted.latest_note || detail || null,
    last_action_by: inserted.updater_name || inserted.updated_by || updatedBy || null
  };

  const { error: syncError } = await supabase
    .from("help_requests")
    .update(syncPatch)
    .eq("case_code", cleanText(caseCode));

  if (syncError) {
    console.error("LEGACY CASE UPDATE SYNC ERROR:", syncError);
  }

  return inserted;
}

function buildCaseUpdateStageQuickReply() {
  return {
    items: CASE_UPDATE_STAGES.map((stage) => ({
      type: "action",
      action: {
        type: "message",
        label: stage.length > 20 ? stage.slice(0, 20) : stage,
        text: stage
      }
    }))
  };
}

function checkDashboardAuth(req, res, next) {
  const auth = req.headers.authorization || "";

  if (!auth.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Dashboard"');
    return res.status(401).send("Authentication required");
  }

  const base64 = auth.split(" ")[1];
  const decoded = Buffer.from(base64, "base64").toString("utf8");
  const [username, password] = decoded.split(":");

  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Dashboard"');
    return res.status(401).send("Invalid credentials");
  }

  next();
}


function formatCaseStatusThai(status = "") {
  switch (String(status).toLowerCase()) {
    case "new":
      return "รับเรื่องแล้ว";
    case "in_progress":
      return "กำลังดำเนินการ";
    case "done":
      return "เสร็จสิ้นแล้ว";
    case "cancelled":
      return "ยกเลิก";
    default:
      return status || "-";
  }
}

function formatPriorityThai(priority = "") {
  switch (String(priority).toLowerCase()) {
    case "urgent":
      return "ด่วน";
    case "high":
      return "สูง";
    case "normal":
      return "ปกติ";
    case "low":
      return "ต่ำ";
    default:
      return priority || "-";
  }
}

function getStatusColor(status = "") {
  switch (String(status).toLowerCase()) {
    case "new":
      return "#2563EB";
    case "in_progress":
      return "#D97706";
    case "done":
      return "#16A34A";
    case "cancelled":
      return "#DC2626";
    default:
      return "#6B7280";
  }
}

function getPriorityColor(priority = "") {
  switch (String(priority).toLowerCase()) {
    case "urgent":
      return "#DC2626";
    case "high":
      return "#EA580C";
    case "normal":
      return "#2563EB";
    case "low":
      return "#6B7280";
    default:
      return "#6B7280";
  }
}

function formatThaiDateTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("th-TH", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildCaseTrackingFlex(item = {}) {
  const statusText = formatCaseStatusThai(item.status);
  const priorityText = formatPriorityThai(item.priority);
  const progressText = `${item.progress_percent ?? 0}%`;
  const currentStepText = item.current_step || "รอทีมงานรับเรื่อง";
  const waitingForText = item.waiting_for || "รอการอัปเดต";
  const updatedAtText = formatThaiDateTime(
    item.last_action_at ||
    item.closed_at ||
    item.assigned_at ||
    item.created_at
  );

  return {
    type: "flex",
    altText: `ติดตามเคส ${item.case_code || "-"}`,
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#0b7c86",
        paddingAll: "18px",
        contents: [
          {
            type: "text",
            text: "สถานะเคส",
            color: "#ffffff",
            weight: "bold",
            size: "lg",
            align: "center",
          },
          {
            type: "text",
            text: item.case_code || "-",
            color: "#d9f3f5",
            size: "sm",
            margin: "sm",
            align: "center",
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        paddingAll: "20px",
        contents: [
          {
            type: "text",
            text: `ชื่อ: ${item.full_name || "-"}`,
            wrap: true,
            align: "center",
          },
          {
            type: "text",
            text: `พื้นที่: ${item.location || "-"}`,
            wrap: true,
            align: "center",
          },
          {
            type: "box",
            layout: "horizontal",
            spacing: "sm",
            contents: [
              {
                type: "box",
                layout: "vertical",
                backgroundColor: "#F3F4F6",
                cornerRadius: "10px",
                paddingAll: "10px",
                flex: 1,
                contents: [
                  {
                    type: "text",
                    text: "สถานะ",
                    size: "xs",
                    color: "#6B7280",
                    align: "center",
                  },
                  {
                    type: "text",
                    text: statusText,
                    color: getStatusColor(item.status),
                    weight: "bold",
                    size: "sm",
                    align: "center",
                    wrap: true,
                  },
                ],
              },
              {
                type: "box",
                layout: "vertical",
                backgroundColor: "#F3F4F6",
                cornerRadius: "10px",
                paddingAll: "10px",
                flex: 1,
                contents: [
                  {
                    type: "text",
                    text: "ระดับ",
                    size: "xs",
                    color: "#6B7280",
                    align: "center",
                  },
                  {
                    type: "text",
                    text: priorityText,
                    color: getPriorityColor(item.priority),
                    weight: "bold",
                    size: "sm",
                    align: "center",
                    wrap: true,
                  },
                ],
              },
            ],
          },
          {
            type: "box",
            layout: "vertical",
            backgroundColor: "#EFF6FF",
            cornerRadius: "12px",
            paddingAll: "12px",
            contents: [
              {
                type: "text",
                text: "ความคืบหน้า",
                size: "xs",
                color: "#6B7280",
                align: "center",
              },
              {
                type: "text",
                text: progressText,
                size: "xl",
                weight: "bold",
                color: "#1D4ED8",
                align: "center",
                margin: "sm",
              },
            ],
          },
          {
            type: "separator",
            margin: "sm",
          },
          {
            type: "text",
            text: `ขั้นตอนล่าสุด: ${currentStepText}`,
            wrap: true,
            size: "sm",
          },
          {
            type: "text",
            text: `ขณะนี้กำลังรอ: ${waitingForText}`,
            wrap: true,
            size: "sm",
          },
          {
            type: "text",
            text: `ผู้รับเคส: ${item.assigned_to || "ยังไม่มีผู้รับผิดชอบ"}`,
            wrap: true,
            size: "sm",
          },
          {
            type: "separator",
            margin: "sm",
          },
          {
            type: "text",
            text: `อัปเดตล่าสุด: ${updatedAtText}`,
            size: "xs",
            color: "#666666",
            wrap: true,
            align: "center",
          }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        paddingAll: "20px",
        contents: [
          {
            type: "button",
            style: "primary",
            height: "md",
            color: "#0b7c86",
            action: {
              type: "message",
              label: "ติดตามอีกครั้ง",
              text: `ติดตามอีกครั้ง ${item.case_code || "-"}`,
            },
          },
          {
            type: "button",
            style: "secondary",
            height: "md",
            action: {
              type: "message",
              label: "ติดต่อเจ้าหน้าที่",
              text: "ติดต่อเจ้าหน้าที่",
            },
          },
        ]
      }
    }
  };
}
function getPriorityHeaderColor(priority = "") {
  return String(priority).toLowerCase() === "urgent" ? "#DC2626" : "#0b7c86";
}

function getStatusBadgeColor(status = "") {
  switch (String(status).toLowerCase()) {
    case "new":
      return "#DBEAFE";
    case "in_progress":
      return "#FEF3C7";
    case "done":
      return "#DCFCE7";
    case "cancelled":
      return "#E5E7EB";
    default:
      return "#E5E7EB";
  }
}

function buildTeamFollowupFlex(item = {}, followupCount = 1) {
  const statusText = formatCaseStatusThai(item.status);
  const priorityText = formatPriorityThai(item.priority);
  const headerColor = getPriorityHeaderColor(item.priority);

  return {
    type: "flex",
    altText: `มีการติดตามเคสอีกครั้ง ${item.case_code || ""}`,
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: headerColor,
        paddingAll: "16px",
        contents: [
          {
            type: "text",
            text: "มีการติดตามเคสอีกครั้ง",
            color: "#ffffff",
            weight: "bold",
            size: "lg",
            wrap: true,
          },
          {
            type: "text",
            text: `เลขเคส: ${item.case_code || "-"}`,
            color: "#F9FAFB",
            size: "sm",
            margin: "sm",
            wrap: true,
          },
        ],
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        paddingAll: "16px",
        contents: [
          {
            type: "box",
            layout: "horizontal",
            spacing: "sm",
            contents: [
              {
                type: "box",
                layout: "vertical",
                backgroundColor: getStatusBadgeColor(item.status),
                cornerRadius: "10px",
                paddingAll: "8px",
                flex: 1,
                contents: [
                  { type: "text", text: "สถานะ", size: "xs", color: "#6B7280", align: "center" },
                  { type: "text", text: statusText, size: "sm", weight: "bold", color: getStatusColor(item.status), align: "center", wrap: true },
                ],
              },
              {
                type: "box",
                layout: "vertical",
                backgroundColor: "#F3F4F6",
                cornerRadius: "10px",
                paddingAll: "8px",
                flex: 1,
                contents: [
                  { type: "text", text: "ระดับ", size: "xs", color: "#6B7280", align: "center" },
                  { type: "text", text: priorityText, size: "sm", weight: "bold", color: getPriorityColor(item.priority), align: "center", wrap: true },
                ],
              },
            ],
          },
          { type: "text", text: `ชื่อ: ${item.full_name || "-"}`, wrap: true, size: "sm" },
          { type: "text", text: `พื้นที่: ${item.location || "-"}`, wrap: true, size: "sm" },
          { type: "text", text: `ผู้รับเคส: ${item.assigned_to || "ยังไม่มีผู้รับผิดชอบ"}`, wrap: true, size: "sm" },
          { type: "text", text: `ติดตามซ้ำครั้งที่ ${followupCount}`, wrap: true, size: "sm", weight: "bold", color: "#111827" },
          {
            type: "box",
            layout: "vertical",
            backgroundColor: "#FFF7ED",
            cornerRadius: "10px",
            paddingAll: "10px",
            contents: [
              {
                type: "text",
                text: "กรุณาตรวจสอบเคสนี้อีกครั้ง",
                size: "sm",
                weight: "bold",
                color: "#9A3412",
                wrap: true,
              }
            ],
          },
        ],
      },
    },
  };
}


function buildTeamNewCaseFlex(item = {}) {
  const statusText = formatCaseStatusThai(item.status);
  const priorityText = formatPriorityThai(item.priority);
  const headerColor = getPriorityHeaderColor(item.priority);

  return {
    type: "flex",
    altText: `มีเคสใหม่เข้าระบบ ${item.case_code || ""}`,
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: headerColor,
        paddingAll: "16px",
        contents: [
          {
            type: "text",
            text: "มีเคสใหม่เข้าระบบ",
            color: "#ffffff",
            weight: "bold",
            size: "lg",
            wrap: true,
          },
          {
            type: "text",
            text: `เลขเคส: ${item.case_code || "-"}`,
            color: "#F9FAFB",
            size: "sm",
            margin: "sm",
            wrap: true,
          },
        ],
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        paddingAll: "16px",
        contents: [
          {
            type: "box",
            layout: "horizontal",
            spacing: "sm",
            contents: [
              {
                type: "box",
                layout: "vertical",
                backgroundColor: getStatusBadgeColor(item.status),
                cornerRadius: "10px",
                paddingAll: "8px",
                flex: 1,
                contents: [
                  { type: "text", text: "สถานะ", size: "xs", color: "#6B7280", align: "center" },
                  { type: "text", text: statusText, size: "sm", weight: "bold", color: getStatusColor(item.status), align: "center", wrap: true },
                ],
              },
              {
                type: "box",
                layout: "vertical",
                backgroundColor: "#F3F4F6",
                cornerRadius: "10px",
                paddingAll: "8px",
                flex: 1,
                contents: [
                  { type: "text", text: "ระดับ", size: "xs", color: "#6B7280", align: "center" },
                  { type: "text", text: priorityText, size: "sm", weight: "bold", color: getPriorityColor(item.priority), align: "center", wrap: true },
                ],
              },
            ],
          },
          { type: "text", text: `ชื่อ: ${item.full_name || "-"}`, wrap: true, size: "sm" },
          { type: "text", text: `โทร: ${item.phone || "-"}`, wrap: true, size: "sm" },
          { type: "text", text: `พื้นที่: ${item.location || "-"}`, wrap: true, size: "sm" },
          { type: "text", text: `รายละเอียด: ${item.problem || "-"}`, wrap: true, size: "sm" },
        ],
      },
    },
  };
}

function getTeamLiffUrl(baseView = "") {
  let raw = null;

  if (process.env.TEAM_LIFF_URL) {
    raw = String(process.env.TEAM_LIFF_URL).trim();
  } else if (process.env.TEAM_LIFF_ID) {
    raw = `https://liff.line.me/${String(process.env.TEAM_LIFF_ID).trim()}`;
  }

  if (!raw) {
    throw new Error("❌ TEAM_LIFF_URL / TEAM_LIFF_ID not set");
  }

  if (!baseView) return raw;

  return raw.includes("?")
    ? `${raw}&view=${encodeURIComponent(baseView)}`
    : `${raw}?view=${encodeURIComponent(baseView)}`;
}

function buildTeamMenuFlex() {
  function menuCard(title, subtitle, accentColor, softBg, action) {
    return {
      type: "box",
      layout: "vertical",
      margin: "none",
      backgroundColor: softBg,
      borderColor: accentColor,
      borderWidth: "2px",
      cornerRadius: "18px",
      paddingAll: "14px",
      action,
      contents: [
        {
          type: "box",
          layout: "horizontal",
          justifyContent: "space-between",
          alignItems: "center",
          contents: [
            {
              type: "text",
              text: title,
              weight: "bold",
              size: "lg",
              color: accentColor,
              flex: 1,
              wrap: true
            },
            {
              type: "box",
              layout: "vertical",
              width: "18px",
              height: "18px",
              cornerRadius: "999px",
              backgroundColor: accentColor,
              contents: []
            }
          ]
        },
        {
          type: "text",
          text: subtitle,
          size: "sm",
          color: "#5F7285",
          wrap: true,
          margin: "sm"
        },
        {
          type: "box",
          layout: "horizontal",
          margin: "md",
          spacing: "6px",
          contents: [
            {
              type: "box",
              layout: "vertical",
              width: "36px",
              height: "5px",
              cornerRadius: "999px",
              backgroundColor: accentColor,
              contents: []
            },
            {
              type: "box",
              layout: "vertical",
              width: "14px",
              height: "5px",
              cornerRadius: "999px",
              backgroundColor: "#B9D4D9",
              contents: []
            },
            {
              type: "box",
              layout: "vertical",
              width: "10px",
              height: "5px",
              cornerRadius: "999px",
              backgroundColor: "#D7E7EA",
              contents: []
            }
          ]
        }
      ]
    };
  }

  return {
    type: "flex",
    altText: "เมนูทีมงาน | ศูนย์ปฏิบัติการ",
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#EAF3F5",
        cornerRadius: "24px",
        paddingAll: "16px",
        spacing: "14px",
        contents: [
          {
            type: "box",
            layout: "vertical",
            backgroundColor: "#0B7C86",
            borderColor: "#1F8F4D",
            borderWidth: "3px",
            cornerRadius: "20px",
            paddingAll: "16px",
            alignItems: "center",
            contents: [
              {
                type: "text",
                text: "เมนูทีมงาน",
                color: "#FFFFFF",
                weight: "bold",
                size: "xl",
                align: "center"
              },
              {
                type: "text",
                text: "ศูนย์ปฏิบัติการรายการเคส",
                color: "#DDF7FA",
                size: "sm",
                align: "center",
                margin: "sm"
              }
            ]
          },
          {
            type: "box",
            layout: "vertical",
            backgroundColor: "#F7FBFC",
            borderColor: "#CFE1E6",
            borderWidth: "1px",
            cornerRadius: "20px",
            paddingAll: "14px",
            spacing: "10px",
            contents: [
              menuCard(
                "ดูเคสใหม่",
                "รายการเคสที่เพิ่งเข้าระบบล่าสุด",
                "#0B7C86",
                "#E9F8FA",
                {
                  type: "uri",
                  label: "ดูเคสใหม่",
                  uri: getTeamLiffUrl("new")
                }
              ),
              menuCard(
                "เคสด่วน",
                "ตรวจสอบเคสเร่งด่วนที่ต้องรีบดำเนินการ",
                "#C56608",
                "#FFF7ED",
                {
                  type: "uri",
                  label: "เคสด่วน",
                  uri: getTeamLiffUrl("urgent")
                }
              ),
              menuCard(
                "ค้นหาเคส",
                "ค้นหาด้วยเลขเคสหรือเบอร์โทร",
                "#163C72",
                "#F8FAFC",
                {
                  type: "uri",
                  label: "ค้นหาเคส",
                  uri: getTeamLiffUrl("search")
                }
              ),
              menuCard(
                "เคสวันนี้",
                "สรุปรายการเคสที่เข้ามาในวันนี้",
                "#1F8F4D",
                "#F0FDF4",
                {
                  type: "uri",
                  label: "เคสวันนี้",
                  uri: getTeamLiffUrl("today")
                }
              )
            ]
          },
          {
            type: "button",
            style: "primary",
            height: "md",
            color: "#0B7C86",
            action: {
              type: "uri",
              label: "เปิดศูนย์ปฏิบัติการ",
              uri: getTeamLiffUrl()
            }
          },
          {
            type: "box",
            layout: "horizontal",
            spacing: "sm",
            contents: [
              {
                type: "button",
                style: "secondary",
                flex: 1,
                color: "#FFFFFF",
                action: {
                  type: "uri",
                  label: "เคสด่วนเต็มจอ",
                  uri: getTeamLiffUrl("urgent")
                }
              },
              {
                type: "button",
                style: "secondary",
                flex: 1,
                color: "#FFFFFF",
                action: {
                  type: "uri",
                  label: "ค้นหาเต็มจอ",
                  uri: getTeamLiffUrl("search")
                }
              }
            ]
          },
          {
            type: "text",
            text: "แนะนำให้ทีมกดเมนูนี้ในแอปไลน์ เพื่อเปิด LIFF แบบเนียนและลดโอกาสเด้งหน้า login",
            color: "#5F7285",
            size: "xs",
            wrap: true,
            align: "center"
          }
        ]
      }
    }
  };
}

function buildTeamNewCaseText(item = {}) {
  return (
    "มีเคสใหม่เข้าระบบ\n\n" +
    `เลขเคส: ${item.case_code || "-"}\n` +
    `ชื่อ: ${item.full_name || "-"}\n` +
    `โทร: ${item.phone || "-"}\n` +
    `พื้นที่: ${item.location || "-"}\n` +
    `รายละเอียด: ${item.problem || "-"}\n` +
    `สถานะ: ${formatCaseStatusThai(item.status)}\n` +
    `ระดับ: ${formatPriorityThai(item.priority)}`
  );
}

async function pushTeamNewCaseNotification(item = {}) {
  const flex = buildTeamNewCaseFlex(item);
  try {
    await callLinePushApi(EFFECTIVE_TEAM_GROUP_ID, [flex]);
  } catch (error) {
    console.error("TEAM NEW CASE FLEX FAILED:", error.message);
    await pushTeamNotification(buildTeamNewCaseText(item));
  }
}

function buildTeamFollowupText(item = {}, followupCount = 1) {
  return (
    "มีการติดตามเคสอีกครั้ง\n\n" +
    `เลขเคส: ${item.case_code || "-"}\n` +
    `ชื่อ: ${item.full_name || "-"}\n` +
    `พื้นที่: ${item.location || "-"}\n` +
    `สถานะ: ${formatCaseStatusThai(item.status)}\n` +
    `ระดับ: ${formatPriorityThai(item.priority)}\n` +
    `ผู้รับเคส: ${item.assigned_to || "ยังไม่มีผู้รับผิดชอบ"}\n` +
    `ติดตามซ้ำครั้งที่ ${followupCount}\n\n` +
    "กรุณาตรวจสอบเคสนี้อีกครั้ง"
  );
}

async function pushTeamFollowupNotification(item = {}, followupCount = 1) {
  const flex = buildTeamFollowupFlex(item, followupCount);
  try {
    await callLinePushApi(EFFECTIVE_TEAM_GROUP_ID, [flex]);
  } catch (error) {
    console.error("TEAM FOLLOWUP FLEX FAILED:", error.message);
    await pushTeamNotification(buildTeamFollowupText(item, followupCount));
  }
}

function normalizePhoneForSearch(phone = "") {
  return String(phone || "").replace(/\D/g, "");
}

function normalizeCaseCodeForSearch(value = "") {
  return String(value || "").trim().replace(/\s+/g, "").toUpperCase();
}

async function findLatestCaseByCaseCodeOrPhone(input = "") {
  const raw = String(input || "").trim();
  if (!raw) return null;

  const normalizedInput = normalizeCaseCodeForSearch(raw);
  const normalizedPhone = normalizePhoneForSearch(raw);

  let caseRes = await supabase
    .from("help_requests")
    .select("*")
    .eq("case_code", raw)
    .order("created_at", { ascending: false })
    .limit(1);

  if (caseRes.error) throw caseRes.error;
  if (caseRes.data?.length) return caseRes.data[0];

  caseRes = await supabase
    .from("help_requests")
    .select("*")
    .ilike("case_code", `%${raw}%`)
    .order("created_at", { ascending: false })
    .limit(5);

  if (caseRes.error) throw caseRes.error;
  if (caseRes.data?.length) {
    const exactNormalizedMatch = caseRes.data.find(
      (row) => normalizeCaseCodeForSearch(row.case_code) === normalizedInput
    );
    return exactNormalizedMatch || caseRes.data[0];
  }

  let phoneRes = await supabase
    .from("help_requests")
    .select("*")
    .eq("phone", raw)
    .order("created_at", { ascending: false })
    .limit(1);

  if (phoneRes.error) throw phoneRes.error;
  if (phoneRes.data?.length) return phoneRes.data[0];

  phoneRes = await supabase
    .from("help_requests")
    .select("*")
    .ilike("phone", `%${raw}%`)
    .order("created_at", { ascending: false })
    .limit(10);

  if (phoneRes.error) throw phoneRes.error;
  if (phoneRes.data?.length) {
    const exactPhoneMatch = phoneRes.data.find(
      (row) => normalizePhoneForSearch(row.phone) === normalizedPhone
    );
    return exactPhoneMatch || phoneRes.data[0];
  }

  const fallbackRes = await supabase
    .from("help_requests")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(300);

  if (fallbackRes.error) throw fallbackRes.error;
  const rows = fallbackRes.data || [];

  const matchedByCaseCode = rows.find(
    (row) => normalizeCaseCodeForSearch(row.case_code) === normalizedInput
  );
  if (matchedByCaseCode) return matchedByCaseCode;

  const matchedByPhone = rows.find(
    (row) => normalizePhoneForSearch(row.phone) === normalizedPhone
  );
  if (matchedByPhone) return matchedByPhone;

  return null;
}


function buildAdminMenuFlex() {
  function messageButton(label, text, color = "#20C44A") {
    return {
      type: "button",
      style: "primary",
      height: "sm",
      color,
      action: {
        type: "message",
        label,
        text
      }
    };
  }

  function uriButton(label, uri, color = "#20C44A") {
    return {
      type: "button",
      style: "primary",
      height: "sm",
      color,
      action: {
        type: "uri",
        label,
        uri
      }
    };
  }

  function buildMenuBubble(heroImage, buttons) {
    return {
      type: "bubble",
      size: "mega",
      hero: {
        type: "image",
        url: heroImage,
        size: "full",
        aspectRatio: "1:1",
        aspectMode: "cover"
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "10px",
        paddingAll: "14px",
        contents: buttons
      }
    };
  }

  return {
    type: "flex",
    altText: "เมนูแอดมิน | ศูนย์ควบคุมระบบ",
    contents: {
      type: "carousel",
      contents: [
        buildMenuBubble(
          "https://img2.pic.in.th/116d0b84e95b08306.png",
          [
            messageButton("ดูเคสใหม่", "ดูเคสใหม่"),
            messageButton("ดูเคสด่วน", "ดูเคสด่วน"),
            messageButton("เคสวันนี้", "เคสวันนี้"),
            messageButton("ค้นหาเคส", "ค้นหาเคส")
          ]
        ),

        buildMenuBubble(
          "https://img1.pic.in.th/images/26272da5848ec9a47.png",
          [
            uriButton("Dashboard", "https://satisfied-stillness-production-7942.up.railway.app/dashboard"),
            uriButton("รายงานผู้บริหาร", "https://satisfied-stillness-production-7942.up.railway.app/report"),
            messageButton("Smart Alert", "Smart Alert"),
            uriButton("เปิดศูนย์ปฏิบัติการ", "https://satisfied-stillness-production-7942.up.railway.app/command-center")
          ]
        ),

        buildMenuBubble(
          "https://img1.pic.in.th/images/346dc5fe1957cf436.png",
          [
            messageButton("ดูทีม", "ดูทีม"),
            messageButton("ดูสิทธิ์", "คำสั่งดูสิทธิ์"),
            messageButton("เพิ่มทีม", "คำสั่งเพิ่มทีม"),
            messageButton("ลบทีม", "คำสั่งลบทีม")
          ]
        )
      ]
    }
  };
}

function buildSmartAlertFlex() {
  function bigButton(label, color, text = null, uri = null) {
    return {
      type: "button",
      style: "primary",
     
      color,
      action: uri
        ? { type: "uri", label, uri }
        : { type: "message", label, text: text || label }
    };
  }

  return {
    type: "flex",
    altText: "SMART ALERT | ศูนย์ติดตามเคส",
    contents: {
      type: "bubble",
      size: "mega",
      hero: {
        type: "image",
        url: "https://img1.pic.in.th/images/479c5c6f6459b101f.png", // 👉 เปลี่ยนเป็นภาพ Smart Alert ของคุณ
        size: "full",
        aspectRatio: "1:1",
        aspectMode: "cover"
      },
    
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "10px",
        paddingAll: "16px",
        contents: [
          bigButton("🚨 เคสด่วน", "#EF4444", "เคสด่วน"),
          bigButton("🔐 เคสค้าง", "#F97316", "เคสค้าง"),
          bigButton("➕ เคสต้องติดตาม", "#1D4ED8", "เคสต้องติดตาม"),
          bigButton(
            "🧭 เปิดศูนย์ปฏิบัติการ",
            "#22C55E",
            null,
            "https://satisfied-stillness-production-7942.up.railway.app/command-center"
          )
        ]
      }
    }
  };
}
function buildHelpRequestChoiceFlex() {
  return {
    type: "flex",
    altText: "เลือกเมนูการขอความช่วยเหลือ",
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#0b7c86",
        paddingAll: "16px",
        contents: [
          { type: "text", text: "ระบบขอความช่วยเหลือ", color: "#ffffff", weight: "bold", size: "lg", wrap: true },
          { type: "text", text: "กรุณาเลือกเมนูที่ต้องการ", color: "#d9f3f5", size: "sm", margin: "sm", wrap: true }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        paddingAll: "18px",
        contents: [
          {
            type: "box",
            layout: "vertical",
            cornerRadius: "14px",
            paddingAll: "14px",
            backgroundColor: "#f7fbfc",
            borderColor: "#dbe3ea",
            borderWidth: "1px",
            action: { type: "message", label: "ขอความช่วยเหลือครั้งแรก", text: "ขอความช่วยเหลือครั้งแรก" },
            contents: [
              { type: "text", text: "ขอความช่วยเหลือครั้งแรก", weight: "bold", size: "md", wrap: true },
              { type: "text", text: "สำหรับผู้ที่ต้องการยื่นเรื่องใหม่เข้าระบบ", size: "sm", color: "#666666", margin: "sm", wrap: true }
            ]
          },
          {
            type: "box",
            layout: "vertical",
            cornerRadius: "14px",
            paddingAll: "14px",
            backgroundColor: "#f7fbfc",
            borderColor: "#dbe3ea",
            borderWidth: "1px",
            action: { type: "message", label: "ติดตามการขอความช่วยเหลือ", text: "ติดตามการขอความช่วยเหลือ" },
            contents: [
              { type: "text", text: "ติดตามการขอความช่วยเหลือ", weight: "bold", size: "md", wrap: true },
              { type: "text", text: "ตรวจสอบสถานะเคสเดิมด้วยเลขเคสหรือเบอร์โทร", size: "sm", color: "#666666", margin: "sm", wrap: true }
            ]
          }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        paddingAll: "16px",
        contents: [
          { type: "text", text: "เจ้าหน้าที่จะตรวจสอบและประสานงานให้โดยเร็วที่สุด", size: "xs", color: "#888888", wrap: true, align: "center" }
        ]
      }
    }
  };
}

function buildHelpFormFlex() {
  const prefill = encodeURIComponent("ชื่อ:\nพื้นที่:\nรายละเอียด:\nเบอร์:");
  const useUri = LINE_OA_ID && LINE_OA_ID.startsWith("@");
  const primaryAction = useUri
    ? { type: "uri", label: "กรอกข้อมูลตามนี้", uri: `https://line.me/R/oaMessage/${LINE_OA_ID}/?${prefill}` }
    : { type: "message", label: "กรอกข้อมูลตามนี้", text: "ชื่อ:\nพื้นที่:\nรายละเอียด:\nเบอร์:" };

  return {
    type: "flex",
    altText: "แบบฟอร์มขอความช่วยเหลือ",
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#0b7c86",
        paddingAll: "16px",
        contents: [
          { type: "text", text: "แบบฟอร์มขอความช่วยเหลือ", color: "#ffffff", weight: "bold", size: "lg", align: "center" },
          { type: "text", text: "กรุณากรอกข้อมูลตามตัวอย่างด้านล่าง", color: "#d9f3f5", size: "sm", margin: "sm", wrap: true, align: "center" }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "lg",
        paddingAll: "20px",
        contents: [
          {
            type: "box",
            layout: "vertical",
            backgroundColor: "#F9FAFB",
            cornerRadius: "12px",
            paddingAll: "16px",
            spacing: "md",
            contents: [
              { type: "text", text: "ชื่อ:", weight: "bold", size: "sm" },
              { type: "text", text: "พื้นที่:", weight: "bold", size: "sm" },
              { type: "text", text: "รายละเอียด:", weight: "bold", size: "sm" },
              { type: "text", text: "เบอร์:", weight: "bold", size: "sm" }
            ]
          },
          {
            type: "text",
            text: useUri ? "กดปุ่มด้านล่างเพื่อเปิดช่องพิมพ์พร้อมหัวข้อฟอร์ม" : "คัดลอกหัวข้อด้านบน แล้วพิมพ์ข้อมูลต่อท้ายได้เลย",
            size: "sm",
            color: "#6B7280",
            wrap: true,
            align: "center"
          }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        paddingAll: "16px",
        contents: [
          { type: "button", style: "primary", height: "sm", color: "#0b7c86", action: primaryAction },
          { type: "button", style: "secondary", height: "sm", action: { type: "message", label: "กลับไปเลือกประเภท", text: "ขอความช่วยเหลือ" } }
        ]
      }
    }
  };
}

function buildContactOfficerFlex() {
  return {
    type: "flex",
    altText: "ติดต่อเจ้าหน้าที่",
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#0b7c86",
        paddingAll: "16px",
        contents: [
          { type: "text", text: "ติดต่อเจ้าหน้าที่", color: "#ffffff", weight: "bold", size: "lg", align: "center" },
          { type: "text", text: "ช่องทางสำหรับสอบถามข้อมูลเพิ่มเติม", color: "#d9f3f5", size: "sm", margin: "sm", wrap: true, align: "center" }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "lg",
        paddingAll: "20px",
        contents: [
          { type: "text", text: "081-959-7060", weight: "bold", size: "xl", color: "#111827", align: "center" },
          { type: "text", text: "กรุณาพิมพ์ข้อความที่ต้องการสอบถาม\nหรือโทรติดต่อผ่านช่องทางของมูลนิธิได้เลยครับ", wrap: true, size: "sm", color: "#4B5563", align: "center" }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        paddingAll: "16px",
        contents: [
          { type: "button", style: "primary", height: "sm", color: "#0b7c86", action: { type: "uri", label: "โทรหาเจ้าหน้าที่", uri: "tel:0819597060" } },
          { type: "button", style: "secondary", height: "sm", action: { type: "message", label: "กลับไปเลือกประเภท", text: "ขอความช่วยเหลือ" } }
        ]
      }
    }
  };
}

// =========================
// GOLDEN SAFE PATCH: SLA HELPERS (READ ONLY)
// =========================

function normalizeSlaStatus(status) {
  const s = String(status || "").trim().toLowerCase();
  if (s === "progress") return "in_progress";
  if (s.includes("กำลัง")) return "in_progress";
  if (s.includes("เสร็จ")) return "done";
  if (s.includes("ยกเลิก")) return "cancelled";
  return s || "new";
}

function normalizeSlaPriority(priority) {
  const p = String(priority || "").trim().toLowerCase();
  if (p === "urgent") return "urgent";
  if (p === "high") return "high";
  if (p === "low") return "low";
  return "normal";
}

function getSlaThresholdHours(priority = "normal") {
  const p = normalizeSlaPriority(priority);

  if (p === "urgent") {
    return { warningHours: 2, breachHours: 4 };
  }
  if (p === "high") {
    return { warningHours: 6, breachHours: 12 };
  }
  if (p === "low") {
    return { warningHours: 48, breachHours: 72 };
  }

  return { warningHours: 24, breachHours: 48 };
}

function formatSlaLabelTh(level) {
  if (level === "breached") return "เกิน SLA";
  if (level === "warning") return "ใกล้เกิน SLA";
  return "ปกติ";
}

function formatSlaColor(level) {
  if (level === "breached") return "#dc2626";
  if (level === "warning") return "#d97706";
  return "#16a34a";
}

function roundSlaHours(value) {
  const num = Number(value || 0);
  return Math.round(num * 10) / 10;
}

function computeSlaState(row = {}) {
  const status = normalizeSlaStatus(row.status);
  const priority = normalizeSlaPriority(row.priority);

  // เคสปิดแล้ว / ยกเลิกแล้ว ไม่นับ SLA active
  if (status === "done" || status === "cancelled") {
    return {
      sla_level: "normal",
      sla_label_th: "ไม่คิด SLA",
      sla_color: "#6b7280",
      sla_excluded: true,
      sla_priority: priority,
      sla_target_warning_hours: null,
      sla_target_breach_hours: null,
      sla_hours_since_action: 0,
      sla_hours_remaining_to_warning: null,
      sla_hours_remaining_to_breach: null
    };
  }

  const { warningHours, breachHours } = getSlaThresholdHours(priority);

  const baseTimeRaw = row.last_action_at || row.created_at || null;
  const baseTime = baseTimeRaw ? new Date(baseTimeRaw) : null;
  const now = new Date();

  let hoursSinceAction = 0;

  if (baseTime && !Number.isNaN(baseTime.getTime())) {
    hoursSinceAction = (now.getTime() - baseTime.getTime()) / (1000 * 60 * 60);
    if (hoursSinceAction < 0) hoursSinceAction = 0;
  }

  let level = "normal";
  if (hoursSinceAction >= breachHours) {
    level = "breached";
  } else if (hoursSinceAction >= warningHours) {
    level = "warning";
  }

  return {
    sla_level: level,
    sla_label_th: formatSlaLabelTh(level),
    sla_color: formatSlaColor(level),
    sla_excluded: false,
    sla_priority: priority,
    sla_target_warning_hours: warningHours,
    sla_target_breach_hours: breachHours,
    sla_hours_since_action: roundSlaHours(hoursSinceAction),
    sla_hours_remaining_to_warning: roundSlaHours(Math.max(0, warningHours - hoursSinceAction)),
    sla_hours_remaining_to_breach: roundSlaHours(Math.max(0, breachHours - hoursSinceAction))
  };
}

function mergeCaseWithSla(row = {}) {
  return {
    ...row,
    ...computeSlaState(row)
  };
}

/* =========================
   ENV CHECK
========================= */
if (!CHANNEL_ACCESS_TOKEN) {
  console.error("❌ Missing CHANNEL_ACCESS_TOKEN");
  process.exit(1);
}

if (!SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing SUPABASE_URL or SERVICE_ROLE_KEY");
  process.exit(1);
}





/* =========================
   MIDDLEWARE
========================= */
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));
// ===== STATIC FILES (SAFE PATCH) =====
app.use(express.static(__dirname));


/* =========================
   BASIC ROUTES
========================= */
app.get("/", (req, res) => {
  res.status(200).send("Foundation Bot Running 🚀");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "foundation-line-bot",
    time: new Date().toISOString(),
  });
});

app.get("/version", (req, res) => {
  res.status(200).send("server version: production-locked-phaseA-final");
});

app.get("/webhook", (req, res) => {
  res.status(200).send("Webhook endpoint is ready ✅");
});

app.get("/dashboard", checkDashboardAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

app.get("/case", checkDashboardAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "case.html"));
});

app.get("/report", checkDashboardAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "report.html"));
});
app.get("/team.html", (req, res) => {
  res.redirect("/team");
});

app.get("/team", (req, res) => {
  res.sendFile(path.join(__dirname, "team.html"));
});

app.get("/api/recent-activity", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "20", 10), 50);

    const { data, error } = await supabase
      .from("case_updates")
      .select(`
        id,
        case_code,
        progress_percent,
        current_step,
        waiting_for,
        latest_note,
        updated_at,
        updated_by,
        updated_by_user_id,
        updated_by_role,
        updater_name,
        message,
        images,
        status_after
      `)
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (error) throw error;

    return res.json({
      ok: true,
      items: data || [],
    });
  } catch (err) {
    console.error("recent-activity error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "recent-activity failed",
    });
  }
});

app.options("/api/cases/map", (req, res) => {
  applyPublicCors(req, res);
  return res.status(204).end();
});

app.options("/api/team/stream", (req, res) => {
  applyPublicCors(req, res);
  return res.status(204).end();
});

// ===============================
// MAP API (Golden Safe Patch - YOUR VERSION)
// ===============================
app.get("/api/cases/map", async (req, res) => {
  try {
    applyPublicCors(req, res);

    const { data, error } = await supabase
      .from("help_requests")
      .select("*")
      .not("latitude", "is", null)
      .not("longitude", "is", null)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("MAP API ERROR:", error);
      return res.status(500).json({
        ok: false,
        error: error.message
      });
    }

    return res.json({
      ok: true,
      items: (data || []).map((row) => ({
        id: row.id || null,
        case_code: row.case_code || "",
        full_name: row.full_name || "-",
        phone: row.phone || "-",
        location: row.location || "",
        problem: row.problem || "",
        assigned_to: row.assigned_to || "",
        status: row.status || "new",
        priority: row.priority || "normal",
        latitude: row.latitude,
        longitude: row.longitude,
        location_text: row.location_text || "",
        latest_note: row.latest_note || "",
        updated_at: row.last_action_at || row.created_at || null
      }))
    });

  } catch (err) {
    console.error("GET /api/cases/map FAILED:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "internal error"
    });
  }
});

// =========================
// TEAM CASE DETAIL (Golden Safe)
// =========================
app.get("/api/team/case-detail", async (req, res) => {
  try {
    const caseCode = String(req.query.case_code || "").trim();

    if (!caseCode) {
      return res.status(400).json({
        ok: false,
        error: "case_code is required"
      });
    }

    // 🔹 ดึงข้อมูลเคสหลัก
    const { data: caseItem, error: caseError } = await supabase
      .from("help_requests")
      .select("*")
      .eq("case_code", caseCode)
      .maybeSingle();

    if (caseError) throw caseError;

    if (!caseItem) {
      return res.status(404).json({
        ok: false,
        error: "case not found"
      });
    }

    // 🔹 ดึง timeline อัปเดต
    const { data: updates, error: updatesError } = await supabase
      .from("case_updates")
      .select("*")
      .eq("case_code", caseCode)
      .order("updated_at", { ascending: false });

    if (updatesError) throw updatesError;

    return res.json({
      ok: true,
      case: caseItem,
      updates: updates || []
    });

  } catch (err) {
    console.error("TEAM CASE DETAIL ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "team case detail failed"
    });
  }
});

// =========================
// 🔥 CASE UPDATE (REAL FLOW)
// =========================
app.post("/api/case-updates", upload.array("images", 5), async (req, res) => {
  try {
    const body = req.body || {};
    const case_code = cleanText(body.case_code || body.caseCode);

    if (!case_code) {
      return res.status(400).json({ ok: false, error: "case_code is required" });
    }

    const helpRequest = await getHelpRequestByCaseCode(case_code);
    const case_id = body.case_id || body.caseId || helpRequest?.id || null;

    const rawStatus = cleanText(body.status || body.status_after || body.rawStatusAfter || body.progressStatus);
    const status_after = rawStatus || null;
    const current_step = cleanText(body.current_step || body.currentStep || body.title);
    const waiting_for = cleanText(body.waiting_for || body.waitingFor) || CASE_UPDATE_WAITING_FOR_MAP[current_step] || null;
    const progress_percent = toNumberOrNull(body.progress_percent ?? body.progressPercent) ?? CASE_UPDATE_PROGRESS_MAP[current_step] ?? null;

    const updater_name = toNullableText(body.updater_name || body.senderName || body.updated_by_name || body.staff_name || body.staffName || body.updated_by || body.updater_user_id);
    const updater_user_id = toNullableText(body.updater_user_id || body.senderUserId || body.updated_by_user_id || body.updated_by);
    const updated_by = toNullableText(body.updated_by || updater_user_id || updater_name);
    const location_text = toNullableText(body.location_text || body.locationText);
    const latitude = toNumberOrNull(body.latitude);
    const longitude = toNumberOrNull(body.longitude);

    const trimmedTitle = cleanText(body.title);
    const trimmedMessage = cleanText(body.message || body.note || body.latest_note);
    const composedMessage = [trimmedTitle ? `[${trimmedTitle}]` : "", trimmedMessage].filter(Boolean).join(" ").trim();
    const note = trimmedMessage || composedMessage || current_step || null;

    const imageUrls = [];
    if (req.files?.length) {
      for (const file of req.files) {
        const ext = (file.mimetype || "image/jpeg").split("/")[1] || "jpg";
        const fileName = `case/${case_code}/${uuidv4()}.${ext}`;

        const { error: uploadError } = await supabase
          .storage
          .from("case-updates")
          .upload(fileName, file.buffer, {
            contentType: file.mimetype,
            upsert: false
          });

        if (uploadError) throw uploadError;

        const { data, error: signedUrlError } = await supabase
          .storage
          .from("case-updates")
          .createSignedUrl(fileName, 60 * 60 * 24 * 7);

        if (signedUrlError) throw signedUrlError;
        imageUrls.push(data?.signedUrl || "");
      }
    }

    const incomingImages = toImageArray(body.images);
    const mergedImages = [...incomingImages, ...imageUrls].filter(Boolean);

    const insertedUpdate = await insertCaseUpdateLog({
      case_id,
      case_code,
      status: status_after,
      status_after,
      current_step,
      waiting_for,
      progress_percent,
      note,
      latest_note: note,
      message: composedMessage || note,
      updated_by,
      updated_by_user_id: updater_user_id,
      updated_by_role: toNullableText(body.updated_by_role),
      updater_name,
      updater_user_id,
      location_text,
      latitude,
      longitude,
      images: mergedImages
    });

    const latestFields = {
      latest_note: insertedUpdate.latest_note || note || null,
      last_action_at: insertedUpdate.updated_at || new Date().toISOString(),
      last_action_by: insertedUpdate.updater_name || insertedUpdate.updated_by || null
    };

    if (insertedUpdate.status_after) {
      latestFields.status = insertedUpdate.status_after;
    }

    if (Number.isFinite(insertedUpdate.latitude) && Number.isFinite(insertedUpdate.longitude)) {
      latestFields.latitude = insertedUpdate.latitude;
      latestFields.longitude = insertedUpdate.longitude;
      latestFields.location_text =
        insertedUpdate.location_text || `${insertedUpdate.latitude}, ${insertedUpdate.longitude}`;
    } else if (insertedUpdate.location_text) {
      latestFields.location_text = insertedUpdate.location_text;
    }

    if (case_id || case_code) {
      let updateQuery = supabase.from("help_requests").update(latestFields);
      if (case_id) {
        updateQuery = updateQuery.eq("id", case_id);
      } else {
        updateQuery = updateQuery.eq("case_code", case_code);
      }

      const { error: helpReqUpdateError } = await updateQuery;
      if (helpReqUpdateError) {
        console.error("help_requests sync error:", helpReqUpdateError);
      }
    }

    broadcastSse("case_update", {
      scope: "team_workspace",
      item: {
        id: insertedUpdate.id,
        case_id: insertedUpdate.case_id || case_id || null,
        case_code: insertedUpdate.case_code,
        progress_percent: insertedUpdate.progress_percent,
        current_step: insertedUpdate.current_step,
        waiting_for: insertedUpdate.waiting_for,
        latest_note: insertedUpdate.latest_note,
        note: insertedUpdate.note || insertedUpdate.latest_note,
        updated_at: insertedUpdate.updated_at,
        updated_by: insertedUpdate.updated_by,
        updated_by_user_id: insertedUpdate.updated_by_user_id,
        updated_by_role: insertedUpdate.updated_by_role,
        updater_name: insertedUpdate.updater_name,
        message: insertedUpdate.message,
        images: insertedUpdate.images || [],
        status_after: insertedUpdate.status_after,
        status: insertedUpdate.status || insertedUpdate.status_after || null,
        latitude: insertedUpdate.latitude ?? null,
        longitude: insertedUpdate.longitude ?? null,
        location_text: insertedUpdate.location_text || ""
      }
    });

    if (Number.isFinite(insertedUpdate.latitude) && Number.isFinite(insertedUpdate.longitude)) {
      broadcastSse("case_geo_updated", {
        scope: "team_workspace",
        item: {
          case_code: insertedUpdate.case_code,
          latitude: insertedUpdate.latitude,
          longitude: insertedUpdate.longitude,
          location_text: insertedUpdate.location_text || "",
          updated_at: insertedUpdate.updated_at,
          status: insertedUpdate.status_after || insertedUpdate.status || null,
          latest_note: insertedUpdate.latest_note || ""
        }
      });
    }

    broadcastSse("recent_activity_refresh", {
      scope: "team_workspace",
      case_code: insertedUpdate.case_code,
      updated_at: insertedUpdate.updated_at
    });

    if (CHANNEL_ACCESS_TOKEN && EFFECTIVE_TEAM_GROUP_ID) {
      await fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`
        },
        body: JSON.stringify({
          to: EFFECTIVE_TEAM_GROUP_ID,
          messages: [{
            type: "text",
            text:
              `📢 อัปเดตเคส
` +
              `เลขเคส: ${case_code}
` +
              `ผู้ส่ง: ${updater_name || updated_by || "-"}
` +
              `รายละเอียด: ${note || composedMessage || "-"}
` +
              `${mergedImages.length ? `แนบรูป ${mergedImages.length} รูป` : "ไม่มีรูป"}`
          }]
        })
      });
    }

    return res.json({ ok: true, data: insertedUpdate });
  } catch (err) {
    console.error("CASE UPDATE ERROR:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/logo.png", (req, res) => {
  res.sendFile(path.join(__dirname, "Logo.png"));
});


/* =========================
   REALTIME / SSE
========================= */
const sseClients = new Set();

function sendSse(client, eventName, payload) {
  try {
    client.res.write(`event: ${eventName}\n`);
    client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch (error) {
    console.error("SSE SEND ERROR:", error.message);
    sseClients.delete(client);
  }
}

function broadcastSse(eventName, payload = {}) {
  for (const client of sseClients) {
    sendSse(client, eventName, {
      ...payload,
      sent_at: new Date().toISOString(),
    });
  }
}

app.get("/api/stream", checkDashboardAuth, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const client = {
    id: Date.now() + Math.random(),
    res,
  };

  sseClients.add(client);

  sendSse(client, "connected", {
    message: "stream connected",
    clients: sseClients.size,
  });

  const heartbeat = setInterval(() => {
    sendSse(client, "heartbeat", { ts: Date.now() });
  }, 20000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(client);
  });
});

app.get("/api/team/stream", (req, res) => {
  applyPublicCors(req, res);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const client = {
    id: Date.now() + Math.random(),
    res,
  };

  sseClients.add(client);

  sendSse(client, "connected", {
    message: "team stream connected",
    clients: sseClients.size,
    scope: "team_workspace",
  });

  const heartbeat = setInterval(() => {
    sendSse(client, "heartbeat", { ts: Date.now(), scope: "team_workspace" });
  }, 20000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(client);
  });
});

/* =========================
   SIGNATURE VERIFY
========================= */
function verifySignature(req) {
  if (!CHANNEL_SECRET) {
    console.warn("⚠️ CHANNEL_SECRET not set, skipping signature verification");
    return true;
  }

  const signature = req.get("x-line-signature");
  if (!signature || !req.rawBody) return false;

  const hash = crypto
    .createHmac("SHA256", CHANNEL_SECRET)
    .update(req.rawBody)
    .digest("base64");

  return hash === signature;
}

/* =========================
   LINE API
========================= */
async function callLineReplyApi(replyToken, messages) {
  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });

  const resultText = await response.text();
  console.log("LINE reply status:", response.status);
  console.log("LINE reply body:", resultText);

  if (!response.ok) {
    throw new Error(`LINE reply failed: ${response.status} ${resultText}`);
  }

  return resultText;
}

async function callLinePushApi(to, messages) {
  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to, messages }),
  });

  const resultText = await response.text();
  console.log("LINE push status:", response.status);
  console.log("LINE push body:", resultText);

  if (!response.ok) {
    throw new Error(`LINE push failed: ${response.status} ${resultText}`);
  }

  return resultText;
}

async function safeReply(replyToken, messages) {
  try {
    await callLineReplyApi(replyToken, messages);
  } catch (error) {
    console.error("Reply failed:", error.message || error);
    // ❌ ห้าม reply ซ้ำด้วย token เดิม
  }
}

async function pushTeamNotification(text) {
  if (!EFFECTIVE_TEAM_GROUP_ID) {
    console.warn("⚠️ TEAM_GROUP_ID / LINE_GROUP_ID is not set yet, skipping team notification");
    return;
  }

  await callLinePushApi(EFFECTIVE_TEAM_GROUP_ID, [{ type: "text", text }]);
}

async function pushLineTextSafe(targetId, text) {
  if (!targetId || !text) return false;
  try {
    await callLinePushApi(targetId, [{ type: "text", text }]);
    return true;
  } catch (error) {
    console.warn("pushLineTextSafe failed:", error.message);
    return false;
  }
}

function buildTeamWorkspaceAutoText(action, row = {}, actorName = "ทีมงาน") {
  const caseCode = row.case_code || "-";
  const caseName = row.full_name || row.title || "-";
  const statusText = typeof formatCaseStatusThai === "function" ? formatCaseStatusThai(row.status || "-") : (row.status || "-");
  const priorityText = typeof formatPriorityThai === "function" ? formatPriorityThai(row.priority || "normal") : (row.priority || "normal");
  const locationText = row.location || row.province || row.location_province || "-";

  if (action === "assign") {
    return [
      "🧭 Team Workspace อัปเดต",
      `รับเคสแล้ว: ${caseCode}`,
      `ผู้รับผิดชอบ: ${actorName}`,
      `ชื่อผู้ขอ: ${caseName}`,
      `พื้นที่: ${locationText}`,
      `ระดับ: ${priorityText}`,
      `สถานะล่าสุด: ${statusText}`
    ].join("\n");
  }

  if (action === "progress") {
    return [
      "🔄 Team Workspace อัปเดตสถานะ",
      `เลขเคส: ${caseCode}`,
      `ผู้ดำเนินการ: ${actorName}`,
      `ชื่อผู้ขอ: ${caseName}`,
      "สถานะ: กำลังดำเนินการ"
    ].join("\n");
  }

  if (action === "done") {
    return [
      "✅ Team Workspace ปิดเคส",
      `เลขเคส: ${caseCode}`,
      `ผู้ดำเนินการ: ${actorName}`,
      `ชื่อผู้ขอ: ${caseName}`,
      "สถานะ: ปิดเคสแล้ว"
    ].join("\n");
  }

  return [
    "📌 Team Workspace แจ้งอัปเดต",
    `เลขเคส: ${caseCode}`,
    `ผู้ดำเนินการ: ${actorName}`,
    `สถานะ: ${statusText}`
  ].join("\n");
}

function buildRequesterAutoText(action, row = {}, actorName = "ทีมงาน") {
  const caseCode = row.case_code || "-";

  if (action === "assign") {
    return [
      "📌 อัปเดตคำขอความช่วยเหลือ",
      `เลขเคส: ${caseCode}`,
      `ขณะนี้ทีมงาน ${actorName} รับเรื่องแล้ว`,
      "ระบบจะติดตามความคืบหน้าให้ต่อเนื่องครับ"
    ].join("\n");
  }

  if (action === "progress") {
    return [
      "🔄 อัปเดตคำขอความช่วยเหลือ",
      `เลขเคส: ${caseCode}`,
      "ขณะนี้เคสของคุณอยู่ระหว่างดำเนินการ",
      `ผู้ประสานงาน: ${actorName}`
    ].join("\n");
  }

  if (action === "done") {
    return [
      "✅ อัปเดตคำขอความช่วยเหลือ",
      `เลขเคส: ${caseCode}`,
      "เคสนี้ถูกปิดงานในระบบแล้ว",
      "หากข้อมูลยังไม่ครบหรือมีรายละเอียดเพิ่มเติม สามารถติดต่อทีมงานได้อีกครั้ง"
    ].join("\n");
  }

  return [
    "📌 มีการอัปเดตเคสของคุณ",
    `เลขเคส: ${caseCode}`
  ].join("\n");
}

/* =========================
   DONATION FLEX
========================= */
function createProjectBubble(title, subtitle, imageUrl, projectUrl) {
  return {
    type: "bubble",
    hero: {
      type: "image",
      url: imageUrl,
      size: "full",
      aspectRatio: "1:1",
      aspectMode: "cover",
      action: {
        type: "uri",
        uri: projectUrl,
      },
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        {
          type: "text",
          text: title,
          weight: "bold",
          size: "lg",
          wrap: true,
        },
        {
          type: "text",
          text: subtitle,
          size: "sm",
          color: "#666666",
          wrap: true,
        },
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        {
          type: "button",
          style: "primary",
          height: "sm",
          action: {
            type: "uri",
            label: "ดูโครงการ",
            uri: projectUrl,
          },
        },
      ],
      flex: 0,
    },
  };
}

const donationFlex = {
  type: "flex",
  altText: "โครงการช่วยเหลือของมูลนิธิ",
  contents: {
    type: "carousel",
    contents: [
      createProjectBubble(
        "ซากาตเพื่อผู้ยากไร้",
        "ร่วมมอบโอกาสให้ผู้ขาดแคลน",
        "https://img5.pic.in.th/file/secure-sv1/KCK142b3df0c343ae11c.png",
        "https://preeminent-otter-b3610c.netlify.app/projects.html?case=zakat"
      ),
      createProjectBubble(
        "การศึกษา",
        "สนับสนุนอนาคตของเด็ก ๆ",
        "https://img5.pic.in.th/file/secure-sv1/KCK2.png",
        "https://preeminent-otter-b3610c.netlify.app/projects.html?case=education"
      ),
      createProjectBubble(
        "ที่อยู่อาศัย",
        "ช่วยเหลือด้านที่พักอาศัยผู้ยากไร้",
        "https://img5.pic.in.th/file/secure-sv1/KCK3.png",
        "https://preeminent-otter-b3610c.netlify.app/projects.html?case=housing"
      ),
      createProjectBubble(
        "ภัยพิบัติ",
        "ช่วยเหลือผู้ประสบเหตุเร่งด่วน",
        "https://img5.pic.in.th/file/secure-sv1/KCK4.png",
        "https://preeminent-otter-b3610c.netlify.app/projects.html?case=disaster"
      ),
      createProjectBubble(
        "อาสาพามัยยิดกลับบ้าน",
        "ร่วมสร้างความดีพาร่างผู้เสียชีวิตกลับภูมิลำเนา",
        "https://img2.pic.in.th/KCK54af3446f47283561.png",
        "https://preeminent-otter-b3610c.netlify.app/projects.html?case=masjid"
      ),
      createProjectBubble(
        "เด็กกำพร้า",
        "ส่งต่อโอกาสและอนาคตที่ดี",
        "https://img5.pic.in.th/file/secure-sv1/KCK6.png",
        "https://preeminent-otter-b3610c.netlify.app/projects.html?case=orphan"
      ),
      createProjectBubble(
        "มูลนิธิคนช่วยฅน",
        "สนับสนุนภารกิจช่วยเหลือสังคม",
        "https://img5.pic.in.th/file/secure-sv1/KCK7.png",
        "https://preeminent-otter-b3610c.netlify.app/projects.html?case=foundation"
      ),
    ],
  },
};

const donationFallbackText = [
  {
    type: "text",
    text:
      "โครงการช่วยเหลือของมูลนิธิ ❤️\n\n" +
      "1) ซากาต\nhttps://preeminent-otter-b3610c.netlify.app/projects.html?case=zakat\n\n" +
      "2) การศึกษา\nhttps://preeminent-otter-b3610c.netlify.app/projects.html?case=education\n\n" +
      "3) ที่อยู่อาศัย\nhttps://preeminent-otter-b3610c.netlify.app/projects.html?case=housing\n\n" +
      "4) ภัยพิบัติ\nhttps://preeminent-otter-b3610c.netlify.app/projects.html?case=disaster",
  },
  {
    type: "text",
    text:
      "โครงการเพิ่มเติม\n\n" +
      "5) มัสยิด\nhttps://preeminent-otter-b3610c.netlify.app/projects.html?case=masjid\n\n" +
      "6) เด็กกำพร้า\nhttps://preeminent-otter-b3610c.netlify.app/projects.html?case=orphan\n\n" +
      "7) มูลนิธิ\nhttps://preeminent-otter-b3610c.netlify.app/projects.html?case=foundation",
  },
];

/* =========================
   MENU
========================= */
function buildMainMenuText(role) {
  const common =
    "เมนูหลักพร้อมใช้งานครับ 🙏\n\n" +
    "สำหรับผู้ใช้งานทั่วไป:\n" +
    "- บริจาค\n" +
    "- ขอความช่วยเหลือ\n" +
    "- ติดตามการขอความช่วยเหลือ\n" +
    "- เกี่ยวกับมูลนิธิ\n" +
    "- ติดต่อเจ้าหน้าที่\n\n";

  if (role === "admin" || role === "staff") {
    return {
      type: "text",
      text:
        common +
        "สำหรับทีมงาน:\n" +
        "- ดูเคสใหม่\n" +
        "- ดูเคสด่วน\n" +
        "- เคสวันนี้\n" +
        "- รับเคส 17032026-001\n" +
        "- ปิดเคส 17032026-001\n" +
        "- เปลี่ยนสถานะ 17032026-001 in_progress\n\n" +
        "คำสั่งด่วนทีมงาน:\n" +
        "- เมนูทีมงาน\n\n" +
        "คำสั่งช่วยตั้งค่า:\n" +
        "- รหัสของฉัน\n" +
        "- สิทธิ์ของฉัน",
    };
  }

  if (role === "viewer") {
    return {
      type: "text",
      text:
        common +
        "สำหรับผู้มีสิทธิ์ดูข้อมูล:\n" +
        "- ดูเคสใหม่\n" +
        "- ดูเคสด่วน\n" +
        "- เคสวันนี้\n\n" +
        "คำสั่งช่วยตั้งค่า:\n" +
        "- รหัสของฉัน\n" +
        "- สิทธิ์ของฉัน",
    };
  }

  return {
    type: "text",
    text: common + "พิมพ์ 'รหัสของฉัน' หากต้องการส่งรหัสให้แอดมินกำหนดสิทธิ์",
  };
}

/* =========================
   HELP REQUEST FUNCTIONS
========================= */
function getLegacyDateKey() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

async function generateCaseCodeFallback() {
  const dateKey = getLegacyDateKey();
  const prefix = `CASE-${dateKey}-`;

  const { data, error } = await supabase
    .from("help_requests")
    .select("case_code")
    .ilike("case_code", `${prefix}%`)
    .order("case_code", { ascending: false })
    .limit(1);

  if (error) {
    console.error("GENERATE CASE CODE FALLBACK ERROR:", error);
    throw error;
  }

  let nextNumber = 1;

  if (data && data.length > 0 && data[0].case_code) {
    const lastCode = data[0].case_code;
    const parts = String(lastCode).split("-");
    const lastSeq = parseInt(parts[2], 10);
    if (!Number.isNaN(lastSeq)) {
      nextNumber = lastSeq + 1;
    }
  }

  return `${prefix}${String(nextNumber).padStart(4, "0")}`;
}

async function generateCaseCode() {
  try {
    const { data, error } = await supabase.rpc("generate_case_code");
    if (error) throw error;
    if (typeof data === "string" && data.trim()) return data.trim();
    throw new Error("Empty case code from RPC");
  } catch (error) {
    console.warn("RPC generate_case_code failed, using fallback:", error.message);
    return await generateCaseCodeFallback();
  }
}


function escapeRegex(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractHelpFormValue(text = "", label = "") {
  if (!text || !label) return "";
  const normalized = String(text).split("\r").join("");
  const escaped = escapeRegex(label);
  const regex = new RegExp(`(?:^|\\n)${escaped}\\s*:\\s*([\\s\\S]*?)(?=\\n(?:ชื่อ|พื้นที่|รายละเอียด|เบอร์)\\s*:|$)`, "i");
  return (normalized.match(regex)?.[1] || "").trim();
}

function looksLikeHelpFormText(text = "") {
  const normalized = String(text).split("\r").join("");
  return ["ชื่อ", "พื้นที่", "รายละเอียด", "เบอร์"].every((label) =>
    new RegExp(`(?:^|\\n)${escapeRegex(label)}\\s*:`, "i").test(normalized)
  );
}

function buildUserCaseReceivedFlex(item = {}) {
  return {
    type: "flex",
    altText: `รับเรื่องแล้ว ${item.case_code || ""}`,
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#0b7c86",
        paddingAll: "18px",
        contents: [
          { type: "text", text: "ทีมงานรับข้อมูลแล้ว", color: "#ffffff", weight: "bold", size: "lg", align: "center" },
          { type: "text", text: `เลขเคส: ${item.case_code || "-"}`, color: "#d9f3f5", size: "sm", margin: "sm", align: "center" }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        paddingAll: "20px",
        contents: [
          { type: "text", text: `ชื่อ: ${item.full_name || "-"}`, wrap: true },
          { type: "text", text: `พื้นที่: ${item.location || "-"}`, wrap: true },
          { type: "text", text: `รายละเอียด: ${item.problem || "-"}`, wrap: true },
          { type: "text", text: `เบอร์: ${item.phone || "-"}`, wrap: true },
          { type: "separator", margin: "sm" },
          { type: "text", text: "เราจะตรวจสอบและติดต่อกลับโดยเร็วที่สุด", size: "sm", color: "#4B5563", wrap: true, align: "center" }
        ]
      }
    }
  };
}

async function saveHelpRequest(userId, text) {
  const full_name = extractHelpFormValue(text, "ชื่อ");
  const location = extractHelpFormValue(text, "พื้นที่");
  const problem = extractHelpFormValue(text, "รายละเอียด");
  const phone = extractHelpFormValue(text, "เบอร์");

  const missing = [];
  if (!full_name) missing.push("ชื่อ");
  if (!location) missing.push("พื้นที่");
  if (!problem) missing.push("รายละเอียด");
  if (!phone) missing.push("เบอร์");

  if (missing.length > 0) {
    const error = new Error("INCOMPLETE_HELP_FORM");
    error.code = "INCOMPLETE_HELP_FORM";
    error.missing = missing;
    throw error;
  }

  const lowerText = text.toLowerCase();
  let priority = "normal";

  if (
    lowerText.includes("ด่วน") ||
    lowerText.includes("ฉุกเฉิน") ||
    lowerText.includes("ไม่มีอาหาร") ||
    lowerText.includes("ไม่มีที่อยู่")
  ) {
    priority = "urgent";
  }

  const case_code = await generateCaseCode();

  const { data, error } = await supabase
    .from("help_requests")
    .insert([
      {
        case_code,
        line_user_id: userId || "",
        full_name,
        phone,
        location,
        problem,
        status: "new",
        priority,
        notify_status: "pending",
      },
    ])
    .select()
    .single();

  if (error) {
    console.error("SUPABASE ERROR:", error);
    throw error;
  }

  broadcastSse("case_created", { case_id: data.id, case_code: data.case_code, priority: data.priority, status: data.status, full_name: data.full_name });
  return data;
}

async function getNewCases(limit = 10) {
  const { data, error } = await supabase
    .from("help_requests")
    .select("*")
    .eq("status", "new")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

async function getUrgentCases(limit = 10) {
  const { data, error } = await supabase
    .from("help_requests")
    .select("*")
    .eq("priority", "urgent")
    .in("status", ["new", "in_progress"])
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

async function getTodayCases(limit = 20) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from("help_requests")
    .select("*")
    .gte("created_at", start.toISOString())
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

async function assignCase(caseCode, staffName = "ทีมงาน") {
  const { data, error } = await supabase
    .from("help_requests")
    .update({
      status: "in_progress",
      assigned_to: staffName,
      assigned_at: new Date().toISOString(),
    })
    .eq("case_code", caseCode)
    .select()
    .single();

  if (error) throw error;
  broadcastSse("case_updated", { case_id: data.id, case_code: data.case_code, action: "assign", status: data.status, priority: data.priority, assigned_to: data.assigned_to });
  return data;
}

async function closeCase(caseCode, staffName = "ทีมงาน") {
  const { data, error } = await supabase
    .from("help_requests")
   .update({
  status: "done",
  assigned_to: staffName,
  closed_at: new Date().toISOString(),

  // 🔥 FIX ตรงนี้ด้วย
  priority: "normal",
  urgent: false,
  urgent_flag: false,
  is_urgent: false
})
    .eq("case_code", caseCode)
    .select()
    .single();

  if (error) throw error;
  broadcastSse("case_updated", { case_id: data.id, case_code: data.case_code, action: "close", status: data.status, priority: data.priority, assigned_to: data.assigned_to });
  return data;
}

async function changeCaseStatus(caseCode, newStatus) {
  const allowed = ["new", "in_progress", "done", "cancelled"];
  if (!allowed.includes(newStatus)) {
    throw new Error("Invalid status");
  }

  const payload = { status: newStatus };

  if (newStatus === "done") {
  payload.closed_at = new Date().toISOString();

  // 🔥 FIX KPI mismatch
  payload.priority = "normal";
  payload.urgent = false;
  payload.urgent_flag = false;
  payload.is_urgent = false;
}

  const { data, error } = await supabase
    .from("help_requests")
    .update(payload)
    .eq("case_code", caseCode)
    .select()
    .single();

  if (error) throw error;
  broadcastSse("case_updated", { case_id: data.id, case_code: data.case_code, action: "change_status", status: data.status, priority: data.priority, assigned_to: data.assigned_to });
  return data;
}

function formatCaseLine(item) {
  return (
    `${item.case_code || "-"}\n` +
    `ชื่อ: ${item.full_name || "-"}\n` +
    `พื้นที่: ${item.location || "-"}\n` +
    `โทร: ${item.phone || "-"}\n` +
    `สถานะ: ${item.status || "-"}\n` +
    `ระดับ: ${item.priority || "normal"}`
  );
}

/* =========================
   DASHBOARD HELPERS
========================= */
function escapeForLike(value = "") {
  return String(value).replace(/[% ,()]/g, (m) => ({ "%": "%25", ",": "%2C", "(": "%28", ")": "%29", " ": "%20" }[m]));
}

function applyDashboardFilters(query, filters = {}) {
  const { status = "", priority = "", search = "" } = filters;

  if (status) query = query.eq("status", status);
  if (priority) query = query.eq("priority", priority);

  if (search) {
    const s = escapeForLike(search.trim());
    query = query.or(
      `case_code.ilike.%${s}%,full_name.ilike.%${s}%,phone.ilike.%${s}%,location.ilike.%${s}%,problem.ilike.%${s}%`
    );
  }

  return query;
}

async function getDashboardSummary() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const [
    { count: totalCases },
    { count: newCases },
    { count: urgentCases },
    { count: todayCases },
    { count: inProgressCases },
    { count: doneCases },
    delayedRes,
    followupRes,
  ] = await Promise.all([
    supabase.from("help_requests").select("*", { count: "exact", head: true }),
    supabase.from("help_requests").select("*", { count: "exact", head: true }).eq("status", "new"),
    supabase.from("help_requests").select("*", { count: "exact", head: true }).eq("priority", "urgent").in("status", ["new", "in_progress"]),
    supabase.from("help_requests").select("*", { count: "exact", head: true }).gte("created_at", start.toISOString()),
    supabase.from("help_requests").select("*", { count: "exact", head: true }).eq("status", "in_progress"),
    supabase.from("help_requests").select("*", { count: "exact", head: true }).eq("status", "done"),

    // เคสที่อาจล่าช้า
    supabase.from("help_requests").select("created_at,status"),

    // เคสที่ต้องติดตามด่วน
    supabase.from("help_requests").select("priority,status"),
  ]);

  if (delayedRes.error) throw delayedRes.error;
  if (followupRes.error) throw followupRes.error;

  const now = Date.now();

  const delayedCases = (delayedRes.data || []).filter((row) => {
    if (row.status === "done" || row.status === "cancelled") return false;

    const created = new Date(row.created_at).getTime();
    if (Number.isNaN(created)) return false;

    const ageDays = (now - created) / (1000 * 60 * 60 * 24);
    return ageDays >= 2;
  }).length;

  const followupUrgentCases = (followupRes.data || []).filter((row) => {
    if (row.status === "done" || row.status === "cancelled") return false;

    const priority = String(row.priority || "").toLowerCase();
    return priority === "urgent";
  }).length;

  return {
    total_cases: totalCases || 0,
    new_cases: newCases || 0,
    urgent_cases: urgentCases || 0,
    today_cases: todayCases || 0,
    in_progress_cases: inProgressCases || 0,
    done_cases: doneCases || 0,
    delayed_cases: delayedCases || 0,
    followup_urgent_cases: followupUrgentCases || 0,
  };
}
async function getDashboardGraph(days = 7) {
  const start = new Date();
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from("help_requests")
    .select("created_at")
    .gte("created_at", start.toISOString())
    .order("created_at", { ascending: true });

  if (error) throw error;

  const map = {};
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    map[key] = 0;
  }

  for (const row of data || []) {
    const key = new Date(row.created_at).toISOString().slice(0, 10);
    if (map[key] !== undefined) map[key] += 1;
  }

  return Object.entries(map).map(([date, count]) => ({ date, count }));
}


function normalizeArea(value = "") {
  const v = String(value || "").trim().replace(/[:：]\s*$/, "");
  const lower = v.toLowerCase();

  if (!v) return "";

  const invalidAreaTokens = [
    "-","รายละเอียด","detail","problem","เบอร์","phone",
    "ชื่อ","name","ไม่ทราบ","ไม่ระบุ",
  ];

  if (invalidAreaTokens.includes(lower) || invalidAreaTokens.includes(v)) return "";
  if (/^[0-9\-\s]{7,}$/.test(v)) return "";
  if (v.length > 40) return "";
  if (/[()";\\]/.test(v)) return "";

  return v;
}

function normalizeProblem(value = "") {
  const v = String(value || "").trim().replace(/[:：]\s*$/, "");
  const lower = v.toLowerCase();

  if (!v) return "";

  const invalidProblemTokens = [
    "-",
    "เบอร์",
    "phone",
    "รายละเอียด",
    "detail",
    "problem",
    "ชื่อ",
    "name",
    "location",
    "พื้นที่",
    "ไม่ทราบ",
    "ไม่ระบุ",
  ];

  if (invalidProblemTokens.includes(lower) || invalidProblemTokens.includes(v)) return "";
  if (/^[0-9\-\s]{7,}$/.test(v)) return "";
  if (/[()";\\]/.test(v)) return "";

  return v;
}
function mapProblemToBusinessLabel(problem = "") {
  const p = String(problem || "").toLowerCase();

  if (
    p.includes("บ้าน") ||
    p.includes("ที่อยู่อาศัย") ||
    p.includes("สร้างบ้าน") ||
    p.includes("ซ่อมบ้าน")
  ) {
    return "ที่อยู่อาศัย";
  }

  if (
    p.includes("เงิน") ||
    p.includes("หนี้") ||
    p.includes("ยากจน") ||
    p.includes("รายได้")
  ) {
    return "ความเป็นอยู่ / รายได้";
  }

  if (
    p.includes("เรียน") ||
    p.includes("การศึกษา") ||
    p.includes("ทุน")
  ) {
    return "การศึกษา";
  }

  if (
    p.includes("ป่วย") ||
    p.includes("สุขภาพ") ||
    p.includes("รักษา")
  ) {
    return "สุขภาพ";
  }

  return problem || "อื่นๆ";
}



function average(values = []) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatSLAReadable(hours = 0) {
  if (!hours || hours <= 0) return "0 ชั่วโมง";
  if (hours < 24) return `${Number(hours.toFixed(1))} ชั่วโมง`;
  return `${Number((hours / 24).toFixed(1))} วัน`;
}
function normalizeProblem(value = "") {
  const v = String(value || "").trim().replace(/[:：]\s*$/, "");
  const lower = v.toLowerCase();

  if (!v) return "";

  const invalidProblemTokens = [
    "-",
    "เบอร์",
    "phone",
    "รายละเอียด",
    "detail",
    "problem",
    "ชื่อ",
    "name",
    "location",
    "พื้นที่",
    "ไม่ทราบ",
    "ไม่ระบุ",
  ];

  if (invalidProblemTokens.includes(lower) || invalidProblemTokens.includes(v)) return "";
  if (/^[0-9\-\s]{7,}$/.test(v)) return "";
  if (/[()";\\]/.test(v)) return "";

  return v;
}

function average(values = []) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatSLAReadable(hours = 0) {
  if (!hours || hours <= 0) return "0 ชั่วโมง";
  if (hours < 24) return `${Number(hours.toFixed(1))} ชั่วโมง`;
  return `${Number((hours / 24).toFixed(1))} วัน`;
}

function calculateTrend(currentValue = 0, previousValue = 0) {
  if (!previousValue && !currentValue) {
    return { percent: 0, text: "0%", direction: "neutral", arrow: "→" };
  }
  if (!previousValue && currentValue > 0) {
    return { percent: 100, text: "+100%", direction: "up", arrow: "↑" };
  }

  const diffPercent = ((currentValue - previousValue) / previousValue) * 100;
  const rounded = Number(diffPercent.toFixed(1));
  return {
    percent: rounded,
    text: `${rounded > 0 ? "+" : ""}${rounded}%`,
    direction: rounded > 0 ? "up" : rounded < 0 ? "down" : "neutral",
    arrow: rounded > 0 ? "↑" : rounded < 0 ? "↓" : "→",
  };
}

function buildInsightSentence({ days, conversionRate, previousConversionRate, avgCloseHours, topAreaLabel, topProblemLabel, trend }) {
  const rangeLabel = `${days} วันล่าสุด`;
  const readableSla = formatSLAReadable(avgCloseHours);
  const prevText = `${previousConversionRate || 0}%`;
  const currentText = `${conversionRate || 0}%`;
  const trendLabel =
    trend?.direction === "up"
      ? "ดีขึ้นจากช่วงก่อนหน้า"
      : trend?.direction === "down"
      ? "ลดลงจากช่วงก่อนหน้า"
      : "ทรงตัวเมื่อเทียบกับช่วงก่อนหน้า";

  return `ในช่วง ${rangeLabel} มูลนิธิสามารถปิดเคสได้ ${currentText} ของเคสทั้งหมด เทียบกับช่วงก่อนหน้าที่ ${prevText} ซึ่ง${trendLabel} โดยใช้เวลาเฉลี่ย ${readableSla} ต่อเคส พื้นที่ที่พบเคสมากที่สุดคือ ${topAreaLabel || "-"} และประเภทเคสที่พบบ่อยที่สุดคือ ${topProblemLabel || "-"}`;
}


async function getReportInsights(days = 7) {
  const start = new Date();
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);

  const previousStart = new Date(start);
  previousStart.setDate(previousStart.getDate() - days);

  const previousEnd = new Date(start);
  previousEnd.setMilliseconds(previousEnd.getMilliseconds() - 1);

  const [currentRes, previousRes] = await Promise.all([
    supabase
      .from("help_requests")
      .select("id, location, problem, status, priority, created_at, closed_at")
      .gte("created_at", start.toISOString())
      .order("created_at", { ascending: false }),
    supabase
      .from("help_requests")
      .select("id, status, created_at")
      .gte("created_at", previousStart.toISOString())
      .lte("created_at", previousEnd.toISOString()),
  ]);

  if (currentRes.error) throw currentRes.error;
  if (previousRes.error) throw previousRes.error;

  const rows = currentRes.data || [];
  const previousRows = previousRes.data || [];
  const total = rows.length;
  const doneRows = rows.filter((row) => row.status === "done");
  const previousDoneRows = previousRows.filter((row) => row.status === "done");

  const conversionRate = total > 0 ? Number(((doneRows.length / total) * 100).toFixed(1)) : 0;
  const previousConversionRate = previousRows.length > 0
    ? Number(((previousDoneRows.length / previousRows.length) * 100).toFixed(1))
    : 0;

  const areaMap = {};
  const problemMap = {};
  const slaHours = [];

  for (const row of rows) {
   const area = normalizeArea(row.location);
   const rawProblem = normalizeProblem(row.problem);
   const problem = rawProblem ? mapProblemToBusinessLabel(rawProblem) : "";

    if (area) {
      areaMap[area] = (areaMap[area] || 0) + 1;
    }

    if (problem) {
      problemMap[problem] = (problemMap[problem] || 0) + 1;
    }

    if (row.status === "done" && row.created_at && row.closed_at) {
      const createdAt = new Date(row.created_at).getTime();
      const closedAt = new Date(row.closed_at).getTime();
      if (!Number.isNaN(createdAt) && !Number.isNaN(closedAt) && closedAt >= createdAt) {
        slaHours.push((closedAt - createdAt) / (1000 * 60 * 60));
      }
    }
  }

  const areaBreakdown = Object.entries(areaMap)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "th"));

  const topProblems = Object.entries(problemMap)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "th"));

  const avgCloseHours = average(slaHours);
  const avgCloseDays = Number((avgCloseHours / 24).toFixed(1));
  const trend = calculateTrend(conversionRate, previousConversionRate);
  const totalTrend = calculateTrend(total, previousRows.length);

  return {
    days,
    total_cases_in_range: total,
    closed_cases_in_range: doneRows.length,
    conversion_rate: conversionRate,
    previous_conversion_rate: previousConversionRate,
    conversion_trend: trend,
    conversion_trend_label: trend.direction === "up" ? "ดีขึ้นจากช่วงก่อนหน้า" : trend.direction === "down" ? "ลดลงจากช่วงก่อนหน้า" : "ทรงตัวเมื่อเทียบกับช่วงก่อนหน้า",
    total_trend: totalTrend,
    area_breakdown: areaBreakdown.slice(0, 10),
    top_problems: topProblems.slice(0, 10),
    avg_close_hours: Number(avgCloseHours.toFixed(1)),
    avg_close_days: avgCloseDays,
    avg_close_readable: formatSLAReadable(avgCloseHours),
    top_area_label: areaBreakdown[0]?.label || "-",
    top_area_count: areaBreakdown[0]?.count || 0,
    top_problem_label: topProblems[0]?.label || "-",
    top_problem_count: topProblems[0]?.count || 0,
    summary_sentence: buildInsightSentence({
      days,
      conversionRate,
      previousConversionRate,
      avgCloseHours,
      topAreaLabel: areaBreakdown[0]?.label || "-",
      topProblemLabel: topProblems[0]?.label || "-",
      trend,
    }),
  };
}


function toCsvValue(value) {
  const str = String(value ?? "");
  return `"${str.replace(/"/g, '""')}"`;
}

async function getDashboardReportData(days = 7) {
  const [summary, graph, recentRes, urgentRes, inProgressRes] = await Promise.all([
    getDashboardSummary(),
    getDashboardGraph(days),
    supabase.from("help_requests").select("*").order("created_at", { ascending: false }).limit(10),
    supabase.from("help_requests").select("*").eq("priority", "urgent").in("status", ["new", "in_progress"]).order("created_at", { ascending: false }).limit(10),
    supabase.from("help_requests").select("*").eq("status", "in_progress").order("assigned_at", { ascending: false }).limit(10),
  ]);

  if (recentRes.error) throw recentRes.error;
  if (urgentRes.error) throw urgentRes.error;
  if (inProgressRes.error) throw inProgressRes.error;

  const insights = await getReportInsights(days);

  return {
    generated_at: new Date().toISOString(),
    summary,
    graph,
    insights,
    recent_cases: recentRes.data || [],
    urgent_cases: urgentRes.data || [],
    in_progress_cases: inProgressRes.data || [],
  };
}


function buildCaseListBubble(item = {}) {
  const priorityText = formatPriorityThai(item.priority);
  const statusText = formatCaseStatusThai(item.status);
  const headerColor =
    String(item.priority).toLowerCase() === "urgent" ? "#DC2626" : "#0b7c86";

  return {
    type: "bubble",
    size: "micro",
    header: {
      type: "box",
      layout: "vertical",
      backgroundColor: headerColor,
      paddingAll: "12px",
      contents: [
        {
          type: "text",
          text: item.case_code || "-",
          color: "#ffffff",
          weight: "bold",
          size: "sm",
          wrap: true,
        },
      ],
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      paddingAll: "12px",
      contents: [
        { type: "text", text: `ชื่อ: ${item.full_name || "-"}`, size: "sm", wrap: true },
        { type: "text", text: `พื้นที่: ${item.location || "-"}`, size: "sm", wrap: true },
        {
          type: "box",
          layout: "baseline",
          spacing: "sm",
          contents: [
            { type: "text", text: "สถานะ", size: "xs", color: "#6B7280", flex: 2 },
            { type: "text", text: statusText, size: "xs", color: getStatusColor(item.status), weight: "bold", flex: 4, wrap: true },
          ],
        },
        {
          type: "box",
          layout: "baseline",
          spacing: "sm",
          contents: [
            { type: "text", text: "ระดับ", size: "xs", color: "#6B7280", flex: 2 },
            { type: "text", text: priorityText, size: "xs", color: getPriorityColor(item.priority), weight: "bold", flex: 4, wrap: true },
          ],
        },
        { type: "text", text: `โทร: ${item.phone || "-"}`, size: "xs", wrap: true, color: "#4B5563" },
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      paddingAll: "10px",
      contents: [
        {
          type: "button",
          style: "primary",
          height: "sm",
          color: "#0b7c86",
          action: {
            type: "message",
            label: "ติดตามเคสนี้",
            text: `ติดตามเคส ${item.case_code || "-"}`,
          },
        },
      ],
    },
  };
}

function buildCaseListFlex(title, cases = []) {
  return {
    type: "flex",
    altText: title,
    contents: {
      type: "carousel",
      contents: cases.slice(0, 10).map((item) => buildCaseListBubble(item)),
    },
  };
}

function buildCaseListFallback(title, cases = []) {
  return {
    type: "text",
    text:
      `${title}\n\n` +
      cases
        .slice(0, 10)
        .map(
          (item, index) =>
            `${index + 1}. ${item.case_code || "-"}\nชื่อ: ${item.full_name || "-"}\nพื้นที่: ${item.location || "-"}\nสถานะ: ${formatCaseStatusThai(item.status)}\nระดับ: ${formatPriorityThai(item.priority)}`
        )
        .join("\n\n"),
  };
}

/* =========================
   TEAM NOTIFY TEST
========================= */
app.get("/test-team-notify", async (req, res) => {
  try {
    if (!EFFECTIVE_TEAM_GROUP_ID) {
      return res.status(400).send("TEAM_GROUP_ID / LINE_GROUP_ID is not set yet");
    }

    await pushTeamNotification("🔔 ทดสอบแจ้งเตือนทีมงานจากระบบมูลนิธิ สำเร็จแล้ว");
    return res.status(200).send("OK: team notification sent");
  } catch (error) {
    console.error("TEST TEAM NOTIFY ERROR:", error);
    return res.status(500).send("ERROR: " + error.message);
  }
});

/* =========================
   DASHBOARD ROUTES
========================= */
app.get("/api/dashboard/summary", checkDashboardAuth, async (req, res) => {
  try {
    const summary = await getDashboardSummary();
    res.json({ ok: true, data: summary });
  } catch (error) {
    console.error("DASHBOARD SUMMARY ERROR:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/dashboard/cases", checkDashboardAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);

    let query = supabase
      .from("help_requests")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    query = applyDashboardFilters(query, {
      status: req.query.status || "",
      priority: req.query.priority || "",
      search: req.query.search || "",
    });

    const { data, error } = await query;
    if (error) throw error;

    res.json({ ok: true, data: data || [] });
  } catch (error) {
    console.error("DASHBOARD CASES ERROR:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/dashboard/search", checkDashboardAuth, async (req, res) => {
  try {
    const q = req.query.q || "";
    let query = supabase
      .from("help_requests")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);

    query = applyDashboardFilters(query, { search: q });

    const { data, error } = await query;
    if (error) throw error;

    res.json({ ok: true, data: data || [] });
  } catch (error) {
    console.error("DASHBOARD SEARCH ERROR:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/dashboard/stats", checkDashboardAuth, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days || "7", 10), 31);
    const data = await getDashboardGraph(days);
    res.json({ ok: true, data });
  } catch (error) {
    console.error("DASHBOARD STATS ERROR:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});


app.get("/api/dashboard/report", checkDashboardAuth, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days || "7", 10), 31);
    const data = await getDashboardReportData(days);
    res.json({ ok: true, data });
  } catch (error) {
    console.error("DASHBOARD REPORT ERROR:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/dashboard/export.csv", checkDashboardAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "5000", 10), 5000);

    let query = supabase
      .from("help_requests")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    query = applyDashboardFilters(query, {
      status: req.query.status || "",
      priority: req.query.priority || "",
      search: req.query.search || "",
    });

    const { data, error } = await query;
    if (error) throw error;

    const rows = data || [];
    const headers = [
      "id",
      "case_code",
      "full_name",
      "phone",
      "location",
      "problem",
      "status",
      "priority",
      "assigned_to",
      "assigned_at",
      "created_at",
      "closed_at",
      "notify_status",
      "notified_at",
    ];

    const csv = [
      headers.join(","),
      ...rows.map((row) =>
        headers.map((header) => toCsvValue(row[header])).join(",")
      ),
    ].join("\n");

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="help_requests_report_${stamp}.csv"`);
    res.send("\ufeff" + csv);
  } catch (error) {
    console.error("DASHBOARD EXPORT ERROR:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

function formatCaseStatusThaiForApi(status = "") {
  switch (String(status).toLowerCase()) {
    case "new":
      return "รับเรื่องแล้ว";
    case "in_progress":
      return "กำลังดำเนินการ";
    case "done":
      return "เสร็จสิ้นแล้ว";
    case "cancelled":
      return "ยกเลิก";
    default:
      return status || "-";
  }
}

function formatPriorityThaiForApi(priority = "") {
  switch (String(priority).toLowerCase()) {
    case "urgent":
      return "ด่วน";
    case "high":
      return "สูง";
    case "normal":
      return "ปกติ";
    case "low":
      return "ต่ำ";
    default:
      return priority || "-";
  }
}

async function getLatestCaseUpdateByCaseCode(caseCode) {
  if (!caseCode) return null;

  const { data, error } = await supabase
    .from("case_updates")
    .select("*")
    .eq("case_code", caseCode)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error("GET LATEST CASE UPDATE ERROR:", error);
    return null;
  }

  const latest = Array.isArray(data) ? data[0] : null;
  return latest ? normalizeCaseUpdateRecord(latest) : null;
}

async function getProjectNameFromProjectDb(caseItem = {}) {
  const projectId = caseItem.project_id || null;
  if (!projectId) return "-";

  const { data, error } = await supabase
    .from("projects")
    .select("id, name")
    .eq("id", projectId)
    .maybeSingle();

  if (error) {
    console.error("GET PROJECT NAME ERROR:", error);
    return "-";
  }

  return data?.name || "-";
}
function buildProjectPatchForHelpRequest(projectRef) {
  if (!projectRef) return {};
  return {
    project_id: projectRef
  };
}

app.get("/api/projects/options", checkDashboardAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("projects")
      .select("id, name")
      .order("name", { ascending: true });

    if (error) throw error;

    const rows = (data || []).map((item) => ({
      value: String(item.id),
      label: item.name
    }));

    return res.json({ ok: true, data: rows });
  } catch (error) {
    console.error("PROJECT OPTIONS ERROR:", error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/case/:id/updates", checkDashboardAuth, async (req, res) => {
  try {
    const caseLookup = String(req.params.id || "").trim();
    const caseItem = await getHelpRequestByIdOrCode(caseLookup);

    if (!caseItem) {
      return res.status(404).json({ ok: false, error: "Case not found" });
    }

    const { data, error } = await supabase
      .from("case_updates")
      .select("*")
      .eq("case_code", caseItem.case_code)
      .order("updated_at", { ascending: false });

    if (error) throw error;

    return res.json({
      ok: true,
      data: (data || []).map((row) => normalizeCaseUpdateRecord(row))
    });
  } catch (error) {
    console.error("CASE TIMELINE ERROR:", error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/case/:id", checkDashboardAuth, async (req, res) => {
  try {
    const caseId = String(req.params.id || "").trim();

    const { data: caseItem, error } = await supabase
      .from("help_requests")
      .select("*")
      .or(`id.eq.${caseId},case_code.eq.${caseId}`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    if (!caseItem) {
      return res.status(404).json({ ok: false, error: "Case not found" });
    }

    const [latestUpdate, projectName] = await Promise.all([
      getLatestCaseUpdateByCaseCode(caseItem.case_code),
      getProjectNameFromProjectDb(caseItem)
    ]);

    const enriched = {
      ...caseItem,

      // ภาษาไทย
      status_th: formatCaseStatusThaiForApi(caseItem.status),
      priority_th: formatPriorityThaiForApi(caseItem.priority),

      // โครงการ
      project_id: caseItem.project_id || null,
      project_name: projectName || "-",

      // latest update จาก case_updates
      latest_update: latestUpdate
        ? {
            progress_percent: latestUpdate.progress_percent ?? 0,
            current_step: latestUpdate.current_step || "-",
            waiting_for: latestUpdate.waiting_for || "-",
            latest_note: latestUpdate.latest_note || latestUpdate.note || latestUpdate.message || "-",
            note: latestUpdate.note || latestUpdate.latest_note || latestUpdate.message || "-",
            updated_by: latestUpdate.updater_name || latestUpdate.updated_by || "-",
            updated_at: latestUpdate.updated_at || null
          }
        : {
            progress_percent: 0,
            current_step: "-",
            waiting_for: "-",
            latest_note: "-",
            note: "-",
            updated_by: "-",
            updated_at: null
          }
    };

    return res.json({ ok: true, data: enriched });
  } catch (error) {
    console.error("CASE DETAIL ERROR:", error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/case/:id/assign", checkDashboardAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const allowedStatus = ["new", "in_progress", "done", "cancelled"];
    const allowedPriority = ["normal", "urgent"];

    const staffName = String(req.body.staff_name || "ทีมงาน").trim() || "ทีมงาน";
    const nextStatus = allowedStatus.includes(req.body.status) ? req.body.status : "in_progress";
    const nextPriority = allowedPriority.includes(req.body.priority) ? req.body.priority : "normal";

    const payload = {
  assigned_to: staffName,
  assigned_at: new Date().toISOString(),
  last_action_at: new Date().toISOString(),
  status: nextStatus,
  priority: nextPriority,
};

Object.assign(payload, buildProjectPatchForHelpRequest(req.body.project_ref));

if (nextStatus === "done") {
  payload.closed_at = new Date().toISOString();
}

    const { data, error } = await supabase
      .from("help_requests")
      .update(payload)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    broadcastSse("case_updated", { case_id: data.id, case_code: data.case_code, action: "update_dashboard", status: data.status, priority: data.priority, assigned_to: data.assigned_to });
    res.json({ ok: true, data });
  } catch (error) {
    console.error("CASE ASSIGN ERROR:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/case/:id/update", checkDashboardAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const allowedStatus = ["new", "in_progress", "done", "cancelled"];
    const allowedPriority = ["normal", "urgent"];

    const payload = {};
Object.assign(payload, buildProjectPatchForHelpRequest(req.body.project_ref));

     
    if (typeof req.body.staff_name === "string") {
      payload.assigned_to = req.body.staff_name.trim() || null;
    }

    if (allowedStatus.includes(req.body.status)) {
      payload.status = req.body.status;
      payload.last_action_at = new Date().toISOString();
      if (req.body.status === "done") {
        payload.closed_at = new Date().toISOString();
      }
    }

    if (allowedPriority.includes(req.body.priority)) {
      payload.priority = req.body.priority;
    }

    if (!Object.keys(payload).length) {
      return res.status(400).json({ ok: false, error: "ไม่มีข้อมูลให้อัปเดต" });
    }

    const { data, error } = await supabase
      .from("help_requests")
      .update(payload)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    broadcastSse("case_updated", { case_id: data.id, case_code: data.case_code, action: "close_dashboard", status: data.status, priority: data.priority, assigned_to: data.assigned_to });
    res.json({ ok: true, data });
  } catch (error) {
    console.error("CASE UPDATE ERROR:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/case/:id/close", checkDashboardAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("help_requests")
      .update({
        status: "done",
        closed_at: new Date().toISOString(),
        last_action_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    res.json({ ok: true, data });
  } catch (error) {
    console.error("CASE CLOSE ERROR:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});


async function getTeamMenuCounts() {
  const [newCases, urgentCases, todayCases] = await Promise.all([
    getNewCases(50),
    getUrgentCases(50),
    getTodayCases(100),
  ]);

  return {
    new_cases: (newCases || []).length,
    urgent_cases: (urgentCases || []).length,
    today_cases: (todayCases || []).length,
  };
}

/* =========================
   WEBHOOK
========================= */
app.post("/webhook", async (req, res) => {
  try {
    if (!verifySignature(req)) {
      console.error("❌ Invalid LINE signature");
      return res.status(401).send("Invalid signature");
    }

    const events = req.body.events || [];

    for (const event of events) {
      if (event.type !== "message") continue;
      if (!event.message || event.message.type !== "text") continue;

      const replyToken = event.replyToken;
      const text = event.message.text.trim();
      const userId = event.source?.userId || "";
      const role = await getUserRole(userId);

console.log("EVENT TEXT =", text);
console.log("USER ID =", userId);
console.log("USER ROLE =", role);

console.log("SOURCE TYPE =", event.source?.type);
console.log("GROUP ID =", event.source?.groupId);
console.log("IS TEAM GROUP =", event.source?.groupId === ALLOWED_TEAM_GROUP_ID);

      const eventDedupKey = buildEventDedupKey(event);
      if (LINE_SAFE_PATCH.EVENT_DEDUPE_ENABLED && hasProcessedEvent(eventDedupKey)) {
        console.log("SKIP DUPLICATE EVENT =", eventDedupKey);
        continue;
      }
      markEventProcessed(eventDedupKey);

      const teamGuard = await guardTeamCommand({
  event,
  userId,
  text,
  role,
});

if (!teamGuard.pass) {
  await replyGuardError(replyToken, teamGuard.reason);
  continue;
}

if (text === "เมนูทีมงาน") {
  if (!isGroupEvent(event) || !isAllowedTeamGroup(event)) {
    await safeReply(replyToken, [
      { type: "text", text: "คำสั่งนี้ใช้ได้เฉพาะในกลุ่มทีมงานเท่านั้น" }
    ]);
    continue;
  }

  const role = await getUserRole(userId);

  if (!["admin", "staff"].includes(String(role || "").toLowerCase())) {
    await safeReply(replyToken, [
      { type: "text", text: "เมนูนี้สำหรับทีมงานเท่านั้น" }
    ]);
    continue;
  }

  await safeReply(replyToken, [buildTeamMenuFlex()]);
  continue;
}
      
const addTeamCommand = parseAddTeamCommand(text);
if (addTeamCommand) {
  if (!isGroupEvent(event) || !isAllowedTeamGroup(event)) {
    await safeReply(replyToken, [
      { type: "text", text: "คำสั่งนี้ใช้ได้เฉพาะในกลุ่มทีมงานเท่านั้น" }
    ]);
    continue;
  }

  if (!(await isAdmin(userId))) {
    await safeReply(replyToken, [
      { type: "text", text: "เฉพาะผู้ดูแลระบบ (admin) เท่านั้นที่ใช้คำสั่งนี้ได้" }
    ]);
    continue;
  }

  const { targetUserId, role: newRole } = addTeamCommand;

  // กันยิงตัวเอง
  if (targetUserId === userId) {
    await safeReply(replyToken, [
      { type: "text", text: "ไม่สามารถเปลี่ยนสิทธิ์ของตัวเองได้" }
    ]);
    continue;
  }

  // กัน admin เหลือ 0 คน (กรณี downgrade admin คนสุดท้าย)
  const currentRole = await getUserRole(targetUserId);
  const activeAdminCount = await countActiveAdmins();

  if (currentRole === "admin" && newRole !== "admin" && activeAdminCount <= 1) {
    await safeReply(replyToken, [
      { type: "text", text: "ต้องมีผู้ดูแลระบบ (admin) อย่างน้อย 1 คน" }
    ]);
    continue;
  }

  try {
    await supabase
      .from("line_user_roles")
      .upsert(
        {
          line_user_id: targetUserId,
          role: newRole,
          is_active: true,
        },
        { onConflict: "line_user_id" }
      );

    roleCache.delete(targetUserId);

    await safeReply(replyToken, [
      {
        type: "text",
        text:
          `เพิ่มทีมสำเร็จ\n` +
          `User: ${targetUserId}\n` +
          `Role: ${newRole}`
      }
    ]);
  } catch (error) {
    console.error("ADD TEAM ERROR:", error);
    await safeReply(replyToken, [
      { type: "text", text: "เกิดข้อผิดพลาดในการเพิ่มทีม" }
    ]);
  }

  continue;
}

const removeTeamCommand = parseRemoveTeamCommand(text);
if (removeTeamCommand) {
  if (!isGroupEvent(event) || !isAllowedTeamGroup(event)) {
    await safeReply(replyToken, [
      { type: "text", text: "คำสั่งนี้ใช้ได้เฉพาะในกลุ่มทีมงานเท่านั้น" }
    ]);
    continue;
  }

  if (!(await isAdmin(userId))) {
    await safeReply(replyToken, [
      { type: "text", text: "เฉพาะผู้ดูแลระบบ (admin) เท่านั้นที่ใช้คำสั่งนี้ได้" }
    ]);
    continue;
  }

  const { targetUserId } = removeTeamCommand;

  // กันยิงตัวเอง
  if (targetUserId === userId) {
    await safeReply(replyToken, [
      { type: "text", text: "ไม่สามารถลบสิทธิ์ของตัวเองได้" }
    ]);
    continue;
  }

  // กัน admin เหลือ 0 คน
  const targetRole = await getUserRole(targetUserId);
  const activeAdminCount = await countActiveAdmins();

  if (targetRole === "admin" && activeAdminCount <= 1) {
    await safeReply(replyToken, [
      { type: "text", text: "ต้องมีผู้ดูแลระบบ (admin) อย่างน้อย 1 คน" }
    ]);
    continue;
  }

  try {
    await softDisableLineUserRole(targetUserId);

    await safeReply(replyToken, [
      {
        type: "text",
        text:
          `ลบทีมสำเร็จ\n` +
          `User: ${targetUserId}\n` +
          `สถานะ: ปิดการใช้งาน`
      }
    ]);
  } catch (error) {
    console.error("REMOVE TEAM ERROR:", error);
    await safeReply(replyToken, [
      { type: "text", text: "เกิดข้อผิดพลาดในการลบทีม" }
    ]);
  }

  continue;
}
       
if (text === "อัปเดตเคส") {
  if (!(event.source?.type === "group" && event.source?.groupId === ALLOWED_TEAM_GROUP_ID)) {
    await safeReply(replyToken, [
      { type: "text", text: "คำสั่งนี้ใช้ได้เฉพาะในกลุ่มทีมงานเท่านั้น" }
    ]);
    continue;
  }

  if (!(role === "admin" || role === "staff")) {
    await safeReply(replyToken, [
      { type: "text", text: "เฉพาะทีมงานที่ได้รับสิทธิ์เท่านั้น" }
    ]);
    continue;
  }

  setCaseUpdateState(userId, {
    step: "await_case_code",
    caseCode: "",
    updateStage: "",
    detail: ""
  });

  await safeReply(replyToken, [
    {
      type: "text",
      text: "เริ่มโหมดอัปเดตเคส\nกรุณาส่งเลขเคสที่ต้องการอัปเดต"
    }
  ]);
  continue;
}

const caseUpdateState = getCaseUpdateState(userId);

if (caseUpdateState?.step === "await_case_code") {
  const foundCase = await findLatestCaseByCaseCodeOrPhone(text);

  if (!foundCase) {
    await safeReply(replyToken, [
      { type: "text", text: "ไม่พบเลขเคสนี้ในระบบ\nกรุณาส่งเลขเคสใหม่อีกครั้ง" }
    ]);
    continue;
  }

  caseUpdateState.caseCode = foundCase.case_code;
  caseUpdateState.step = "await_update_stage";
  setCaseUpdateState(userId, caseUpdateState);

  await safeReply(replyToken, [
    {
      type: "text",
      text:
        `พบเคส: ${foundCase.case_code}\n` +
        `ชื่อ: ${foundCase.full_name || "-"}\n\n` +
        "กรุณาเลือกสถานะอัปเดตจากปุ่มด้านล่าง หรือพิมพ์เองก็ได้",
    quickReply: buildCaseUpdateStageQuickReply()
    }
  ]);
  continue;
}

if (caseUpdateState?.step === "await_update_stage") {
  if (!CASE_UPDATE_STAGES.includes(text)) {
   await safeReply(replyToken, [
  {
    type: "text",
    text:
      "สถานะไม่ถูกต้อง\nกรุณาเลือกจากปุ่มด้านล่าง หรือพิมพ์ตามรายการนี้:\n- " +
      CASE_UPDATE_STAGES.join("\n- "),
    quickReply: buildCaseUpdateStageQuickReply()
  }
]);
continue;
  }

  caseUpdateState.updateStage = text;
  caseUpdateState.step = "await_detail";
  setCaseUpdateState(userId, caseUpdateState);

  await safeReply(replyToken, [
    {
      type: "text",
      text:
        `สถานะที่เลือก: ${text}\n` +
        "กรุณาพิมพ์รายละเอียดการอัปเดต"
    }
  ]);
  continue;
}

if (caseUpdateState?.step === "await_detail") {
  const detail = String(text || "").trim();

  if (!detail) {
    await safeReply(replyToken, [
      { type: "text", text: "กรุณาพิมพ์รายละเอียดการอัปเดต" }
    ]);
    continue;
  }

  try {
    const saved = await upsertCaseUpdateLegacy({
      caseCode: caseUpdateState.caseCode,
      updateStage: caseUpdateState.updateStage,
      detail,
      updatedBy: userId
    });

    clearCaseUpdateState(userId);

    await safeReply(replyToken, [
      {
        type: "text",
        text:
          "บันทึกอัปเดตเคสสำเร็จ\n" +
          `เลขเคส: ${saved.case_code}\n` +
          `สถานะ: ${saved.current_step}\n` +
          `ความคืบหน้า: ${saved.progress_percent}%`
      }
    ]);
  } catch (error) {
    console.error("UPSERT CASE UPDATE ERROR:", error);
    await safeReply(replyToken, [
      { type: "text", text: "เกิดข้อผิดพลาดในการบันทึกอัปเดตเคส" }
    ]);
  }

  continue;
}
       
       

if (text === "เมนูแอดมิน" || text === "เปิดเมนูแอดมิน" || text === "รีเฟรชเมนูแอดมิน") {
  if (!isGroupEvent(event)) {
    await safeReply(replyToken, [{ type: "text", text: "❌ คำสั่งนี้ใช้ได้เฉพาะในไลน์กลุ่มเท่านั้น" }]);
    continue;
  }

  if (TEAM_GROUP_ENABLED && !isAllowedTeamGroup(event)) {
    await safeReply(replyToken, [{ type: "text", text: "❌ เมนูแอดมินใช้ได้เฉพาะในกลุ่มทีมงานที่ได้รับอนุญาตเท่านั้น" }]);
    continue;
  }

  if (!(await isAdmin(userId))) {
    await safeReply(replyToken, [{ type: "text", text: "❌ เมนูนี้สำหรับผู้ดูแลระบบ" }]);
    continue;
  }

  await safeReply(replyToken, [buildAdminMenuFlex()], [
    {
      type: "text",
      text:
        "เมนูแอดมิน\n\n" +
        "- ดูเคสใหม่\n" +
        "- ดูเคสด่วน\n" +
        "- เคสวันนี้\n" +
        "- รายงาน\n" +
        "- สรุปรายวัน\n" +
        "- ดูทีม"
    },
  ]);
  continue;
}

if (text === "คำสั่งดูสิทธิ์") {
  await safeReply(replyToken, [{
    type: "text",
    text:
      "คำสั่งดูสิทธิ์ทีมงาน\n\n" +
      "ใช้รูปแบบ:\n" +
      "ดูสิทธิ์ USER_ID\n\n" +
      "ตัวอย่าง:\n" +
      "ดูสิทธิ์ U1234567890abcdef"
  }]);
  continue;
}

if (text === "คำสั่งเพิ่มทีม") {
  await safeReply(replyToken, [{
    type: "text",
    text:
      "คำสั่งเพิ่มทีม\n\n" +
      "ใช้รูปแบบ:\n" +
      "เพิ่มทีม USER_ID role\n\n" +
      "role ที่ใช้ได้:\n" +
      "- admin\n- staff\n- viewer\n\n" +
      "ตัวอย่าง:\n" +
      "เพิ่มทีม U1234567890abcdef staff"
  }]);
  continue;
}

if (text === "คำสั่งลบทีม") {
  await safeReply(replyToken, [{
    type: "text",
    text:
      "คำสั่งลบทีม\n\n" +
      "ใช้รูปแบบ:\n" +
      "ลบทีม USER_ID\n\n" +
      "ตัวอย่าง:\n" +
      "ลบทีม U1234567890abcdef"
  }]);
  continue;
}

if (text === "Smart Alert") {
  await safeReply(replyToken, [buildSmartAlertFlex()]);
  continue;
}
      
if (text === "เมนูทีมงาน" || text === "เปิดเมนูทีมงาน" || text === "รีเฟรชเมนูทีมงาน") {
  if (!(await isViewer(userId))) {
    await safeReply(replyToken, [{ type: "text", text: "เฉพาะทีมงานหรือผู้มีสิทธิ์เท่านั้น" }]);
    continue;
  }

  const counts = await getTeamMenuCounts();
  await safeReply(replyToken, [buildTeamMenuFlex(counts)], [
    {
      type: "text",
      text:
        "เมนูทีมงาน\n\n" +
        `ดูเคสใหม่ (${counts.new_cases})\n` +
        `เคสด่วน (${counts.urgent_cases})\n` +
        `เคสวันนี้ (${counts.today_cases})`,
    },
  ]);
  continue;
}


if (/^ติดตามอีกครั้ง\s+/i.test(text)) {
  const caseCode = text.replace(/^ติดตามอีกครั้ง\s+/i, "").trim();

  try {
    const foundCase = await findLatestCaseByCaseCodeOrPhone(caseCode);

    if (!foundCase) {
      await safeReply(replyToken, [
        {
          type: "text",
          text: "ไม่พบข้อมูลเคสสำหรับแจ้งเตือนทีม กรุณาลองค้นหาเคสใหม่อีกครั้ง",
        },
      ]);
      continue;
    }

    if (String(foundCase.status).toLowerCase() === "done") {
      await safeReply(replyToken, [
        {
          type: "text",
          text: "เคสนี้ปิดแล้ว จึงไม่ส่งแจ้งเตือนทีมซ้ำครับ",
        },
      ]);
      continue;
    }

    const cooldownMs = 10 * 60 * 1000;
    const trackerKey = String(foundCase.case_code || caseCode);
    const now = Date.now();
    const prev = caseFollowupTracker[trackerKey];

    if (prev && now - prev.lastAt < cooldownMs) {
      await safeReply(replyToken, [
        {
          type: "text",
          text: "เพิ่มรายการแจ้งเตือนเคสนี้ไปไม่นาน กรุณารอสักครู่แล้วลองอีกครั้ง",
        },
      ]);
      continue;
    }

    const nextCount = (prev?.count || 0) + 1;
    caseFollowupTracker[trackerKey] = {
      lastAt: now,
      count: nextCount,
    };

    if (EFFECTIVE_TEAM_GROUP_ID) {
      await pushTeamFollowupNotification(foundCase, nextCount);
    } else {
      console.warn("TEAM GROUP ID NOT SET FOR FOLLOWUP");
    }

    await safeReply(replyToken, [
      {
        type: "text",
        text: "เพิ่มการแจ้งเตือนเคสนี้ไปที่ทีมงานแล้ว กรุณารอสักครู่แล้วลองอีกครั้ง",
      },
    ]);
  } catch (err) {
    console.error("FOLLOWUP NOTIFY ERROR:", err);
    await safeReply(replyToken, [
      {
        type: "text",
        text: "แจ้งเตือนทีมงานไม่สำเร็จ กรุณาลองใหม่อีกครั้ง",
      },
    ]);
  }

  continue;
}


if (text === "ขอความช่วยเหลือ") {
  await safeReply(replyToken, [buildHelpRequestChoiceFlex()]);
  continue;
}

if (text === "ขอความช่วยเหลือครั้งแรก") {
  await safeReply(replyToken, [buildHelpFormFlex()], [
    {
      type: "text",
      text:
        "กรุณาส่งข้อมูลดังนี้\n" +
        "ชื่อ:\n" +
        "พื้นที่:\n" +
        "รายละเอียด:\n" +
        "เบอร์:",
    },
  ]);
  continue;
}

if (text === "ติดต่อเจ้าหน้าที่") {
  await safeReply(replyToken, [buildContactOfficerFlex()], [
    {
      type: "text",
      text:
        "ติดต่อเจ้าหน้าที่ โทร.081-959-7060\n\n" +
        "กรุณาพิมพ์ข้อความที่ต้องการสอบถาม หรือโทรติดต่อผ่านช่องทางของมูลนิธิได้เลยครับ",
    },
  ]);
  continue;
}
if (text.startsWith("ติดตามเคส ")) {
  const caseCode = text.replace("ติดตามเคส ", "").trim();

  try {
    const found = await findLatestCaseByCaseCodeOrPhone(caseCode);

    if (!found) {
      await safeReply(replyToken, [
        { type: "text", text: "ไม่พบเคสในระบบ" },
      ]);
      continue;
    }

    await safeReply(replyToken, [buildCaseTrackingFlex(found)]);
  } catch (err) {
    console.error("TRACK CASE DIRECT ERROR:", err);
    await safeReply(replyToken, [
      { type: "text", text: "เกิดข้อผิดพลาดในการติดตามเคส" },
    ]);
  }

  continue;
}
if (text.startsWith("ติดตามอีกครั้ง ")) {
  const caseCode = text.replace("ติดตามอีกครั้ง ", "").trim();

  try {
    const found = await findLatestCaseByCaseCodeOrPhone(caseCode);

    if (!found) {
      await safeReply(replyToken, [
        { type: "text", text: "ไม่พบเคสในระบบ" },
      ]);
      continue;
    }

    await safeReply(replyToken, [buildCaseTrackingFlex(found)]);
  } catch (err) {
    console.error("TRACK AGAIN ERROR:", err);
    await safeReply(replyToken, [
      { type: "text", text: "ติดตามเคสไม่สำเร็จ" },
    ]);
  }

  continue;
}
       
if (text === "ติดตามการขอความช่วยเหลือ") {
  if (userId) {
    userStates[userId] = "tracking_case";
  }
  
  await safeReply(replyToken, [
    {
      type: "text",
      text: 'กรุณาส่ง "เลขเคส" หรือ "เบอร์โทร" เพื่อติดตามสถานะ',
    },
  ]);
  continue;
}


       
if (text === "ค้นหาเคส") {
  if (userId) {
    userStates[userId] = "search_case";
  }

  await safeReply(replyToken, [
    {
      type: "text",
      text: "กรุณาส่งเลขเคสหรือเบอร์โทร\n\nตัวอย่าง:\n21032026-001\n0976543215",
    },
  ]);
  continue;
}

if (
  userId &&
  userStates[userId] === "search_case" &&
  (/^\d{8}-\d{3}$/.test(text) || /^\d{9,10}$/.test(text))
) {
  const found = await findLatestCaseByCaseCodeOrPhone(text);

  if (!found) {
    await safeReply(replyToken, [
      { type: "text", text: "ไม่พบเคสในระบบ" },
    ]);
    continue;
  }

  delete userStates[userId];

  await safeReply(replyToken, [buildCaseTrackingFlex(found)]);
  continue;
}

if (userId && userStates[userId] === "tracking_case") {

  if (text === "ยกเลิก" || text === "ออก") {
    delete userStates[userId];

    await safeReply(replyToken, [
      {
        type: "text",
        text: "ออกจากโหมดติดตามเคสแล้วครับ",
      },
    ]);

    continue;
  }

  try {
    const foundCase = await findLatestCaseByCaseCodeOrPhone(text);

    if (!foundCase) {
      await safeReply(replyToken, [
        {
          type: "text",
          text:
            "ไม่พบข้อมูลเคส\n" +
            "กรุณาตรวจสอบเลขเคสหรือเบอร์โทรอีกครั้ง",
        },
      ]);
      delete userStates[userId];
      continue;
    }

    await safeReply(
      replyToken,
      [buildCaseTrackingFlex(foundCase)],
      [
        {
          type: "text",
          text:
            "ผลการติดตามเคส\n\n" +
            `เลขเคส: ${foundCase.case_code || "-"}\n` +
            `ชื่อ: ${foundCase.full_name || "-"}\n` +
            `สถานะ: ${formatCaseStatusThai(foundCase.status)}\n` +
            `ระดับ: ${formatPriorityThai(foundCase.priority)}\n` +
            `พื้นที่: ${foundCase.location || "-"}\n` +
            `ผู้รับเคส: ${foundCase.assigned_to || "ยังไม่มีผู้รับผิดชอบ"}\n` +
            `อัปเดตล่าสุด: ${formatThaiDateTime(
              foundCase.closed_at ||
                foundCase.assigned_at ||
                foundCase.created_at
            )}`,
        },
      ]
    );

    delete userStates[userId];
  } catch (err) {
    console.error("TRACK CASE ERROR:", err);
    await safeReply(replyToken, [
      {
        type: "text",
        text: "ติดตามเคสไม่สำเร็จครับ กรุณาลองใหม่อีกครั้ง",
      },
    ]);
    delete userStates[userId];
  }

  continue;
}


      if (text === "รหัสของฉัน") {
        await safeReply(replyToken, [{ type: "text", text: userId || "ไม่พบ userId" }]);
        continue;
      }

      if (text === "สิทธิ์ของฉัน") {
        await safeReply(replyToken, [{ type: "text", text: `สิทธิ์ของคุณคือ: ${role}` }]);
        continue;
      }

      if (text.startsWith("ตั้งสิทธิ์ ")) {
        if (role !== "admin") {
          await safeReply(replyToken, [{ type: "text", text: "❌ เฉพาะ admin เท่านั้น" }]);
          continue;
        }

        const parts = text.split(/\s+/).filter(Boolean);
        if (parts.length < 3) {
          await safeReply(replyToken, [{ type: "text", text: "รูปแบบคำสั่ง: ตั้งสิทธิ์ USER_ID staff\nสิทธิ์ที่ใช้ได้: admin, staff, viewer, guest" }]);
          continue;
        }

        const targetUserId = parts[1].trim();
        const newRole = parts[2].trim().toLowerCase();

        try {
          await setLineUserRole(targetUserId, newRole);
          await safeReply(replyToken, [{ type: "text", text: `✅ ตั้งสิทธิ์สำเร็จ\nUSER ID: ${targetUserId}\nROLE: ${newRole}` }]);
        } catch (err) {
          console.error("SET ROLE ERROR:", err);
          await safeReply(replyToken, [{ type: "text", text: "ตั้งสิทธิ์ไม่สำเร็จ\nสิทธิ์ที่ใช้ได้: admin, staff, viewer, guest" }]);
        }
        continue;
      }

      if (text === "เมนู" || text === "กลับสู่เมนูหลัก") {
        await safeReply(replyToken, [buildMainMenuText(role)]);
        continue;
      }


if (text === "ดูเคสใหม่" || text === "เคสใหม่") {
  if (!(await isViewer(userId))) {
    await safeReply(replyToken, [{ type: "text", text: "❌ คุณไม่มีสิทธิ์ดูข้อมูลเคส" }]);
    continue;
  }

  try {
    const cases = await getNewCases(10);

    if (!cases.length) {
      await safeReply(replyToken, [{ type: "text", text: "ตอนนี้ยังไม่มีเคสใหม่ครับ" }]);
      continue;
    }

    await safeReply(
      replyToken,
      [buildCaseListFlex("เคสใหม่ล่าสุด", cases)],
      [buildCaseListFallback("เคสใหม่ล่าสุด", cases)]
    );
  } catch (err) {
    console.error("GET NEW CASES ERROR:", err);
    await safeReply(replyToken, [{ type: "text", text: "ดึงเคสใหม่ไม่สำเร็จครับ" }]);
  }
  continue;
}


if (text === "ดูเคสด่วน" || text === "เคสด่วน") {
  if (!(await isViewer(userId))) {
    await safeReply(replyToken, [{ type: "text", text: "❌ คุณไม่มีสิทธิ์ดูเคสด่วน" }]);
    continue;
  }

  try {
    const cases = await getUrgentCases(10);

    if (!cases.length) {
      await safeReply(replyToken, [{ type: "text", text: "ตอนนี้ยังไม่มีเคสด่วนครับ" }]);
      continue;
    }

    await safeReply(
      replyToken,
      [buildCaseListFlex("เคสด่วน", cases)],
      [buildCaseListFallback("เคสด่วน", cases)]
    );
  } catch (err) {
    console.error("GET URGENT CASES ERROR:", err);
    await safeReply(replyToken, [{ type: "text", text: "ดึงเคสด่วนไม่สำเร็จครับ" }]);
  }
  continue;
}


if (text === "เคสวันนี้") {
  if (!(await isViewer(userId))) {
    await safeReply(replyToken, [{ type: "text", text: "❌ คุณไม่มีสิทธิ์ดูเคสวันนี้" }]);
    continue;
  }

  try {
    const cases = await getTodayCases(10);

    if (!cases.length) {
      await safeReply(replyToken, [{ type: "text", text: "วันนี้ยังไม่มีเคสเข้าระบบครับ" }]);
      continue;
    }

    await safeReply(
      replyToken,
      [buildCaseListFlex("เคสวันนี้", cases)],
      [buildCaseListFallback("เคสวันนี้", cases)]
    );
  } catch (err) {
    console.error("GET TODAY CASES ERROR:", err);
    await safeReply(replyToken, [{ type: "text", text: "ดึงเคสวันนี้ไม่สำเร็จครับ" }]);
  }
  continue;
}

      if (text.startsWith("รับเคส ")) {
        if (!(await isStaff(userId))) {
          await safeReply(replyToken, [{ type: "text", text: "❌ เฉพาะทีมงานเท่านั้น" }]);
          continue;
        }

        try {
          const caseCode = text.replace("รับเคส ", "").trim();
          const updated = await assignCase(caseCode, "ทีมงาน");

          await safeReply(replyToken, [
            {
              type: "text",
              text:
                "✅ รับเคสเรียบร้อยแล้ว\n\n" +
                `เลขเคส: ${updated.case_code}\n` +
                `สถานะ: ${updated.status}\n` +
                `ผู้รับเคส: ${updated.assigned_to || "-"}`,
            },
          ]);
        } catch (err) {
          console.error("ASSIGN CASE ERROR:", err);
          await safeReply(replyToken, [{ type: "text", text: "รับเคสไม่สำเร็จ กรุณาตรวจเลขเคสอีกครั้ง" }]);
        }
        continue;
      }

      if (text.startsWith("ปิดเคส ")) {
        if (!(await isStaff(userId))) {
          await safeReply(replyToken, [{ type: "text", text: "❌ เฉพาะทีมงานเท่านั้น" }]);
          continue;
        }

        try {
          const caseCode = text.replace("ปิดเคส ", "").trim();
          const updated = await closeCase(caseCode, "ทีมงาน");

          await safeReply(replyToken, [
            {
              type: "text",
              text:
                "✅ ปิดเคสเรียบร้อยแล้ว\n\n" +
                `เลขเคส: ${updated.case_code}\n` +
                `สถานะ: ${updated.status}`,
            },
          ]);
        } catch (err) {
          console.error("CLOSE CASE ERROR:", err);
          await safeReply(replyToken, [{ type: "text", text: "ปิดเคสไม่สำเร็จ กรุณาตรวจเลขเคสอีกครั้ง" }]);
        }
        continue;
      }

      if (text.startsWith("เปลี่ยนสถานะ ")) {
        if (!(await isStaff(userId))) {
          await safeReply(replyToken, [{ type: "text", text: "❌ เฉพาะทีมงานเท่านั้น" }]);
          continue;
        }

        try {
          const parts = text.split(" ");
          if (parts.length < 3) {
            await safeReply(replyToken, [{ type: "text", text: "รูปแบบคำสั่ง: เปลี่ยนสถานะ 17032026-001 in_progress" }]);
            continue;
          }

          const caseCode = parts[1].trim();
          const newStatus = parts[2].trim();
          const updated = await changeCaseStatus(caseCode, newStatus);

          await safeReply(replyToken, [
            {
              type: "text",
              text:
                "🔄 เปลี่ยนสถานะสำเร็จ\n\n" +
                `เลขเคส: ${updated.case_code}\n` +
                `สถานะใหม่: ${updated.status}`,
            },
          ]);
        } catch (err) {
          console.error("CHANGE STATUS ERROR:", err);
          await safeReply(replyToken, [
            {
              type: "text",
              text: "เปลี่ยนสถานะไม่สำเร็จ\nสถานะที่ใช้ได้: new, in_progress, done, cancelled",
            },
          ]);
        }
        continue;
      }

      if (looksLikeHelpFormText(text)) {
        try {
          const insertedCase = await saveHelpRequest(userId, text);

          await safeReply(
            replyToken,
            [buildUserCaseReceivedFlex(insertedCase)],
            [
              {
                type: "text",
                text:
                  "ทีมงานได้รับข้อมูลแล้วครับ 🙏\n" +
                  `เลขเคสของคุณคือ ${insertedCase.case_code}\n` +
                  "เราจะตรวจสอบและติดต่อกลับโดยเร็วที่สุด",
              },
            ]
          );

try {
  await pushTeamNewCaseNotification(insertedCase);

            await supabase
              .from("help_requests")
              .update({
                notify_status: "sent",
                notified_at: new Date().toISOString(),
              })
              .eq("id", insertedCase.id);
          } catch (notifyError) {
            console.error("TEAM NOTIFICATION FAILED:", notifyError.message);

            await supabase
              .from("help_requests")
              .update({
                notify_status: "failed",
              })
              .eq("id", insertedCase.id);
          }
        } catch (err) {
          console.error("SAVE HELP REQUEST FAILED:", err);
          if (err && err.code === "INCOMPLETE_HELP_FORM") {
            const missingText = Array.isArray(err.missing) ? err.missing.join(" / ") : "ชื่อ / พื้นที่ / รายละเอียด / เบอร์";
            await safeReply(
              replyToken,
              [
                buildHelpFormFlex(),
                {
                  type: "text",
                  text:
                    "กรุณากรอกข้อมูลให้ครบก่อนส่ง\n" +
                    `ยังขาด: ${missingText}\n\n` +
                    'กดปุ่ม "กรอกข้อมูลตามนี้" อีกครั้ง หรือพิมพ์ข้อมูลต่อจากข้อความเดิมได้เลย',
                },
              ]
            );
          } else {
            await safeReply(replyToken, [
              {
                type: "text",
                text: "บันทึกข้อมูลไม่สำเร็จครับ กรุณาลองใหม่อีกครั้ง",
              },
            ]);
          }
        }
        continue;
      }

      if (["บริจาค", "ซากาต", "ช่วยเหลือ", "ดูโครงการ"].includes(text)) {
        await safeReply(replyToken, [donationFlex], donationFallbackText);
        continue;
      }


      if (text === "เกี่ยวกับมูลนิธิ") {
        await safeReply(replyToken, [
          {
            type: "text",
            text:
              "มูลนิธิของเราดำเนินงานเพื่อช่วยเหลือผู้ยากไร้ สนับสนุนเคสเร่งด่วน และสร้างโอกาสให้ผู้ขาดแคลนในสังคม ❤️",
          },
        ]);
        continue;
      }

      await safeReply(replyToken, [
        {
          type: "text",
          text:
            "พิมพ์คำว่า 'เมนู' เพื่อดูคำสั่งทั้งหมด\n\n" +
            "หรือใช้คำสั่งหลักได้ทันที:\n" +
            "- บริจาค\n" +
            "- ขอความช่วยเหลือ\n" +
            "- ดูเคสใหม่\n" +
            "- เคสด่วน\n" +
            "- เคสวันนี้\n\n" +
            "คำสั่งช่วยตั้งค่า:\n" +
            "- รหัสของฉัน\n" +
            "- สิทธิ์ของฉัน",
        },
      ]);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("WEBHOOK ERROR:", err);
    return res.sendStatus(200);
  }
});

// PATCH SAFE: Dashboard API Fix Only

function safeJson(res, data) {
  try {
    res.setHeader("Content-Type", "application/json");
    res.json(data);
  } catch (e) {
    console.error("[SAFE_JSON_ERROR]", e);
    res.status(500).json({
      success: false,
      error: "JSON_RESPONSE_FAILED",
    });
  }
}

// ===== PATCH: /api/alerts =====
app.get("/api/alerts", async (req, res) => {
  try {
    const status = req.query.status || "open";

    return safeJson(res, {
      success: true,
      data: [],
    });

  } catch (err) {
    console.error("[ALERTS_ERROR]", err);

    return safeJson(res, {
      success: true,
      data: [],
      fallback: true,
    });
  }
});

// ===== PATCH: /api/executive/decision-board =====
app.get("/api/executive/decision-board", async (req, res) => {
  try {
    return safeJson(res, {
      success: true,
      data: {},
    });

  } catch (err) {
    console.error("[EXEC_BOARD_ERROR]", err);

    return safeJson(res, {
      success: true,
      data: {},
      fallback: true,
    });
  }
});

/**
 * Phase PRO MAX UI - Golden-safe patch
 * เพิ่ม block นี้ก่อน app.listen(...)
 */

const TEAM_MENU_VERSION = process.env.TEAM_MENU_VERSION || "PRO-MAX-UI-v1";

const __teamSseClients = new Set();

function broadcastTeamUiEvent(payload = {}) {
  const data = `data: ${JSON.stringify({ ok: true, ts: Date.now(), ...payload })}\n\n`;
  for (const res of __teamSseClients) {
    try { res.write(data); } catch (_) {}
  }
}

app.get("/api/team/ui-stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  res.write(`data: ${JSON.stringify({ ok:true, event:"connected", version:TEAM_MENU_VERSION, ts:Date.now() })}\n\n`);
  __teamSseClients.add(res);

  const keepAlive = setInterval(() => {
    try { res.write(`: keep-alive ${Date.now()}\n\n`); } catch (_) {}
  }, 25000);

  req.on("close", () => {
    clearInterval(keepAlive);
    __teamSseClients.delete(res);
  });
});

/**
 * เรียกต่อท้ายในจุดที่ assign / update status / send update สำเร็จ เช่น:
 * broadcastTeamUiEvent({ event: "cases_updated" });
 */


/* =========================
   COMMAND CENTER (ADD ONLY / SAFE PATCH)
   วางบล็อกนี้ก่อน app.listen(...) ตัวสุดท้าย
========================= */

function buildCommandCenterSummaryText(summary = {}, days = 7) {
  return `ช่วง ${days} วันล่าสุด มีเคสด่วนที่ยังเปิด ${summary.urgent_open_cases || 0} เคส, เคสล่าช้า ${summary.delayed_cases || 0} เคส, ปิดแล้ว ${summary.done_cases || 0} เคส และติดตามด่วน ${summary.followup_urgent_cases || 0} เคส`;
}

function applyCommandCenterSearch(rows = [], q = "") {
  const keyword = String(q || "").trim().toLowerCase();
  if (!keyword) return rows;

  return rows.filter((row) => {
    return [
      row.case_code,
      row.full_name,
      row.phone,
      row.location,
      row.problem,
      row.status,
      row.priority,
      row.assigned_to,
    ]
      .map((value) => String(value || "").toLowerCase())
      .some((value) => value.includes(keyword));
  });
}

async function getCommandCenterRows(limit = 100) {
  const { data, error } = await supabase
    .from("help_requests")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

function filterDelayedCases(rows = []) {
  const now = Date.now();
  return rows.filter((row) => {
    if (["done", "cancelled"].includes(String(row.status || "").toLowerCase())) return false;
    const createdAt = new Date(row.created_at).getTime();
    if (Number.isNaN(createdAt)) return false;
    const ageDays = (now - createdAt) / (1000 * 60 * 60 * 24);
    return ageDays >= 2;
  });
}

function filterUrgentOpenCases(rows = []) {
  return rows.filter((row) => {
    const status = String(row.status || "").toLowerCase();
    const priority = String(row.priority || "").toLowerCase();
    return priority === "urgent" && ["new", "in_progress"].includes(status);
  });
}

function filterClosedCases(rows = []) {
  return rows.filter((row) => String(row.status || "").toLowerCase() === "done");
}

async function getCommandCenterSummary(days = 7) {
  const dashboardSummary = await getDashboardSummary();

  return {
    ...dashboardSummary,
    urgent_open_cases: dashboardSummary.urgent_cases || 0,
    summary_text: buildCommandCenterSummaryText({
      urgent_open_cases: dashboardSummary.urgent_cases || 0,
      delayed_cases: dashboardSummary.delayed_cases || 0,
      done_cases: dashboardSummary.done_cases || 0,
      followup_urgent_cases: dashboardSummary.followup_urgent_cases || 0,
    }, days),
  };
}

async function getCommandCenterList(type = "urgent_open", q = "", limit = 30) {
  const rows = await getCommandCenterRows(Math.max(limit, 100));
  let filtered = rows;

  switch (type) {
    case "closed":
      filtered = filterClosedCases(rows);
      break;
    case "delayed":
      filtered = filterDelayedCases(rows);
      break;
    case "followup_urgent":
      filtered = filterUrgentOpenCases(rows);
      break;
    case "latest":
      filtered = rows;
      break;
    case "urgent_open":
    default:
      filtered = filterUrgentOpenCases(rows);
      break;
  }

  return applyCommandCenterSearch(filtered, q).slice(0, limit);
}

async function getCommandCenterActivity(limit = 12) {
  const { data, error } = await supabase
    .from("help_requests")
    .select("id, case_code, full_name, status, priority, assigned_to, created_at, assigned_at, closed_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;

  return (data || []).map((row) => {
    let activityText = `สถานะ ${formatCaseStatusThai(row.status)} / ระดับ ${formatPriorityThai(row.priority)}`;
    let eventTime = row.created_at;

    if (row.closed_at) {
      activityText = `ปิดเคสแล้ว${row.assigned_to ? ` โดย ${row.assigned_to}` : ""}`;
      eventTime = row.closed_at;
    } else if (row.assigned_at) {
      activityText = `รับเคสแล้ว${row.assigned_to ? ` โดย ${row.assigned_to}` : ""}`;
      eventTime = row.assigned_at;
    }

    return {
      ...row,
      activity_text: activityText,
      event_time: eventTime,
    };
  });
}


function buildSmartAlerts(rows = []) {
  const alerts = [];
  const urgentOpen = filterUrgentOpenCases(rows);
  const delayed = filterDelayedCases(rows);
  const closed = filterClosedCases(rows);
  const unassignedUrgent = urgentOpen.filter((row) => !String(row.assigned_to || "").trim());
  const staleUrgent = urgentOpen.filter((row) => {
    const createdAt = new Date(row.created_at).getTime();
    if (Number.isNaN(createdAt)) return false;
    const ageHours = (Date.now() - createdAt) / (1000 * 60 * 60);
    return ageHours >= 12;
  });

  if (unassignedUrgent.length > 0) {
    alerts.push({
      severity: "high",
      title: "เคสด่วนยังไม่มีผู้รับเคส",
      detail: `พบ ${unassignedUrgent.length} เคสที่ยังไม่มีผู้รับผิดชอบ`,
      recommendation: "ควรมอบหมายผู้รับเคสทันที",
      filter_key: "urgent_open"
    });
  }

  if (staleUrgent.length > 0) {
    alerts.push({
      severity: "high",
      title: "เคสด่วนค้างเกิน 12 ชั่วโมง",
      detail: `พบ ${staleUrgent.length} เคสที่ยังไม่ปิดและค้างนานผิดปกติ`,
      recommendation: "ควรติดตามสถานะและเร่งปิดเคส",
      filter_key: "followup_urgent"
    });
  }

  if (delayed.length >= 10) {
    alerts.push({
      severity: "medium",
      title: "เคสล่าช้าสะสมสูง",
      detail: `พบเคสล่าช้า ${delayed.length} เคส`,
      recommendation: "ควรดึงรายการล่าช้ามาตรวจสอบทันที",
      filter_key: "delayed"
    });
  }

  if (closed.length > 0) {
    alerts.push({
      severity: "low",
      title: "มีเคสปิดล่าสุดพร้อมตรวจผลลัพธ์",
      detail: `พบเคสปิดแล้ว ${closed.length} เคส`,
      recommendation: "ใช้ติดตาม output และคุณภาพการปิดเคส",
      filter_key: "closed"
    });
  }

  if (!alerts.length) {
    alerts.push({
      severity: "low",
      title: "ไม่พบสัญญาณเตือนสำคัญ",
      detail: "ระบบยังไม่พบเหตุผิดปกติที่ต้องเร่งจัดการ",
      recommendation: "ติดตามภาพรวมตามปกติ",
      filter_key: "latest"
    });
  }

  return alerts.slice(0, 4);
}

async function getCommandCenterAlerts() {
  const rows = await getCommandCenterRows(200);
  return buildSmartAlerts(rows);
}

app.get("/command-center", checkDashboardAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "command-center.html"));
});

app.get("/api/command-center/summary", checkDashboardAuth, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days || "7", 10), 31);
    const data = await getCommandCenterSummary(days);
    res.json({ ok: true, data });
  } catch (error) {
    console.error("COMMAND CENTER SUMMARY ERROR:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/command-center/list", checkDashboardAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "30", 10), 100);
    const type = String(req.query.type || "urgent_open");
    const q = String(req.query.q || "");
    const data = await getCommandCenterList(type, q, limit);
    res.json({ ok: true, data });
  } catch (error) {
    console.error("COMMAND CENTER LIST ERROR:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});


app.get("/api/command-center/alerts", checkDashboardAuth, async (req, res) => {
  try {
    const data = await getCommandCenterAlerts();
    res.json({ ok: true, data });
  } catch (error) {
    console.error("COMMAND CENTER ALERTS ERROR:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/command-center/activity", checkDashboardAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "12", 10), 50);
    const data = await getCommandCenterActivity(limit);
    res.json({ ok: true, data });
  } catch (error) {
    console.error("COMMAND CENTER ACTIVITY ERROR:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});



/* =========================
   HYBRID SYSTEM PHASE 2 - TEAM WORKSPACE API (GOLDEN SAFE)
   เพิ่ม endpoint ใหม่โดยไม่แตะ flow เดิม
========================= */
function mapCaseRowToTeamCase(row = {}) {
  const rawStatus = String(row.status || "").toLowerCase().trim();
  const rawPriority = String(row.priority || row.case_priority || "").toLowerCase().trim();

  const urgentFlag =
    row.is_urgent === true ||
    row.urgent === true ||
    row.urgent_flag === true;

  let status = "new";

  if (
    rawStatus === "in_progress" ||
    rawStatus === "progress" ||
    rawStatus === "assigned" ||
    rawStatus === "รับเคสแล้ว" ||
    rawStatus === "กำลังดำเนินการ" ||
    rawStatus.includes("ดำเนิน")
  ) {
    status = "in_progress";
  } else if (
    rawStatus === "done" ||
    rawStatus === "closed" ||
    rawStatus === "completed" ||
    rawStatus === "ปิดเคส" ||
    rawStatus.includes("ปิด")
  ) {
    status = "done";
  } else if (
    rawStatus === "cancelled" ||
    rawStatus === "canceled" ||
    rawStatus === "ยกเลิก"
  ) {
    status = "cancelled";
  } else {
    status = "new";
  }

  let priority = "normal";
  if (
    rawPriority === "urgent" ||
    rawPriority === "ด่วน" ||
    urgentFlag
  ) {
    priority = "urgent";
  }

  const locationValue =
    row.location ||
    row.province ||
    row.location_province ||
    "-";

  const fallbackCategory =
    typeof mapProblemToBusinessLabel === "function"
      ? mapProblemToBusinessLabel(row.problem || row.problem_summary || "")
      : (row.problem_type || row.category || "-");

  return {
    case_code: row.case_code || row.id || "-",
    title: row.full_name
      ? `เคสขอความช่วยเหลือ: ${row.full_name}`
      : (row.problem_summary || row.problem || "เคสขอความช่วยเหลือ"),
    description:
      row.problem_summary ||
      row.problem ||
      row.additional_details ||
      "ไม่มีรายละเอียดเพิ่มเติม",

    // แยก 2 มิติชัดเจน
    status,
    priority,

    // ส่ง flag ไปด้วย เผื่อฝั่งหน้าใช้
    urgent: priority === "urgent",
    urgent_flag: priority === "urgent",
    is_urgent: priority === "urgent",

    province: locationValue,
    owner: row.assigned_to || row.last_action_by || "-",
    updated_at: row.updated_at || row.last_action_at || row.created_at || null,
    category:
      row.business_label ||
      row.problem_type ||
      row.category ||
      fallbackCategory ||
      "-",

    // optional
    role_hint: row.role_hint || "admin"
  };
}

app.get("/api/team/me", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();

    if (!userId) {
      return res.status(400).json({ ok: false, error: "missing userId" });
    }

    const effectiveRole = await getUserRole(userId);
    let roleName = effectiveRole;
    let profile = null;

    try {
      const roleResult = await supabase
        .from("line_user_roles")
        .select("line_user_id, role, is_active")
        .eq("line_user_id", userId)
        .maybeSingle();

      if (!roleResult.error && roleResult.data) {
        profile = roleResult.data;
        roleName = roleResult.data.role || effectiveRole || "guest";
      }
    } catch (lookupError) {
      console.warn("/api/team/me lookup fallback:", lookupError.message);
    }

    return res.json({
      ok: true,
      roleName,
      profile,
    });
  } catch (err) {
    console.error("GET /api/team/me error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/team/cases", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "100", 10), 200);
    const result = await supabase
      .from("help_requests")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (result.error) throw result.error;

    const cases = (result.data || []).map(mapCaseRowToTeamCase);

    return res.json({
      ok: true,
      cases,
    });
  } catch (err) {
    console.error("GET /api/team/cases error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/team/activities", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "10", 10), 30);
    const result = await supabase
      .from("help_requests")
      .select("case_code, full_name, status, assigned_to, last_action_by, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (result.error) throw result.error;

    const activities = (result.data || []).map((row) => {
      const actor = row.assigned_to || row.last_action_by || "-";

      return {
        title: `อัปเดตเคส ${row.case_code || "-"}`,
        detail: `${row.full_name || "ไม่ระบุชื่อ"} • สถานะ ${row.status || "-"} • ผู้รับเคส ${actor}`,
        time: formatThaiDateTime(row.created_at || null),
      };
    });

    return res.json({
      ok: true,
      activities,
    });
  } catch (err) {
    console.error("GET /api/team/activities error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/team/cases/assign", async (req, res) => {
  try {
    const { caseCode, userId, displayName } = req.body || {};

    if (!caseCode) {
      return res.status(400).json({ ok: false, error: "missing caseCode" });
    }

    const actorName = displayName || "ทีมงาน";
const payload = {
  assigned_to: actorName,
  status: "in_progress",
  assigned_at: new Date().toISOString(),
  last_action_at: new Date().toISOString(),
  last_action_by: actorName
};

    const result = await supabase
      .from("help_requests")
      .update(payload)
      .eq("case_code", caseCode)
      .select()
      .limit(1);

    if (result.error) throw result.error;

    const updatedCase = result.data?.[0] || null;

  broadcastSse("team_case_assigned", {
  case_code: caseCode,
  assigned_to: payload.assigned_to,
  sync_target: "dashboard_and_team",
});

    broadcastSse("dashboard_refresh", {
      reason: "team_case_assigned",
      case_code: caseCode,
      sync_target: "dashboard_and_team",
    });

    await pushTeamNotification(buildTeamWorkspaceAutoText("assign", updatedCase || payload, actorName));
    if (updatedCase?.line_user_id) {
      await pushLineTextSafe(updatedCase.line_user_id, buildRequesterAutoText("assign", updatedCase, actorName));
    }

    return res.json({
      ok: true,
      message: "assigned",
      case: updatedCase,
      auto_notify: {
        team: true,
        requester: !!updatedCase?.line_user_id,
      },
    });
  } catch (err) {
    console.error("POST /api/team/cases/assign error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/team/cases/status", async (req, res) => {
  try {
    const { caseCode, status, displayName } = req.body || {};

    if (!caseCode || !status) {
      return res.status(400).json({ ok: false, error: "missing caseCode or status" });
    }

    let nextStatus = status;
    if (status === "progress") nextStatus = "in_progress";
    if (status === "done") nextStatus = "done";

    const actorName = displayName || "ทีมงาน";

    const payload = {
  status: nextStatus,
  last_action_at: new Date().toISOString(),
  last_action_by: actorName,
};

    if (nextStatus === "done") {
      payload.closed_at = new Date().toISOString();
      payload.priority = "normal";
    }

    const result = await supabase
      .from("help_requests")
      .update(payload)
      .eq("case_code", caseCode)
      .select()
      .limit(1);

    if (result.error) throw result.error;

    const updatedCase = result.data?.[0] || null;

    broadcastSse("team_case_status_updated", {
      case_code: caseCode,
      status: nextStatus,
      sync_target: "dashboard_and_team",
    });

    broadcastSse("dashboard_refresh", {
      reason: "team_case_status_updated",
      case_code: caseCode,
      status: nextStatus,
      sync_target: "dashboard_and_team",
    });

    const notifyAction = nextStatus === "done" ? "done" : "progress";
    await pushTeamNotification(
      buildTeamWorkspaceAutoText(
        notifyAction,
        updatedCase || { case_code: caseCode, status: nextStatus },
        actorName
      )
    );

    if (updatedCase?.line_user_id) {
      await pushLineTextSafe(
        updatedCase.line_user_id,
        buildRequesterAutoText(
          notifyAction,
          updatedCase || { case_code: caseCode },
          actorName
        )
      );
    }

    return res.json({
      ok: true,
      message: "status updated",
      case: updatedCase,
      auto_notify: {
        team: true,
        requester: !!updatedCase?.line_user_id,
      },
    });
  } catch (err) {
    console.error("POST /api/team/cases/status error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/team/send-update", async (req, res) => {
  try {
    const { type, message, caseCode, targetUserId } = req.body || {};

    if (!message) {
      return res.status(400).json({ ok: false, error: "missing message" });
    }

    const effectiveTeamGroupId = process.env.LINE_TEAM_GROUP_ID || EFFECTIVE_TEAM_GROUP_ID;

    if (type === "team") {
      if (!effectiveTeamGroupId) {
        return res.status(400).json({ ok: false, error: "missing LINE_TEAM_GROUP_ID / TEAM_GROUP_ID / LINE_GROUP_ID" });
      }

      await callLinePushApi(effectiveTeamGroupId, [
        {
          type: "text",
          text: message,
        },
      ]);

      broadcastSse("team_message_sent", {
        type: "team",
        target: "team_group",
        sync_target: "dashboard_and_team",
      });

      return res.json({ ok: true, sentTo: "team_group" });
    }

    if (type === "requester") {
      let userId = targetUserId || null;

      if (!userId && caseCode) {
        const caseResult = await supabase
          .from("help_requests")
          .select("line_user_id")
          .eq("case_code", caseCode)
          .maybeSingle();

        if (caseResult.error) throw caseResult.error;
        userId = caseResult.data?.line_user_id || null;
      }

      if (!userId) {
        return res.status(400).json({ ok: false, error: "missing requester line user id" });
      }

      await callLinePushApi(userId, [
        {
          type: "text",
          text: message,
        },
      ]);

      broadcastSse("team_message_sent", {
        type: "requester",
        target: userId,
        case_code: caseCode || null,
        sync_target: "dashboard_and_team",
      });

      return res.json({ ok: true, sentTo: "requester" });
    }

    return res.status(400).json({ ok: false, error: "invalid type" });
  } catch (err) {
    console.error("POST /api/team/send-update error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});
app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Server started on port " + PORT);
});

