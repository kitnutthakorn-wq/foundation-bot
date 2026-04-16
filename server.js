// PRODUCTION LOCKED BASELINE
require("dotenv").config();
console.log("SUPABASE_URL:", process.env.SUPABASE_URL);

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const { createClient } = require("@supabase/supabase-js");
const { createCanvas, loadImage, registerFont } = require("canvas");
const sharp = require("sharp");

try {
 registerFont(path.join(__dirname, "fonts", "Kanit-Bold.ttf"), {
  family: "ThaiBold"
});
registerFont(path.join(__dirname, "fonts", "Kanit-Regular.ttf"), {
  family: "ThaiRegular"
});
  console.log("✅ Thai fonts registered");
} catch (e) {
  console.warn("⚠️ Font register failed:", e.message);
}

const upload = multer({ storage: multer.memoryStorage() });
const caseInfoUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024,
    files: 10
  }
});
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const userStates = {};

// =========================
// PRO MAX: Recent Users Cache
// =========================
const recentUsers = new Map(); // userId -> { userId, displayName, lastSeen }

function upsertRecentUser(userId, displayName = "") {
  if (!userId) return;

  recentUsers.set(userId, {
    userId,
    displayName: displayName || userId,
    lastSeen: Date.now()
  });

  // จำกัดไม่เกิน 30 คน
  if (recentUsers.size > 30) {
    const oldest = [...recentUsers.entries()]
      .sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
    if (oldest) recentUsers.delete(oldest[0]);
  }
}
// =========================
// GOLDEN SAFE PATCH: LINE PROFILE HELPERS
// =========================
async function getLineProfileNameSafe(event = {}) {
  try {
    const userId = event?.source?.userId || "";
    if (!userId) return "";

    const sourceType = event?.source?.type || "";
    console.log("PROFILE DEBUG sourceType:", sourceType, "userId:", userId, "groupId:", event?.source?.groupId || "", "roomId:", event?.source?.roomId || "");

    if (sourceType === "user") {
      const profile = await getLineProfile(userId);
      return profile?.displayName || "";
    }

    if (sourceType === "group" && event?.source?.groupId) {
      const profile = await getGroupMemberProfile(event.source.groupId, userId);
      return profile?.displayName || "";
    }

    if (sourceType === "room" && event?.source?.roomId) {
      const profile = await getRoomMemberProfile(event.source.roomId, userId);
      return profile?.displayName || "";
    }

    return "";
  } catch (err) {
   if (!String(err?.message || "").includes("404")) {
  console.log("getLineProfileNameSafe error:", err?.message || err);
}
    return "";
  }
}
// 👇 วาง helper ตรงนี้เลย
function setAddTeamState(userId, step, payload = {}) {
  userStates[userId] = userStates[userId] || {};
  userStates[userId].addTeam = {
    step,
    ...payload
  };
}

function getAddTeamState(userId) {
  return userStates[userId]?.addTeam || null;
}

function clearAddTeamState(userId) {
  if (userStates[userId]?.addTeam) {
    delete userStates[userId].addTeam;
  }
}

function setCaseSearchState(userId, payload = {}) {
  userStates[userId] = userStates[userId] || {};
  userStates[userId].caseSearch = payload;
}

function getCaseSearchState(userId) {
  return userStates[userId]?.caseSearch || null;
}

function clearCaseSearchState(userId) {
  if (userStates[userId]?.caseSearch) {
    delete userStates[userId].caseSearch;
  }
}


async function upsertTeamCandidate({
  lineUserId,
  displayName = "",
  pictureUrl = "",
  source = "liff",
  joinedGroupId = "",
  note = "",
  status = "pending"
}) {
  const payload = {
    line_user_id: String(lineUserId || "").trim(),
    display_name: String(displayName || "").trim() || null,
    picture_url: String(pictureUrl || "").trim() || null,
    source: String(source || "liff").trim(),
    status: String(status || "pending").trim(),
    joined_group_id: String(joinedGroupId || "").trim() || null,
    note: String(note || "").trim() || null,
    last_seen_at: new Date().toISOString()
  };

  if (!payload.line_user_id) {
    throw new Error("line_user_id is required");
  }

  const { data, error } = await supabase
    .from("team_candidates")
    .upsert(payload, { onConflict: "line_user_id" })
    .select()
    .single();

  if (error) throw error;
  return data;
}


// =====================================================
// CENTRAL SLA ENGINE (Golden Safe Shared Logic)
// =====================================================

function normalizeCaseStatus(status = "") {
  const s = String(status || "").trim().toLowerCase();

  if (s === "progress") return "in_progress";
  if (s === "in progress") return "in_progress";
  if (s === "in_progress") return "in_progress";
  if (s === "pending") return "new";

  return s || "new";
}

function getCaseBaseTime(row = {}) {
  return row.created_at || null;
}

function getSlaHoursFromCase(row = {}, now = new Date()) {
  const baseTime = getCaseBaseTime(row);
  if (!baseTime) return 0;

  const start = new Date(baseTime);
  const diffMs = now - start;
  return diffMs > 0 ? diffMs / (1000 * 60 * 60) : 0;
}

const SLA_CONFIG = {
  CRITICAL_HOURS: 48,
  WARNING_HOURS: 24
};

function isUrgentPriority(priority = "") {
  const p = String(priority || "").trim().toLowerCase();
  return p === "urgent" || p === "ด่วน";
}

function getSlaLevel(row = {}) {
  const status = normalizeCaseStatus(row.status);

  // ปิดเคส = ไม่ active SLA
  if (status === "done" || status === "cancelled") {
    return {
      sla_level: "normal",
      sla_label_th: "ปิดเคสแล้ว",
      sla_hours_since_action: 0,
      is_sla_active: false
    };
  }

  const hours = getSlaHoursFromCase(row);

  let slaLevel = "normal";
  let slaLabel = "ปกติ";

  // ใช้ SLA เข้มเฉพาะเคสด่วน
  if (isUrgentPriority(row.priority)) {
    if (hours >= SLA_CONFIG.CRITICAL_HOURS) {
      slaLevel = "breached";
      slaLabel = "เกิน SLA";
    } else if (hours >= SLA_CONFIG.WARNING_HOURS) {
      slaLevel = "warning";
      slaLabel = "ใกล้เกิน SLA";
    }
  }

  return {
    sla_level: slaLevel,
    sla_label_th: slaLabel,
    sla_hours_since_action: hours,
    is_sla_active: true
  };
}

function attachSla(row = {}) {
  return {
    ...row,
    ...getSlaLevel(row)
  };
}

function buildSlaSummary(rows = []) {
  const urgentRows = (Array.isArray(rows) ? rows : []).filter((row) => {
    const status = normalizeCaseStatus(row.status);
    return isUrgentPriority(row.priority) && status !== "done" && status !== "cancelled";
  });

  const breached = urgentRows.filter(
    (row) => getSlaLevel(row).sla_level === "breached"
  ).length;

  const warning = urgentRows.filter(
    (row) => getSlaLevel(row).sla_level === "warning"
  ).length;

  const normal = urgentRows.filter(
    (row) => getSlaLevel(row).sla_level === "normal"
  ).length;

  return {
    breached,
    warning,
    normal,
    urgent_total: urgentRows.length
  };
}
const caseFollowupTracker = {};
const fetch = globalThis.fetch;

const webSessions = new Map();

function generateWebSessionId() {
  return crypto.randomBytes(24).toString("hex");
}

function createWebSession(user) {
  const sessionId = generateWebSessionId();

  webSessions.set(sessionId, {
    userId: user.userId,
    displayName: user.displayName || "",
    pictureUrl: user.pictureUrl || "",
    role: user.role || "viewer",
    createdAt: Date.now(),
    lastSeenAt: Date.now()
  });

  return sessionId;
}

function getWebSession(sessionId) {
  if (!sessionId) return null;

  const session = webSessions.get(sessionId);
  if (!session) return null;

  const MAX_AGE = 1000 * 60 * 60 * 24 * 7; // 7 วัน
  if (Date.now() - session.lastSeenAt > MAX_AGE) {
    webSessions.delete(sessionId);
    return null;
  }

  session.lastSeenAt = Date.now();
  return session;
}

function destroyWebSession(sessionId) {
  if (!sessionId) return;
  webSessions.delete(sessionId);
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header
      .split(";")
      .map(v => v.trim())
      .filter(Boolean)
      .map(v => {
        const idx = v.indexOf("=");
        if (idx === -1) return [v, ""];
        return [decodeURIComponent(v.slice(0, idx)), decodeURIComponent(v.slice(idx + 1))];
      })
  );
}

function getSessionFromRequest(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies.kck_session || "";
  return getWebSession(sessionId);
}

function setSessionCookie(res, sessionId) {
  const isProd = process.env.NODE_ENV === "production";
  const cookie = [
    `kck_session=${encodeURIComponent(sessionId)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=604800"
  ];

  if (isProd) cookie.push("Secure");

  res.setHeader("Set-Cookie", cookie.join("; "));
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    "kck_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
  );
}
const app = express();
const PORT = process.env.PORT || 3000;
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));
async function getUrgentCaseMenuCounts() {
  const { data, error } = await supabase
    .from("help_requests")
    .select("*");

  if (error) {
    console.error("GET URGENT CASE COUNTS ERROR:", error);
    return {
      breached: 0,
      critical: 0, // alias กันของเก่าพัง
      warning: 0,
      normal: 0,
      open_cases: 0,
      inProgress: 0
    };
  }

  const rows = (Array.isArray(data) ? data : []).filter((row) => {
    const status = normalizeCaseStatus(row.status);
    return status === "new" || status === "in_progress";
  });

  console.log("=== URGENT MENU DEBUG: RAW DATA ===");
  (Array.isArray(data) ? data : []).forEach((row) => {
    console.log(
      "[RAW]",
      row.case_code,
      "status=", JSON.stringify(row.status),
      "normalizedStatus=", normalizeCaseStatus(row.status),
      "priority=", JSON.stringify(row.priority),
      "slaLevel=", getSlaLevel(row)
    );
  });

  console.log("=== URGENT MENU DEBUG: FILTERED ROWS ===");
  rows.forEach((row) => {
    console.log(
      "[ROW]",
      row.case_code,
      "status=", JSON.stringify(row.status),
      "normalizedStatus=", normalizeCaseStatus(row.status),
      "priority=", JSON.stringify(row.priority),
      "slaLevel=", getSlaLevel(row)
    );
  });

  const sla = buildSlaSummary(rows);

  return {
    breached: sla.breached,
    critical: sla.breached, // alias กัน UI เก่า
    warning: sla.warning,
    normal: sla.normal,
    open_cases: sla.urgent_total,
    inProgress: sla.normal
  };
}


function drawText(ctx, text, x, y, options = {}) {
  const {
    font = 'bold 42px "ThaiBold", sans-serif',
    color = "#000000",
    align = "left",
    maxWidth = 700
  } = options;

  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "top";

  const lines = wrapText(ctx, String(text || "-"), maxWidth);
  const lineHeight = getLineHeight(font);

  lines.forEach((line, i) => {
    ctx.fillText(line, x, y + i * lineHeight);
  });
}

function wrapText(ctx, text, maxWidth) {
  const paragraphs = String(text || "").split("\n");
  const lines = [];

  for (const para of paragraphs) {
    let line = "";
    for (const ch of para) {
      const testLine = line + ch;
      const width = ctx.measureText(testLine).width;
      if (width > maxWidth && line) {
        lines.push(line);
        line = ch;
      } else {
        line = testLine;
      }
    }
    if (line) lines.push(line);
  }

  return lines.length ? lines : ["-"];
}

function getLineHeight(font) {
  const m = /(\d+)px/.exec(font);
  const size = m ? parseInt(m[1], 10) : 40;
  return Math.round(size * 1.35);
}

function roundRectPath(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

async function getNewCaseMenuCounts() {
  const { data, error } = await supabase
    .from("help_requests")
    .select("status, priority");

  if (error) {
    console.error("GET NEW CASE MENU COUNTS ERROR:", error);
    return {
      total: 0,
      urgent: 0,
      normal: 0
    };
  }

  const rows = (Array.isArray(data) ? data : []).filter(row => {
    const status = String(row.status || "").toLowerCase().trim();
    return status === "new" || status === "in_progress";
  });

  const total = rows.length;

  const urgent = rows.filter(
    row => String(row.priority || "").toLowerCase().trim() === "urgent"
  ).length;

  const normal = rows.filter(
    row => String(row.priority || "").toLowerCase().trim() !== "urgent"
  ).length;

  return {
    total,
    urgent,
    normal
  };
}
function buildNewCaseMenuRevision(counts = {}) {
  const total = Number(counts.total || 0);
  const urgent = Number(counts.urgent || 0);
  const normal = Number(counts.normal || 0);
  return `${total}-${urgent}-${normal}`;
}

app.get("/imagemap/urgent-case-poster/1040", async (req, res) => {
  try {
   const rawCaseCode = String(req.query.case_code || "").trim();
const caseCode = rawCaseCode
  .split("?")[0]
  .replace(/\/(1040|700|460|240)$/i, "")
  .replace(/\/+$/g, "")
  .trim();

console.log("URGENT POSTER rawCaseCode =", rawCaseCode);
console.log("URGENT POSTER finalCaseCode =", caseCode);
   
    const imagePath = path.join(__dirname, "imagemap", "urgent-case-poster.png");

    const { data } = await supabase
      .from("help_requests")
      .select("*")
      .eq("case_code", caseCode)
      .maybeSingle();

    const baseImage = await loadImage(imagePath);
    const canvas = createCanvas(1040, 1559);
    const ctx = canvas.getContext("2d");

    ctx.drawImage(baseImage, 0, 0, 1040, 1559);

    // =========================
    // DATA
    // =========================
    const case_code = data?.case_code || caseCode || "-";
const full_name = data?.full_name || "ไม่ระบุชื่อ";
const location = data?.location || "ไม่ระบุพื้นที่";

const rawStatus = String(data?.status || "").toLowerCase();
const rawPriority = String(data?.priority || "").toLowerCase();

const statusThai =
  rawStatus === "done" ? "ปิดแล้ว" :
  rawStatus === "closed" ? "ปิดแล้ว" :
  formatCaseStatusThai(data?.status || "");

const priorityThai = formatPriorityThai(data?.priority || "");

const updatedText = formatThaiDateTime(
  data?.last_action_at ||
  data?.closed_at ||
  data?.assigned_at ||
  data?.created_at
);

const slaInfo = getSlaLevel(data || {});
const slaLevel = slaInfo.sla_level;

let slaText = "ปกติ";

if (slaLevel === "breached") {
  slaText = "เกิน SLA";
} else if (slaLevel === "warning") {
  slaText = "ใกล้เกิน SLA";
}
const progressPercent =
  rawStatus === "done" || rawStatus === "closed"
    ? 100
    : Math.max(0, Math.min(100, Number(data?.progress_percent ?? 60)));

    // =========================
    // LAYOUT
    // =========================
    const CARD = {
      left: 78,
      top: 262,
      width: 884,
      height: 610
    };

    const INNER_X = CARD.left + 93;
    const HEADER_CENTER_X = 520;

    // =========================
    // TEXT
    // =========================

// CASE CODE
drawText(ctx, case_code, HEADER_CENTER_X, 292, {
  font: 'bold 72px "ThaiBold", sans-serif',
  color: "#ffffff",
  align: "center"
});

// NAME
drawText(ctx, "ชื่อ: " + full_name, INNER_X, 480, {
  font: 'bold 48px "ThaiBold", sans-serif',
  color: "#222222"
});

// LOCATION
drawText(ctx, location, INNER_X, 560, {
  font: 'bold 34px "ThaiRegular", sans-serif',
  color: "#666666"
});

// STATUS
drawText(ctx, "สถานะ:", INNER_X, 660, {
  font: 'bold 38px "ThaiBold", sans-serif',
  color: "#333333"
});

drawText(ctx, statusThai, INNER_X + 120, 660, {
  font: 'bold 38px "ThaiBold", sans-serif',
  color: "#E67E22"
});

// PRIORITY
drawText(ctx, "ระดับ:", INNER_X, 720, {
  font: 'bold 38px "ThaiBold", sans-serif',
  color: "#333333"
});

drawText(ctx, priorityThai, INNER_X + 100, 720, {
  font: 'bold 38px "ThaiBold", sans-serif',
  color: "#D63031"
});

    // LINE
    ctx.strokeStyle = "#D9D9D9";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(CARD.left + 34, 815);
    ctx.lineTo(CARD.left + CARD.width - 34, 815);
    ctx.stroke();

    // UPDATED
drawText(ctx, "อัปเดตล่าสุด: " + updatedText, INNER_X, 835, {
  font: 'bold 34px "ThaiRegular", sans-serif',
  color: "#777777"
});

    // =========================
    // SLA BOX (สำคัญ)
    // =========================

    // SLA TEXT
drawText(ctx, "SLA: " + slaText, INNER_X, 960, {
  font: 'bold 36px "ThaiBold", sans-serif',
  color: "#E67E22"
});


// %
drawText(ctx, progressPercent + "%", CARD.left + CARD.width - 82, 969, {
  font: 'bold 38px "ThaiBold", sans-serif',
  color: "#444444",
  align: "right"
});

    // BAR
    const barX = INNER_X;
    const barY = 1020;
    const barW = 690;
    const barH = 18;

    const fillW = Math.max(18, Math.round((progressPercent / 100) * barW));

    ctx.fillStyle = "#B7B09B";
   roundRectPath(ctx, barX, barY, barW, barH, 9);
    ctx.fill();

    const grad = ctx.createLinearGradient(barX, barY, barX + barW, barY);
    grad.addColorStop(0, "#FFD400");
    grad.addColorStop(0.45, "#C9F000");
    grad.addColorStop(1, "#6D6A3A");

    ctx.fillStyle = grad;
   roundRectPath(ctx, barX, barY, fillW, barH, 9);
    ctx.fill();

    // DOT
    const dotX = barX + fillW - 3;
    const dotY = barY + (barH / 2);

    ctx.fillStyle = "#FFF36B";
    ctx.beginPath();
    ctx.arc(dotX, dotY, 7, 0, Math.PI * 2);
    ctx.fill();

    // =========================
    // OUTPUT
    // =========================
    const buffer = canvas.toBuffer("image/png");
    res.set("Content-Type", "image/png");
    return res.send(buffer);

  } catch (err) {
    console.error(err);
    return res.status(500).send("render failed");
  }
});

app.get("/imagemap/search-menu-v2/:size", async (req, res) => {
  try {
    const size = req.params.size;

    // 🔥 ตรวจว่าเป็น @2x ไหม
    const is2x = size.includes("@2x");

    const width = is2x ? 1040 * 2 : 1040;
    const height = is2x ? 1559 * 2 : 1559;

    const imagePath = path.join(__dirname, "imagemap", "search-menu-bg.png");
    const baseImage = await loadImage(imagePath);

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    // scale ให้ภาพคมใน @2x
    if (is2x) {
      ctx.scale(2, 2);
    }

    ctx.drawImage(baseImage, 0, 0, 1040, 1559);

    const buffer = canvas.toBuffer("image/png");
    res.set("Content-Type", "image/png");
    return res.send(buffer);

  } catch (err) {
    console.error(err);
    return res.status(500).send("render failed");
  }
});

// =========================
// SEARCH PHONE PROMPT IMAGEMAP IMAGE ROUTE
// ใช้ไฟล์ imagemap/Telcase.png
// วางหลัง /imagemap/search-menu-v2/:size
// =========================
app.get("/imagemap/search-phone-prompt-r:rev/:size", async (req, res) => {
  try {
    const size = String(req.params.size || "");
    const is2x = size.includes("@2x");

    const width = is2x ? 1040 * 2 : 1040;
    const height = is2x ? 1559 * 2 : 1559;

    const imagePath = path.join(__dirname, "imagemap", "Telcase.png");
    const baseImage = await loadImage(imagePath);

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    if (is2x) {
      ctx.scale(2, 2);
    }

    ctx.drawImage(baseImage, 0, 0, 1040, 1559);

    const buffer = canvas.toBuffer("image/png");
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    return res.send(buffer);
  } catch (err) {
    console.error("search-phone-prompt render failed:", err);
    return res.status(500).send("render failed");
  }
});

// =========================
// SEARCH CASE CODE PROMPT IMAGEMAP IMAGE ROUTE
// ใช้ไฟล์ imagemap/NumberCase.png
// วางหลัง /imagemap/search-phone-prompt-r:rev/:size
// =========================
app.get("/imagemap/search-casecode-prompt-r:rev/:size", async (req, res) => {
  try {
    const size = String(req.params.size || "");
    const is2x = size.includes("@2x");

    const width = is2x ? 1040 * 2 : 1040;
    const height = is2x ? 1559 * 2 : 1559;

    const imagePath = path.join(__dirname, "imagemap", "NumberCase.png");
    const baseImage = await loadImage(imagePath);

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    if (is2x) {
      ctx.scale(2, 2);
    }

    ctx.drawImage(baseImage, 0, 0, 1040, 1559);

    const buffer = canvas.toBuffer("image/png");
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    return res.send(buffer);
  } catch (err) {
    console.error("search-casecode-prompt render failed:", err);
    return res.status(500).send("render failed");
  }
});

// =========================
// ADMIN MAIN MENU IMAGEMAP IMAGE ROUTE
// ใช้ไฟล์ imagemap/MainMenu.png
// วางหลัง /imagemap/search-menu-v2/:size
// และก่อน /imagemap/new-case-menu-v2-r:rev/:size
// =========================
app.get("/imagemap/admin-main-menu-r:rev/:size", async (req, res) => {
  try {
    const size = String(req.params.size || "");
    const is2x = size.includes("@2x");

    const width = is2x ? 1040 * 2 : 1040;
    const height = is2x ? 1559 * 2 : 1559;

    const imagePath = path.join(__dirname, "imagemap", "MainMenu.png");
    const baseImage = await loadImage(imagePath);

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    if (is2x) {
      ctx.scale(2, 2);
    }

    ctx.drawImage(baseImage, 0, 0, 1040, 1559);

    const buffer = canvas.toBuffer("image/png");
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    return res.send(buffer);
  } catch (err) {
    console.error("admin-main-menu render failed:", err);
    return res.status(500).send("render failed");
  }
});

// =========================
// ADMIN CASE MENU IMAGEMAP IMAGE ROUTE
// ใช้ไฟล์ imagemap/Case.png
// วางหลัง /imagemap/admin-main-menu-r:rev/:size
// และก่อน /imagemap/new-case-menu-v2-r:rev/:size
// =========================
app.get("/imagemap/admin-case-menu-r:rev/:size", async (req, res) => {
  try {
    const size = String(req.params.size || "");
    const is2x = size.includes("@2x");

    const width = is2x ? 1040 * 2 : 1040;
    const height = is2x ? 1559 * 2 : 1559;

    const imagePath = path.join(__dirname, "imagemap", "Case.png");
    const baseImage = await loadImage(imagePath);

    const counts = await getNewCaseMenuCounts();
    const urgentCounts = await getUrgentCaseMenuCounts();

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const { data: todayRows, error: todayError } = await supabase
      .from("help_requests")
      .select("id, created_at")
      .gte("created_at", todayStart.toISOString())
      .lte("created_at", todayEnd.toISOString());

    if (todayError) {
      console.error("GET ADMIN CASE MENU TODAY COUNT ERROR:", todayError);
    }

    const todayCount = Array.isArray(todayRows) ? todayRows.length : 0;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    if (is2x) {
      ctx.scale(2, 2);
    }

    ctx.drawImage(baseImage, 0, 0, 1040, 1559);

    const centerX = 520;

    // ปุ่ม 1: ดูเคสใหม่
    drawText(ctx, `ดูเคสใหม่ (${Number(counts.total || 0)})`, centerX, 755, {
      font: 'bold 56px "ThaiBold", sans-serif',
      color: "#111111",
      align: "center",
      maxWidth: 760
    });

    // ปุ่ม 2: ดูเคสด่วน
    drawText(ctx, `ดูเคสด่วน (${Number(urgentCounts.open_cases || 0)})`, centerX, 917, {
      font: 'bold 56px "ThaiBold", sans-serif',
      color: "#111111",
      align: "center",
      maxWidth: 760
    });

    // ปุ่ม 3: เคสวันนี้
    drawText(ctx, `เคสวันนี้ (${Number(todayCount || 0)})`, centerX, 1075, {
      font: 'bold 56px "ThaiBold", sans-serif',
      color: "#111111",
      align: "center",
      maxWidth: 760
    });

// ปุ่ม 4: ค้นหาเคส
drawText(ctx, "ค้นหาเคส", centerX, 1225, {
  font: 'bold 56px "ThaiBold", sans-serif',
  color: "#111111",
  align: "center",
  maxWidth: 760
});
   
    const buffer = canvas.toBuffer("image/png");
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    return res.send(buffer);
  } catch (err) {
    console.error("admin-case-menu render failed:", err);
    return res.status(500).send("render failed");
  }
});

// =========================
// ADMIN DASHBOARD MENU IMAGEMAP IMAGE ROUTE
// ใช้ไฟล์ imagemap/dashboard.png
// วางหลัง /imagemap/admin-case-menu-r:rev/:size
// และก่อน /imagemap/new-case-menu-v2-r:rev/:size
// =========================
app.get("/imagemap/admin-dashboard-menu-r:rev/:size", async (req, res) => {
  try {
    const size = String(req.params.size || "");
    const is2x = size.includes("@2x");

    const width = is2x ? 1040 * 2 : 1040;
    const height = is2x ? 1559 * 2 : 1559;

    const imagePath = path.join(__dirname, "imagemap", "dashboard.png");
    const baseImage = await loadImage(imagePath);

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    if (is2x) {
      ctx.scale(2, 2);
    }

    ctx.drawImage(baseImage, 0, 0, 1040, 1559);

    const buffer = canvas.toBuffer("image/png");
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    return res.send(buffer);
  } catch (err) {
    console.error("admin-dashboard-menu render failed:", err);
    return res.status(500).send("render failed");
  }
});

// =========================
// SMART ALERT MENU IMAGEMAP IMAGE ROUTE
// ใช้ไฟล์ imagemap/SmartAlert.png
// วางหลัง /imagemap/admin-dashboard-menu-r:rev/:size
// และก่อน /imagemap/new-case-menu-v2-r:rev/:size
// =========================
app.get("/imagemap/smart-alert-menu-r:rev/:size", async (req, res) => {
  try {
    const size = String(req.params.size || "");
    const is2x = size.includes("@2x");

    const width = is2x ? 1040 * 2 : 1040;
    const height = is2x ? 1559 * 2 : 1559;

    const imagePath = path.join(__dirname, "imagemap", "SmartAlert.png");
    const baseImage = await loadImage(imagePath);

    const slaCounts = await getSlaMenuCounts();

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    if (is2x) {
      ctx.scale(2, 2);
    }

    ctx.drawImage(baseImage, 0, 0, 1040, 1559);

    const centerX = 520;

   // ปุ่ม 1: SLA วิกฤต
drawText(ctx, `SLA วิกฤต (${Number(slaCounts.overdue || 0)})`, centerX, 752, {
  font: 'bold 56px "ThaiBold", sans-serif',
  color: "#111111",
  align: "center",
  maxWidth: 760
});

// ปุ่ม 2: ใกล้หลุด SLA
drawText(ctx, `ใกล้หลุด SLA (${Number(slaCounts.near_due || 0)})`, centerX, 910, {
  font: 'bold 56px "ThaiBold", sans-serif',
  color: "#111111",
  align: "center",
  maxWidth: 760
});

// ปุ่ม 3: เคสเปิดทั้งหมด
drawText(ctx, `เคสเปิดทั้งหมด (${Number(slaCounts.open_cases || 0)})`, centerX, 1062, {
  font: 'bold 56px "ThaiBold", sans-serif',
  color: "#111111",
  align: "center",
  maxWidth: 760
});

// ปุ่ม 4: เปิดศูนย์ปฏิบัติการ
drawText(ctx, "เปิดศูนย์ปฏิบัติการ", centerX, 1216, {
  font: 'bold 56px "ThaiBold", sans-serif',
  color: "#111111",
  align: "center",
  maxWidth: 760
});
    const buffer = canvas.toBuffer("image/png");
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    return res.send(buffer);
  } catch (err) {
    console.error("smart-alert-menu render failed:", err);
    return res.status(500).send("render failed");
  }
});

// =========================
// ADMIN TEAM MANAGE MENU IMAGEMAP IMAGE ROUTE
// ใช้ไฟล์ imagemap/Teamwork.png
// วางหลัง /imagemap/smart-alert-menu-r:rev/:size
// และก่อน /imagemap/new-case-menu-v2-r:rev/:size
// =========================
app.get("/imagemap/admin-team-manage-menu-r:rev/:size", async (req, res) => {
  try {
    const size = String(req.params.size || "");
    const is2x = size.includes("@2x");

    const width = is2x ? 1040 * 2 : 1040;
    const height = is2x ? 1559 * 2 : 1559;

    const imagePath = path.join(__dirname, "imagemap", "Teamwork.png");
    const baseImage = await loadImage(imagePath);

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    if (is2x) {
      ctx.scale(2, 2);
    }

    ctx.drawImage(baseImage, 0, 0, 1040, 1559);

    const buffer = canvas.toBuffer("image/png");
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    return res.send(buffer);
  } catch (err) {
    console.error("admin-team-manage-menu render failed:", err);
    return res.status(500).send("render failed");
  }
});

app.get("/imagemap/new-case-menu-v2-r:rev/:size", async (req, res) => {
  try {
    const size = String(req.params.size || "");
    const is2x = size.includes("@2x");

    const width = is2x ? 1040 * 2 : 1040;
    const height = is2x ? 1559 * 2 : 1559;

    const imagePath = path.join(__dirname, "imagemap", "new-case-menu-bg.png");
    const baseImage = await loadImage(imagePath);

    const counts = await getNewCaseMenuCounts();

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    if (is2x) {
      ctx.scale(2, 2);
    }

    ctx.drawImage(baseImage, 0, 0, 1040, 1559);

    const centerX = 520;

    // ปุ่ม 1
    drawText(ctx, `ดูเคสใหม่ทั้งหมด (${counts.total})`, centerX, 935, {
      font: 'bold 50px "ThaiBold", sans-serif',
      color: "#111111",
      align: "center",
      maxWidth: 760
    });

    // ปุ่ม 2
    drawText(ctx, `ดูเคสใหม่ด่วน (${counts.urgent})`, centerX, 1095, {
      font: 'bold 52px "ThaiBold", sans-serif',
      color: "#111111",
      align: "center",
      maxWidth: 760
    });

    // ปุ่ม 3
    drawText(ctx, `ดูเคสใหม่ปกติ (${counts.normal})`, centerX, 1250, {
      font: 'bold 52px "ThaiBold", sans-serif',
      color: "#111111",
      align: "center",
      maxWidth: 760
    });

    const buffer = canvas.toBuffer("image/png");
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    return res.send(buffer);
  } catch (err) {
    console.error("new-case-menu-v2 render failed:", err);
    return res.status(500).send("render failed");
  }
});

app.get("/imagemap/urgent-case-menu-v2-r:rev/:size", async (req, res) => {
  try {

    console.log("🖼 URGENT MENU IMAGE ROUTE HIT:", req.params.rev, req.params.size);
    const size = String(req.params.size || "");
    const is2x = size.includes("@2x");

    const width = is2x ? 1040 * 2 : 1040;
    const height = is2x ? 1559 * 2 : 1559;

    const imagePath = path.join(__dirname, "imagemap", "urgent-case-menu-v2.png");
    const baseImage = await loadImage(imagePath);

    const counts = await getUrgentCaseMenuCounts();
    console.log("🖼 IMAGE ROUTE COUNTS:", counts);

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    if (is2x) {
      ctx.scale(2, 2);
    }

    ctx.drawImage(baseImage, 0, 0, 1040, 1559);

    const centerX = 520;

    // 🔥 ปุ่ม 1
    drawText(ctx, `เคสด่วน SLA วิกฤต (${Number(counts.critical || 0)})`, centerX, 935, {
      font: 'bold 52px "ThaiBold"',
      align: "center"
    });

    // 🔥 ปุ่ม 2
   drawText(ctx, `เคสด่วน SLA ใกล้วิกฤต (${Number(counts.warning || 0)})`, centerX, 1095, {
      font: 'bold 52px "ThaiBold"',
      align: "center"
    });

    // 🔥 ปุ่ม 3
   drawText(ctx, `เคสด่วน SLA ปกติ (${Number(counts.inProgress || 0)})`, centerX, 1250, {
      font: 'bold 52px "ThaiBold"',
      align: "center"
    });

    const buffer = canvas.toBuffer("image/png");

    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "no-store");

    return res.send(buffer);

  } catch (err) {
    console.error("urgent-case-menu render failed:", err);
    return res.status(500).send("render failed");
  }
});

app.use("/imagemap", express.static(path.join(__dirname, "imagemap")));

// ================================
// URGENT CASE MENU IMAGEMAP
// ================================
app.get("/imagemap/urgent-case-menu-v2", (req, res) => {
  const imagePath = path.join(__dirname, "imagemap", "urgent-case-menu-v2.png");
  res.sendFile(imagePath);
});

app.get("/imagemap/urgent-case-menu-v2@2x", (req, res) => {
  const imagePath = path.join(__dirname, "imagemap", "urgent-case-menu-v2@2x.png");
  res.sendFile(imagePath);
});

const PUBLIC_WEB_ORIGINS = [
  process.env.APP_ORIGIN,
  process.env.PUBLIC_SITE_URL,
  process.env.NETLIFY_SITE_URL,
  process.env.URL
].filter(Boolean);

async function getOpenCasesForMenu(filterType = "all", limit = 10) {
  const { data, error } = await supabase
    .from("help_requests")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("GET OPEN CASES FOR MENU ERROR:", error);
    return [];
  }

  const rows = (Array.isArray(data) ? data : []).filter(row => {
    const status = String(row.status || "").toLowerCase().trim();
    return status === "new" || status === "in_progress";
  });

  let filtered = rows;

  if (filterType === "urgent") {
    filtered = rows.filter(
      row => String(row.priority || "").toLowerCase().trim() === "urgent"
    );
  } else if (filterType === "normal") {
    filtered = rows.filter(
      row => String(row.priority || "").toLowerCase().trim() !== "urgent"
    );
  }

  return filtered.slice(0, limit);
}

const URGENT_CASE_CAROUSEL_HERO =
  "https://img1.pic.in.th/images/SLA.png";

function buildCaseMenuCarouselBubble(item = {}, options = {}) {
  const statusText = formatCaseStatusThai(item.status || "");
  const priorityText = formatPriorityThai(item.priority || "");

  const detailUrl =
    `https://satisfied-stillness-production-7942.up.railway.app/team-case-view.html?case_code=${encodeURIComponent(item.case_code || "")}`;

  const updateUrl =
    `https://satisfied-stillness-production-7942.up.railway.app/update-case.html?case_code=${encodeURIComponent(item.case_code || "")}`;

  const heroImage =
    String(options.heroImage || "").trim() ||
    (
      Array.isArray(item.images) && item.images.length > 0
        ? item.images[0]
        : "https://img1.pic.in.th/images/kck-poster.jpg"
    );

  const isUrgent = String(item.priority || "").toLowerCase() === "urgent";

  return {
    type: "bubble",
    size: "kilo",

    // 🔥 HERO (คม + กดได้)
   hero: {
  type: "image",
  url: heroImage,
  size: "full",
  aspectRatio: "20:13",   // 🔥 สูงขึ้นทันที
  aspectMode: "cover"

    },

    // 🔥 BODY (Kanit vibe)
    body: {
      type: "box",
      layout: "vertical",
      backgroundColor: "#FFFFFF",
      cornerRadius: "20px",
      paddingAll: "14px",
      spacing: "md",
      contents: [
        // แถบเลขเคส (คมๆ)
        {
          type: "box",
          layout: "horizontal",
          contents: [
            {
              type: "text",
              text: item.case_code || "-",
              weight: "bold",
              size: "md",
              color: "#0B7C86",
              flex: 1
            },
            // badge ระดับ
            {
              
  type: "box",
  layout: "vertical",
  paddingStart: "10px",
  paddingEnd: "10px",
  paddingTop: "4px",
  paddingBottom: "4px",
 
  backgroundColor: isUrgent ? "#FDECEC" : "#EAF7EF",
              contents: [
                {
                  type: "text",
                  text: priorityText,
                  size: "xs",
                  weight: "bold",
                  color: isUrgent ? "#D32F2F" : "#1F8F4D",
                  align: "center"
                }
              ]
            }
          ]
        },

        // ชื่อ (หัวใหญ่แบบ Kanit)
        {
          type: "text",
          text: item.full_name || "ไม่ระบุชื่อ",
          weight: "bold",
          size: "lg",
          wrap: true,
          color: "#102A43"
        },

        // พื้นที่
        {
          type: "text",
          text: `📍 ${item.location || "-"}`,
          size: "sm",
          color: "#6B7280",
          wrap: true
        },

        // รายละเอียด (สั้น กระชับ)
        {
          type: "text",
          text: item.problem || "-",
          size: "sm",
          color: "#334155",
          wrap: true,
          maxLines: 2
        },

        // สถานะ
        {
          type: "box",
          layout: "horizontal",
          margin: "sm",
          contents: [
            {
              type: "text",
              text: "สถานะ:",
              size: "xs",
              color: "#9CA3AF",
              flex: 2
            },
            {
              type: "text",
              text: statusText,
              size: "xs",
              weight: "bold",
              color: "#0B7C86",
              align: "end",
              flex: 3
            }
          ]
        }
      ]
    },

    // 🔥 FOOTER (ปุ่มคม ๆ)
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      paddingAll: "14px",
      contents: [
        {
          type: "button",
          style: "primary",
          color: "#0B7C86",
          height: "sm",
          action: {
            type: "uri",
            label: "เปิดเคส",
            uri: detailUrl
          }
        },
        {
          type: "button",
          style: "secondary",
          height: "sm",
          action: {
            type: "uri",
            label: "อัปเดตเคส",
            uri: updateUrl
          }
        }
      ]
    }
  };
}
function buildCaseMenuCarouselFlex(title, cases = [], options = {}) {
  return {
    type: "flex",
    altText: title,
    contents: {
      type: "carousel",
      contents: cases.map(item => buildCaseMenuCarouselBubble(item, options))
    }
  };
}

async function replyCaseMenuCarousel({
  replyToken,
  title,
  filterType = "all",
  heroImage = ""
}) {
  const cases = await getOpenCasesForMenu(filterType, 10);

  if (!cases.length) {
    await safeReply(replyToken, [
      {
        type: "text",
        text: `${title}\n\nยังไม่มีรายการเคสในหมวดนี้`
      }
    ]);
    return;
  }

  await safeReply(replyToken, [
    buildCaseMenuCarouselFlex(title, cases, { heroImage })
  ]);
}

async function replyCasesFromRowsCarousel({
  replyToken,
  title,
  rows = [],
  heroImage = ""
}) {
  const items = Array.isArray(rows) ? rows : [];

  if (!items.length) {
    await safeReply(replyToken, [
      {
        type: "text",
        text: `${title}\n\nยังไม่มีรายการเคสในหมวดนี้`
      }
    ]);
    return;
  }

  await safeReply(replyToken, [
    buildCaseMenuCarouselFlex(title, items, { heroImage })
  ]);
}

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
const EFFECTIVE_TEAM_GROUP_ID =
  process.env.EFFECTIVE_TEAM_GROUP_ID ||
  TEAM_GROUP_ID ||
  LINE_GROUP_ID ||
  "";

const PRESENTATION_MODE = true;

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

async function findTeamMemberByUserId(lineUserId) {
  const { data, error } = await supabase
    .from("line_user_roles")
    .select("*")
    .eq("line_user_id", lineUserId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
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
    note: row.latest_note || row.message || null,
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
  case_code: toNullableText(payload.case_code),
  latest_note: toNullableText(payload.latest_note || payload.note || payload.message),
  message: toNullableText(payload.message),
  updated_by: toNullableText(payload.updated_by),
  updated_by_user_id: toNullableText(payload.updated_by_user_id),
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

async function uploadCaseInfoFilesToSupabase(caseCode, files = []) {
  if (!files.length) return [];

  const uploaded = [];

  for (const file of files) {
    const ext = path.extname(file.originalname || "") || "";
    const safeBaseName = String(file.originalname || "file")
      .replace(ext, "")
      .replace(/[^\wก-๙.-]+/g, "_")
      .slice(0, 80);

    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    const filePath = `case-info/${caseCode}/${safeBaseName}-${fileName}`;

    const { error: uploadError } = await supabase.storage
      .from("work-uploads")
      .upload(filePath, file.buffer, {
        contentType: file.mimetype || "application/octet-stream",
        upsert: false
      });

    if (uploadError) {
      throw new Error(`upload failed: ${uploadError.message}`);
    }

    const { data: publicData } = supabase.storage
      .from("work-uploads")
      .getPublicUrl(filePath);

    uploaded.push({
      name: file.originalname || fileName,
      path: filePath,
      url: publicData?.publicUrl || "",
      size: file.size || 0,
      mime_type: file.mimetype || ""
    });
  }

  return uploaded;
}

// =========================
// REVERSE GEOCODING (OSM / NOMINATIM)
// Golden Safe Patch
// =========================
async function reverseGeocodeLatLng(lat, lng) {
  try {
    const latNum = Number(lat);
    const lngNum = Number(lng);

    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
      return null;
    }

    const url =
      `https://nominatim.openstreetmap.org/reverse` +
      `?format=jsonv2&lat=${encodeURIComponent(latNum)}` +
      `&lon=${encodeURIComponent(lngNum)}` +
      `&zoom=18&addressdetails=1`;

    const res = await fetch(url, {
      headers: {
        "User-Agent": "khonchuaykhon-foundation/1.0",
        "Accept-Language": "th"
      }
    });

    if (!res.ok) {
      console.warn("reverseGeocodeLatLng failed:", res.status);
      return null;
    }

    const data = await res.json();
    const addr = data?.address || {};

    // เก็บแบบเผื่อหลายประเทศ/หลายโครงสร้าง
    const province =
      addr.state ||
      addr.province ||
      addr.region ||
      "";

    const district =
      addr.county ||
      addr.state_district ||
      addr.city_district ||
      addr.suburb ||
      "";

    const subdistrict =
      addr.town ||
      addr.city ||
      addr.village ||
      addr.hamlet ||
      addr.neighbourhood ||
      "";

    // เรียงจากละเอียด -> กว้าง
    const parts = [subdistrict, district, province]
      .map(v => String(v || "").trim())
      .filter(Boolean);

    const prettyText =
      parts.length > 0
        ? parts.join(", ")
        : (data?.display_name ? String(data.display_name).trim() : null);

    return {
      latitude: latNum,
      longitude: lngNum,
      location_text: prettyText || `${latNum}, ${lngNum}`,
      raw: data
    };
  } catch (err) {
    console.warn("reverseGeocodeLatLng error:", err?.message || err);
    return null;
  }
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
  case_code: caseCode,
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
  const wantsJson =
    String(req.path || "").startsWith("/api/") ||
    String(req.headers.accept || "").includes("application/json");

  if (!auth.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Dashboard"');

    if (wantsJson) {
      return res.status(401).json({
        ok: false,
        error: "Authentication required"
      });
    }

    return res.status(401).send("Authentication required");
  }

  const base64 = auth.split(" ")[1] || "";
  const decoded = Buffer.from(base64, "base64").toString("utf8");
  const [username, password] = decoded.split(":");

  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Dashboard"');

    if (wantsJson) {
      return res.status(401).json({
        ok: false,
        error: "Invalid credentials"
      });
    }

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

function escapeXml(value = "") {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function loadFontBase64Safe(relativePath) {
  try {
    const abs = path.join(__dirname, relativePath);
    return fs.readFileSync(abs).toString("base64");
  } catch (err) {
    console.warn("FONT LOAD ERROR:", relativePath, err?.message || err);
    return "";
  }
}

const KANIT_REGULAR_BASE64 = loadFontBase64Safe("fonts/Kanit-Regular.ttf");
const KANIT_BOLD_BASE64 = loadFontBase64Safe("fonts/Kanit-Bold.ttf");

function buildEmbeddedFontCss() {
  const chunks = [];

  if (KANIT_REGULAR_BASE64) {
    chunks.push(`
      @font-face {
        font-family: 'KanitEmbedded';
        src: url(data:font/ttf;base64,${KANIT_REGULAR_BASE64}) format('truetype');
        font-weight: 400;
        font-style: normal;
      }
    `);
  }

  if (KANIT_BOLD_BASE64) {
    chunks.push(`
      @font-face {
        font-family: 'KanitEmbedded';
        src: url(data:font/ttf;base64,${KANIT_BOLD_BASE64}) format('truetype');
        font-weight: 700;
        font-style: normal;
      }
    `);
  }

  return chunks.join("\n");
}
function buildUrgentCasePosterSvg(item = {}) {
  const caseCode = escapeXml(item.case_code || "-");
  const fullName = escapeXml(item.full_name || "-");
  const location = escapeXml(item.location || "ยังไม่ระบุพื้นที่");
  const statusText = escapeXml(formatCaseStatusThai(item.status));
  const priorityText = escapeXml(formatPriorityThai(item.priority));
  const updatedAtText = escapeXml(
    formatThaiDateTime(
      item.last_action_at ||
      item.closed_at ||
      item.assigned_at ||
      item.created_at
    )
  );

  const progress = Math.max(0, Math.min(100, Number(item.progress_percent ?? 60)));
  const progressWidth = Math.round((progress / 100) * 300);

  const slaText =
    item.sla_level === "breached"
      ? "ใกล้เกินกำหนด"
      : item.sla_level === "warning"
      ? "ต้องเฝ้าระวัง"
      : "ปกติ";

   const embeddedFontCss = buildEmbeddedFontCss();

  return `
  <svg width="1040" height="1559" viewBox="0 0 1040 1559" xmlns="http://www.w3.org/2000/svg">
    <style>
      ${embeddedFontCss}

      .t1 { font-family: 'KanitEmbedded', sans-serif; font-size: 52px; font-weight: 700; fill: #ffffff; }
.t2 { font-family: 'KanitEmbedded', sans-serif; font-size: 40px; font-weight: 700; fill: #ffffff; }
.t3 { font-family: 'KanitEmbedded', sans-serif; font-size: 28px; font-weight: 700; fill: #444444; }
.t4 { font-family: 'KanitEmbedded', sans-serif; font-size: 28px; font-weight: 400; fill: #444444; }
.t5 { font-family: 'KanitEmbedded', sans-serif; font-size: 30px; font-weight: 700; fill: #d97706; }
.t6 { font-family: 'KanitEmbedded', sans-serif; font-size: 30px; font-weight: 700; fill: #dc2626; }
.t7 { font-family: 'KanitEmbedded', sans-serif; font-size: 24px; font-weight: 400; fill: #666666; }
.t8 { font-family: 'KanitEmbedded', sans-serif; font-size: 30px; font-weight: 700; fill: #f59e0b; }
.t9 { font-family: 'KanitEmbedded', sans-serif; font-size: 42px; font-weight: 700; fill: #444444; }
    </style>

    <!-- code -->
    <text x="520" y="405" text-anchor="middle" class="t2">${caseCode}</text>

    <!-- content -->
    <text x="120" y="590" class="t3">ชื่อ: <tspan class="t4">${fullName}</tspan></text>
    <text x="120" y="665" class="t4">📍 ${location}</text>

    <text x="120" y="760" class="t3">สถานะ: <tspan class="t5">${statusText}</tspan></text>
    <text x="120" y="835" class="t3">ระดับ: <tspan class="t6">${priorityText}</tspan></text>

    <line x1="100" y1="885" x2="940" y2="885" stroke="#DDDDDD" stroke-width="2"/>

    <text x="120" y="965" class="t7">อัปเดตล่าสุด: ${updatedAtText}</text>

    <text x="120" y="1060" class="t8">⚠ SLA: ${escapeXml(slaText)}</text>
    <text x="900" y="1060" text-anchor="end" class="t9">${progress}%</text>

    <!-- progress track -->
    <rect x="120" y="1115" rx="16" ry="16" width="760" height="34" fill="#D1D5DB"/>
    <rect x="120" y="1115" rx="16" ry="16" width="${progressWidth}" height="34" fill="#C7F000"/>
  </svg>
  `;
}

function buildCaseTrackingFlex(item = {}) {
  const statusText = formatCaseStatusThai(item.status);
  const priorityText = formatPriorityThai(item.priority);
  const updatedAtText = formatThaiDateTime(
    item.last_action_at ||
    item.closed_at ||
    item.assigned_at ||
    item.created_at
  );

  const progress = Number(item.progress_percent ?? 60);
  const progressText = `${progress}%`;

  const bgImage =
    "https://img2.pic.in.th/case-card-demo.png"; // เปลี่ยนเป็นภาพจริงของคุณได้

  const slaText =
    item.sla_level === "breached"
      ? "ใกล้เกินกำหนด"
      : item.sla_level === "warning"
      ? "ต้องเฝ้าระวัง"
      : "ปกติ";

  return {
    type: "flex",
    altText: `ติดตามเคส ${item.case_code || "-"}`,
    contents: {
      type: "bubble",
      size: "giga",
      hero: {
        type: "image",
        url: bgImage,
        size: "full",
        aspectRatio: "3:4",
        aspectMode: "cover"
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "0px",
        backgroundColor: "#0B0F1A",
        contents: [
          {
            type: "box",
            layout: "vertical",
            paddingTop: "16px",
            paddingBottom: "8px",
            contents: [
              {
                type: "text",
                text: "ศูนย์ปฏิบัติการเคส",
                color: "#FFFFFF",
                weight: "bold",
                size: "xxl",
                align: "center"
              }
            ]
          },
          {
            type: "box",
            layout: "vertical",
            margin: "md",
            cornerRadius: "18px",
            backgroundColor: "#FFFFFF",
            paddingAll: "0px",
            offsetTop: "-6px",
            contents: [
              {
                type: "box",
                layout: "vertical",
                backgroundColor: "#EF2B1D",
                cornerRadius: "18px",
                paddingTop: "18px",
                paddingBottom: "18px",
                contents: [
                  {
                    type: "text",
                    text: item.case_code || "-",
                    color: "#FFFFFF",
                    weight: "bold",
                    size: "lg",
                    align: "center"
                  }
                ]
              },
              {
                type: "box",
                layout: "vertical",
                paddingAll: "16px",
                spacing: "md",
                contents: [
                  {
                    type: "text",
                    text: `ชื่อ: ${item.full_name || "-"}`,
                    wrap: true,
                    color: "#333333",
                    size: "md"
                  },
                  {
                    type: "text",
                    text: `📍 ${item.location || "ยังไม่ระบุพื้นที่"}`,
                    wrap: true,
                    color: "#555555",
                    size: "sm"
                  },
                  {
                    type: "text",
                    text: `สถานะ: ${statusText}`,
                    wrap: true,
                    color: "#E67E22",
                    weight: "bold",
                    size: "md"
                  },
                  {
                    type: "text",
                    text: `ระดับ: ${priorityText}`,
                    wrap: true,
                    color: "#DC2626",
                    weight: "bold",
                    size: "md"
                  },
                  {
                    type: "separator",
                    margin: "sm"
                  },
                  {
                    type: "text",
                    text: `อัปเดตล่าสุด: ${updatedAtText}`,
                    color: "#666666",
                    size: "sm",
                    wrap: true
                  },
                  {
                    type: "box",
                    layout: "horizontal",
                    margin: "md",
                    contents: [
                      {
                        type: "text",
                        text: `⚠ SLA: ${slaText}`,
                        color: "#F59E0B",
                        weight: "bold",
                        size: "md",
                        flex: 4
                      },
                      {
                        type: "text",
                        text: progressText,
                        align: "end",
                        color: "#333333",
                        weight: "bold",
                        size: "xl",
                        flex: 2
                      }
                    ]
                  },
                  {
                    type: "box",
                    layout: "vertical",
                    backgroundColor: "#E5E7EB",
                    cornerRadius: "20px",
                    height: "16px",
                    contents: [
                      {
                        type: "box",
                        layout: "horizontal",
                        backgroundColor: "#C7F000",
                        cornerRadius: "20px",
                        width: `${Math.max(8, Math.min(progress, 100))}%`,
                        height: "16px",
                        contents: []
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#0B0F1A",
        spacing: "md",
        paddingTop: "8px",
        paddingBottom: "20px",
        paddingStart: "20px",
        paddingEnd: "20px",
        contents: [
          {
            type: "button",
            style: "primary",
            height: "md",
            color: "#0F8AA4",
            action: {
              type: "message",
              label: "ติดตามเคสนี้",
              text: `ติดตามอีกครั้ง ${item.case_code || "-"}`
            }
          },
          {
            type: "button",
            style: "primary",
            height: "md",
            color: "#EF2B1D",
            action: {
              type: "uri",
              label: "เปิดศูนย์ปฏิบัติการ",
              uri: "https://satisfied-stillness-production-7942.up.railway.app/team.html"
            }
          }
        ]
      }
    }
  };
}
function getPriorityHeaderColor(priority = "") {
  return String(priority).toLowerCase() === "urgent" ? "#DC2626" : "#0b7c86";
}
function getCaseHeaderTheme(item = {}) {
  const priority = String(item.priority || "").toLowerCase();
  const slaLevel = String(item.sla_level || "").toLowerCase();

  // 🔴 ด่วน / SLA หลุด
  if (priority === "urgent" || slaLevel === "breached") {
    return {
      color: "#DC2626",
      label: "ด่วน"
    };
  }

  // 🟠 ต้องระวัง
  if (priority === "high" || slaLevel === "warning") {
    return {
      color: "#F97316",
      label: "ต้องระวัง"
    };
  }

  // 🔵 ปกติ
  return {
    color: "#0B7C86",
    label: "ทั่วไป"
  };
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
const headerTheme = getCaseHeaderTheme(item);
const headerColor = headerTheme.color;

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
const headerTheme = getCaseHeaderTheme(item);
const headerColor = headerTheme.color;

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
  const view = String(baseView || "").trim();

  if (view === "join-team") {
    if (process.env.TEAM_JOIN_LIFF_URL) {
      return String(process.env.TEAM_JOIN_LIFF_URL).trim();
    }

    if (process.env.TEAM_JOIN_LIFF_ID) {
      return `https://liff.line.me/${String(process.env.TEAM_JOIN_LIFF_ID).trim()}`;
    }
  }

  let raw = null;

  if (process.env.TEAM_LIFF_URL) {
    raw = String(process.env.TEAM_LIFF_URL).trim();
  } else if (process.env.TEAM_LIFF_ID) {
    raw = `https://liff.line.me/${String(process.env.TEAM_LIFF_ID).trim()}`;
  }

  if (!raw) {
    throw new Error("❌ TEAM_LIFF_URL / TEAM_LIFF_ID not set");
  }

  if (!view) return raw;

  return raw.includes("?")
    ? `${raw}&view=${encodeURIComponent(view)}`
    : `${raw}?view=${encodeURIComponent(view)}`;
}
function buildTeamJoinWelcomeFlex(displayName = "") {
  const safeName = String(displayName || "").trim() || "สมาชิกใหม่";

  return {
    type: "flex",
    altText: "ยินดีต้อนรับ กรุณาสมัครเข้าทีม",
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#0B7C86",
        paddingAll: "18px",
        contents: [
          {
            type: "text",
            text: "ยินดีต้อนรับสู่ทีมงาน",
            color: "#FFFFFF",
            weight: "bold",
            size: "lg",
            align: "center",
            wrap: true
          },
          {
            type: "text",
            text: safeName,
            color: "#E0F2FE",
            size: "sm",
            align: "center",
            margin: "sm",
            wrap: true
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        paddingAll: "18px",
        contents: [
          {
            type: "text",
            text: "ก่อนเริ่มใช้งาน กรุณาสมัครเข้าทีม 1 ครั้ง เพื่อให้ผู้ดูแลระบบกำหนดสิทธิ์การใช้งานให้คุณได้",
            wrap: true,
            size: "sm",
            color: "#334155"
          },
          {
            type: "box",
            layout: "vertical",
            backgroundColor: "#F8FAFC",
            cornerRadius: "12px",
            paddingAll: "12px",
            contents: [
              {
                type: "text",
                text: "หลังสมัครสำเร็จ ผู้ดูแลระบบจะสามารถกำหนดสิทธิ์ให้คุณเป็น Admin / Staff / Viewer ได้ทันที",
                wrap: true,
                size: "xs",
                color: "#475569"
              }
            ]
          }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        paddingAll: "14px",
        contents: [
          {
            type: "button",
            style: "primary",
            height: "sm",
            color: "#22C55E",
            action: {
              type: "uri",
              label: "สมัครเข้าทีม",
              uri: getTeamLiffUrl("join-team")
            }
          },
          {
            type: "button",
            style: "secondary",
            height: "sm",
            action: {
              type: "message",
              label: "ภายหลัง",
              text: "สมัครทีมภายหลัง"
            }
          }
        ]
      }
    }
  };
}

// =========================
// HANDLE VIEW NEW SPLIT
// =========================
async function handleViewNewSplit({ replyToken }) {
  try {
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const { data: newCases, error: newError } = await supabase
      .from("help_requests")
      .select("*")
      .eq("status", "new")
      .gte("created_at", last24h.toISOString())
      .order("created_at", { ascending: false })
      .limit(5);

    if (newError) throw newError;

    const { data: oldCases, error: oldError } = await supabase
      .from("help_requests")
      .select("*")
      .eq("status", "new")
      .lt("created_at", last24h.toISOString())
      .order("created_at", { ascending: false })
      .limit(5);

    if (oldError) throw oldError;

   return safeReply(replyToken, [
      buildNewCaseSplitFlex(newCases || [], oldCases || [])
    ]);
  } catch (err) {
    console.error("handleViewNewSplit error:", err);
   return safeReply(replyToken, [
  { type: "text", text: "เกิดข้อผิดพลาดในการโหลดเคสใหม่" }
]);
  }
}

// =========================
// NEW CASE MENU IMAGEMAP
// =========================

function buildUrgentCaseMenuRevision(counts = {}) {
  const critical = Number(counts.critical || 0);
  const warning = Number(counts.warning || 0);
  const normal = Number(counts.normal || 0);
  return `${critical}-${warning}-${normal}`;
}
async function buildNewCaseMenuImagemap() {
  const rootUrl =
    "https://satisfied-stillness-production-7942.up.railway.app";

  const counts = await getNewCaseMenuCounts();
  const rev = buildNewCaseMenuRevision(counts);

  return {
    type: "imagemap",
    baseUrl: `${rootUrl}/imagemap/new-case-menu-v2-r${rev}`,
    altText: `เมนูดูเคสใหม่ | ทั้งหมด ${counts.total} | ด่วน ${counts.urgent} | ปกติ ${counts.normal}`,
    baseSize: {
      width: 1040,
      height: 1559
    },
    actions: [
      {
        type: "message",
        text: "ดูเคสใหม่ทั้งหมด",
        area: { x: 120, y: 840, width: 800, height: 135 }
      },
      {
        type: "message",
        text: "ดูเคสใหม่ด่วน",
        area: { x: 120, y: 1010, width: 800, height: 135 }
      },
      {
        type: "message",
        text: "ดูเคสใหม่ปกติ",
        area: { x: 120, y: 1180, width: 800, height: 135 }
      },
      {
        type: "message",
        text: "กลับสู่เมนูทีมงาน",
        area: { x: 120, y: 1360, width: 800, height: 140 }
      }
    ]
  };
}

async function buildUrgentCaseMenuImagemap() {
  const rootUrl = "https://satisfied-stillness-production-7942.up.railway.app";

  const counts = await getUrgentCaseMenuCounts();

  console.log("🔥 URGENT MENU COUNTS:", counts);

  return {
    type: "imagemap",
    baseUrl: `${rootUrl}/imagemap/urgent-case-menu-v2`,
   altText: `เมนูเคสด่วน | วิกฤต ${counts.critical} | ใกล้วิกฤต ${counts.warning} | ปกติ ${counts.inProgress}`,
    baseSize: {
      width: 1040,
      height: 1559
    },
    actions: [
      {
        type: "message",
        text: "เคสด่วน SLA วิกฤต",
        area: { x: 120, y: 840, width: 800, height: 135 }
      },
      {
        type: "message",
        text: "เคสด่วน SLA ใกล้วิกฤต",
        area: { x: 120, y: 1010, width: 800, height: 135 }
      },
      {
        type: "message",
        text: "เคสด่วน SLA ปกติ",
        area: { x: 120, y: 1180, width: 800, height: 135 }
      },
      {
        type: "message",
        text: "กลับสู่เมนูทีมงาน",
        area: { x: 120, y: 1360, width: 800, height: 140 }
      }
    ]
  };
}
 
function buildPosterModeFlex() {
  return {
    type: "flex",
    altText: "ศูนย์ปฏิบัติการเคส",
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "0px",
        contents: [
          {
            type: "image",
            url: "https://img2.pic.in.th/pic/kck-poster.jpg",
            size: "full",
            aspectMode: "cover",
            
          },
          {
            type: "box",
            layout: "vertical",
            paddingAll: "16px",
            spacing: "10px",
            contents: [
              {
                type: "button",
                style: "primary",
                color: "#22C55E",
                action: {
                  type: "message",
                  label: "ดูเคสวันนี้",
                  text: "เคสวันนี้"
                }
              },
              {
                type: "button",
                style: "primary",
                color: "#22C55E",
                action: {
                  type: "message",
                  label: "ดูเคสด่วน",
                  text: "ดูเคสด่วน"
                }
              },
              {
                type: "button",
                style: "primary",
                color: "#22C55E",
                action: {
                  type: "message",
                  label: "ค้นหาเคส",
                  text: "ค้นหาเคส"
                }
              },
              {
                type: "button",
                style: "primary",
                color: "#F97316",
                action: {
                  type: "uri",
                  label: "เปิดศูนย์ปฏิบัติการ",
                  uri: "https://your-domain.com/team.html"
                }
              }
            ]
          }
        ]
      }
    }
  };
}

  
// =========================
// NEW + OLD CASE FLEX (PRO MAX)
// =========================
function buildNewCaseSplitFlex(newCases, oldCases) {
  return {
    type: "flex",
    altText: "เคสใหม่ / เคสค้าง",
    contents: {
      type: "bubble",
      size: "giga",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "lg",
        contents: [

          {
            type: "text",
            text: "📋 เคสใหม่ (วันนี้)",
            weight: "bold",
            size: "xl"
          },

          ...(newCases.length > 0
            ? newCases.slice(0, 3).map(c => ({
                type: "box",
                layout: "vertical",
                paddingAll: "12px",
                backgroundColor: "#E8F8F0",
                cornerRadius: "12px",
                contents: [
                  { type: "text", text: `📌 ${c.case_code}`, weight: "bold" },
                  { type: "text", text: c.problem || "-", size: "sm", wrap: true },
                  { type: "text", text: `📍 ${c.location || "-"}`, size: "xs", color: "#666666" }
                ]
              }))
            : [{ type: "text", text: "ไม่มีเคสใหม่", size: "sm", color: "#999999" }]),

          { type: "separator", margin: "lg" },

          {
            type: "text",
            text: "⚠️ เคสค้าง",
            weight: "bold",
            size: "xl"
          },

          ...(oldCases.length > 0
            ? oldCases.slice(0, 3).map(c => ({
                type: "box",
                layout: "vertical",
                paddingAll: "12px",
                backgroundColor: "#FFF4E5",
                cornerRadius: "12px",
                contents: [
                  { type: "text", text: `📌 ${c.case_code}`, weight: "bold" },
                  { type: "text", text: c.problem || "-", size: "sm", wrap: true },
                  { type: "text", text: `📍 ${c.location || "-"}`, size: "xs", color: "#666666" }
                ]
              }))
            : [{ type: "text", text: "ไม่มีเคสค้าง", size: "sm", color: "#999999" }])

        ]
      }
    }
  };
}


function buildTeamMenuFlex() {
  function messageButton(label, text, color = "#22C55E") {
    return {
      type: "button",
      style: "primary",
      height: "sm",
      color,
      action: {
        type: "message",
        label: label.slice(0, 20),
        text
      }
    };
  }

  function uriButton(label, uri, color = "#F97316") {
    return {
      type: "button",
      style: "primary",
      height: "sm",
      color,
      action: {
        type: "uri",
        label: label.slice(0, 20),
        uri
      }
    };
  }

  return {
    type: "flex",
    altText: "เมนูทีมงาน | ศูนย์ปฏิบัติการ",
    contents: {
  type: "bubble",
  size: "mega",
  hero: {
        type: "image",
        url: "https://img2.pic.in.th/Teamwork.png",
        size: "full",
        aspectRatio: "1:1",
        aspectMode: "cover"
      },
      body: {
  type: "box",
  layout: "vertical",
  spacing: "12px",
  paddingAll: "18px",
  backgroundColor: "#000000",
 contents: [
  whiteButton("ดูเคสวันนี้", "เคสวันนี้"),
  whiteButton("ดูเคสด่วน", "ดูเคสด่วน"),
  whiteButton("ค้นหาเคส", "ค้นหาเคส"),
  orangeButton(
    "เปิดศูนย์ปฏิบัติการ",
    "https://satisfied-stillness-production-7942.up.railway.app/team.html"
  )
]
      }
    }
  };
} // <- ตัวนี้หายอยู่ตอนนี้

function whiteButton(label, text) {
  return {
    type: "box",
    layout: "vertical",
    margin: "sm",
    contents: [
      {
        // 👇 ชั้นล่าง (เงา)
        type: "box",
        layout: "vertical",
        backgroundColor: "#D1D5DB",
        cornerRadius: "16px",
        paddingAll: "2px",
        contents: [
          {
            // 👇 ชั้นบน (ปุ่มจริง)
            type: "box",
            layout: "vertical",
            backgroundColor: "#F9FAFB",
            cornerRadius: "14px",
            paddingAll: "12px",
            contents: [
              {
                type: "text",
                text: label,
                weight: "bold",
                size: "md",
                color: "#111827",
                align: "center",
                action: {
                  type: "message",
                  label: label,
                  text: text
                }
              }
            ]
          }
        ]
      }
    ]
  };
}
function orangeButton(label, uri) {
  return {
    type: "box",
    layout: "vertical",
    margin: "sm",
    contents: [
      {
        type: "box",
        layout: "vertical",
        backgroundColor: "#7F1D1D",
        cornerRadius: "16px",
        paddingAll: "2px",
        contents: [
          {
            type: "box",
            layout: "vertical",
            backgroundColor: "#DC2626",
            cornerRadius: "14px",
            paddingAll: "12px",
            contents: [
              {
                type: "text",
                text: label,
                weight: "bold",
                size: "md",
                color: "#FFFFFF",
                align: "center",
                action: {
                  type: "uri",
                  label: label,
                  uri: uri
                }
              }
            ]
          }
        ]
      }
    ]
  };
}

// =========================
// TEAM MENU IMAGEMAP (SAFE PATCH)
// วางหลัง orangeButton()
// และก่อน buildTeamNewCaseText()
// =========================
function buildTeamMenuImagemap(baseUrlOverride = "") {
  const baseUrl =
    String(baseUrlOverride || process.env.APP_ORIGIN || process.env.URL || "").replace(/\/+$/, "") ||
    "https://satisfied-stillness-production-7942.up.railway.app";

return {
  type: "imagemap",
  baseUrl: `${baseUrl}/imagemap/team-menu`,
  altText: "เมนูทีมงาน | ศูนย์ปฏิบัติการ",
  baseSize: {
    width: 1040,
    height: 1559
  },
    
// BACKUP OLD HITBOX
// area: { x: 120, y: 950, width: 800, height: 140 }
// area: { x: 120, y: 1110, width: 800, height: 140 }
// area: { x: 120, y: 1270, width: 800, height: 140 }
// area: { x: 120, y: 1430, width: 800, height: 140 }
    
actions: [
 {
  type: "message",
  text: "ดูเคสใหม่",
  area: { x: 70, y: 880, width: 900, height: 140 }
},
  {
    type: "message",
    text: "ดูเคสด่วน",
    area: { x: 70, y: 1050, width: 900, height: 140 }
  },
  {
    type: "message",
    text: "ค้นหาเคส",
    area: { x: 70, y: 1220, width: 900, height: 140 }
  },
  {
    type: "uri",
    linkUri: "https://satisfied-stillness-production-7942.up.railway.app/team.html",
    area: { x: 70, y: 1380, width: 900, height: 120 }
  }
]
};
}

// =========================
// ADMIN MENU IMAGEMAP (SAFE PATCH)
// วางต่อจาก buildTeamMenuImagemap()
// =========================
function buildAdminMenuImagemap(baseUrlOverride = "", revision = Date.now()) {
  const baseUrl =
    String(baseUrlOverride || process.env.APP_ORIGIN || process.env.URL || "").replace(/\/+$/, "") ||
    "https://satisfied-stillness-production-7942.up.railway.app";

  return {
    type: "imagemap",
    baseUrl: `${baseUrl}/imagemap/admin-main-menu-r${revision}`,
    altText: "เมนูแอดมิน | ผู้ดูแลระบบ",
    baseSize: {
      width: 1040,
      height: 1559
    },
    actions: [
     {
  type: "message",
  text: "เปิดเมนูจัดการเคส",
  area: { x: 120, y: 875, width: 800, height: 140 }
},
{
  type: "message",
  text: "เมนูรายงานผู้บริหาร",
  area: { x: 120, y: 1035, width: 800, height: 140 }
},
{
  type: "message",
  text: "เปิดเมนูจัดการทีม",
  area: { x: 120, y: 1195, width: 800, height: 140 }
},
{
  type: "message",
  text: "Smart Alert",
  area: { x: 120, y: 1365, width: 800, height: 130 }
}    ]
  };
}

// =========================
// ADMIN CASE MENU IMAGEMAP (SAFE PATCH)
// วางต่อจาก buildAdminMenuImagemap()
// =========================
function buildAdminCaseMenuImagemap(baseUrlOverride = "", revision = Date.now()) {
  const baseUrl =
    String(baseUrlOverride || process.env.APP_ORIGIN || process.env.URL || "").replace(/\/+$/, "") ||
    "https://satisfied-stillness-production-7942.up.railway.app";

  return {
    type: "imagemap",
    baseUrl: `${baseUrl}/imagemap/admin-case-menu-r${revision}`,
    altText: "เมนูจัดการเคส | ผู้ดูแลระบบ",
    baseSize: {
      width: 1040,
      height: 1559
    },
    actions: [
  {
    type: "message",
    text: "ดูเคสใหม่ทั้งหมด",
    area: { x: 120, y: 715, width: 800, height: 140 }
  },
  {
    type: "message",
    text: "ดูเคสใหม่ด่วน",
    area: { x: 120, y: 875, width: 800, height: 140 }
  },
  {
    type: "message",
    text: "เคสวันนี้",
    area: { x: 120, y: 1035, width: 800, height: 140 }
  },
  {
    type: "message",
    text: "ค้นหาเคส",
    area: { x: 120, y: 1195, width: 800, height: 110 }
  },
  {
    type: "message",
    text: "เมนูแอดมิน",
    area: { x: 120, y: 1325, width: 800, height: 120 }
  }
]
  };
}

// =========================
// ADMIN DASHBOARD MENU IMAGEMAP (SAFE PATCH)
// วางต่อจาก buildAdminCaseMenuImagemap()
// ใช้ภาพ dashboard.png
// =========================
function buildAdminDashboardMenuImagemap(baseUrlOverride = "", revision = Date.now()) {
  const baseUrl =
    String(baseUrlOverride || process.env.APP_ORIGIN || process.env.URL || "").replace(/\/+$/, "") ||
    "https://satisfied-stillness-production-7942.up.railway.app";

  return {
    type: "imagemap",
    baseUrl: `${baseUrl}/imagemap/admin-dashboard-menu-r${revision}`,
    altText: "เมนูรายงานผู้บริหาร | ผู้ดูแลระบบ",
    baseSize: {
      width: 1040,
      height: 1559
    },
actions: [
  {
    type: "uri",
    linkUri: `${baseUrl}/dashboard`,
    area: { x: 120, y: 781, width: 800, height: 120 }
  },
  {
    type: "uri",
    linkUri: `${baseUrl}/report`,
    area: { x: 120, y: 941, width: 800, height: 120 }
  },
  {
    type: "message",
    text: "Smart Alert",
    area: { x: 120, y: 1101, width: 800, height: 120 }
  },
  {
    type: "uri",
    linkUri: `${baseUrl}/command-center`,
    area: { x: 120, y: 1261, width: 800, height: 120 }
  },
  {
    type: "message",
    text: "เมนูแอดมิน",
    area: { x: 120, y: 1421, width: 800, height: 90 }
  }
]
  };
}

// =========================
// SMART ALERT MENU IMAGEMAP (SAFE PATCH)
// วางต่อจาก buildAdminDashboardMenuImagemap()
// ใช้ภาพ SmartAlert.png
// =========================
function buildSmartAlertMenuImagemap(baseUrlOverride = "", revision = Date.now()) {
  const baseUrl =
    String(baseUrlOverride || process.env.APP_ORIGIN || process.env.URL || "").replace(/\/+$/, "") ||
    "https://satisfied-stillness-production-7942.up.railway.app";

  return {
    type: "imagemap",
    baseUrl: `${baseUrl}/imagemap/smart-alert-menu-r${revision}`,
    altText: "Smart Alert | ผู้ดูแลระบบ",
    baseSize: {
      width: 1040,
      height: 1559
    },
    actions: [
  {
    type: "message",
    text: "ดู SLA วิกฤต",
    area: { x: 120, y: 755, width: 800, height: 120 }
  },
  {
    type: "message",
    text: "ดูใกล้หลุด SLA",
    area: { x: 120, y: 923, width: 800, height: 120 }
  },
  {
    type: "message",
    text: "ดูเคสเปิดทั้งหมด",
    area: { x: 120, y: 1091, width: 800, height: 120 }
  },
  {
    type: "uri",
    linkUri: `${baseUrl}/command-center`,
    area: { x: 120, y: 1250, width: 800, height: 120 }
  },
  {
    type: "message",
    text: "เมนูรายงานผู้บริหาร",
    area: { x: 120, y: 1413, width: 800, height: 90 }
  }
]
  };
}

// =========================
// ADMIN TEAM MANAGE MENU IMAGEMAP (SAFE PATCH)
// วางต่อจาก buildSmartAlertMenuImagemap()
// ใช้ภาพ team-manage.png หรือภาพเมนูบริหารทีมของคุณ
// =========================
function buildAdminTeamManageMenuImagemap(baseUrlOverride = "", revision = Date.now()) {
  const baseUrl =
    String(baseUrlOverride || process.env.APP_ORIGIN || process.env.URL || "").replace(/\/+$/, "") ||
    "https://satisfied-stillness-production-7942.up.railway.app";

  const teamManagementUrl = `${baseUrl}/team-management.html`;

  return {
    type: "imagemap",
    baseUrl: `${baseUrl}/imagemap/admin-team-manage-menu-r${revision}`,
    altText: "เมนูบริหารจัดการทีม | ผู้ดูแลระบบ",
    baseSize: {
      width: 1040,
      height: 1560
    },
    actions: [
      {
        type: "uri",
        linkUri: `${teamManagementUrl}?mode=list`,
        area: { x: 120, y: 760, width: 800, height: 120 }
      },
      {
        type: "uri",
        linkUri: `${teamManagementUrl}?mode=role`,
        area: { x: 120, y: 928, width: 800, height: 120 }
      },
      {
        type: "uri",
        linkUri: `${teamManagementUrl}?mode=add`,
        area: { x: 120, y: 1096, width: 800, height: 120 }
      },
      {
        type: "uri",
        linkUri: `${baseUrl}/command-center`,
        area: { x: 120, y: 1255, width: 800, height: 120 }
      },
      {
        type: "message",
        text: "เมนูแอดมิน",
        area: { x: 120, y: 1412, width: 800, height: 90 }
      }
    ]
  };
}

function buildUrgentCasePosterImagemap(caseData = {}, baseUrlOverride = "") {
  const baseUrl =
    String(baseUrlOverride || process.env.APP_ORIGIN || process.env.URL || "").replace(/\/+$/, "") ||
    "https://satisfied-stillness-production-7942.up.railway.app";

  const caseCode = String(caseData?.case_code || "").trim();
  const rawStatus = String(caseData?.status || "").toLowerCase();
  const isClosed = rawStatus === "done" || rawStatus === "closed" || rawStatus === "cancelled";

  const actions = [];

  if (!isClosed) {
    actions.push({
      type: "message",
      text: `ติดตามอีกครั้ง ${caseCode}`,
      area: { x: 180, y: 1190, width: 680, height: 120 }
    });
  }

  actions.push({
    type: "uri",
    linkUri: `${baseUrl}/team.html?case_code=${encodeURIComponent(caseCode)}`,
    area: isClosed
      ? { x: 180, y: 1190, width: 680, height: 145 }
      : { x: 180, y: 1380, width: 680, height: 145 }
  });

  return {
    type: "imagemap",
    baseUrl: `${baseUrl}/imagemap/urgent-case-poster/1040?case_code=${encodeURIComponent(caseCode)}&v=3`,
    altText: `ศูนย์ปฏิบัติการเคสด่วน ${caseCode || ""}`,
    baseSize: {
      width: 1040,
      height: 1559
    },
    actions
  };
}
// =========================
// OVERLAY MENU (PRO MAX++)
// วางหลัง orangeButton()
// และก่อน buildTeamNewCaseText()
// =========================

function buildSearchMenuImagemap(baseUrlOverride = "") {
  const baseUrl =
    String(baseUrlOverride || process.env.APP_ORIGIN || process.env.URL || "").replace(/\/+$/, "") ||
    "https://satisfied-stillness-production-7942.up.railway.app";

  return {
    type: "imagemap",
    baseUrl: `${baseUrl}/imagemap/search-menu-v2`,
    altText: "เมนูค้นหาเคส",
    baseSize: {
      width: 1040,
      height: 1559
    },
    actions: [
  {
    type: "message",
    text: "ค้นหาด้วยเบอร์โทร",
    area: { x: 120, y: 1055, width: 800, height: 150 }
  },
  {
    type: "message",
    text: "ค้นหาด้วยเลขเคส",
    area: { x: 120, y: 1240, width: 800, height: 150 }
  }
]
  };
}

// =========================
// SEARCH PHONE PROMPT IMAGEMAP (SAFE PATCH)
// วางต่อจาก buildSearchMenuImagemap()
// ใช้ภาพ Telcase.png
// =========================
function buildSearchPhonePromptImagemap(baseUrlOverride = "", revision = Date.now()) {
  const baseUrl =
    String(baseUrlOverride || process.env.APP_ORIGIN || process.env.URL || "").replace(/\/+$/, "") ||
    "https://satisfied-stillness-production-7942.up.railway.app";

  return {
    type: "imagemap",
    baseUrl: `${baseUrl}/imagemap/search-phone-prompt-r${revision}`,
    altText: "ค้นหาเคสด้วยเบอร์โทร",
    baseSize: {
      width: 1040,
      height: 1559
    },
    actions: [
      {
        type: "message",
        text: "กลับสู่เมนูค้นหาเคส",
        area: { x: 140, y: 1260, width: 760, height: 140 }
      }
    ]
  };
}

// =========================
// SEARCH CASE CODE PROMPT IMAGEMAP (SAFE PATCH)
// วางต่อจาก buildSearchPhonePromptImagemap()
// ใช้ภาพ NumberCase.png
// =========================
function buildSearchCaseCodePromptImagemap(baseUrlOverride = "", revision = Date.now()) {
  const baseUrl =
    String(baseUrlOverride || process.env.APP_ORIGIN || process.env.URL || "").replace(/\/+$/, "") ||
    "https://satisfied-stillness-production-7942.up.railway.app";

  return {
    type: "imagemap",
    baseUrl: `${baseUrl}/imagemap/search-casecode-prompt-r${revision}`,
    altText: "ค้นหาเคสด้วยเลขเคส",
    baseSize: {
      width: 1040,
      height: 1559
    },
    actions: [
      {
        type: "message",
        text: "กลับสู่เมนูค้นหาเคส",
        area: { x: 140, y: 1260, width: 760, height: 140 }
      }
    ]
  };
}


function buildTeamMenuOverlayFlex() {
  return {
    type: "flex",
    altText: "เมนูทีมงาน (Overlay)",
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "0px",
        contents: [
          {
            type: "box",
            layout: "vertical",
            flex: 85,
            contents: [
              {
                type: "image",
                url: "https://img1.pic.in.th/images/New_WorkTeamed5ed051c96db132.png",
                size: "full",
                aspectMode: "cover",
             
              }
            ]
          },
          {
            type: "box",
            layout: "vertical",
            flex: 15,
            paddingAll: "4px",
            backgroundColor: "#000000",
            contents: [
              hit("ดูเคสใหม่", "ดูเคสใหม่"),
              hit("ดูเคสด่วน", "ดูเคสด่วน"),
              hit("ค้นหาเคส", "ค้นหาเคส"),
              hitUri(
                "เปิดศูนย์ปฏิบัติการ",
                "https://satisfied-stillness-production-7942.up.railway.app/team.html"
              )
            ]
          }
        ]
      }
    }
  };
}

function hit(label, text) {
  return {
    type: "box",
    layout: "vertical",
    height: "44px",
    margin: "sm",
    backgroundColor: "#00000000",
    contents: [
      {
        type: "text",
        text: label,
        color: "#00000000",
        size: "sm",
        action: {
          type: "message",
          label: label,
          text: text
        }
      }
    ]
  };
}

function hitUri(label, uri) {
  return {
    type: "box",
    layout: "vertical",
    height: "48px",
    margin: "sm",
    backgroundColor: "#00000000",
    contents: [
      {
        type: "text",
        text: label,
        color: "#00000000",
        size: "sm",
        action: {
          type: "uri",
          label: label,
          uri: uri
        }
      }
    ]
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
}// =========================
// GOLDEN SAFE: PRESENTATION NOTIFY
// =========================
async function sendPresentationNotify({ replyToken = "", fallbackText = "" }) {
  try {
    if (!replyToken) {
      console.warn("sendPresentationNotify: missing replyToken");
      return false;
    }

    const res = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        replyToken,
        messages: [
          buildTeamMenuImagemap()
        ]
      })
    });

    if (!res.ok) {
      const text = await res.text();
      console.warn("LINE reply failed:", text);
      return false;
    }

    console.log("LINE reply status: 200");
    return true;

  } catch (err) {
    console.warn("sendPresentationNotify error:", err?.message || err);
    return false;
  }
}

// =========================
// GOLDEN SAFE PATCH: TEAM GROUP PUSH HELPERS
// FINAL FIX - SAFE / NO REGRESSION
// =========================

function getEffectiveTeamGroupId() {
  return (
    process.env.EFFECTIVE_TEAM_GROUP_ID ||
    process.env.TEAM_GROUP_ID ||
    process.env.LINE_GROUP_ID ||
    ""
  ).trim();
}

function maskGroupId(groupId = "") {
  if (!groupId) return "(empty)";
  if (groupId.length <= 10) return groupId;
  return `${groupId.slice(0, 6)}...${groupId.slice(-4)}`;
}

function buildLineHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`
  };
}

async function safePushToTeamGroup(messages, debugLabel = "team-group-push") {
  const groupId = getEffectiveTeamGroupId();

  console.log(`[${debugLabel}] start`);
  console.log(`[${debugLabel}] effectiveGroupId = ${maskGroupId(groupId)}`);
  console.log(`[${debugLabel}] messageCount = ${Array.isArray(messages) ? messages.length : 0}`);

  if (!CHANNEL_ACCESS_TOKEN) {
    console.warn(`[${debugLabel}] skip: CHANNEL_ACCESS_TOKEN missing`);
    return { ok: false, skipped: true, reason: "missing_channel_access_token" };
  }

  if (!groupId) {
    console.warn(`[${debugLabel}] skip: team group id missing`);
    return { ok: false, skipped: true, reason: "missing_group_id" };
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    console.warn(`[${debugLabel}] skip: no messages`);
    return { ok: false, skipped: true, reason: "empty_messages" };
  }

  try {
    const response = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: buildLineHeaders(),
      body: JSON.stringify({
        to: groupId,
        messages
      })
    });

    const rawText = await response.text();

    if (!response.ok) {
      console.warn(`[${debugLabel}] LINE push failed: ${response.status} ${response.statusText}`);
      console.warn(`[${debugLabel}] response = ${rawText}`);

      return {
        ok: false,
        skipped: false,
        reason: "line_push_failed",
        status: response.status,
        statusText: response.statusText,
        body: rawText
      };
    }

    console.log(`[${debugLabel}] push success`);
    return {
      ok: true,
      skipped: false,
      status: response.status,
      body: rawText
    };
  } catch (error) {
    console.warn(`[${debugLabel}] fetch error:`, error?.message || error);
    return {
      ok: false,
      skipped: false,
      reason: "fetch_error",
      error: error?.message || String(error)
    };
  }
}
async function pushTeamNewCaseNotification(item = {}) {
  const sla = computeSlaState(item);
  item.sla_level = sla.sla_level;

  const flex = buildTeamNewCaseFlex(item);
  const fallbackText = buildTeamNewCaseText(item);

  if (PRESENTATION_MODE) {
    console.log("📣 HYBRID MODE: reply user + push team (new case)");

    if (item.replyToken) {
      try {
        const replied = await sendPresentationNotify({
          replyToken: item.replyToken,
          fallbackText: `📣 รับเรื่องแล้ว\nเลขเคส: ${item.case_code || "-"}`
        });

        if (!replied) {
          console.warn("HYBRID reply user failed");
        }
      } catch (err) {
        console.warn("HYBRID reply user error:", err?.message || err);
      }
    } else {
      console.warn("HYBRID new case: missing replyToken");
    }

    const pushResult = await safePushToTeamGroup(
      [flex, { type: "text", text: fallbackText }],
      "pushTeamNewCaseNotification"
    );

    console.log("[pushTeamNewCaseNotification] result =", pushResult);
    return pushResult;
  }

  const pushResult = await safePushToTeamGroup(
    [flex, { type: "text", text: fallbackText }],
    "pushTeamNewCaseNotification"
  );

  console.log("[pushTeamNewCaseNotification] result =", pushResult);
  return pushResult;
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
  const sla = computeSlaState(item);
  item.sla_level = sla.sla_level;

  const flex = buildTeamFollowupFlex(item, followupCount);
  const fallbackText = buildTeamFollowupText(item, followupCount);

  if (PRESENTATION_MODE) {
    console.log("📣 HYBRID MODE: reply user + push team (followup)");

    if (item.replyToken) {
      try {
        const replied = await sendPresentationNotify({
          replyToken: item.replyToken,
          fallbackText:
            "📣 รับคำขอติดตามเคสแล้ว\n" +
            `เลขเคส: ${item.case_code || "-"}\n` +
            `ติดตามซ้ำครั้งที่ ${followupCount}`
        });

        if (!replied) {
          console.warn("HYBRID followup reply failed");
        }
      } catch (err) {
        console.warn("HYBRID followup reply error:", err?.message || err);
      }
    } else {
      console.warn("HYBRID followup: missing replyToken");
    }

    const pushResult = await safePushToTeamGroup(
      [flex, { type: "text", text: fallbackText }],
      "pushTeamFollowupNotification"
    );

    console.log("[pushTeamFollowupNotification] result =", pushResult);
    return pushResult;
  }

  const pushResult = await safePushToTeamGroup(
    [flex, { type: "text", text: fallbackText }],
    "pushTeamFollowupNotification"
  );

  console.log("[pushTeamFollowupNotification] result =", pushResult);
  return pushResult;
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


function buildAdminMenuFlex(sla = {}) {
  const overdue = Number(sla.overdue || 0);
  const nearDue = Number(sla.near_due || 0);
  const openCases = Number(sla.open_cases || 0);
  const smartAlert = Number(sla.smart_alert || 0);

  function messageButton(label, text, color = "#20C44A") {
    return {
      type: "button",
      style: "primary",
      height: "sm",
      color,
      action: {
        type: "message",
        label: label.slice(0, 20),
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
        label: label.slice(0, 20),
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
            uriButton("แดชบอร์ดผู้บริหาร", "https://satisfied-stillness-production-7942.up.railway.app/dashboard"),
            uriButton("รายงานผู้บริหาร", "https://satisfied-stillness-production-7942.up.railway.app/report"),
            messageButton("Smart Alert", "ดู Smart Alert"),
            uriButton("เปิดศูนย์ปฏิบัติการ", "https://satisfied-stillness-production-7942.up.railway.app/command-center")
          ]
        ),

        buildMenuBubble(
          "https://img1.pic.in.th/images/346dc5fe1957cf436.png",
          [
            messageButton("ดูทีม", "เปิดเมนูจัดการทีม"),
            messageButton("ดูสิทธิ์", "คำสั่งดูสิทธิ์"),
            messageButton("เพิ่มทีม", "คำสั่งเพิ่มทีม"),
            messageButton("ลบทีม", "คำสั่งลบทีม"),
          ]
        )
      ]
    }
  };
}

function buildTeamManageFlex() {
  function btn(label, text) {
    return {
      type: "button",
      style: "primary",
      height: "sm",
      color: "#22C55E",
      action: {
        type: "message",
        label,
        text
      }
    };
  }

  return {
    type: "flex",
    altText: "เมนูจัดการทีม",
    contents: {
      type: "bubble",
      size: "mega",
      hero: {
        type: "image",
        url: "https://img1.pic.in.th/images/346dc5fe1957cf436.png",
        size: "full",
        aspectRatio: "1:1",
        aspectMode: "cover"
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "10px",
        paddingAll: "14px",
        contents: [
          {
            type: "button",
            style: "primary",
            height: "sm",
            color: "#22C55E",
            action: {
              type: "uri",
              label: "ดูรายชื่อทีมงาน",
              uri: `${TEAM_MANAGEMENT_URL}?mode=list`
            }
          },
          {
            type: "button",
            style: "primary",
            height: "sm",
            color: "#22C55E",
            action: {
              type: "uri",
              label: "กำหนดสิทธิ์ทีมงาน",
              uri: `${TEAM_MANAGEMENT_URL}?mode=role`
            }
          },
          {
            type: "button",
            style: "secondary",
            height: "sm",
            action: {
              type: "uri",
              label: "เพิ่มทีมงาน",
              uri: `${TEAM_MANAGEMENT_URL}?mode=add`
            }
          },
          btn("ลบทีมงาน", "คำสั่งลบทีม")
        ]
      }
    }
  };
}

function getTeamRoleTheme(role = "") {
  const r = String(role || "").toLowerCase();

  if (r === "admin") {
    return { color: "#DC2626", label: "ผู้ดูแลระบบ" };
  }
  if (r === "staff") {
    return { color: "#F97316", label: "ทีมงาน" };
  }
  if (r === "viewer") {
    return { color: "#0B7C86", label: "ดูได้อย่างเดียว" };
  }

  return { color: "#6B7280", label: role || "ไม่ระบุ" };
}

function buildTeamMemberFlex(item = {}) {
  const theme = getTeamRoleTheme(item.role);
  const activeText = item.is_active === false ? "ปิดการใช้งาน" : "ใช้งานอยู่";

  return {
    type: "flex",
    altText: `ข้อมูลทีม ${item.line_user_id || "-"}`,
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: theme.color,
        paddingAll: "16px",
        contents: [
          {
            type: "text",
            text: "ข้อมูลทีมงาน",
            color: "#FFFFFF",
            weight: "bold",
            size: "lg",
            align: "center"
          },
          {
            type: "text",
            text: theme.label,
            color: "#F9FAFB",
            size: "sm",
            margin: "sm",
            align: "center"
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        paddingAll: "16px",
        contents: [
          {
            type: "text",
            text: `LINE USER ID: ${item.line_user_id || "-"}`,
            wrap: true,
            size: "sm"
          },
          {
            type: "text",
            text: `สิทธิ์: ${item.role || "-"}`,
            wrap: true,
            size: "sm"
          },
          {
            type: "text",
            text: `สถานะ: ${activeText}`,
            wrap: true,
            size: "sm"
          }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        paddingAll: "14px",
        contents: [
          {
            type: "button",
            style: "secondary",
            height: "sm",
            action: {
              type: "message",
              label: "ดูสิทธิ์",
              text: `ดูสิทธิ์ ${item.line_user_id || ""}`
            }
          }
        ]
      }
    }
  };
}

async function listPendingTeamCandidates() {
  try {
   const { data, error } = await supabase
  .from("team_candidates")
  .select("id, line_user_id, display_name, picture_url, status, created_at")
  .eq("status", "pending")
  .order("created_at", { ascending: false });

    if (error) {
      console.error("listPendingTeamCandidates error:", error);
      return [];
    }

    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error("listPendingTeamCandidates failed:", err);
    return [];
  }
}

function normalizeSelectableUser(raw = {}, source = "recent") {
  const lineUserId =
    String(raw.line_user_id || raw.user_id || raw.lineId || raw.userId || "").trim();

  const displayName =
    String(raw.display_name || raw.name || raw.full_name || "ไม่ระบุชื่อ").trim();

  const pictureUrl =
    String(raw.picture_url || raw.picture || raw.avatar_url || "").trim();

  const candidateStatus =
    String(raw.status || raw.candidate_status || "").trim().toLowerCase();

  return {
    line_user_id: lineUserId,
    display_name: displayName,
    picture_url: pictureUrl,
    source,
    created_at: raw.created_at || null,
    candidate_status: candidateStatus || null
  };
}

async function getSelectableTeamUsers() {
  try {
    let recentUsers = [];

    try {
      if (typeof getRecentUsers === "function") {
        recentUsers = await getRecentUsers();
      } else if (typeof listRecentUsers === "function") {
        recentUsers = await listRecentUsers();
      } else {
        console.warn("getSelectableTeamUsers: recent users helper not found");
      }
    } catch (err) {
      console.error("getSelectableTeamUsers recentUsers failed:", err);
      recentUsers = [];
    }

    const pendingCandidates = await listPendingTeamCandidates();

const merged = [
 
  ...(Array.isArray(recentUsers)
    ? recentUsers.map((u) => normalizeSelectableUser(u, "recent"))
    : []),
  ...(Array.isArray(pendingCandidates)
    ? pendingCandidates.map((u) => normalizeSelectableUser(u, "candidate"))
    : [])
];

    const map = new Map();

    for (const user of merged) {
      const key = String(user.line_user_id || "").trim();
      if (!key) continue;

      if (!map.has(key)) {
        map.set(key, user);
        continue;
      }

      const existing = map.get(key);

      if (existing.source !== "candidate" && user.source === "candidate") {
        map.set(key, user);
      }
    }

    const result = Array.from(map.values());

    result.sort((a, b) => {
      if (a.source === "candidate" && b.source !== "candidate") return -1;
      if (a.source !== "candidate" && b.source === "candidate") return 1;
      return String(a.display_name || "").localeCompare(String(b.display_name || ""), "th");
    });

    return result;
  } catch (err) {
    console.error("getSelectableTeamUsers failed:", err);
    return [];
  }
}

async function approvePendingTeamCandidate(lineUserId, approvedRole, approvedBy = "") {
  try {
    const userId = String(lineUserId || "").trim();
    const role = String(approvedRole || "").trim();
    const approvedByUser = String(approvedBy || "").trim();

    if (!userId) {
      return { success: false, reason: "missing_line_user_id" };
    }

    const { data: pendingRow, error: findError } = await supabase
      .from("team_candidates")
      .select("id, line_user_id, status")
      .eq("line_user_id", userId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (findError) {
      console.error("approvePendingTeamCandidate find error:", findError);
      return { success: false, reason: "find_failed", error: findError };
    }

    if (!pendingRow) {
      return { success: true, skipped: true, reason: "no_pending_candidate" };
    }

    const payload = {
      status: "approved",
      approved_role: role || null,
      approved_by: approvedByUser || null,
      approved_at: new Date().toISOString()
    };

    const { error: updateError } = await supabase
      .from("team_candidates")
      .update(payload)
      .eq("id", pendingRow.id);

    if (updateError) {
      console.error("approvePendingTeamCandidate update error:", updateError);
      return { success: false, reason: "update_failed", error: updateError };
    }

    return {
      success: true,
      skipped: false,
      candidate_id: pendingRow.id,
      line_user_id: userId
    };
  } catch (err) {
    console.error("approvePendingTeamCandidate failed:", err);
    return { success: false, reason: "exception", error: err };
  }
}

function buildSelectableUserBadges(user = {}) {
  const badges = [];

  if (user.source === "candidate") {
    badges.push({
      type: "box",
      layout: "vertical",
      paddingStart: "8px",
      paddingEnd: "8px",
      paddingTop: "4px",
      paddingBottom: "4px",
     
      backgroundColor: "#DCFCE7",
      contents: [
        {
          type: "text",
          text: "ผู้สมัครใหม่",
          size: "xs",
          weight: "bold",
          color: "#166534",
          align: "center"
        }
      ]
    });
  }

  if (user.candidate_status === "pending") {
    badges.push({
      type: "box",
      layout: "vertical",
      paddingStart: "8px",
      paddingEnd: "8px",
      paddingTop: "4px",
      paddingBottom: "4px",
    
      backgroundColor: "#FEF3C7",
      contents: [
        {
          type: "text",
          text: "รออนุมัติ",
          size: "xs",
          weight: "bold",
          color: "#92400E",
          align: "center"
        }
      ]
    });
  }

  if (user.source !== "candidate") {
    badges.push({
      type: "box",
      layout: "vertical",
      paddingStart: "8px",
      paddingEnd: "8px",
      paddingTop: "4px",
      paddingBottom: "4px",

      backgroundColor: "#E2E8F0",
      contents: [
        {
          type: "text",
          text: "ผู้ใช้ล่าสุด",
          size: "xs",
          weight: "bold",
          color: "#475569",
          align: "center"
        }
      ]
    });
  }

  return badges;
}

function buildSelectableUserBadges(u = {}) {
  const badges = [];

  if (u.source === "candidate") {
    badges.push({
      type: "box",
      layout: "horizontal",
      spacing: "4px",
      paddingStart: "10px",
      paddingEnd: "10px",
      paddingTop: "5px",
      paddingBottom: "5px",
 
      backgroundColor: "#E8F7EC",
      contents: [
        {
          type: "text",
          text: "ผู้สมัครใหม่",
          size: "xs",
          weight: "bold",
          color: "#2F855A",
          align: "center"
        }
      ]
    });
  } else {
    badges.push({
      type: "box",
      layout: "horizontal",
      spacing: "4px",
      paddingStart: "10px",
      paddingEnd: "10px",
      paddingTop: "5px",
      paddingBottom: "5px",
     
      backgroundColor: "#EEF2F7",
      contents: [
        {
          type: "text",
          text: "ผู้ใช้ล่าสุด",
          size: "xs",
          weight: "bold",
          color: "#5B6472",
          align: "center"
        }
      ]
    });
  }

  if (String(u.candidate_status || "").toLowerCase() === "pending") {
    badges.push({
      type: "box",
      layout: "horizontal",
      spacing: "4px",
      paddingStart: "10px",
      paddingEnd: "10px",
      paddingTop: "5px",
      paddingBottom: "5px",
      
      backgroundColor: "#FBECC8",
      contents: [
        {
          type: "text",
          text: "รออนุมัติ",
          size: "xs",
          weight: "bold",
          color: "#B45309",
          align: "center"
        }
      ]
    });
  } else if (String(u.role || "").trim()) {
    badges.push({
      type: "box",
      layout: "horizontal",
      spacing: "4px",
      paddingStart: "10px",
      paddingEnd: "10px",
      paddingTop: "5px",
      paddingBottom: "5px",
      
      backgroundColor: "#E8F1FD",
      contents: [
        {
          type: "text",
          text: "มีสิทธิ์อยู่แล้ว",
          size: "xs",
          weight: "bold",
          color: "#2563EB",
          align: "center"
        }
      ]
    });
  }

  return badges;
}

const FLEX_HEAD_IMAGE_URL = "https://img2.pic.in.th/Headline.jpg";

function getSelectableUserAvatar(u = {}) {
  const picture = String(u.picture_url || "").trim();
  if (picture) return picture;

  return "https://cdn-icons-png.flaticon.com/512/149/149071.png";
}

function buildSelectableUserBubble(user = {}) {
  const displayName =
    user.display_name ||
    user.full_name ||
    user.name ||
    "ไม่ทราบชื่อ";

  const roleText = user.role ? `บทบาท: ${user.role}` : "ผู้ใช้งานที่เลือกได้";
  const userIdText = user.user_id || user.line_user_id || "-";

  const statusText =
    user.status === "pending" ? "รออนุมัติ" :
    user.status === "approved" ? "อนุมัติแล้ว" :
    user.status === "active" ? "มีสิทธิ์ใช้งานแล้ว" :
    user.status === "rejected" ? "ไม่ผ่าน" :
    user.source === "candidate" ? "รออนุมัติ" :
    "-";

  const sourceText =
    user.source === "candidate" ? "ผู้สมัครเข้าทีม" :
    user.source === "recent" ? "ผู้ใช้ล่าสุด" :
    user.source || "-";

  const numberText = `${user.id || user.candidate_no || user.candidate_id || "-"}`;
  const dateText =
    user.created_at || user.joined_at
      ? new Date(user.created_at || user.joined_at).toLocaleDateString("th-TH", {
          year: "numeric",
          month: "short",
          day: "numeric"
        })
      : "-";

  function infoRow(label, value, valueColor = "#111111") {
    return {
      type: "box",
      layout: "horizontal",
      spacing: "sm",
      margin: "md",
      contents: [
        {
          type: "text",
          text: label,
          size: "xl",
          weight: "bold",
          color: "#111111",
          flex: 3
        },
        {
          type: "text",
          text: value,
          size: "xl",
          weight: "bold",
          color: valueColor,
          wrap: true,
          flex: 5
        }
      ]
    };
  }

  return {
    type: "bubble",
    size: "mega",
    hero: {
      type: "image",
      url: FLEX_HEAD_IMAGE_URL,
      size: "full",
      aspectRatio: "20:14",
      aspectMode: "cover"
    },
    body: {
      type: "box",
      layout: "vertical",
      paddingAll: "14px",
      spacing: "none",
      backgroundColor: "#FFFFFF",
      contents: [
        {
          type: "box",
          layout: "horizontal",
          spacing: "md",
          alignItems: "center",
          contents: [
            {
              type: "image",
              url: getSelectableUserAvatar(user),
              size: "54px",
              aspectMode: "cover",
              aspectRatio: "1:1",
              flex: 0
            },
            {
              type: "box",
              layout: "vertical",
              flex: 1,
              spacing: "xs",
              contents: [
                {
                  type: "text",
                  text: displayName,
                  weight: "bold",
                  size: "xxl",
                  color: "#111111",
                  wrap: true
                },
                {
                  type: "text",
                  text: roleText,
                  size: "lg",
                  color: "#4B5563",
                  wrap: true
                }
              ]
            }
          ]
        },
        {
          type: "separator",
          margin: "md",
          color: "#D1D5DB"
        },
        infoRow("เลขที่", numberText),
        infoRow("วันที่", dateText),
        infoRow("สถานะ:", statusText, "#0F766E"),
        infoRow("ที่มา :", sourceText, "#374151")
      ]
    },
    footer: {
      type: "box",
      layout: "vertical",
      paddingTop: "8px",
      paddingBottom: "10px",
      paddingStart: "14px",
      paddingEnd: "14px",
      backgroundColor: "#FFFFFF",
      contents: [
        {
          type: "button",
          style: "primary",
          height: "sm",
          color: "#0B7C86",
          action: {
            type: "message",
            label: "เลือกคนนี้",
            text: `เลือกสมาชิก:${userIdText}`
          }
        }
      ]
    }
  };
}
async function buildSelectUserFlex() {
  const users = (await getSelectableTeamUsers())
    .sort((a, b) => {
      const aTime = new Date(a.created_at || 0).getTime();
      const bTime = new Date(b.created_at || 0).getTime();
      return bTime - aTime;
    })
    .slice(0, 10);

  if (users.length === 0) {
    return {
      type: "flex",
      altText: "ยังไม่มีผู้ใช้",
      contents: {
        type: "bubble",
        size: "kilo",
        header: {
          type: "box",
          layout: "vertical",
          backgroundColor: "#119EAB",
          paddingAll: "14px",
          contents: [
            {
              type: "text",
              text: "ยังไม่มีผู้ใช้",
              color: "#FFFFFF",
              weight: "bold",
              size: "lg",
              align: "center"
            }
          ]
        },
        body: {
          type: "box",
          layout: "vertical",
          paddingAll: "16px",
          contents: [
            {
              type: "text",
              text: "ยังไม่มีรายชื่อผู้ใช้หรือผู้สมัครใหม่ในขณะนี้",
              wrap: true,
              size: "sm",
              color: "#475569"
            }
          ]
        }
      }
    };
  }

  return {
    type: "flex",
    altText: "เลือกสมาชิก",
    contents: {
      type: "carousel",
      contents: users.map((u) => buildSelectableUserBubble(u))
    }
  };
}
        
function buildSelectRoleFlex(userId) {
  function btn(label, text, color) {
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

  return {
    type: "flex",
    altText: "เลือกสิทธิ์ทีมงาน",
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#0B7C86",
        paddingAll: "16px",
        contents: [
          {
            type: "text",
            text: "เลือกสิทธิ์ทีมงาน",
            color: "#FFFFFF",
            weight: "bold",
            size: "lg",
            align: "center"
          },
          {
            type: "text",
            text: userId,
            color: "#D1FAE5",
            size: "sm",
            align: "center",
            margin: "sm"
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "12px",
        paddingAll: "16px",
        contents: [
          btn("Admin", "setrole_auto admin", "#DC2626"),
          btn("Staff", "setrole_auto staff", "#F97316"),
          btn("Viewer", "setrole_auto viewer", "#0F8A96")
        ]
      }
    }
  };
}
function buildSmartAlertFlex(sla = {}) {
  const overdue = Number(sla.overdue || 0);
  const nearDue = Number(sla.near_due || 0);
  const openCases = Number(sla.open_cases || 0);
  const smartAlert = Number(sla.smart_alert || 0);

  function bigButton(label, color, text = null, uri = null) {
    return {
      type: "button",
      style: "primary",
      color,
      action: uri
        ? { type: "uri", label: label.slice(0, 20), uri }
        : { type: "message", label: label.slice(0, 20), text: text || label }
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
        url: "https://img1.pic.in.th/images/479c5c6f6459b101f.png",
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
          bigButton(` SLA วิกฤต (${overdue})`, "#EF4444", "ดู SLA วิกฤต"),
          bigButton(` ใกล้หลุด SLA (${nearDue})`, "#F97316", "ดูใกล้หลุด SLA"),
          bigButton(` เคสเปิดทั้งหมด (${openCases})`, "#1D4ED8", "ดูเคสเปิดทั้งหมด"),
          bigButton(
            "เปิดศูนย์ปฏิบัติการ",
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

function buildHelpFirstContactFlex() {
  return {
    type: "flex",
    altText: "เลือกวิธีแจ้งขอความช่วยเหลือ",
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#0b7c86",
        paddingAll: "18px",
        contents: [
          { type: "text", text: "ขอความช่วยเหลือครั้งแรก", color: "#ffffff", weight: "bold", size: "lg", wrap: true },
          { type: "text", text: "เลือกวิธีที่สะดวกที่สุดได้เลยครับ", color: "#d9f3f5", size: "sm", margin: "sm", wrap: true }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        paddingAll: "18px",
        contents: [
          {
            type: "text",
            text: "เราพร้อมรับฟังและช่วยเหลือท่านครับ",
            weight: "bold",
            size: "md",
            color: "#16324F",
            wrap: true
          },
          {
            type: "text",
            text: "หากไม่สะดวกกรอกฟอร์ม สามารถเลือกพิมพ์คุยกับเจ้าหน้าที่ได้ทันทีนะครับ",
            size: "sm",
            color: "#5B6575",
            wrap: true
          },
          {
            type: "box",
            layout: "vertical",
            cornerRadius: "14px",
            paddingAll: "14px",
            backgroundColor: "#F4FBFC",
            borderColor: "#D9EEF0",
            borderWidth: "1px",
            contents: [
              { type: "text", text: "1) กรอกข้อมูลแบบง่าย", weight: "bold", size: "md", color: "#0b7c86", wrap: true },
              { type: "text", text: "เหมาะสำหรับผู้ที่สะดวกพิมพ์ตามแบบตัวอย่าง ใช้เวลาไม่นานครับ", size: "sm", color: "#5B6575", margin: "sm", wrap: true }
            ]
          },
          {
            type: "box",
            layout: "vertical",
            cornerRadius: "14px",
            paddingAll: "14px",
            backgroundColor: "#F7F9FC",
            borderColor: "#E5E7EB",
            borderWidth: "1px",
            contents: [
              { type: "text", text: "2) พิมพ์คุยกับเจ้าหน้าที่", weight: "bold", size: "md", color: "#163C72", wrap: true },
              { type: "text", text: "เหมาะสำหรับผู้ที่ไม่สะดวกกรอกตามแบบ สามารถค่อยๆ พิมพ์คุยกับเราได้เลยครับ", size: "sm", color: "#5B6575", margin: "sm", wrap: true }
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
          { type: "button", style: "primary", height: "sm", color: "#1F8F4D", action: { type: "message", label: "กรอกข้อมูลแบบง่าย", text: "ขอความช่วยเหลือแบบฟอร์ม" } },
          { type: "button", style: "secondary", height: "sm", action: { type: "message", label: "พิมพ์คุยกับเจ้าหน้าที่", text: "ขอความช่วยเหลือแบบแชท" } },
          { type: "text", text: "ไม่ต้องกังวลนะครับ เลือกแบบที่ท่านสะดวกที่สุดได้เลย", size: "xs", color: "#7A8594", wrap: true, align: "center", margin: "md" }
        ]
      }
    }
  };
}

function buildHelpFormFlex() {
  const prefill = encodeURIComponent("ชื่อ:\nพื้นที่:\nรายละเอียด:\nเบอร์:");
  const useUri = LINE_OA_ID && LINE_OA_ID.startsWith("@");
  const primaryAction = useUri
    ? { type: "uri", label: "เปิดช่องพิมพ์ตามแบบ", uri: `https://line.me/R/oaMessage/${LINE_OA_ID}/?${prefill}` }
    : { type: "message", label: "ส่งหัวข้อให้พิมพ์ต่อ", text: "ชื่อ:\nพื้นที่:\nรายละเอียด:\nเบอร์:" };

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
          { type: "text", text: "กรอกข้อมูลแบบง่าย", color: "#ffffff", weight: "bold", size: "lg", align: "center" },
          { type: "text", text: "ค่อยๆ พิมพ์ตามหัวข้อด้านล่างได้เลยครับ", color: "#d9f3f5", size: "sm", margin: "sm", wrap: true, align: "center" }
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
            text: useUri ? "กดปุ่มด้านล่างเพื่อเปิดช่องพิมพ์พร้อมหัวข้อได้เลยครับ" : "กดปุ่มด้านล่าง แล้วค่อยๆ พิมพ์ข้อมูลต่อท้ายได้เลยครับ",
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
          { type: "button", style: "secondary", height: "sm", action: { type: "message", label: "พิมพ์คุยกับเจ้าหน้าที่", text: "ขอความช่วยเหลือแบบแชท" } },
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
        sla_hours_remaining_to_breach: roundSlaHours(
      Math.max(0, breachHours - hoursSinceAction)
    )
  };
}
function mergeCaseWithSla(row = {}) {
  return {
    ...row,
    ...getSlaLevel(row)
  };
}

async function getSlaMenuCounts() {
  try {
    const { data, error } = await supabase
      .from("help_requests")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;

    const rows = Array.isArray(data) ? data : [];
    const summary = buildSlaSummary(rows);

    const urgentRows = rows.filter(
      row =>
        String(row.priority || "").toLowerCase() === "urgent" &&
        !["done", "cancelled"].includes(normalizeCaseStatus(row.status))
    );

    const overdueRows = urgentRows.filter(
      row => getSlaLevel(row).sla_level === "breached"
    );

    const nearDueRows = urgentRows.filter(
      row => getSlaLevel(row).sla_level === "warning"
    );

    const smartAlertRows = urgentRows.filter((row) => {
      const level = getSlaLevel(row).sla_level;
      return level === "breached" || level === "warning";
    });

    return {
      overdue: summary.breached,
      near_due: summary.warning,
      open_cases: summary.urgent_total,
      smart_alert: summary.breached + summary.warning,
      overdue_rows: overdueRows.slice(0, 10),
      near_due_rows: nearDueRows.slice(0, 10),
      smart_alert_rows: smartAlertRows.slice(0, 10)
    };
  } catch (err) {
    console.error("getSlaMenuCounts catch:", err);
    return {
      overdue: 0,
      near_due: 0,
      open_cases: 0,
      smart_alert: 0,
      overdue_rows: [],
      near_due_rows: [],
      smart_alert_rows: []
    };
  }
}

function formatMenuBadgeLabel(label, count) {
  const n = Number(count || 0);
  return n > 0 ? `${label} (${n})` : label;
}

function buildSlaPreviewText(title, rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return `${title}\n\nไม่มีรายการ`;
  }

  return [
    title,
    "",
    ...rows.slice(0, 10).map((row, index) => {
      return `${index + 1}. ${row.case_code || "-"} | ${row.full_name || "-"} | ${formatPriorityThai(row.priority || "")}`;
    })
  ].join("\n");
}

/* =========================
   SLA ALERT (GOLDEN SAFE PATCH)
========================= */
const SLA_ALERT_ENABLED = true;
const SLA_ALERT_INTERVAL_MS = 10 * 60 * 1000; // 10 นาที

const SLA_ALERT_COOLDOWN_MS = {
  warning: 6 * 60 * 60 * 1000,
  breached: 12 * 60 * 60 * 1000,
};

const slaAlertCooldownMap = new Map();

function getSlaAlertKey(item = {}) {
  return `${item.case_code || "unknown"}:${item.sla_level || "normal"}`;
}

function shouldSendSlaAlert(item = {}) {
  const level = String(item.sla_level || "").toLowerCase();
  if (!["warning", "breached"].includes(level)) return false;

  const key = getSlaAlertKey(item);
  const found = slaAlertCooldownMap.get(key);
  if (!found) return true;

  const cooldownMs = SLA_ALERT_COOLDOWN_MS[level] || (6 * 60 * 60 * 1000);
  return (Date.now() - found.sentAt) >= cooldownMs;
}

function markSlaAlertSent(item = {}) {
  const key = getSlaAlertKey(item);
  slaAlertCooldownMap.set(key, { sentAt: Date.now() });
}

function cleanupSlaAlertCooldownMap() {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000;
  for (const [key, value] of slaAlertCooldownMap.entries()) {
    if (!value?.sentAt || (now - value.sentAt) > maxAge) {
      slaAlertCooldownMap.delete(key);
    }
  }
}

function buildSlaAlertText(item = {}) {
  const level = String(item.sla_level || "").toLowerCase();
  const icon = level === "breached" ? "🚨" : "⚠️";
  const levelTh = item.sla_label_th || (level === "breached" ? "เกิน SLA" : "ใกล้เกิน SLA");
  const caseCode = item.case_code || "-";
  const fullName = item.full_name || "-";
  const location = item.location || "-";
  const assignedTo = item.assigned_to || "ยังไม่มีผู้รับเคส";
  const hours = Number(item.sla_hours_since_action || 0);
  const priority = formatPriorityThai(item.priority || "normal");

  return [
    `${icon} SLA ALERT`,
    `เลขเคส: ${caseCode}`,
    `ชื่อ: ${fullName}`,
    `พื้นที่: ${location}`,
    `ระดับ SLA: ${levelTh}`,
    `ค้างมาแล้ว: ${hours} ชั่วโมง`,
    `ความเร่งด่วน: ${priority}`,
    `ผู้รับเคส: ${assignedTo}`,
    `กรุณาเข้าไปติดตามเคสนี้ทันที`
  ].join("\n");
}

async function getSlaAlertCandidates(limit = 200) {
  const { data, error } = await supabase
    .from("help_requests")
    .select(`
      id,
      case_code,
      full_name,
      phone,
      problem,
      location,
      status,
      priority,
      assigned_to,
      created_at,
      last_action_at,
      closed_at
    `)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];
  return rows
    .map(mergeCaseWithSla)
    .filter(item => !item.sla_excluded)
    .filter(item => ["warning", "breached"].includes(String(item.sla_level || "").toLowerCase()))
    .sort((a, b) => {
      const rank = { breached: 2, warning: 1 };
      const ra = rank[a.sla_level] || 0;
      const rb = rank[b.sla_level] || 0;
      if (rb !== ra) return rb - ra;
      return Number(b.sla_hours_since_action || 0) - Number(a.sla_hours_since_action || 0);
    });
}

async function processSlaAlertsNow() {
  if (!SLA_ALERT_ENABLED) {
    return { ok: true, sent: 0, skipped: 0, reason: "disabled" };
  }

  if (!CHANNEL_ACCESS_TOKEN || !EFFECTIVE_TEAM_GROUP_ID) {
    return { ok: false, sent: 0, skipped: 0, reason: "missing_line_config" };
  }

cleanupSlaAlertCooldownMap();

let sent = 0;
let skipped = 0;

const candidates = (await getSlaAlertCandidates(200))
  .slice(0, 5);

for (const item of candidates) {
  if (!shouldSendSlaAlert(item)) {
    skipped += 1;
    continue;
  }

  const text = buildSlaAlertText(item);   // ✅ สร้างก่อนใช้

  await pushTeamNotification(text);       // ✅ ส่ง 1 ครั้ง
  markSlaAlertSent(item);                 // ✅ mark 1 ครั้ง

  sent += 1;
}

return {
  ok: true,
  sent,
  skipped,
  total_candidates: candidates.length,
  checked_at: new Date().toISOString()
};
}


// =========================
// GOLDEN SAFE PATCH: ALERT ENGINE HELPERS
// =========================
const ALERT_ENGINE_DEDUPE_MS = 60 * 60 * 1000;
const ALERT_ENGINE_MEMORY_LIMIT = 300;
const alertEngineMemory = [];
const alertEngineSeenMap = new Map();
let alertEngineTableCheckedAt = 0;
let alertEngineTableAvailable = null;

function cleanupAlertEngineSeenMap() {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000;
  for (const [key, value] of alertEngineSeenMap.entries()) {
    if (!value?.ts || (now - value.ts) > maxAge) {
      alertEngineSeenMap.delete(key);
    }
  }
  while (alertEngineMemory.length > ALERT_ENGINE_MEMORY_LIMIT) {
    alertEngineMemory.shift();
  }
}

function normalizeAlertSeverity(value = '') {
  const raw = String(value || '').trim().toLowerCase();
  if (['critical', 'high', 'medium', 'info'].includes(raw)) return raw;
  return 'info';
}

function getAlertSeverityFromCase(row = {}, merged = row) {
  const priority = normalizeSlaPriority(row.priority);
  const slaLevel = String(merged?.sla_level || '').toLowerCase();
  const assignedTo = String(row.assigned_to || '').trim();
  const status = normalizeSlaStatus(row.status);

  if (status === 'done' || status === 'cancelled') return 'info';
  if (slaLevel === 'breached') return priority === 'urgent' ? 'critical' : 'high';
  if (status === 'new' && !assignedTo) return priority === 'urgent' ? 'critical' : 'high';
  if (priority === 'urgent') return 'high';
  if (slaLevel === 'warning') return 'medium';
  return 'info';
}

function buildGoldenAlertFromCase(row = {}, options = {}) {
  const merged = options.mergedRow || mergeCaseWithSla(row || {});
  const status = normalizeSlaStatus(merged.status);
  const priority = normalizeSlaPriority(merged.priority);
  const assignedTo = String(merged.assigned_to || '').trim();
  const hours = Number(merged.sla_hours_since_action || 0);

  if (!merged?.case_code) return null;
  if (status === 'done' || status === 'cancelled') return null;

  let alertType = '';
  let title = '';
  let message = '';

  if (merged.sla_level === 'breached') {
    alertType = 'sla_breach';
    title = 'เคสเกิน SLA';
    message = `เคส ${merged.case_code} เกิน SLA แล้ว (${hours} ชั่วโมง)`;
  } else if (merged.sla_level === 'warning') {
    alertType = 'sla_warning';
    title = 'เคสใกล้เกิน SLA';
    message = `เคส ${merged.case_code} ใกล้เกิน SLA (${hours} ชั่วโมง)`;
  } else if (status === 'new' && !assignedTo) {
    alertType = 'new_case_unassigned';
    title = priority === 'urgent' ? 'เคสด่วนยังไม่มีผู้รับผิดชอบ' : 'เคสใหม่ยังไม่มีผู้รับผิดชอบ';
    message = `เคส ${merged.case_code} ยังไม่มีผู้รับผิดชอบ`;
  } else if (priority === 'urgent') {
    alertType = 'urgent_case';
    title = 'พบเคสด่วน';
    message = `เคส ${merged.case_code} ถูกจัดเป็นเคสด่วน`;
  } else {
    return null;
  }

  return {
    id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    case_code: merged.case_code,
    alert_type: alertType,
    severity: normalizeAlertSeverity(getAlertSeverityFromCase(merged, merged)),
    title,
    message,
    status: 'open',
    source_type: options.source_type || 'system',
    source_id: String(options.source_id || merged.id || merged.case_code || '-'),
    created_at: new Date().toISOString(),
    metadata: {
      case_id: merged.id || null,
      full_name: merged.full_name || null,
      location: merged.location || null,
      assigned_to: merged.assigned_to || null,
      priority: merged.priority || null,
      status: merged.status || null,
      sla_level: merged.sla_level || null,
      sla_hours_since_action: merged.sla_hours_since_action || 0
    }
  };
}

function getAlertEngineKey(alert = {}) {
  return `${alert.case_code || 'unknown'}:${alert.alert_type || 'unknown'}`;
}

function shouldCreateGoldenAlert(alert = {}) {
  const key = getAlertEngineKey(alert);
  const found = alertEngineSeenMap.get(key);
  if (!found) return true;
  return (Date.now() - found.ts) >= ALERT_ENGINE_DEDUPE_MS;
}

async function isAlertLogsTableAvailable() {
  const now = Date.now();
  if (alertEngineTableAvailable !== null && (now - alertEngineTableCheckedAt) < 5 * 60 * 1000) {
    return alertEngineTableAvailable;
  }

  alertEngineTableCheckedAt = now;
  try {
    const { error } = await supabase
      .from('alert_logs')
      .select('id', { head: true, count: 'exact' })
      .limit(1);

    alertEngineTableAvailable = !error;
    if (error) {
      console.warn('alert_logs table unavailable:', error.message || error);
    }
  } catch (err) {
    alertEngineTableAvailable = false;
    console.warn('alert_logs table check failed:', err?.message || err);
  }

  return alertEngineTableAvailable;
}

async function persistGoldenAlert(alert = {}) {
  const canUseTable = await isAlertLogsTableAvailable();
  if (!canUseTable) return { ok: false, persisted: false, reason: 'table_unavailable' };

  try {
    const { data, error } = await supabase
      .from('alert_logs')
      .insert([{
        case_code: alert.case_code,
        alert_type: alert.alert_type,
        alert_level: alert.severity,
        title: alert.title,
        message: alert.message,
        status: alert.status || 'open',
        source: alert.source_type || 'system',
        sent_to_line: false,
        metadata: alert.metadata || {}
      }])
      .select()
      .single();

    if (error) {
      console.warn('persistGoldenAlert insert failed:', error.message || error);
      return { ok: false, persisted: false, reason: error.message || 'insert_failed' };
    }

    return { ok: true, persisted: true, row: data };
  } catch (err) {
    console.warn('persistGoldenAlert catch:', err?.message || err);
    return { ok: false, persisted: false, reason: err?.message || 'insert_failed' };
  }
}

async function updateGoldenAlertLineStatus(dbId, sentToLine, lineError = null) {
  if (!dbId) return;
  const canUseTable = await isAlertLogsTableAvailable();
  if (!canUseTable) return;

  try {
    await supabase
      .from('alert_logs')
      .update({
        sent_to_line: !!sentToLine,
        line_error: sentToLine ? null : (lineError || null)
      })
      .eq('id', dbId);
  } catch (err) {
    console.warn('updateGoldenAlertLineStatus failed:', err?.message || err);
  }
}

async function safePushAlertToTeam(text = '') {
  if (!text) return { ok: false, reason: 'empty_text' };
  try {
    await pushTeamNotification(text);
    return { ok: true };
  } catch (err) {
    console.warn('safePushAlertToTeam failed:', err?.message || err);
    return { ok: false, reason: err?.message || 'push_failed' };
  }
}

function buildGoldenAlertLineMessage(alert = {}) {
  const meta = alert.metadata || {};
  const severity = String(alert.severity || 'info').toUpperCase();
  return [
    '🚨 ALERT ENGINE',
    `${alert.title || 'พบเหตุแจ้งเตือน'}`,
    `เคส: ${alert.case_code || '-'}`,
    `ระดับ: ${severity}`,
    `สถานะ: ${formatCaseStatusThai(meta.status || '-')}`,
    `ความสำคัญ: ${formatPriorityThai(meta.priority || 'normal')}`,
    `ผู้รับผิดชอบ: ${meta.assigned_to || 'ยังไม่มีผู้รับผิดชอบ'}`,
    `รายละเอียด: ${alert.message || '-'}`
  ].join('\n');
}

async function createGoldenAlertFromCaseRow(row = {}, options = {}) {
  cleanupAlertEngineSeenMap();

  const alert = buildGoldenAlertFromCase(row, options);
  if (!alert) return { ok: true, created: false, reason: 'no_alert' };
  if (!options.force && !shouldCreateGoldenAlert(alert)) {
    return { ok: true, created: false, reason: 'cooldown' };
  }

  const key = getAlertEngineKey(alert);
  alertEngineSeenMap.set(key, { ts: Date.now() });
  alertEngineMemory.push(alert);
  cleanupAlertEngineSeenMap();

  const persisted = await persistGoldenAlert(alert);
  const mergedCaseForAutoAssign = mergeCaseWithSla(row || {});
  const autoAssignProfile = buildRiskDecisionProfile(mergedCaseForAutoAssign);
  let autoAssignResult = { ok: true, assigned: false, profile: autoAssignProfile };
  try {
    autoAssignResult = await processAutoAssignFromRisk(mergedCaseForAutoAssign, {
      profile: autoAssignProfile,
      trigger_alert_type: alert.alert_type,
      source_type: options.source_type || 'alert_engine'
    });
  } catch (autoAssignErr) {
    console.warn('AUTO ASSIGN WARNING:', autoAssignErr?.message || autoAssignErr);
  }

  if (autoAssignResult?.assigned && autoAssignResult.case) {
    alert.metadata = {
      ...(alert.metadata || {}),
      auto_assigned: true,
      auto_assigned_to: autoAssignResult.assignee?.assigned_to || autoAssignResult.case.assigned_to || null,
      auto_assign_risk_score: autoAssignResult.profile?.risk_score || autoAssignProfile.risk_score || 0,
      auto_assign_risk_level: autoAssignResult.profile?.risk_level || autoAssignProfile.risk_level || 'normal'
    };
  }

  let line = { ok: false, reason: 'notify_disabled' };
  if (options.notify !== false) {
    line = await safePushAlertToTeam(buildGoldenAlertLineMessage(alert));
  }
  if (persisted?.row?.id) {
    await updateGoldenAlertLineStatus(persisted.row.id, line.ok, line.reason || null);
  }

  try {
    broadcastSse('alert_update', {
      case_code: alert.case_code,
      alert_type: alert.alert_type,
      severity: alert.severity,
      title: alert.title,
      message: alert.message
    });
  } catch (err) {
    console.warn('broadcast alert_update failed:', err?.message || err);
  }

  return { ok: true, created: true, alert, line, persisted, auto_assign: autoAssignResult };
}

async function getAlertCasesSnapshot(limit = 100) {
  const { data, error } = await supabase
    .from('help_requests')
    .select('id, case_code, full_name, location, status, priority, assigned_to, created_at, last_action_at, closed_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data || []).map(mergeCaseWithSla);
}

async function getAlertsFromDatabase(status = 'open', limit = 50) {
  const canUseTable = await isAlertLogsTableAvailable();
  if (!canUseTable) return [];

  try {
    let query = supabase
      .from('alert_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) {
      console.warn('getAlertsFromDatabase failed:', error.message || error);
      return [];
    }

    return (data || []).map((row) => ({
      id: row.id || `db-${row.case_code || 'case'}-${row.alert_type || 'alert'}`,
      case_code: row.case_code || '-',
      alert_type: row.alert_type || '-',
      severity: normalizeAlertSeverity(row.alert_level || row.severity || 'info'),
      title: row.title || '-',
      message: row.message || '-',
      status: row.status || 'open',
      source_type: row.source || 'system',
      source_id: row.id || '-',
      created_at: row.created_at || new Date().toISOString(),
      metadata: row.metadata || {}
    }));
  } catch (err) {
    console.warn('getAlertsFromDatabase catch:', err?.message || err);
    return [];
  }
}

async function listGoldenAlerts(options = {}) {
  const status = String(options.status || 'open').trim().toLowerCase();
  const limit = Math.max(1, Math.min(Number(options.limit || 20), 100));

  const dbAlerts = await getAlertsFromDatabase(status, limit);
  if (dbAlerts.length) {
    return dbAlerts.slice(0, limit);
  }

  const memoryAlerts = [...alertEngineMemory]
    .filter((item) => !status || (item.status || 'open') === status)
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

  if (memoryAlerts.length) {
    return memoryAlerts.slice(0, limit);
  }

  try {
    const snapshot = await getAlertCasesSnapshot(Math.max(limit * 4, 50));
    const generated = snapshot
      .map((row) => buildGoldenAlertFromCase(row, { source_type: 'snapshot', source_id: row.id || row.case_code }))
      .filter(Boolean)
      .sort((a, b) => {
        const rank = { critical: 4, high: 3, medium: 2, info: 1 };
        return (rank[b.severity] || 0) - (rank[a.severity] || 0);
      });
    return generated.slice(0, limit);
  } catch (err) {
    console.warn('listGoldenAlerts snapshot failed:', err?.message || err);
    return [];
  }
}

async function generateGoldenAlertsNow(options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit || 20), 100));
  const snapshot = await getAlertCasesSnapshot(Math.max(limit * 5, 50));
  let created = 0;
  let skipped = 0;
  const items = [];

  for (const row of snapshot.slice(0, Math.max(limit * 2, 20))) {
    const result = await createGoldenAlertFromCaseRow(row, {
      source_type: options.source_type || 'manual_generate',
      source_id: row.id || row.case_code,
      force: false,
      notify: options.notify !== false
    });

    if (result.created) {
      created += 1;
      items.push(result.alert);
      if (created >= limit) break;
    } else {
      skipped += 1;
    }
  }

  try {
    broadcastSse('alerts_generated', {
      created,
      skipped,
      checked_at: new Date().toISOString()
    });
  } catch (err) {
    console.warn('broadcast alerts_generated failed:', err?.message || err);
  }

  return {
    ok: true,
    created,
    skipped,
    items,
    checked_at: new Date().toISOString()
  };
}



// =========================
// AUTO ASSIGN ENGINE (GOLDEN SAFE PATCH)
// =========================
const AUTO_ASSIGN_ENABLED = true;
const AUTO_ASSIGN_CRITICAL_THRESHOLD = 120;
const AUTO_ASSIGN_HIGH_THRESHOLD = 80;
const AUTO_ASSIGN_MEMORY_LIMIT = 300;
const autoAssignMemory = [];
let autoAssignLogsTableCheckedAt = 0;
let autoAssignLogsTableAvailable = null;

function cleanupAutoAssignMemory() {
  while (autoAssignMemory.length > AUTO_ASSIGN_MEMORY_LIMIT) {
    autoAssignMemory.shift();
  }
}

async function isAutoAssignLogsTableAvailable() {
  const now = Date.now();
  if (autoAssignLogsTableAvailable !== null && (now - autoAssignLogsTableCheckedAt) < 5 * 60 * 1000) {
    return autoAssignLogsTableAvailable;
  }

  autoAssignLogsTableCheckedAt = now;
  try {
    const { error } = await supabase
      .from('auto_assign_logs')
      .select('id', { head: true, count: 'exact' })
      .limit(1);

    autoAssignLogsTableAvailable = !error;
    if (error) {
      console.warn('auto_assign_logs table unavailable:', error.message || error);
    }
  } catch (err) {
    autoAssignLogsTableAvailable = false;
    console.warn('auto_assign_logs table check failed:', err?.message || err);
  }

  return autoAssignLogsTableAvailable;
}

function getAutoAssignDisplayName(member = {}) {
  return (
    member.display_name ||
    member.displayName ||
    member.name ||
    member.full_name ||
    member.nickname ||
    member.line_user_id ||
    'เจ้าหน้าที่อัตโนมัติ'
  );
}

async function pickAutoAssignee() {
  try {
    const { data, error } = await supabase
      .from('line_user_roles')
      .select('*')
      .in('role', ['staff', 'admin'])
      .eq('is_active', true)
      .order('updated_at', { ascending: true, nullsFirst: false });

    if (error) throw error;

    const members = Array.isArray(data) ? data : [];
    if (!members.length) return null;

    const labels = members.map((member) => getAutoAssignDisplayName(member));

    let loadMap = new Map();
    try {
      const { data: caseRows, error: caseError } = await supabase
        .from('help_requests')
        .select('assigned_to, status')
        .in('status', ['new', 'in_progress']);

      if (caseError) throw caseError;

      loadMap = new Map();
      for (const row of caseRows || []) {
        const key = String(row.assigned_to || '').trim();
        if (!key) continue;
        loadMap.set(key, (loadMap.get(key) || 0) + 1);
      }
    } catch (loadErr) {
      console.warn('pickAutoAssignee load map warning:', loadErr?.message || loadErr);
    }

    const sorted = [...members].sort((a, b) => {
      const labelA = getAutoAssignDisplayName(a);
      const labelB = getAutoAssignDisplayName(b);
      const loadA = Number(loadMap.get(labelA) || 0);
      const loadB = Number(loadMap.get(labelB) || 0);
      if (loadA !== loadB) return loadA - loadB;
      return String(labelA).localeCompare(String(labelB), 'th');
    });

   
    const picked = sorted[0] || null;
    if (!picked) return null;

    return {
      line_user_id: picked.line_user_id || null,
      assigned_to: getAutoAssignDisplayName(picked),
      role: picked.role || 'staff',
      raw: picked
    };
  } catch (err) {
    console.warn('pickAutoAssignee error:', err?.message || err);
    return null;
  }
}

async function persistAutoAssignLog(entry = {}) {
  const payload = {
    id: entry.id || `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    case_code: entry.case_code || '-',
    assigned_to: entry.assigned_to || 'เจ้าหน้าที่อัตโนมัติ',
    line_user_id: entry.line_user_id || null,
    risk_score: Number(entry.risk_score || 0),
    risk_level: entry.risk_level || 'normal',
    trigger_alert_type: entry.trigger_alert_type || null,
    reason: entry.reason || 'auto_assign_by_risk',
    source_type: entry.source_type || 'alert_engine',
    created_at: entry.created_at || new Date().toISOString(),
    metadata: entry.metadata || {}
  };

  autoAssignMemory.unshift(payload);
  cleanupAutoAssignMemory();

  const canUseTable = await isAutoAssignLogsTableAvailable();
  if (!canUseTable) {
    return { ok: true, persisted: false, memory: true, row: payload };
  }

  try {
    const { data, error } = await supabase
      .from('auto_assign_logs')
      .insert([{
        case_code: payload.case_code,
        assigned_to: payload.assigned_to,
        risk_score: payload.risk_score,
        reason: payload.reason,
        metadata: payload.metadata
      }])
      .select()
      .single();

    if (error) {
      console.warn('persistAutoAssignLog failed:', error.message || error);
      return { ok: false, persisted: false, memory: true, row: payload, reason: error.message || 'insert_failed' };
    }

    return { ok: true, persisted: true, row: { ...payload, db_row: data } };
  } catch (err) {
    console.warn('persistAutoAssignLog catch:', err?.message || err);
    return { ok: false, persisted: false, memory: true, row: payload, reason: err?.message || 'insert_failed' };
  }
}

async function listAutoAssignLogs(limit = 20) {
  const safeLimit = Math.max(1, Math.min(Number(limit || 20), 100));
  const canUseTable = await isAutoAssignLogsTableAvailable();

  if (canUseTable) {
    try {
      const { data, error } = await supabase
        .from('auto_assign_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(safeLimit);

      if (!error && Array.isArray(data) && data.length) {
        return data.map((row) => ({
          id: row.id || `db-${row.case_code || 'case'}`,
          case_code: row.case_code || '-',
          assigned_to: row.assigned_to || '-',
          risk_score: Number(row.risk_score || 0),
          risk_level: row.metadata?.risk_level || 'normal',
          trigger_alert_type: row.metadata?.trigger_alert_type || null,
          reason: row.reason || 'auto_assign_by_risk',
          source_type: row.metadata?.source_type || 'alert_engine',
          created_at: row.created_at || new Date().toISOString(),
          metadata: row.metadata || {}
        }));
      }
      if (error) {
        console.warn('listAutoAssignLogs db failed:', error.message || error);
      }
    } catch (err) {
      console.warn('listAutoAssignLogs catch:', err?.message || err);
    }
  }

  return autoAssignMemory.slice(0, safeLimit);
}

async function getAutoAssignSummary(days = 7) {
  const logs = await listAutoAssignLogs(100);
  const now = Date.now();
  const rangeMs = Math.max(1, Number(days || 7)) * 24 * 60 * 60 * 1000;
  const recent = logs.filter((item) => {
    const ts = new Date(item.created_at || 0).getTime();
    return Number.isFinite(ts) && (now - ts) <= rangeMs;
  });

  return {
    total: recent.length,
    critical: recent.filter((item) => String(item.risk_level || '').toLowerCase() === 'critical').length,
    high: recent.filter((item) => String(item.risk_level || '').toLowerCase() === 'high').length,
    recent: recent.slice(0, 5)
  };
}

function buildRiskDecisionProfile(row = {}) {
  const priority = normalizeSlaPriority(row.priority);
  const severity = getAlertSeverityFromCase(row, row);
  const priorityScore =
    (priority === 'urgent' ? 40 : priority === 'high' ? 25 : priority === 'normal' ? 12 : 6) +
    (!row.assigned_to ? 10 : 0) +
    (row.status === 'new' ? 8 : row.status === 'in_progress' ? 6 : 0);

  const riskScore =
    (row.sla_level === 'breached' ? 50 : row.sla_level === 'warning' ? 25 : 5) +
    Number(row.sla_hours_since_action || 0);

  let recommendedAction = 'ติดตามเคส';
  let actionCode = 'follow_case';
  let actionButtonText = 'ติดตามเคส';
  if (row.sla_level === 'breached') {
    recommendedAction = 'เร่งเคลียร์เคสเกิน SLA ทันที';
    actionCode = 'rush_clear_sla';
    actionButtonText = 'เร่งเคลียร์ SLA';
  } else if (row.sla_level === 'warning') {
    recommendedAction = 'ติดตามเชิงรุกก่อนเกิน SLA';
    actionCode = 'follow_before_breach';
    actionButtonText = 'ติดตามเชิงรุก';
  } else if (!row.assigned_to) {
    recommendedAction = 'มอบหมายผู้รับผิดชอบโดยเร็ว';
    actionCode = 'assign_owner';
    actionButtonText = 'มอบหมายผู้รับผิดชอบ';
  } else if (priority === 'urgent') {
    recommendedAction = 'เร่งติดตามเคสด่วน';
    actionCode = 'expedite_urgent_case';
    actionButtonText = 'เร่งติดตามเคสด่วน';
  }

  const riskScoreRounded = Math.round(riskScore * 10) / 10;
  const riskLevel = riskScoreRounded >= 100 ? 'critical' : riskScoreRounded >= 50 ? 'high' : riskScoreRounded >= 20 ? 'medium' : 'normal';
  const riskLabelTh =
    riskLevel === 'critical' ? 'วิกฤต' :
    riskLevel === 'high' ? 'สูง' :
    riskLevel === 'medium' ? 'เฝ้าระวัง' :
    'ปกติ';

  return {
    severity,
    priority_score: priorityScore,
    priority_label_th: formatPriorityThai(priority),
    risk_score: riskScoreRounded,
    risk_level: riskLevel,
    risk_label_th: riskLabelTh,
    recommended_action: recommendedAction,
    recommended_action_label_th: recommendedAction,
    action_code: actionCode,
    action_button_text: actionButtonText
  };
}

function shouldAutoAssignFromProfile(caseRow = {}, profile = {}) {
  if (!AUTO_ASSIGN_ENABLED) return false;
  if (!caseRow || !caseRow.case_code) return false;

  const status = normalizeSlaStatus(caseRow.status);
  if (['done', 'cancelled'].includes(status)) return false;
  if (String(caseRow.assigned_to || '').trim()) return false;

  const riskScore = Number(profile.risk_score || 0);
  return riskScore >= AUTO_ASSIGN_HIGH_THRESHOLD;
}

async function processAutoAssignFromRisk(caseRow = {}, options = {}) {
  try {
    const merged = mergeCaseWithSla(caseRow);
    const profile = options.profile || buildRiskDecisionProfile(merged);

    if (!shouldAutoAssignFromProfile(merged, profile)) {
      return { ok: true, assigned: false, reason: 'threshold_or_state_not_matched', profile };
    }

    const freshCase = await getHelpRequestByCaseCode(merged.case_code || '');
    const caseToAssign = freshCase ? mergeCaseWithSla(freshCase) : merged;
    if (String(caseToAssign.assigned_to || '').trim()) {
      return { ok: true, assigned: false, reason: 'already_assigned', profile, case: caseToAssign };
    }

    const assignee = await pickAutoAssignee();
    if (!assignee?.assigned_to) {
      return { ok: true, assigned: false, reason: 'no_assignee_available', profile, case: caseToAssign };
    }

    const nowIso = new Date().toISOString();
    const updatePayload = {
      assigned_to: assignee.assigned_to,
      assigned_at: nowIso,
      last_action_at: nowIso,
      last_action_by: 'ระบบ Auto Assign'
    };

    const { data, error } = await supabase
      .from('help_requests')
      .update(updatePayload)
      .eq('case_code', caseToAssign.case_code)
      .select()
      .limit(1);

    if (error) throw error;

    const updatedCase = (data && data[0]) ? data[0] : { ...caseToAssign, ...updatePayload };
    const mergedUpdatedCase = mergeCaseWithSla(updatedCase);

    const logEntry = {
      case_code: mergedUpdatedCase.case_code,
      assigned_to: assignee.assigned_to,
      line_user_id: assignee.line_user_id,
      risk_score: profile.risk_score,
      risk_level: profile.risk_level,
      trigger_alert_type: options.trigger_alert_type || null,
      reason: profile.risk_score >= AUTO_ASSIGN_CRITICAL_THRESHOLD ? 'auto_assign_critical_risk' : 'auto_assign_high_risk',
      source_type: options.source_type || 'alert_engine',
      created_at: nowIso,
      metadata: {
        case_id: mergedUpdatedCase.id || null,
        full_name: mergedUpdatedCase.full_name || null,
        location: mergedUpdatedCase.location || null,
        status: mergedUpdatedCase.status || null,
        priority: mergedUpdatedCase.priority || null,
        risk_level: profile.risk_level,
        risk_score: profile.risk_score,
        trigger_alert_type: options.trigger_alert_type || null,
        source_type: options.source_type || 'alert_engine'
      }
    };

    const persistedLog = await persistAutoAssignLog(logEntry);

    const lineText = [
      '🤖 AUTO ASSIGN',
      `เลขเคส: ${mergedUpdatedCase.case_code || '-'}`,
      `ผู้ร้อง: ${mergedUpdatedCase.full_name || '-'}`,
      `พื้นที่: ${mergedUpdatedCase.location || '-'}`,
      `Risk Score: ${profile.risk_score || 0}`,
      `ระดับความเสี่ยง: ${profile.risk_label_th || profile.risk_level || '-'}`,
      `มอบหมายให้: ${assignee.assigned_to}`,
      `เหตุผล: ${profile.recommended_action_label_th || profile.recommended_action || 'เร่งติดตามเคส'}`
    ].join('\n');

    const line = await safePushAlertToTeam(lineText);

    try {
      broadcastSse('case_updated', {
        case_id: mergedUpdatedCase.id,
        case_code: mergedUpdatedCase.case_code,
        action: 'auto_assign',
        assigned_to: assignee.assigned_to,
        priority: mergedUpdatedCase.priority,
        status: mergedUpdatedCase.status,
        risk_score: profile.risk_score,
        risk_level: profile.risk_level
      });
      broadcastSse('dashboard_refresh', {
        reason: 'auto_assign_by_risk',
        case_code: mergedUpdatedCase.case_code,
        assigned_to: assignee.assigned_to,
        risk_score: profile.risk_score,
        risk_level: profile.risk_level
      });
    } catch (broadcastErr) {
      console.warn('AUTO ASSIGN broadcast warning:', broadcastErr?.message || broadcastErr);
    }

    return {
      ok: true,
      assigned: true,
      case: mergedUpdatedCase,
      assignee,
      profile,
      line,
      log: persistedLog?.row || logEntry
    };
  } catch (err) {
    console.warn('processAutoAssignFromRisk error:', err?.message || err);
    return { ok: false, assigned: false, reason: err?.message || 'auto_assign_failed' };
  }
}

async function buildExecutiveDecisionBoard(limit = 10) {
  const rows = await getAlertCasesSnapshot(Math.max(limit * 5, 50));
  const activeRows = rows.filter((row) => !row.sla_excluded);

  const autoAssignSummary = await getAutoAssignSummary(7);
  const recentAutoAssignMap = new Map((autoAssignSummary.recent || []).map((item) => [String(item.case_code || ''), item]));

  const cases = activeRows
    .map((row) => {
      const profile = buildRiskDecisionProfile(row);
      const recentAutoAssign = recentAutoAssignMap.get(String(row.case_code || '')) || null;
     return {
  case: row,
  ...profile,
        auto_assign_enabled: AUTO_ASSIGN_ENABLED,
        auto_assign_candidate: !row.assigned_to && Number(profile.risk_score || 0) >= AUTO_ASSIGN_HIGH_THRESHOLD,
        auto_assign_threshold: AUTO_ASSIGN_HIGH_THRESHOLD,
        auto_assigned: !!recentAutoAssign,
        auto_assigned_to: recentAutoAssign?.assigned_to || null,
        auto_assigned_at: recentAutoAssign?.created_at || null,
        auto_assign_reason: recentAutoAssign?.reason || null,
        case_url: `/case?id=${encodeURIComponent(row.id || '')}`
      };
    })
    .sort((a, b) => (b.risk_score - a.risk_score) || (b.priority_score - a.priority_score))
    .slice(0, limit);

  return {
    ok: true,
    cases,
    alerts: await listGoldenAlerts({ status: 'open', limit: 5 }),
    auto_assign_summary: autoAssignSummary
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

// =========================
// SLA ALERT (MANUAL TRIGGER)
// =========================
app.get("/api/sla/alerts/run", async (req, res) => {
  try {
    const result = await processSlaAlertsNow();
    return res.json(result);
  } catch (err) {
    console.error("SLA ALERT RUN ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "SLA alert run failed"
    });
  }
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
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
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
        case_code,
        latest_note,
        message,
        updated_at,
        updated_by,
        updater_name,
        images
      `)
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (error) throw error;

    return res.json({
      ok: true,
      items: (data || []).map((row) => {
        const label =
          row.latest_note ||
          row.message ||
          "มีการอัปเดตเคส";

        const actor =
          row.updater_name ||
          row.updated_by ||
          "ทีมงาน";

       return {
  ...row,
  label,
  title: `${row.case_code || "-"} · ${label}`,
          subtitle: `อัปเดตโดย ${actor}`,
          detail: label,
          updated_at: row.updated_at || null,
          images: Array.isArray(row.images) ? row.images : [],
          updater_name: actor
        };
      }),
    });
  } catch (err) {
    console.error("recent-activity error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "recent-activity failed",
    });
  }
});

// =====================================================
// API: CENTRAL SLA SUMMARY
// =====================================================



// =========================
// GOLDEN SAFE PATCH: SLA SUMMARY API (READ ONLY)
// =========================
app.get("/api/sla/summary", async (req, res) => {
  try {
    const limit = Number(req.query.limit || 200);

    const { data, error } = await supabase
      .from("help_requests")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;

    const rows = Array.isArray(data) ? data : [];

    const enriched = rows.map(attachSla);

    const activeRows = enriched.filter(row => row.is_sla_active);

    const totals = {
      normal: activeRows.filter(r => r.sla_level === "normal").length,
      warning: activeRows.filter(r => r.sla_level === "warning").length,
      breached: activeRows.filter(r => r.sla_level === "breached").length
    };

    const items = activeRows
      .sort((a, b) => Number(b.sla_hours_since_action || 0) - Number(a.sla_hours_since_action || 0))
      .slice(0, limit);

    return res.json({
      ok: true,
      totals,
      items
    });
  } catch (err) {
    console.error("sla summary failed:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "sla summary failed"
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
app.post("/api/sla/alerts/run", checkDashboardAuth, async (req, res) => {
  try {
    const result = await processSlaAlertsNow();
    return res.json({ ok: true, data: result });
  } catch (error) {
    console.error("SLA ALERT RUN ERROR:", error);
    return res.status(500).json({
      ok: false,
      error: error.message || "SLA alert run failed"
    });
  }
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

    const rawRows = Array.isArray(data) ? data : [];
    const rows = rawRows.map(attachSla);

    return res.json({
      ok: true,
      items: rows.map((row) => ({
        id: row.id || null,
        case_code: row.case_code || "",
        full_name: row.full_name || "-",
        phone: row.phone || "-",
        location: row.location || "",
        problem: row.problem || "",
        assigned_to: row.assigned_to || "",
        status: row.status || "new",
        priority: row.priority || "normal",

        // ✅ SLA จาก helper กลาง
        sla_level: row.sla_level || "normal",
        sla_label_th: row.sla_label_th || "ปกติ",
        sla_hours_since_action: row.sla_hours_since_action || 0,
        is_sla_active: !!row.is_sla_active,

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

const { data: infoUpdates, error: infoError } = await supabase
  .from("case_info_updates")
  .select("*")
  .eq("case_code", caseCode)
  .order("created_at", { ascending: false });

if (updatesError) throw updatesError;
if (infoError) throw infoError;

return res.json({
  ok: true,
  case: caseItem,
  updates: updates || [],
  info_updates: infoUpdates || []
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

try {
  const lat = latitude;
  const lng = longitude;

  const hasGps =
    lat !== null &&
    lng !== null &&
    lat !== "" &&
    lng !== "";

  if (hasGps) {
    const geo = await reverseGeocodeLatLng(lat, lng);

    const resolvedLocationText =
      geo?.location_text ||
      `${Number(lat)}, ${Number(lng)}`;

    await supabase
      .from("help_requests")
      .update({
        latitude: Number(lat),
        longitude: Number(lng),
        location_text: resolvedLocationText,
        last_action_at: new Date().toISOString()
      })
      .eq("case_code", case_code);

    console.log("GPS sync success:", {
      case_code,
      latitude: Number(lat),
      longitude: Number(lng),
      location_text: resolvedLocationText
    });
  }
} catch (geoErr) {
  console.warn("GPS sync / reverse geocoding warning:", geoErr?.message || geoErr);
}
    
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

app.post("/api/team/case-info/upload", caseInfoUpload.array("files", 10), async (req, res) => {
  try {
    const caseCode = String(req.body.case_code || "").trim();
    const docType = String(req.body.doc_type || "").trim();
    const docTitle = String(req.body.doc_title || "").trim();
    const docNote = String(req.body.doc_note || "").trim();

    if (!caseCode) {
      return res.status(400).json({ ok: false, error: "case_code is required" });
    }

    const { data: caseItem, error: caseError } = await supabase
      .from("help_requests")
      .select("case_code, full_name, status")
      .eq("case_code", caseCode)
      .maybeSingle();

    if (caseError) {
      return res.status(500).json({ ok: false, error: caseError.message });
    }

    if (!caseItem) {
      return res.status(404).json({ ok: false, error: "case not found" });
    }

    const files = Array.isArray(req.files) ? req.files : [];
    const uploadedFiles = await uploadCaseInfoFilesToSupabase(caseCode, files);

    const fileUrls = uploadedFiles.map(f => f.url);
    const fileNames = uploadedFiles.map(f => f.name);

    const createdBy = String(req.body.created_by || "team");
    const createdByUserId = String(req.body.created_by_user_id || "");

    const payload = {
      case_code: caseCode,
      doc_type: docType || null,
      doc_title: docTitle || null,
      doc_note: docNote || null,
      file_urls: fileUrls,
      file_names: fileNames,
      created_by: createdBy || null,
      created_by_user_id: createdByUserId || null
    };

    const { data: inserted, error: insertError } = await supabase
      .from("case_info_updates")
      .insert(payload)
      .select()
      .single();

    if (insertError) {
      return res.status(500).json({ ok: false, error: insertError.message });
    }

    try {
      broadcastSse("recent_activity_refresh", {
        scope: "case_info_upload",
        case_code: caseCode,
        updated_at: new Date().toISOString()
      });
    } catch (broadcastErr) {
      console.warn("broadcast case info upload warning:", broadcastErr?.message || broadcastErr);
    }

    return res.json({
      ok: true,
      message: "case info uploaded successfully",
      item: inserted,
      files: uploadedFiles
    });

  } catch (err) {
    console.error("POST /api/team/case-info/upload error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "internal server error"
    });
  }
});

app.post("/api/work-uploads", async (req, res) => {
  try {
    const {
      case_code,
      work_type,
      work_date,
      title,
      description,
      internal_note,
      source
    } = req.body || {};

    if (!case_code) {
      return res.status(400).json({ ok: false, error: "case_code is required" });
    }

    if (!work_type) {
      return res.status(400).json({ ok: false, error: "work_type is required" });
    }

    if (!title || !String(title).trim()) {
      return res.status(400).json({ ok: false, error: "title is required" });
    }

    const { data: helpRequest, error: caseError } = await supabase
      .from("help_requests")
      .select("id, case_code, full_name, status")
      .eq("case_code", case_code)
      .maybeSingle();

    if (caseError) {
      return res.status(500).json({ ok: false, error: caseError.message });
    }

    if (!helpRequest) {
      return res.status(404).json({ ok: false, error: "case not found" });
    }

    const messageLines = [
      `📤 อัปโหลดงาน: ${title}`,
      `ประเภทงาน: ${work_type}`,
      work_date ? `วันที่ดำเนินการ: ${work_date}` : null,
      description ? `รายละเอียด: ${description}` : null,
      internal_note ? `หมายเหตุ: ${internal_note}` : null,
      source ? `ต้นทาง: ${source}` : null
    ].filter(Boolean);

    const payload = {
      case_code: helpRequest.case_code,
      message: messageLines.join("\n"),
      current_step: "work_upload",
      progress_percent: null,
      waiting_for: null,
      latest_note: internal_note || description || title,
      status_after: null
    };

    const { data: insertedUpdate, error: insertError } = await supabase
      .from("case_updates")
      .insert(payload)
      .select()
      .single();

    if (insertError) {
      return res.status(500).json({ ok: false, error: insertError.message });
    }

try {
  const lat = helpRequest?.latitude ?? null;
  const lng = helpRequest?.longitude ?? null;

  const hasGps =
    lat !== null &&
    lng !== null &&
    lat !== "" &&
    lng !== "";

  if (hasGps) {
    const geo = await reverseGeocodeLatLng(lat, lng);

    const resolvedLocationText =
      geo?.location_text ||
      `${Number(lat)}, ${Number(lng)}`;

    await supabase
      .from("help_requests")
      .update({
        location_text: resolvedLocationText,
        last_action_at: new Date().toISOString()
      })
      .eq("case_code", helpRequest.case_code);

    console.log("WORK UPLOAD reverse geocoding success:", {
      case_code: helpRequest.case_code,
      latitude: Number(lat),
      longitude: Number(lng),
      location_text: resolvedLocationText
    });
  }
} catch (geoErr) {
  console.warn("WORK UPLOAD reverse geocoding warning:", geoErr?.message || geoErr);
}
    
    return res.json({
      ok: true,
      message: "บันทึกงานสำเร็จ",
      case_code: helpRequest.case_code,
      update: insertedUpdate
    });
  } catch (err) {
    console.error("POST /api/work-uploads error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "internal server error"
    });
  }
});

app.post("/api/work-uploads/files", upload.array("files", 10), async (req, res) => {
  try {
    const { case_code } = req.body || {};
    const files = req.files || [];

    if (!case_code) {
      return res.status(400).json({ ok: false, error: "case_code is required" });
    }

    if (!files.length) {
      return res.status(400).json({ ok: false, error: "no files uploaded" });
    }

    const uploaded = [];

    for (const file of files) {
      const safeName = `${Date.now()}-${file.originalname.replace(/\s+/g, "-")}`;
      const storagePath = `${case_code}/${safeName}`;

      const { error: uploadError } = await supabase.storage
        .from("work-uploads")
        .upload(storagePath, file.buffer, {
          contentType: file.mimetype,
          upsert: false
        });

      if (uploadError) {
        throw uploadError;
      }

      uploaded.push({
        file_name: file.originalname,
        file_path: storagePath,
        file_type: file.mimetype,
        file_size: file.size
      });
    }

    const imageUrls = uploaded
      .map(file => {
        const { data } = supabase.storage
          .from("work-uploads")
          .getPublicUrl(file.file_path);

        return data?.publicUrl || "";
      })
      .filter(Boolean);

    if (imageUrls.length) {
      const { error: timelineInsertError } = await supabase
        .from("case_updates")
        .insert({
          case_code,
          message: "📎 แนบไฟล์งาน",
          latest_note: "แนบไฟล์จากหน้าอัปโหลดงาน",
          current_step: "work_upload_files",
          progress_percent: null,
          waiting_for: null,
          updated_by: "upload-work",
          updater_name: "UPLOAD WORK",
          images: imageUrls,
          updated_at: new Date().toISOString()
        });

      if (timelineInsertError) {
        throw timelineInsertError;
      }

      try {
        broadcastSse("case_update", {
          scope: "upload_work_files",
          item: {
            case_code,
            message: "📎 แนบไฟล์งาน",
            latest_note: "แนบไฟล์จากหน้าอัปโหลดงาน",
            updater_name: "UPLOAD WORK",
            images: imageUrls,
            updated_at: new Date().toISOString()
          }
        });

        broadcastSse("recent_activity_refresh", {
          scope: "upload_work_files",
          case_code,
          updated_at: new Date().toISOString()
        });
      } catch (broadcastErr) {
        console.warn("broadcast upload files warning:", broadcastErr?.message || broadcastErr);
      }
    }

    return res.json({
      ok: true,
      files: uploaded,
      imageUrls
    });
  } catch (err) {
    console.error("POST /api/work-uploads/files error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "upload failed"
    });
  }
});

app.post("/api/team/case-info/upload", caseInfoUpload.array("files", 10), async (req, res) => {
  try {
    const caseCode = String(req.body.case_code || "").trim();
    const docType = String(req.body.doc_type || "").trim();
    const docTitle = String(req.body.doc_title || "").trim();
    const docNote = String(req.body.doc_note || "").trim();

    if (!caseCode) {
      return res.status(400).json({ ok: false, error: "case_code is required" });
    }

    const { data: caseItem, error: caseError } = await supabase
      .from("help_requests")
      .select("case_code, full_name, status")
      .eq("case_code", caseCode)
      .maybeSingle();

    if (caseError) {
      return res.status(500).json({ ok: false, error: caseError.message });
    }

    if (!caseItem) {
      return res.status(404).json({ ok: false, error: "case not found" });
    }

    const files = Array.isArray(req.files) ? req.files : [];
    const uploadedFiles = await uploadCaseInfoFilesToSupabase(caseCode, files);

    const fileUrls = uploadedFiles.map(f => f.url);
    const fileNames = uploadedFiles.map(f => f.name);

    const createdBy = String(req.body.created_by || "team");
    const createdByUserId = String(req.body.created_by_user_id || "");

    const payload = {
      case_code: caseCode,
      doc_type: docType || null,
      doc_title: docTitle || null,
      doc_note: docNote || null,
      file_urls: fileUrls,
      file_names: fileNames,
      created_by: createdBy || null,
      created_by_user_id: createdByUserId || null
    };

    const { data: inserted, error: insertError } = await supabase
      .from("case_info_updates")
      .insert(payload)
      .select()
      .single();

    if (insertError) {
      return res.status(500).json({ ok: false, error: insertError.message });
    }

    try {
      broadcastSse("recent_activity_refresh", {
        scope: "case_info_upload",
        case_code: caseCode,
        updated_at: new Date().toISOString()
      });
    } catch (broadcastErr) {
      console.warn("broadcast case info upload warning:", broadcastErr?.message || broadcastErr);
    }

    return res.json({
      ok: true,
      message: "case info uploaded successfully",
      item: inserted,
      files: uploadedFiles
    });
  } catch (err) {
    console.error("POST /api/team/case-info/upload error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "internal server error"
    });
  }
});

app.get("/api/help-requests/by-case-code/:caseCode", async (req, res) => {
  try {
    const caseCode = String(req.params.caseCode || "").trim();

    if (!caseCode) {
      return res.status(400).json({
        ok: false,
        error: "caseCode is required"
      });
    }

    const { data, error } = await supabase
      .from("help_requests")
      .select("*")
      .eq("case_code", caseCode)
      .maybeSingle();

    if (error) {
      console.error("GET BY CASE CODE ERROR:", error);
      return res.status(500).json({
        ok: false,
        error: error.message || "query failed"
      });
    }

    if (!data) {
      return res.status(404).json({
        ok: false,
        error: "case not found"
      });
    }

    return res.json({
      ok: true,
      data
    });
  } catch (err) {
    console.error("GET /api/help-requests/by-case-code/:caseCode ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "internal server error"
    });
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
async function getLineProfile(userId) {
  if (!userId) return null;

  const response = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
  });

  const resultText = await response.text();
  console.log("LINE profile status:", response.status);
  console.log("LINE profile body:", resultText);

  if (!response.ok) {
    throw new Error(`LINE profile failed: ${response.status} ${resultText}`);
  }

  try {
    return JSON.parse(resultText);
  } catch {
    return null;
  }
}

async function getGroupMemberProfile(groupId, userId) {
  if (!groupId || !userId) return null;

  const response = await fetch(
    `https://api.line.me/v2/bot/group/${groupId}/member/${userId}/profile`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
      },
    }
  );

  const resultText = await response.text();
  console.log("LINE group member profile status:", response.status);
  console.log("LINE group member profile body:", resultText);

  if (!response.ok) {
    throw new Error(`LINE group member profile failed: ${response.status} ${resultText}`);
  }

  try {
    return JSON.parse(resultText);
  } catch {
    return null;
  }
}

async function getRoomMemberProfile(roomId, userId) {
  if (!roomId || !userId) return null;

  const response = await fetch(
    `https://api.line.me/v2/bot/room/${roomId}/member/${userId}/profile`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
      },
    }
  );

  const resultText = await response.text();
  console.log("LINE room member profile status:", response.status);
  console.log("LINE room member profile body:", resultText);

  if (!response.ok) {
    throw new Error(`LINE room member profile failed: ${response.status} ${resultText}`);
  }

  try {
    return JSON.parse(resultText);
  } catch {
    return null;
  }
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

function lineImage(url, version = "donation-20260416-v1") {
  const clean = String(url || "").trim();
  if (!clean) return "";
  return clean.includes("?")
    ? `${clean}&v=${encodeURIComponent(version)}`
    : `${clean}?v=${encodeURIComponent(version)}`;
}

function createProjectBubble(title, subtitle, imageUrl, projectUrl) {
  return {
    type: "bubble",
    hero: {
      type: "image",
      url: imageUrl,
      size: "full",
      aspectRatio: "1:1",
      aspectMode: "cover",
      backgroundColor: "#EEEEEE",
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

// =========================
// REPORT SAFE: SUMMARY BY DAYS
// =========================
async function getDashboardSummaryByDays(days = 7) {
  const rangeStart = new Date();
  rangeStart.setDate(rangeStart.getDate() - (days - 1));
  rangeStart.setHours(0, 0, 0, 0);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

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
    supabase.from("help_requests").select("*", { count: "exact", head: true }).gte("created_at", rangeStart.toISOString()),
    supabase.from("help_requests").select("*", { count: "exact", head: true }).eq("status", "new").gte("created_at", rangeStart.toISOString()),
    supabase.from("help_requests").select("*", { count: "exact", head: true }).eq("priority", "urgent").in("status", ["new", "in_progress"]).gte("created_at", rangeStart.toISOString()),
    supabase.from("help_requests").select("*", { count: "exact", head: true }).gte("created_at", todayStart.toISOString()),
    supabase.from("help_requests").select("*", { count: "exact", head: true }).eq("status", "in_progress").gte("created_at", rangeStart.toISOString()),
    supabase.from("help_requests").select("*", { count: "exact", head: true }).eq("status", "done").gte("created_at", rangeStart.toISOString()),
    supabase.from("help_requests").select("created_at,status").gte("created_at", rangeStart.toISOString()),
    supabase.from("help_requests").select("priority,status,created_at").gte("created_at", rangeStart.toISOString()),
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
  const rangeStart = new Date();
  rangeStart.setDate(rangeStart.getDate() - (days - 1));
  rangeStart.setHours(0, 0, 0, 0);

  const [summary, graph, recentRes, urgentRes, inProgressRes] = await Promise.all([
    getDashboardSummaryByDays(days),
    getDashboardGraph(days),
    supabase.from("help_requests").select("*").gte("created_at", rangeStart.toISOString()).order("created_at", { ascending: false }).limit(10),
    supabase.from("help_requests").select("*").eq("priority", "urgent").in("status", ["new", "in_progress"]).gte("created_at", rangeStart.toISOString()).order("created_at", { ascending: false }).limit(10),
    supabase.from("help_requests").select("*").eq("status", "in_progress").gte("created_at", rangeStart.toISOString()).order("assigned_at", { ascending: false }).limit(10),
  ]);

  if (recentRes.error) throw recentRes.error;
  if (urgentRes.error) throw urgentRes.error;
  if (inProgressRes.error) throw inProgressRes.error;

  const insights = await getReportInsights(days);
  const autoAssignSummary = await getAutoAssignSummary(days);

  const executiveBrief = {
    headline: `ในช่วง ${days} วันล่าสุด รับเรื่อง ${summary.total_cases || 0} เคส ปิดแล้ว ${summary.done_cases || 0} เคส`,
    subheadline: `ยังมี ${summary.delayed_cases || 0} เคสล่าช้า • เคสด่วนค้าง ${summary.followup_urgent_cases || summary.urgent_cases || 0} เคส • Auto Assign ${autoAssignSummary.total || 0} เคส • เวลาปิดเฉลี่ย ${insights.avg_close_readable || "0 ชั่วโมง"}`,
    tone: (summary.delayed_cases || 0) > 0 || (summary.followup_urgent_cases || 0) > 0 ? "warning" : "good"
  };

  const recentCases = recentRes.data || [];
  const urgentOpenCases = urgentRes.data || [];
  const inProgressCases = inProgressRes.data || [];

  return {
    generated_at: new Date().toISOString(),
    summary,
    graph,
    insights,
    executive_brief: executiveBrief,
    recent_cases: recentCases,
    urgent_cases: urgentOpenCases,
    in_progress_cases: inProgressCases,
    auto_assign_summary: autoAssignSummary,
    operational_tables: {
      recent_cases: recentCases,
      urgent_open_cases: urgentOpenCases,
      in_progress_cases: inProgressCases
    }
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
app.get("/debug/team-group", async (req, res) => {
  try {
    const effectiveGroupId = getEffectiveTeamGroupId();

    return res.json({
      ok: true,
      hasChannelAccessToken: !!CHANNEL_ACCESS_TOKEN,
      effectiveTeamGroupIdMasked: maskGroupId(effectiveGroupId),
      source: {
        EFFECTIVE_TEAM_GROUP_ID: !!process.env.EFFECTIVE_TEAM_GROUP_ID,
        TEAM_GROUP_ID: !!process.env.TEAM_GROUP_ID,
        LINE_GROUP_ID: !!process.env.LINE_GROUP_ID
      }
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error)
    });
  }
});

app.get("/debug/push-team-test", async (req, res) => {
  try {
    const now = new Date().toLocaleString("th-TH", {
      timeZone: "Asia/Bangkok"
    });

    const result = await safePushToTeamGroup(
      [
        {
          type: "text",
          text: `✅ TEST PUSH ถึงกลุ่มทีมงาน\nเวลา: ${now}`
        }
      ],
      "debug-push-team-test"
    );

    return res.json({
      ok: true,
      result
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error)
    });
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

    const rows = Array.isArray(data) ? data : [];
    const finalRows = rows.map(attachSla);

    res.json({ ok: true, data: finalRows });
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

    const rows = Array.isArray(data) ? data : [];
    const finalRows = rows.map(attachSla);

    res.json({ ok: true, data: finalRows });
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
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
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

  const rawRows = Array.isArray(data) ? data : [];
  const rows = rawRows.map(attachSla);
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

// =========================
// IMAGEMAP STATIC SERVE (วางตรงนี้)
// =========================
app.get("/imagemap/team-menu/1040", (req, res) => {
res.sendFile(path.join(__dirname, "imagemap/New_WorkTeam.png"));
});

// =========================
// TEAM JOIN API
// สำหรับ LIFF สมัครเข้าทีม
// =========================
app.post("/api/team/join", async (req, res) => {
  try {
    const {
      line_user_id,
      display_name,
      picture_url,
      joined_group_id,
      source
    } = req.body || {};

    const lineUserId = String(line_user_id || "").trim();
    const displayName = String(display_name || "").trim();
    const pictureUrl = String(picture_url || "").trim();
    const joinedGroupId = String(joined_group_id || "").trim();
    const safeSource = String(source || "liff").trim();

    if (!lineUserId) {
      return res.status(400).json({
        ok: false,
        error: "missing_line_user_id"
      });
    }

    const { data: existingRow, error: existingError } = await supabase
      .from("team_candidates")
      .select("id, line_user_id, display_name, status, created_at")
      .eq("line_user_id", lineUserId)
      .maybeSingle();

    if (existingError) {
      throw existingError;
    }

    const payload = {
      line_user_id: lineUserId,
      display_name: displayName || null,
      picture_url: pictureUrl || null,
      joined_group_id: joinedGroupId || null,
      source: safeSource,
      status: existingRow?.status === "approved" ? "approved" : "pending",
      last_seen_at: new Date().toISOString()
    };

    const { data: row, error: upsertError } = await supabase
      .from("team_candidates")
      .upsert(payload, { onConflict: "line_user_id" })
      .select("id, line_user_id, display_name, status, created_at")
      .single();

    if (upsertError) {
      throw upsertError;
    }

    const alreadyRequested =
      !!existingRow && String(existingRow.status || "").trim().toLowerCase() === "pending";

    const alreadyApproved =
      !!existingRow && String(existingRow.status || "").trim().toLowerCase() === "approved";

    return res.json({
      ok: true,
      request_id: row?.id || null,
      candidate_id: row?.id || null,
      status: row?.status || "pending",
      already_requested: alreadyRequested,
      already_approved: alreadyApproved,
      message: alreadyApproved
        ? "คุณได้รับการอนุมัติเป็นสมาชิกแล้ว"
        : alreadyRequested
          ? `คุณได้ทำการสมัครสมาชิกแล้ว ตามคำขอเลขที่ ${row?.id || "-"} ขณะนี้อยู่ระหว่างรออนุมัติ ระบบจะรีบส่งข้อมูลการอนุมัติให้เร็วที่สุด ขอบคุณครับ`
          : "สมัครเข้าทีมสำเร็จแล้ว"
    });

  } catch (err) {
    console.error("TEAM JOIN API ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "internal_error"
    });
  }
});
/* =========================
   WEBHOOK
========================= */
app.post("/webhook", async (req, res) => {
  try {
    console.log("WEBHOOK DEBUG signature =", req.get("x-line-signature"));
    console.log("WEBHOOK DEBUG rawBody exists =", !!req.rawBody);
    console.log("WEBHOOK DEBUG body exists =", !!req.body);

    if (!verifySignature(req)) {
      console.error("❌ Invalid LINE signature");
      return res.status(401).send("Invalid signature");
    }

    const events = req.body.events || [];

    for (const event of events) {
      const replyToken = event.replyToken;

      // =========================
      // TEAM JOIN AUTO WELCOME (memberJoined)
      // วางก่อน if (event.type !== "message") continue;
      // =========================
      if (event.type === "memberJoined" && event.source?.type === "group") {
        try {
          const joinedMembers = Array.isArray(event.joined?.members) ? event.joined.members : [];
          const firstJoinedUserId = String(joinedMembers[0]?.userId || "").trim();

          if (!firstJoinedUserId) {
            continue;
          }

          if (TEAM_GROUP_ENABLED && !isAllowedTeamGroup(event)) {
            continue;
          }

          let joinedDisplayName = "สมาชิกใหม่";

          try {
            const profile = await getGroupMemberProfile(event.source.groupId, firstJoinedUserId);
            joinedDisplayName = String(profile?.displayName || "").trim() || "สมาชิกใหม่";
          } catch (err) {
            console.log("JOINED PROFILE LOAD ERROR:", err?.message || err);
          }

          upsertRecentUser(firstJoinedUserId, joinedDisplayName);

          await safeReply(replyToken, [
            buildTeamJoinWelcomeFlex(joinedDisplayName)
          ]);
        } catch (err) {
          console.error("MEMBER JOINED WELCOME ERROR:", err);
        }

        continue;
      }

      if (event.type !== "message") continue;
      if (!event.message || event.message.type !== "text") continue;

      const text = String(event?.message?.text || "").trim();
      console.log("👉 USER CLICK:", text);
      const userId = event?.source?.userId || "";

      console.log("ROLE CHECK DEBUG userId =", userId);
      console.log("ROLE CHECK DEBUG text =", text);
      console.log("ROLE CHECK DEBUG role =", await getUserRole(userId));
      console.log("ROLE CHECK DEBUG sourceType =", event.source?.type);
      console.log("ROLE CHECK DEBUG groupId =", event.source?.groupId || "");
      console.log("ROLE CHECK DEBUG allowedGroupId =", ALLOWED_TEAM_GROUP_ID);

      let lineDisplayName = "";

      try {
        lineDisplayName = await getLineProfileNameSafe(event);
      } catch (err) {
        console.log("LINE display name load error:", err?.message || err);
      }

      upsertRecentUser(userId, lineDisplayName || userId);

      // จากตรงนี้ค่อยต่อ logic message เดิมของคุณลงไป

  const role = await getUserRole(userId);

  if (text === "เคสวันนี้") {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const { data, error } = await supabase
    .from("help_requests")
    .select("*")
    .gte("created_at", todayStart.toISOString())
    .lte("created_at", todayEnd.toISOString())
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    console.error("TODAY CASES ERROR:", error);
    await safeReply(replyToken, [
      { type: "text", text: "เกิดข้อผิดพลาดในการโหลดเคสวันนี้" }
    ]);
    continue;
  }

  if (!data || data.length === 0) {
    await safeReply(replyToken, [
      { type: "text", text: "วันนี้ยังไม่มีเคสใหม่ในระบบ" }
    ]);
    continue;
  }

  const textLines = data.map((item, index) =>
    `${index + 1}. ${item.case_code || "-"} | ${item.full_name || "-"} | ${item.location || "-"}`
  );

  await safeReply(replyToken, [
    {
      type: "text",
      text: ("เคสวันนี้\n\n" + textLines.join("\n")).slice(0, 4900)
    }
  ]);
  continue;
}

if (text === "ค้นหาเคส") {
  clearCaseSearchState(userId);

  await safeReply(replyToken, [
    buildSearchMenuImagemap()
  ]);
  continue;
}

  // 👉 STEP FLOW ของต่อจากนี้

const caseSearchState = getCaseSearchState(userId);

if (String(text || "").trim() === "ค้นหาด้วยเลขเคส") {
  const revision = Date.now();

  setCaseSearchState(userId, {
    mode: "case_code",
    step: "waiting_case_code"
  });

  await safeReply(replyToken, [
    buildSearchCaseCodePromptImagemap("", revision)
  ]);
  continue;
}

if (String(text || "").trim() === "ค้นหาด้วยเบอร์โทร") {
  const revision = Date.now();

  setCaseSearchState(userId, {
    mode: "phone",
    step: "waiting_phone"
  });

  await safeReply(replyToken, [
    buildSearchPhonePromptImagemap("", revision)
  ]);
  continue;
}

if (String(text || "").trim() === "กลับสู่เมนูค้นหาเคส") {
  clearCaseSearchState(userId);

  await safeReply(replyToken, [
    buildSearchMenuImagemap("")
  ]);
  continue;
}
     
if (caseSearchState?.step === "waiting_case_code") {

const rawText = String(text || "").trim();

if (
  rawText === "กลับสู่เมนูค้นหาเคส" ||
  rawText === "เมนูค้นหาเคส" ||
  rawText === "ยกเลิก"
) {
  clearCaseSearchState(userId);

  await safeReply(replyToken, [
    buildSearchMenuImagemap("")
  ]);
  continue;
}
 
  const query = String(text || "").trim();

  if (!query) {
    await safeReply(replyToken, [
      { type: "text", text: "กรุณาพิมพ์เลขเคส" }
    ]);
    continue;
  }

  const { data: caseByCode, error } = await supabase
    .from("help_requests")
    .select("*")
    .eq("case_code", query)
    .maybeSingle();

  if (error) {
    console.error("CASE SEARCH BY CODE ERROR:", error);
    clearCaseSearchState(userId);

    await safeReply(replyToken, [
      { type: "text", text: "เกิดข้อผิดพลาดในการค้นหาเคส" }
    ]);
    continue;
  }

  if (!caseByCode) {
    await safeReply(replyToken, [
      { type: "text", text: "ไม่พบเคสนี้ กรุณาตรวจสอบเลขเคสอีกครั้ง" }
    ]);
    continue;
  }

  clearCaseSearchState(userId);

  await safeReply(replyToken, [
    buildUrgentCasePosterImagemap(caseByCode)
  ]);
  continue;
}
if (caseSearchState?.step === "waiting_phone") {
  const rawText = String(text || "").trim();

  if (
  rawText === "กลับเมนูค้นหาเคส" ||
  rawText === "กลับสู่เมนูค้นหาเคส" ||
  rawText === "เมนูค้นหาเคส" ||
  rawText === "ยกเลิก"
) {
    clearCaseSearchState(userId);

    await safeReply(replyToken, [
      buildSearchMenuImagemap("")
    ]);
    continue;
  }

  const query = String(text || "").replace(/\D/g, "");

  if (query.length < 9) {
    await safeReply(replyToken, [
      { type: "text", text: "กรุณากรอกเบอร์โทรให้ครบถ้วน" }
    ]);
    continue;
  }
  const { data: casesByPhone, error } = await supabase
    .from("help_requests")
    .select("*")
    .ilike("phone", `%${query}%`)
    .order("created_at", { ascending: false })
    .limit(5);

  if (error) {
    console.error("CASE SEARCH BY PHONE ERROR:", error);
    clearCaseSearchState(userId);

    await safeReply(replyToken, [
      { type: "text", text: "เกิดข้อผิดพลาดในการค้นหาเคส" }
    ]);
    continue;
  }

  if (!casesByPhone || casesByPhone.length === 0) {
    await safeReply(replyToken, [
      { type: "text", text: "ไม่พบเคสจากเบอร์โทรนี้" }
    ]);
    continue;
  }

  if (casesByPhone.length === 1) {
    clearCaseSearchState(userId);

    await safeReply(replyToken, [
      buildUrgentCasePosterImagemap(casesByPhone[0])
    ]);
    continue;
  }

  clearCaseSearchState(userId);

  const textLines = casesByPhone.map((item, index) =>
    `${index + 1}. ${item.case_code || "-"} | ${item.full_name || "-"} | ${item.location || "-"}`
  );

  await safeReply(replyToken, [
    {
      type: "text",
      text: ("พบหลายเคสจากเบอร์โทรนี้\n\n" + textLines.join("\n")).slice(0, 4900)
    }
  ]);
  continue;
} 
 // =========================
// STEP FLOW: เพิ่มทีม (รับ USER ID)
// =========================

 if (String(text || "").trim() === "ทดสอบบอท") {
  await safeReply(replyToken, [
    { type: "text", text: "✅ บอททำงานอยู่" }
  ]);
  continue;
}

if (String(text || "").trim() === "สมัครทีมภายหลัง") {
  await safeReply(replyToken, [
    {
      type: "text",
      text: "รับทราบครับ 😊 เมื่อพร้อมแล้วสามารถกดสมัครเข้าทีมได้ทุกเมื่อ ระบบจะรอการยืนยันจากคุณอยู่เสมอ"
    }
  ]);
  continue;
}

if (String(text || "").trim() === "เพิ่มทีมงาน") {
  if (!isGroupEvent(event)) {
    await safeReply(replyToken, [
      { type: "text", text: "❌ คำสั่งนี้ใช้ได้เฉพาะในไลน์กลุ่มเท่านั้น" }
    ]);
    continue;
  }

  if (TEAM_GROUP_ENABLED && !isAllowedTeamGroup(event)) {
    await safeReply(replyToken, [
      { type: "text", text: "❌ คำสั่งนี้ใช้ได้เฉพาะในกลุ่มทีมงานที่ได้รับอนุญาตเท่านั้น" }
    ]);
    continue;
  }

  if (!(await isAdmin(userId))) {
    await safeReply(replyToken, [
      { type: "text", text: "❌ คำสั่งนี้สำหรับผู้ดูแลระบบ" }
    ]);
    continue;
  }

  try {
    const flex = await buildSelectUserFlex();
    await safeReply(replyToken, [flex]);
  } catch (err) {
    console.error("เพิ่มทีมงาน buildSelectUserFlex error:", err);
    await safeReply(replyToken, [
      { type: "text", text: "❌ โหลดรายชื่อทีมงานไม่สำเร็จ" }
    ]);
  }

  continue;
}

if (String(text || "").trim() === "ดูรายชื่อทีมงาน") {
  if (!(await isAdmin(userId))) {
    await safeReply(replyToken, [
      { type: "text", text: "❌ ไม่มีสิทธิ์ใช้งานคำสั่งนี้" }
    ]);
    continue;
  }

  try {
    const { data, error } = await supabase
      .from("line_user_roles")
      .select("line_user_id, role, is_active, updated_at")
      .eq("is_active", true)
      .order("updated_at", { ascending: false });

    if (error) throw error;

    const rows = Array.isArray(data) ? data : [];

    if (!rows.length) {
      await safeReply(replyToken, [
        { type: "text", text: "ℹ️ ยังไม่มีรายชื่อทีมงาน" }
      ]);
      continue;
    }

    const textLines = rows.slice(0, 20).map((row, i) =>
      `${i + 1}. ${row.line_user_id}\nสิทธิ์: ${row.role}`
    );

    await safeReply(replyToken, [
      {
        type: "text",
        text: `รายชื่อทีมงาน\n\n${textLines.join("\n\n")}`
      }
    ]);
    continue;

  } catch (err) {
    console.error("LIST TEAM ERROR:", err);
    await safeReply(replyToken, [
      { type: "text", text: "❌ ดึงรายชื่อทีมงานไม่สำเร็จ" }
    ]);
    continue;
  }
}


 
const addState = getAddTeamState(userId);

if (addState?.step === "waiting_user_id") {
  const inputId = text.trim();

  if (!inputId.startsWith("U")) {
    await safeReply(replyToken, [
      { type: "text", text: "❌ USER ID ต้องขึ้นต้นด้วย U" }
    ]);
    continue;
  }

  setAddTeamState(userId, "waiting_role", {
    targetUserId: inputId
  });

  await safeReply(replyToken, [
    buildSelectRoleFlex(inputId)
  ]);

  continue;
}

if (text.startsWith("select_user ")) {

  if (!(await isAdmin(userId))) {
    await safeReply(replyToken, [
      { type: "text", text: "❌ ไม่มีสิทธิ์ใช้งานคำสั่งนี้" }
    ]);
    continue;
  }

  console.log("CHECK select_user command HIT:", text);

  const targetUserId = text.replace("select_user ", "").trim();

  if (!targetUserId.startsWith("U")) {
    await safeReply(replyToken, [
      { type: "text", text: "❌ USER ID ไม่ถูกต้อง" }
    ]);
    continue;
  }

  setAddTeamState(userId, "waiting_role", { targetUserId });

  await safeReply(replyToken, [
    buildSelectRoleFlex(targetUserId)
  ]);

  continue;
}


 
if (text.startsWith("setrole_auto ")) {

  if (!(await isAdmin(userId))) {
    await safeReply(replyToken, [
      { type: "text", text: "❌ ไม่มีสิทธิ์ใช้งานคำสั่งนี้" }
    ]);
    continue;
  }

  console.log("CHECK setrole_auto command HIT:", text);

  const role = (text.split(" ")[1] || "").toLowerCase();
  const addTeamState = getAddTeamState(userId);

  try {
    if (!["admin", "staff", "viewer"].includes(role)) {
      await safeReply(replyToken, [
        { type: "text", text: "❌ role ต้องเป็น admin, staff หรือ viewer เท่านั้น" }
      ]);
      continue;
    }

    if (!addTeamState || addTeamState.step !== "waiting_role" || !addTeamState.targetUserId) {
      await safeReply(replyToken, [
        { type: "text", text: "❌ ยังไม่ได้เลือกผู้ใช้เป้าหมาย\nกรุณาเริ่มจากคำสั่งเพิ่มทีมอีกครั้ง" }
      ]);
      continue;
    }

    const targetUserId = String(addTeamState.targetUserId || "").trim();

    if (!targetUserId.startsWith("U")) {
      await safeReply(replyToken, [
        { type: "text", text: "❌ ไม่พบ USER ID ที่ถูกต้อง" }
      ]);
      clearAddTeamState(userId);
      continue;
    }

    if (targetUserId === userId && role !== "admin") {
      await safeReply(replyToken, [
        { type: "text", text: "❌ ไม่สามารถลดสิทธิ์ของตัวเองได้" }
      ]);
      clearAddTeamState(userId);
      continue;
    }

    const currentRole = await getUserRole(targetUserId);
    const adminCount = await countActiveAdmins();

    if (role === "admin" && currentRole !== "admin" && adminCount >= 3) {
      await safeReply(replyToken, [
        { type: "text", text: "❌ Admin เต็มแล้ว (สูงสุด 3 คน)" }
      ]);
      clearAddTeamState(userId);
      continue;
    }

    if (currentRole === "admin" && role !== "admin" && adminCount <= 1) {
      await safeReply(replyToken, [
        { type: "text", text: "❌ ต้องมีผู้ดูแลระบบอย่างน้อย 1 คน" }
      ]);
      clearAddTeamState(userId);
      continue;
    }

    const { data: existing, error: existingError } = await supabase
      .from("line_user_roles")
      .select("line_user_id, is_active, role")
      .eq("line_user_id", targetUserId)
      .maybeSingle();

    if (existingError) throw existingError;

    if (existing && existing.is_active !== false && existing.role === role) {
      await safeReply(replyToken, [
        { type: "text", text: "⚠️ ผู้ใช้นี้มีสิทธิ์นี้อยู่แล้ว" }
      ]);
      clearAddTeamState(userId);
      continue;
    }

    const { error: upsertError } = await supabase
      .from("line_user_roles")
      .upsert(
        {
          line_user_id: targetUserId,
          role,
          is_active: true
        },
        { onConflict: "line_user_id" }
      );

    if (upsertError) throw upsertError;

    const approveResult = await approvePendingTeamCandidate(targetUserId, role, userId);

    if (!approveResult.success) {
      console.warn("approvePendingTeamCandidate warning:", approveResult);
    }

    roleCache.delete(targetUserId);
    clearAddTeamState(userId);

    await safeReply(replyToken, [
      {
        type: "text",
        text: `✅ อัปเดตสิทธิ์สำเร็จ (${role})\nUSER ID: ${targetUserId}`
      }
    ]);

  } catch (err) {
    console.error("SET ROLE ERROR:", err);

    await safeReply(replyToken, [
      { type: "text", text: "❌ เกิดข้อผิดพลาด" }
    ]);

    clearAddTeamState(userId);
    continue;
  }

  continue;
}console.log("EVENT TEXT =", text);
console.log("USER ID =", userId);


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

if (String(text || "").trim().toLowerCase() === "test imagemap") {
  return await safeReply(replyToken, [buildTeamMenuImagemap()]);
}
      
if (String(text).trim().toLowerCase() === "test poster") {
  return await safeReply(replyToken, [buildPosterModeFlex()]);
}

if (String(text || "").trim().toLowerCase() === "test overlay") {
  return await safeReply(replyToken, [buildTeamMenuOverlayFlex()]);
}
    
      
if (!teamGuard.pass) {
  await replyGuardError(replyToken, teamGuard.reason);
  continue;
}

  
if (String(text || "").trim() === "เมนูทีมงาน") {
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

  await safeReply(replyToken, [
    buildTeamMenuImagemap()
  ]);
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

  const revision = Date.now();

  await safeReply(replyToken, [
    buildAdminMenuImagemap("", revision)
  ]);
  continue;
}

if (
  String(text || "").trim() === "เปิดเมนูจัดการเคส" ||
  String(text || "").trim() === "เมนูจัดการเคส" ||
  String(text || "").trim() === "จัดการเคส"
) {
  if (!isGroupEvent(event)) {
    await safeReply(replyToken, [{ type: "text", text: "❌ คำสั่งนี้ใช้ได้เฉพาะในไลน์กลุ่มเท่านั้น" }]);
    continue;
  }

  if (TEAM_GROUP_ENABLED && !isAllowedTeamGroup(event)) {
    await safeReply(replyToken, [{ type: "text", text: "❌ เมนูจัดการเคสใช้ได้เฉพาะในกลุ่มทีมงานที่ได้รับอนุญาตเท่านั้น" }]);
    continue;
  }

  if (!(await isAdmin(userId))) {
    await safeReply(replyToken, [{ type: "text", text: "❌ เมนูนี้สำหรับผู้ดูแลระบบ" }]);
    continue;
  }

  const revision = Date.now();

  await safeReply(replyToken, [
    buildAdminCaseMenuImagemap("", revision)
  ]);
  continue;
}

if (String(text || "").trim() === "เมนูรายงานผู้บริหาร") {
  if (!isGroupEvent(event)) {
    await safeReply(replyToken, [{ type: "text", text: "❌ คำสั่งนี้ใช้ได้เฉพาะในไลน์กลุ่มเท่านั้น" }]);
    continue;
  }

  if (TEAM_GROUP_ENABLED && !isAllowedTeamGroup(event)) {
    await safeReply(replyToken, [{ type: "text", text: "❌ เมนูรายงานผู้บริหารใช้ได้เฉพาะในกลุ่มทีมงานที่ได้รับอนุญาตเท่านั้น" }]);
    continue;
  }

  if (!(await isAdmin(userId))) {
    await safeReply(replyToken, [{ type: "text", text: "❌ เมนูนี้สำหรับผู้ดูแลระบบ" }]);
    continue;
  }

  const revision = Date.now();

  await safeReply(replyToken, [
    buildAdminDashboardMenuImagemap("", revision)
  ]);
  continue;
}

if (
  String(text || "").trim() === "เมนูบริหารจัดการทีม" ||
  String(text || "").trim() === "เปิดเมนูจัดการทีม" ||
  String(text || "").trim() === "บริหารจัดการทีม"
) {
  if (!isGroupEvent(event)) {
    await safeReply(replyToken, [{ type: "text", text: "❌ คำสั่งนี้ใช้ได้เฉพาะในไลน์กลุ่มเท่านั้น" }]);
    continue;
  }

  if (TEAM_GROUP_ENABLED && !isAllowedTeamGroup(event)) {
    await safeReply(replyToken, [{ type: "text", text: "❌ เมนูบริหารจัดการทีมใช้ได้เฉพาะในกลุ่มทีมงานที่ได้รับอนุญาตเท่านั้น" }]);
    continue;
  }

  if (!(await isAdmin(userId))) {
    await safeReply(replyToken, [{ type: "text", text: "❌ เมนูนี้สำหรับผู้ดูแลระบบ" }]);
    continue;
  }

  const revision = Date.now();

  await safeReply(replyToken, [
    buildAdminTeamManageMenuImagemap("", revision)
  ]);
  continue;
}

if (
  String(text || "").trim() === "คำสั่งเพิ่มทีม" ||
  String(text || "").trim() === "เพิ่มทีม" ||
  String(text || "").trim() === "เพิ่มทีมงาน"
) {
  if (!(await isAdmin(userId))) {
    await safeReply(replyToken, [
      { type: "text", text: "❌ เมนูนี้สำหรับผู้ดูแลระบบ" }
    ]);
    continue;
  }

  clearAddTeamState(userId);

  await safeReply(replyToken, [
    buildSelectUserFlex()
  ]);
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

if (
  String(text || "").trim() === "Smart Alert" ||
  String(text || "").trim() === "ดู Smart Alert"
) {
  if (!isGroupEvent(event)) {
    await safeReply(replyToken, [{ type: "text", text: "❌ คำสั่งนี้ใช้ได้เฉพาะในไลน์กลุ่มเท่านั้น" }]);
    continue;
  }

  if (TEAM_GROUP_ENABLED && !isAllowedTeamGroup(event)) {
    await safeReply(replyToken, [{ type: "text", text: "❌ เมนู Smart Alert ใช้ได้เฉพาะในกลุ่มทีมงานที่ได้รับอนุญาตเท่านั้น" }]);
    continue;
  }

  if (!(await isAdmin(userId))) {
    await safeReply(replyToken, [{ type: "text", text: "❌ เมนูนี้สำหรับผู้ดูแลระบบ" }]);
    continue;
  }

  const revision = Date.now();

  await safeReply(replyToken, [
    buildSmartAlertMenuImagemap("", revision)
  ]);
  continue;
}
if (text === "ดู SLA วิกฤต") {
  const slaCounts = await getSlaMenuCounts();

  await replyCasesFromRowsCarousel({
    replyToken,
    title: "🚨 รายการ SLA วิกฤต",
    rows: slaCounts.overdue_rows || [],
    heroImage: URGENT_CASE_CAROUSEL_HERO
  });
  continue;
}

if (text === "ดูใกล้หลุด SLA") {
  const slaCounts = await getSlaMenuCounts();

  await replyCasesFromRowsCarousel({
    replyToken,
    title: "⚠️ รายการใกล้หลุด SLA",
    rows: slaCounts.near_due_rows || [],
    heroImage: URGENT_CASE_CAROUSEL_HERO
  });
  continue;
}

if (text === "ดูเคสเปิดทั้งหมด") {
  const openCases = await getOpenCasesForMenu("all", 10);

  await replyCasesFromRowsCarousel({
    replyToken,
    title: "📋 เคสเปิดทั้งหมด",
    rows: openCases,
    heroImage: URGENT_CASE_CAROUSEL_HERO
  });
  continue;
}
if (text === "เมนูทีมงาน" || text === "เปิดเมนูทีมงาน" || text === "รีเฟรชเมนูทีมงาน") {
  if (!(await isViewer(userId))) {
    await safeReply(replyToken, [{ type: "text", text: "เฉพาะทีมงานหรือผู้มีสิทธิ์เท่านั้น" }]);
   
     return;
  }

  await safeReply(replyToken, [
    buildTeamMenuImagemap()
  ]);
  return;
  
}

if (String(text || "").trim() === "ดูเคสใหม่" || String(text || "").trim() === "เคสใหม่") {
  if (!(await isViewer(userId))) {
    await safeReply(replyToken, [
      { type: "text", text: "❌ คุณไม่มีสิทธิ์ดูข้อมูลเคสใหม่" }
    ]);
    return;
  }

  await safeReply(replyToken, [
    await buildNewCaseMenuImagemap()
  ]);
  return;
}

if (String(text || "").trim() === "ดูเคสใหม่ทั้งหมด") {
  await replyCaseMenuCarousel({
    replyToken,
    title: "รายการเคสเปิดทั้งหมด",
    filterType: "all"
  });
  return;
}

if (String(text || "").trim() === "ดูเคสใหม่ด่วน") {
await replyCaseMenuCarousel({
  replyToken,
  title: "รายการเคสด่วน",
  filterType: "urgent",
  heroImage: URGENT_CASE_CAROUSEL_HERO
});
  return;
}

if (String(text || "").trim() === "ดูเคสใหม่ปกติ") {
  await replyCaseMenuCarousel({
    replyToken,
    title: "รายการเคสปกติ",
    filterType: "normal"
  });
  return;
}
if (String(text || "").trim() === "กลับสู่เมนูทีมงาน") {
  if (!(await isViewer(userId))) {
    await safeReply(replyToken, [{ type: "text", text: "❌ คุณไม่มีสิทธิ์ใช้งานเมนูทีมงาน" }]);
    return;
  }

  await safeReply(replyToken, [
    buildTeamMenuImagemap()
  ]);
  return;
}

     
if (String(text || "").trim() === "ดูเคสด่วน" || String(text || "").trim() === "เคสด่วน") {

  if (!(await isViewer(userId))) {
    await safeReply(replyToken, [
      { type: "text", text: "❌ คุณไม่มีสิทธิ์ดูเคสด่วน" }
    ]);
    return;
  }

  console.log("🔥 HANDLER ดูเคสด่วน START");

  const counts = await getUrgentCaseMenuCounts();
  console.log("🔥 HANDLER COUNTS:", counts);

  const revision = `${counts.critical}-${counts.warning}-${counts.inProgress}-v8`;

  await safeReply(replyToken, [
    {
      type: "imagemap",
      baseUrl: `https://satisfied-stillness-production-7942.up.railway.app/imagemap/urgent-case-menu-v2-r${revision}`,
      altText: `เมนูเคสด่วน | วิกฤต ${counts.critical} | ใกล้วิกฤต ${counts.warning} | ปกติ ${counts.normal}`,
      baseSize: { width: 1040, height: 1559 },
      actions: [
        {
          type: "message",
          text: "เคสด่วน SLA วิกฤต",
          area: { x: 100, y: 900, width: 840, height: 120 }
        },
        {
          type: "message",
          text: "เคสด่วน SLA ใกล้วิกฤต",
          area: { x: 100, y: 1060, width: 840, height: 120 }
        },
        {
          type: "message",
          text: "เคสด่วน SLA ปกติ",
          area: { x: 100, y: 1220, width: 840, height: 120 }
        },
        {
          type: "message",
          text: "กลับสู่เมนูทีมงาน",
          area: { x: 100, y: 1380, width: 840, height: 120 }
        }
      ]
    }
  ]);
try {
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

// ================================
// SLA: เคสด่วน วิกฤต
// ================================
if (String(text || "").trim() === "เคสด่วน SLA วิกฤต") {
  const slaCounts = await getSlaMenuCounts();
  const cases = Array.isArray(slaCounts.overdue_rows) ? slaCounts.overdue_rows : [];

 if (!cases.length) {
  await safeReply(replyToken, [
    {
      type: "text",
      text: "เคสด่วน SLA วิกฤต\n\nยังไม่มีรายการเคสในหมวดนี้"
    }
  ]);
  continue;
}

    await safeReply(replyToken, [
    buildCaseMenuCarouselFlex("เคสด่วน SLA วิกฤต", cases, {
      heroImage: URGENT_CASE_CAROUSEL_HERO
    })
  ]);
  continue;
}

// ================================
// SLA: เคสด่วน ใกล้วิกฤต
// ================================
if (String(text || "").trim() === "เคสด่วน SLA ใกล้วิกฤต") {
  const slaCounts = await getSlaMenuCounts();
  const cases = Array.isArray(slaCounts.near_due_rows) ? slaCounts.near_due_rows : [];

  if (!cases.length) {
    await safeReply(replyToken, [
      {
        type: "text",
        text: "เคสด่วน SLA ใกล้วิกฤต\n\nยังไม่มีรายการเคสในหมวดนี้"
      }
    ]);
    continue;
  }

  await safeReply(replyToken, [
    buildCaseMenuCarouselFlex("เคสด่วน SLA ใกล้วิกฤต", cases.slice(0, 10), {
      heroImage: URGENT_CASE_CAROUSEL_HERO
    })
  ]);
  continue;
}

// ================================
// SLA: เคสด่วน กำลังดำเนินการ
// ================================
if (String(text || "").trim() === "เคสด่วน SLA ปกติ") {
  const { data, error } = await supabase
    .from("help_requests")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
  console.error("URGENT SLA NORMAL ERROR:", error);
  await safeReply(replyToken, [
    { type: "text", text: "โหลดรายการเคสด่วน SLA ปกติไม่สำเร็จ" }
  ]);
  continue;
}

  const cases = (Array.isArray(data) ? data : []).filter((row) => {
    const status = normalizeCaseStatus(row.status);
    const isActive = status === "new" || status === "in_progress";
    const isUrgent = String(row.priority || "").trim().toLowerCase() === "urgent";
    const slaLevel = getSlaLevel(row).sla_level;

    return isActive && isUrgent && slaLevel === "normal";
  });

if (!cases.length) {
  await safeReply(replyToken, [
    {
      type: "text",
      text: "เคสด่วน SLA ปกติ\n\nยังไม่มีรายการเคสในหมวดนี้"
    }
  ]);
  continue;
}

    await safeReply(replyToken, [
    buildCaseMenuCarouselFlex("เคสด่วน SLA ปกติ", cases.slice(0, 10), {
      heroImage: URGENT_CASE_CAROUSEL_HERO
    })
  ]);
  continue;
}


         
if (text === "ขอความช่วยเหลือ") {
  await safeReply(replyToken, [buildHelpRequestChoiceFlex()]);
  continue;
}

if (text === "ขอความช่วยเหลือครั้งแรก") {
  await safeReply(replyToken, [buildHelpFirstContactFlex()], [
    {
      type: "text",
      text:
        "สวัสดีครับ ท่านสามารถเลือกวิธีแจ้งเรื่องที่สะดวกที่สุดได้เลยครับ\n\n" +
        "1) กรอกข้อมูลแบบง่าย\n" +
        "2) พิมพ์คุยกับเจ้าหน้าที่",
    },
  ]);
  continue;
}

if (text === "ขอความช่วยเหลือแบบฟอร์ม") {
  await safeReply(replyToken, [buildHelpFormFlex()], [
    {
      type: "text",
      text:
        "หากสะดวก รบกวนค่อยๆ พิมพ์ข้อมูลตามนี้ได้เลยครับ\n\n" +
        "ชื่อ:\n" +
        "พื้นที่:\n" +
        "รายละเอียด:\n" +
        "เบอร์:\n\n" +
        "หากยังพิมพ์ไม่ครบในครั้งเดียวก็ไม่เป็นไรนะครับ ค่อยๆ ส่งมาได้ครับ",
    },
  ]);
  continue;
}

if (text === "ขอความช่วยเหลือแบบแชท") {
  await safeReply(replyToken, [
    {
      type: "text",
      text:
        "สวัสดีครับ เรายินดีรับฟังและพร้อมช่วยเหลือท่านนะครับ\n\n" +
        "หากสะดวก รบกวนค่อยๆ พิมพ์ข้อมูลตามนี้ได้เลยครับ\n\n" +
        "ชื่อ:\n" +
        "พื้นที่:\n" +
        "รายละเอียด:\n" +
        "เบอร์:\n\n" +
        "หากยังพิมพ์ไม่ครบในครั้งเดียวก็ไม่เป็นไรนะครับ ค่อยๆ ส่งมาได้ครับ",
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

  await safeReply(replyToken, [buildNewCaseMenuImagemap()]);
  continue;
}
     
if (text === "เคสวันนี้") {
  if (!(await isViewer(userId))) {
    await safeReply(replyToken, [{ type: "text", text: "❌ คุณไม่มีสิทธิ์ดูเคสวันนี้" }]);
    continue;
  }

  try {
    const cases = await getTodayCases(1);

    if (!cases.length) {
      await safeReply(replyToken, [{ type: "text", text: "วันนี้ยังไม่มีเคสเข้าระบบครับ" }]);
      continue;
    }

    await safeReply(replyToken, [
      buildCaseTrackingFlex(cases[0])
    ]);
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

            try {
              await createGoldenAlertFromCaseRow(insertedCase, {
                source_type: "new_case_created",
                source_id: insertedCase.id || insertedCase.case_code,
                notify: false
              });
            } catch (alertErr) {
              console.warn("NEW CASE ALERT WARNING:", alertErr?.message || alertErr);
            }

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


// ===== PATCH: /api/alerts/summary =====
app.get("/api/alerts/summary", async (req, res) => {
  try {
    const alerts = await listGoldenAlerts({
      status: String(req.query.status || 'open'),
      limit: Math.max(20, Math.min(Number(req.query.limit || 100), 200))
    });

    const summary = {
      total_open: alerts.length,
      critical: alerts.filter((item) => item.severity === 'critical').length,
      high: alerts.filter((item) => item.severity === 'high').length,
      medium: alerts.filter((item) => item.severity === 'medium').length,
      info: alerts.filter((item) => item.severity === 'info').length,
      by_type: {
        new_case_unassigned: alerts.filter((item) => item.alert_type === 'new_case_unassigned').length,
        urgent_case: alerts.filter((item) => item.alert_type === 'urgent_case').length,
        sla_warning: alerts.filter((item) => item.alert_type === 'sla_warning').length,
        sla_breach: alerts.filter((item) => item.alert_type === 'sla_breach').length,
      }
    };

    return safeJson(res, { ok: true, summary });
  } catch (err) {
    console.error('[ALERTS_SUMMARY_ERROR]', err);
    return safeJson(res, {
      ok: true,
      summary: {
        total_open: 0,
        critical: 0,
        high: 0,
        medium: 0,
        info: 0,
        by_type: {
          new_case_unassigned: 0,
          urgent_case: 0,
          sla_warning: 0,
          sla_breach: 0,
        }
      },
      fallback: true,
    });
  }
});

// ===== PATCH: /api/alerts/recent =====
app.get("/api/alerts/recent", async (req, res) => {
  try {
    const items = await listGoldenAlerts({
      status: String(req.query.status || 'open'),
      limit: Number(req.query.limit || 20)
    });

    return safeJson(res, { ok: true, items });
  } catch (err) {
    console.error('[ALERTS_RECENT_ERROR]', err);
    return safeJson(res, { ok: true, items: [], fallback: true });
  }
});

// ===== PATCH: /api/alerts/generate =====
app.get("/api/alerts/generate", async (req, res) => {
  try {
    const result = await generateGoldenAlertsNow({
      limit: Number(req.query.limit || 10),
      notify: req.query.notify === '0' ? false : true,
      source_type: 'manual_generate'
    });
    return safeJson(res, result);
  } catch (err) {
    console.error('[ALERTS_GENERATE_ERROR]', err);
    return res.status(500).json({ ok: false, error: err.message || 'generate_alerts_failed' });
  }
});


// ===== PATCH: /api/alerts =====
app.get("/api/alerts", async (req, res) => {
  try {
    const status = String(req.query.status || "open").trim().toLowerCase();
    const limit = Math.max(1, Math.min(Number(req.query.limit || 20), 100));
    const alerts = await listGoldenAlerts({ status, limit });

    return safeJson(res, {
      success: true,
      data: alerts,
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




// ===== PATCH: /api/auto-assign/summary =====
app.get("/api/auto-assign/summary", async (req, res) => {
  try {
    const days = Math.max(1, Math.min(Number(req.query.days || 7), 30));
    const summary = await getAutoAssignSummary(days);
    return safeJson(res, {
      success: true,
      summary
    });
  } catch (err) {
    console.error("[AUTO_ASSIGN_SUMMARY_ERROR]", err);
    return safeJson(res, {
      success: true,
      summary: { total: 0, critical: 0, high: 0, recent: [] },
      fallback: true
    });
  }
});

// ===== PATCH: /api/executive/decision-board =====
app.get("/api/executive/decision-board", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit || 10), 50));
    const board = await buildExecutiveDecisionBoard(limit);

    return safeJson(res, {
      success: true,
      cases: board.cases || [],
      alerts: board.alerts || [],
      auto_assign_summary: board.auto_assign_summary || { total: 0, critical: 0, high: 0, recent: [] },
    });

  } catch (err) {
    console.error("[EXEC_BOARD_ERROR]", err);

    return safeJson(res, {
      success: true,
      cases: [],
      alerts: [],
      auto_assign_summary: { total: 0, critical: 0, high: 0, recent: [] },
      fallback: true,
    });
  }
});

// =========================
// TEAM MENU IMAGEMAP IMAGE ROUTE
// =========================
app.get("/imagemap/team-menu/:size", async (req, res) => {
  try {
    const imageUrl = "https://img2.pic.in.th/New_WorkTeam.png";

    const upstream = await fetch(imageUrl);
    if (!upstream.ok) {
      return res.status(502).send("Failed to load imagemap source");
    }

    const contentType = upstream.headers.get("content-type") || "image/png";
    const buffer = Buffer.from(await upstream.arrayBuffer());

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.send(buffer);
  } catch (err) {
    console.error("IMAGEMAP ROUTE ERROR:", err);
    return res.status(500).send("Imagemap route error");
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
    let status = String(row.status || "").trim().toLowerCase();
    if (status === "progress") status = "in_progress";

    const priority = String(row.priority || "").trim().toLowerCase();
    return priority === "urgent" && ["new", "in_progress"].includes(status);
  });
}

function filterClosedCases(rows = []) {
  return rows.filter((row) => {
    let status = String(row.status || "").trim().toLowerCase();
    if (status === "progress") status = "in_progress";
    return status === "done";
  });
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



async function getCommandCenterCommandQueue(limit = 8) {
  const rows = await getCommandCenterRows(300);
  const queue = [];
  const urgentOpen = filterUrgentOpenCases(rows);
  const delayed = filterDelayedCases(rows);
  const unassigned = rows.filter((row) => {
    const assigned = String(row.assigned_to || "").trim();
    let status = String(row.status || "").trim().toLowerCase();
    if (status === "progress") status = "in_progress";
    return !assigned && ["new", "in_progress"].includes(status);
  });

  urgentOpen.slice(0, limit).forEach((row) => {
    const assigned = String(row.assigned_to || "").trim();
    queue.push({
      type: assigned ? "urgent_followup" : "assign_now",
      severity: assigned ? "high" : "critical",
      case_id: row.id,
      case_code: row.case_code,
      full_name: row.full_name,
      location: row.location,
      status: row.status,
      priority: row.priority,
      assigned_to: row.assigned_to || null,
      action_text: assigned ? "ติดตามเคสด่วนทันที" : "มอบหมายผู้รับผิดชอบด่วน",
      reason: assigned ? "เป็นเคสด่วนที่ยังเปิดอยู่" : "เป็นเคสด่วนและยังไม่มีผู้รับผิดชอบ"
    });
  });

  delayed.filter((row) => !queue.some((item) => item.case_id === row.id)).slice(0, limit).forEach((row) => {
    queue.push({
      type: "delayed_followup",
      severity: "medium",
      case_id: row.id,
      case_code: row.case_code,
      full_name: row.full_name,
      location: row.location,
      status: row.status,
      priority: row.priority,
      assigned_to: row.assigned_to || null,
      action_text: "เร่งติดตามเคสล่าช้า",
      reason: "เคสยังไม่ปิดและค้างเกินเกณฑ์"
    });
  });

  unassigned.filter((row) => !queue.some((item) => item.case_id === row.id)).slice(0, limit).forEach((row) => {
    queue.push({
      type: "assign_owner",
      severity: "medium",
      case_id: row.id,
      case_code: row.case_code,
      full_name: row.full_name,
      location: row.location,
      status: row.status,
      priority: row.priority,
      assigned_to: null,
      action_text: "มอบหมายผู้รับผิดชอบ",
      reason: "เคสยังไม่มีผู้รับผิดชอบ"
    });
  });

  return queue.slice(0, limit);
}

async function getCommandCenterWorkload() {
  const rows = await getCommandCenterRows(500);
  const openRows = rows.filter((row) => {
    let status = String(row.status || "").trim().toLowerCase();
    if (status === "progress") status = "in_progress";
    return ["new", "in_progress"].includes(status);
  });
  const map = new Map();
  openRows.forEach((row) => {
    const key = String(row.assigned_to || "").trim() || "ยังไม่มีผู้รับผิดชอบ";
    const bucket = map.get(key) || {
      assignee: key,
      total_open_cases: 0,
      urgent_cases: 0,
      new_cases: 0,
      in_progress_cases: 0,
    };
    bucket.total_open_cases += 1;
    if (String(row.priority || "").trim().toLowerCase() === "urgent") bucket.urgent_cases += 1;
    const status = String(row.status || "").trim().toLowerCase();
    if (status === "new") bucket.new_cases += 1;
    if (status === "in_progress" || status === "progress") bucket.in_progress_cases += 1;
    map.set(key, bucket);
  });
  return Array.from(map.values()).sort((a, b) => b.total_open_cases - a.total_open_cases).slice(0, 10);
}

async function getCommandCenterUnassigned(limit = 10) {
  const rows = await getCommandCenterRows(300);
  return rows.filter((row) => {
    const assigned = String(row.assigned_to || "").trim();
    let status = String(row.status || "").trim().toLowerCase();
    if (status === "progress") status = "in_progress";
    return !assigned && ["new", "in_progress"].includes(status);
  }).slice(0, limit);
}

async function getCommandCenterSystemHealth() {
  const recentAlerts = await getCommandCenterAlerts();
  const autoAssignEnabled = typeof processAutoAssign === "function";
  return {
    stream_ready: true,
    alert_engine_ready: recentAlerts.length >= 0,
    auto_assign_ready: autoAssignEnabled,
    team_group_ready: Boolean(getEffectiveTeamGroupId()),
    status_text: autoAssignEnabled ? "ระบบพร้อมสั่งการและติดตามสด" : "ระบบพร้อมติดตามสด แต่ Auto Assign ยังไม่ active"
  };
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


app.get("/api/command-center/command-queue", checkDashboardAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "8", 10), 20);
    const data = await getCommandCenterCommandQueue(limit);
    res.json({ ok: true, data });
  } catch (error) {
    console.error("COMMAND CENTER QUEUE ERROR:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/command-center/workload", checkDashboardAuth, async (req, res) => {
  try {
    const data = await getCommandCenterWorkload();
    res.json({ ok: true, data });
  } catch (error) {
    console.error("COMMAND CENTER WORKLOAD ERROR:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/command-center/unassigned", checkDashboardAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "10", 10), 30);
    const data = await getCommandCenterUnassigned(limit);
    res.json({ ok: true, data });
  } catch (error) {
    console.error("COMMAND CENTER UNASSIGNED ERROR:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/command-center/system-health", checkDashboardAuth, async (req, res) => {
  try {
    const data = await getCommandCenterSystemHealth();
    res.json({ ok: true, data });
  } catch (error) {
    console.error("COMMAND CENTER SYSTEM HEALTH ERROR:", error);
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

app.post("/api/auth/web-login", async (req, res) => {
  try {
    const { userId, displayName, pictureUrl } = req.body || {};

    if (!userId) {
      return res.status(400).json({ ok: false, error: "userId is required" });
    }

    let role = "viewer";

    try {
      const { data: roleRow } = await supabase
        .from("line_user_roles")
        .select("role")
        .eq("line_user_id", userId)
        .eq("is_active", true)
        .maybeSingle();

      if (roleRow?.role) {
        role = roleRow.role;
      }
    } catch (err) {
      console.warn("web-login role lookup failed:", err.message);
    }

    const sessionId = createWebSession({
      userId,
      displayName,
      pictureUrl,
      role
    });

    setSessionCookie(res, sessionId);

    return res.json({
      ok: true,
      user: {
        userId,
        displayName: displayName || "",
        pictureUrl: pictureUrl || "",
        role
      }
    });
  } catch (err) {
    console.error("web-login failed:", err);
    return res.status(500).json({ ok: false, error: "web login failed" });
  }
});

app.get("/api/auth/me", async (req, res) => {
  try {
    const session = getSessionFromRequest(req);

    if (!session) {
      return res.status(401).json({ ok: false, error: "no active session" });
    }

    return res.json({
      ok: true,
      user: {
        userId: session.userId,
        displayName: session.displayName,
        pictureUrl: session.pictureUrl,
        role: session.role
      }
    });
  } catch (err) {
    console.error("auth me failed:", err);
    return res.status(500).json({ ok: false, error: "auth me failed" });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    const cookies = parseCookies(req);
    const sessionId = cookies.kck_session || "";

    destroyWebSession(sessionId);
    clearSessionCookie(res);

    return res.json({ ok: true });
  } catch (err) {
    console.error("logout failed:", err);
    return res.status(500).json({ ok: false, error: "logout failed" });
  }
});

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

app.post("/api/team-management/approve", checkDashboardAuth, async (req, res) => {
  try {
    const lineUserId = String(req.body?.line_user_id || "").trim();

    if (!lineUserId) {
      return res.status(400).json({
        ok: false,
        error: "line_user_id is required"
      });
    }

    const { data, error } = await supabase
      .from("team_candidates")
      .update({
        status: "approved",
        last_seen_at: new Date().toISOString()
      })
      .eq("line_user_id", lineUserId)
      .select()
      .maybeSingle();

    if (error) throw error;

    return res.json({
      ok: true,
      item: data || null
    });
  } catch (err) {
    console.error("POST /api/team-management/approve error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "approve failed"
    });
  }
});

app.post("/api/team-management/toggle-active", checkDashboardAuth, async (req, res) => {
  try {
    const lineUserId = String(req.body?.line_user_id || "").trim();
    const nextActive = req.body?.is_active;

    if (!lineUserId) {
      return res.status(400).json({
        ok: false,
        error: "line_user_id is required"
      });
    }

    if (typeof nextActive !== "boolean") {
      return res.status(400).json({
        ok: false,
        error: "is_active must be boolean"
      });
    }

    const { data: existing, error: findError } = await supabase
      .from("line_user_roles")
      .select("line_user_id, role, is_active")
      .eq("line_user_id", lineUserId)
      .maybeSingle();

    if (findError) {
      console.error("toggle-active findError:", findError);
      return res.status(500).json({
        ok: false,
        error: findError.message
      });
    }

    if (!existing) {
      return res.status(404).json({
        ok: false,
        error: "ไม่พบผู้ใช้งานในระบบทีม"
      });
    }

    // กันพังระดับองค์กร: ต้องเหลือ admin ที่ active อย่างน้อย 1 คน
    if (existing.role === "admin" && nextActive === false) {
      const { count: activeAdminCount, error: countError } = await supabase
        .from("line_user_roles")
        .select("*", { count: "exact", head: true })
        .eq("role", "admin")
        .eq("is_active", true);

      if (countError) {
        console.error("toggle-active countError:", countError);
        return res.status(500).json({
          ok: false,
          error: countError.message
        });
      }

      if ((activeAdminCount || 0) <= 1) {
        return res.status(400).json({
          ok: false,
          error: "ไม่สามารถปิดใช้งานแอดมินคนสุดท้ายได้"
        });
      }
    }

    const { data, error } = await supabase
      .from("line_user_roles")
      .update({
        is_active: nextActive
      })
      .eq("line_user_id", lineUserId)
      .select("line_user_id, role, is_active")
      .single();

    if (error) {
      console.error("toggle-active updateError:", error);
      return res.status(500).json({
        ok: false,
        error: error.message
      });
    }

    return res.json({
      ok: true,
      message: nextActive ? "เปิดใช้งานสำเร็จ" : "ปิดใช้งานสำเร็จ",
      user: data
    });
  } catch (err) {
    console.error("toggle-active unexpected:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "toggle active failed"
    });
  }
});


app.post("/api/team-management/reject", checkDashboardAuth, async (req, res) => {
  try {
    const lineUserId = String(req.body?.line_user_id || "").trim();

    if (!lineUserId) {
      return res.status(400).json({
        ok: false,
        error: "line_user_id is required"
      });
    }

    const { data, error } = await supabase
      .from("team_candidates")
      .update({
        status: "rejected",
        last_seen_at: new Date().toISOString()
      })
      .eq("line_user_id", lineUserId)
      .select()
      .maybeSingle();

    if (error) throw error;

    return res.json({
      ok: true,
      item: data || null
    });
  } catch (err) {
    console.error("POST /api/team-management/reject error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "reject failed"
    });
  }
});

app.post("/api/team-management/set-role", checkDashboardAuth, async (req, res) => {
  try {
    const lineUserId = String(req.body?.line_user_id || "").trim();
    const role = String(req.body?.role || "").trim().toLowerCase();

    if (!lineUserId) {
      return res.status(400).json({
        ok: false,
        error: "line_user_id is required"
      });
    }

    if (!["admin", "staff", "viewer"].includes(role)) {
      return res.status(400).json({
        ok: false,
        error: "invalid role"
      });
    }

    const { data, error } = await supabase
      .from("line_user_roles")
      .upsert(
        {
          line_user_id: lineUserId,
          role,
          is_active: true
        },
        { onConflict: "line_user_id" }
      )
      .select()
      .maybeSingle();

    if (error) throw error;

    return res.json({
      ok: true,
      item: data || null
    });
  } catch (err) {
    console.error("POST /api/team-management/set-role error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "set role failed"
    });
  }
});


app.get("/api/team-management/list", checkDashboardAuth, async (req, res) => {
  try {
    const search = String(req.query.search || "").trim().toLowerCase();
    const applicationStatus = String(req.query.application_status || "").trim().toLowerCase();
    const roleFilter = String(req.query.role || "").trim().toLowerCase();
    const activeFilter = String(req.query.is_active || "").trim().toLowerCase();

    // STEP 1B = อ่านข้อมูลก่อน ยังไม่แก้ไขข้อมูลใด ๆ
    const [candidateResult, roleResult] = await Promise.all([
      supabase
        .from("team_candidates")
        .select(`
          id,
          line_user_id,
          display_name,
          picture_url,
          source,
          status,
          joined_group_id,
          note,
          last_seen_at,
          created_at
        `)
        .order("created_at", { ascending: false }),

      supabase
        .from("line_user_roles")
        .select(`
          line_user_id,
          role,
          is_active
        `)
    ]);

    if (candidateResult.error) throw candidateResult.error;
    if (roleResult.error) throw roleResult.error;

    const candidateRows = Array.isArray(candidateResult.data) ? candidateResult.data : [];
    const roleRows = Array.isArray(roleResult.data) ? roleResult.data : [];

    const roleMap = new Map(
      roleRows.map((row) => [
        String(row.line_user_id || "").trim(),
        {
          role: String(row.role || "").trim().toLowerCase() || "none",
          is_active: row.is_active === true
        }
      ])
    );

   const candidateMap = new Map(
  candidateRows.map((row) => [
    String(row.line_user_id || "").trim(),
    row
  ])
);

const allUserIds = Array.from(
  new Set([
    ...candidateRows.map((row) => String(row.line_user_id || "").trim()).filter(Boolean),
    ...roleRows.map((row) => String(row.line_user_id || "").trim()).filter(Boolean)
  ])
);

const merged = allUserIds.map((lineUserId) => {
  const row = candidateMap.get(lineUserId) || null;
  const roleInfo = roleMap.get(lineUserId) || null;

  return {
    id: row?.id || null,
    line_user_id: lineUserId,
    display_name: row?.display_name || "",
    picture_url: row?.picture_url || "",
    source: row?.source || "role_only",
    joined_group_id: row?.joined_group_id || "",
    note: row?.note || "",
    created_at: row?.created_at || null,
    last_seen_at: row?.last_seen_at || null,

    // สำหรับหน้า team-management.html
    applied_at: row?.created_at || row?.last_seen_at || null,
    application_status: String(row?.status || "approved").trim().toLowerCase(),
    role: roleInfo?.role || "none",
    is_active: roleInfo?.is_active === true
  };
});

    let rows = merged;

    if (search) {
      rows = rows.filter((row) => {
        return [
          row.display_name,
          row.line_user_id,
          row.source,
          row.joined_group_id,
          row.note
        ]
          .map((value) => String(value || "").toLowerCase())
          .some((value) => value.includes(search));
      });
    }

    if (applicationStatus) {
      rows = rows.filter(
        (row) => String(row.application_status || "").toLowerCase() === applicationStatus
      );
    }

    if (roleFilter) {
      if (roleFilter === "none") {
        rows = rows.filter((row) => !row.role || row.role === "none");
      } else {
        rows = rows.filter(
          (row) => String(row.role || "").toLowerCase() === roleFilter
        );
      }
    }

    if (activeFilter) {
      const expected = activeFilter === "true";
      rows = rows.filter((row) => !!row.is_active === expected);
    }

    // sort: pending ก่อน แล้วค่อยล่าสุดไปเก่าสุด
    rows.sort((a, b) => {
      const aPending = a.application_status === "pending" ? 0 : 1;
      const bPending = b.application_status === "pending" ? 0 : 1;
      if (aPending !== bPending) return aPending - bPending;

      const aTime = new Date(a.applied_at || 0).getTime();
      const bTime = new Date(b.applied_at || 0).getTime();
      return bTime - aTime;
    });

    const summary = {
      pending: rows.filter((r) => r.application_status === "pending").length,
      approved: rows.filter((r) => r.application_status === "approved").length,
      rejected: rows.filter((r) => r.application_status === "rejected").length,
      active: rows.filter((r) => r.is_active === true).length,
      admin: rows.filter((r) => r.role === "admin").length,
      staff: rows.filter((r) => r.role === "staff").length,
      viewer: rows.filter((r) => r.role === "viewer").length
    };

    return res.json({
      ok: true,
      items: rows,
      summary
    });
  } catch (err) {
    console.error("GET /api/team-management/list error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "team management list failed"
    });
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

    try {
      if (updatedCase) {
        await createGoldenAlertFromCaseRow(updatedCase, {
          source_type: "team_case_assigned",
          source_id: updatedCase.id || updatedCase.case_code,
          notify: false
        });
      }
    } catch (alertErr) {
      console.warn("TEAM ASSIGN ALERT WARNING:", alertErr?.message || alertErr);
    }

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

   if (PRESENTATION_MODE) {
  console.log("📣 PRESENTATION MODE (assign)");

  await pushTeamNotification(
    buildTeamWorkspaceAutoText("assign", updatedCase || payload, actorName)
  );
} else {
  await pushTeamNotification(
    buildTeamWorkspaceAutoText("assign", updatedCase || payload, actorName)
  );
}
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
    const now = new Date().toISOString();

    const payload = {
      status: nextStatus,
      last_action_at: now,
      last_action_by: actorName,
    };

    if (nextStatus === "done") {
      payload.closed_at = now;
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

    try {
      if (updatedCase) {
        await createGoldenAlertFromCaseRow(updatedCase, {
          source_type: "team_case_status_updated",
          source_id: updatedCase.id || updatedCase.case_code,
          notify: false
        });
      }
    } catch (alertErr) {
      console.warn("TEAM STATUS ALERT WARNING:", alertErr?.message || alertErr);
    }

    // ✅ งานหลักต้องสำเร็จก่อน
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

    // ✅ งานรอง: แจ้งเตือน LINE แต่ห้ามทำให้ route ล้ม
    const notifyAction = nextStatus === "done" ? "done" : "progress";

    let teamNotifyOk = false;
    let requesterNotifyOk = false;
    const notifyWarnings = [];

  if (PRESENTATION_MODE) {
  await sendPresentationNotify({
    replyToken: req.body?.replyToken || "",
    fallbackText:
      "📣 มีการอัปเดตเคส\n" +
      `เลขเคส: ${caseCode || "-"}\n` +
      `สถานะ: ${nextStatus || "-"}\n` +
      `โดย: ${actorName || "ทีมงาน"}`
  });
} else {
  try {
    await pushTeamNotification(
      buildTeamWorkspaceAutoText(
        notifyAction,
        updatedCase || { case_code: caseCode, status: nextStatus },
        actorName
      )
    );
    teamNotifyOk = true;
  } catch (notifyErr) {
    console.warn("TEAM STATUS NOTIFY WARNING:", notifyErr?.message || notifyErr);
    notifyWarnings.push({
      target: "team",
      message: notifyErr?.message || String(notifyErr),
    });
  }

  if (updatedCase?.line_user_id) {
    try {
      await pushLineTextSafe(
        updatedCase.line_user_id,
        buildRequesterAutoText(
          notifyAction,
          updatedCase || { case_code: caseCode },
          actorName
        )
      );
      requesterNotifyOk = true;
    } catch (requesterErr) {
      console.warn("REQUESTER STATUS NOTIFY WARNING:", requesterErr?.message || requesterErr);
      notifyWarnings.push({
        target: "requester",
        message: requesterErr?.message || String(requesterErr),
      });
    }
  }
}
    // ✅ ถึง LINE push จะ fail ก็ยังตอบสำเร็จ
    return res.json({
      ok: true,
      message: "status updated",
      case: updatedCase,
      auto_notify: {
        team: teamNotifyOk,
        requester: requesterNotifyOk,
      },
      warnings: notifyWarnings,
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
// =========================
// DEBUG TEAM GROUP
// =========================

app.get("/debug/team-group", async (req, res) => {
  try {
    const effectiveGroupId = getEffectiveTeamGroupId();

    return res.json({
      ok: true,
      hasChannelAccessToken: !!CHANNEL_ACCESS_TOKEN,
      effectiveTeamGroupIdMasked: maskGroupId(effectiveGroupId),
      source: {
        EFFECTIVE_TEAM_GROUP_ID: !!process.env.EFFECTIVE_TEAM_GROUP_ID,
        TEAM_GROUP_ID: !!process.env.TEAM_GROUP_ID,
        LINE_GROUP_ID: !!process.env.LINE_GROUP_ID
      }
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error)
    });
  }
});

app.get("/debug/push-team-test", async (req, res) => {
  try {
    const now = new Date().toLocaleString("th-TH", {
      timeZone: "Asia/Bangkok"
    });

    const result = await safePushToTeamGroup(
      [
        {
          type: "text",
          text: `✅ TEST PUSH ถึงกลุ่มทีมงาน\nเวลา: ${now}`
        }
      ],
      "debug-push-team-test"
    );

    return res.json({
      ok: true,
      result
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error)
    });
  }
});
app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Server started on port " + PORT);
});
