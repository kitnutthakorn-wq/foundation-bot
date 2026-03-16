require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.CHANNEL_SECRET || "";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TEAM_GROUP_ID = process.env.TEAM_GROUP_ID || "";

if (!CHANNEL_ACCESS_TOKEN) {
  console.error("❌ Missing CHANNEL_ACCESS_TOKEN in environment variables");
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_KEY in environment variables");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));

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
  res.status(200).send("server version: case-management-v1");
});

app.get("/webhook", (req, res) => {
  res.status(200).send("Webhook endpoint is ready ✅");
});

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

async function safeReply(replyToken, messages, fallbackMessages = null) {
  try {
    await callLineReplyApi(replyToken, messages);
  } catch (error) {
    console.error("Primary reply failed:", error.message);

    if (fallbackMessages) {
      try {
        await callLineReplyApi(replyToken, fallbackMessages);
      } catch (fallbackError) {
        console.error("Fallback reply failed:", fallbackError.message);
        throw fallbackError;
      }
    } else {
      throw error;
    }
  }
}

async function pushTeamNotification(text) {
  if (!TEAM_GROUP_ID) {
    console.warn("⚠️ TEAM_GROUP_ID is not set yet, skipping team notification");
    return;
  }

  await callLinePushApi(TEAM_GROUP_ID, [{ type: "text", text }]);
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

const mainMenuText = {
  type: "text",
  text:
    "เมนูหลักพร้อมใช้งานครับ 🙏\n\n" +
    "สำหรับผู้ใช้งานทั่วไป:\n" +
    "- บริจาค\n" +
    "- ขอความช่วยเหลือ\n" +
    "- เกี่ยวกับมูลนิธิ\n\n" +
    "สำหรับทีมงาน:\n" +
    "- ดูเคสใหม่\n" +
    "- ดูเคสด่วน\n" +
    "- เคสวันนี้\n" +
    "- รับเคส CASE-YYYYMMDD-0001\n" +
    "- ปิดเคส CASE-YYYYMMDD-0001\n" +
    "- เปลี่ยนสถานะ CASE-YYYYMMDD-0001 in_progress",
};

function getDateKey() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

async function generateCaseCode() {
  const dateKey = getDateKey();
  const prefix = `CASE-${dateKey}-`;

  const { data, error } = await supabase
    .from("help_requests")
    .select("case_code")
    .ilike("case_code", `${prefix}%`)
    .order("case_code", { ascending: false })
    .limit(1);

  if (error) {
    console.error("GENERATE CASE CODE ERROR:", error);
    throw error;
  }

  let nextNumber = 1;

  if (data && data.length > 0 && data[0].case_code) {
    const lastCode = data[0].case_code;
    const lastSeq = parseInt(lastCode.split("-")[2], 10);
    if (!Number.isNaN(lastSeq)) {
      nextNumber = lastSeq + 1;
    }
  }

  return `${prefix}${String(nextNumber).padStart(4, "0")}`;
}

async function saveHelpRequest(userId, text) {
  const full_name = text.match(/ชื่อ:\s*(.*)/)?.[1]?.trim() || "";
  const location = text.match(/พื้นที่:\s*(.*)/)?.[1]?.trim() || "";
  const problem = text.match(/รายละเอียด:\s*(.*)/)?.[1]?.trim() || "";
  const phone = text.match(/เบอร์:\s*(.*)/)?.[1]?.trim() || "";

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

  console.log("SAVE HELP REQUEST:", {
    case_code,
    line_user_id: userId || "",
    full_name,
    location,
    problem,
    phone,
    status: "new",
    priority,
  });

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

  console.log("SUPABASE INSERT OK:", data);
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
  return data;
}

async function closeCase(caseCode, staffName = "ทีมงาน") {
  const { data, error } = await supabase
    .from("help_requests")
    .update({
      status: "done",
      assigned_to: staffName,
      closed_at: new Date().toISOString(),
    })
    .eq("case_code", caseCode)
    .select()
    .single();

  if (error) throw error;
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
  }

  const { data, error } = await supabase
    .from("help_requests")
    .update(payload)
    .eq("case_code", caseCode)
    .select()
    .single();

  if (error) throw error;
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

app.get("/test-team-notify", async (req, res) => {
  try {
    if (!TEAM_GROUP_ID) {
      return res.status(400).send("TEAM_GROUP_ID is not set yet");
    }

    await pushTeamNotification("🔔 ทดสอบแจ้งเตือนทีมงานจากระบบมูลนิธิ สำเร็จแล้ว");
    return res.status(200).send("OK: team notification sent");
  } catch (error) {
    console.error("TEST TEAM NOTIFY ERROR:", error);
    return res.status(500).send("ERROR: " + error.message);
  }
});

app.post("/webhook", async (req, res) => {
  try {
    if (!verifySignature(req)) {
      console.error("❌ Invalid LINE signature");
      return res.status(401).send("Invalid signature");
    }

    console.log("=== WEBHOOK IN ===");
    console.log(JSON.stringify(req.body, null, 2));

    const events = req.body.events || [];

    for (const event of events) {
      console.log("EVENT =", JSON.stringify(event, null, 2));

      if (event.source && event.source.type === "group") {
        console.log("GROUP ID =", event.source.groupId);
      }

      if (event.type !== "message") continue;
      if (!event.message || event.message.type !== "text") continue;

      const replyToken = event.replyToken;
      const text = event.message.text.trim();

      console.log("User text:", text);

      if (text === "ดูเคสใหม่") {
        try {
          const cases = await getNewCases(10);

          if (!cases.length) {
            await safeReply(replyToken, [
              { type: "text", text: "ตอนนี้ยังไม่มีเคสใหม่ครับ" },
            ]);
            continue;
          }

          const msg =
            "📋 เคสใหม่ล่าสุด\n\n" +
            cases.map((item, index) => `${index + 1}.\n${formatCaseLine(item)}`).join("\n\n");

          await safeReply(replyToken, [{ type: "text", text: msg.slice(0, 4900) }]);
        } catch (err) {
          console.error("GET NEW CASES ERROR:", err);
          await safeReply(replyToken, [
            { type: "text", text: "ดึงเคสใหม่ไม่สำเร็จครับ" },
          ]);
        }
        continue;
      }

      if (text === "ดูเคสด่วน") {
        try {
          const cases = await getUrgentCases(10);

          if (!cases.length) {
            await safeReply(replyToken, [
              { type: "text", text: "ตอนนี้ยังไม่มีเคสด่วนครับ" },
            ]);
            continue;
          }

          const msg =
            "🚨 เคสด่วน\n\n" +
            cases.map((item, index) => `${index + 1}.\n${formatCaseLine(item)}`).join("\n\n");

          await safeReply(replyToken, [{ type: "text", text: msg.slice(0, 4900) }]);
        } catch (err) {
          console.error("GET URGENT CASES ERROR:", err);
          await safeReply(replyToken, [
            { type: "text", text: "ดึงเคสด่วนไม่สำเร็จครับ" },
          ]);
        }
        continue;
      }

      if (text === "เคสวันนี้") {
        try {
          const cases = await getTodayCases(20);

          if (!cases.length) {
            await safeReply(replyToken, [
              { type: "text", text: "วันนี้ยังไม่มีเคสเข้าระบบครับ" },
            ]);
            continue;
          }

          const msg =
            "🗓️ เคสวันนี้\n\n" +
            cases.map((item, index) => `${index + 1}.\n${formatCaseLine(item)}`).join("\n\n");

          await safeReply(replyToken, [{ type: "text", text: msg.slice(0, 4900) }]);
        } catch (err) {
          console.error("GET TODAY CASES ERROR:", err);
          await safeReply(replyToken, [
            { type: "text", text: "ดึงเคสวันนี้ไม่สำเร็จครับ" },
          ]);
        }
        continue;
      }

      if (text.startsWith("รับเคส ")) {
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
          await safeReply(replyToken, [
            { type: "text", text: "รับเคสไม่สำเร็จ กรุณาตรวจเลขเคสอีกครั้ง" },
          ]);
        }
        continue;
      }

      if (text.startsWith("ปิดเคส ")) {
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
          await safeReply(replyToken, [
            { type: "text", text: "ปิดเคสไม่สำเร็จ กรุณาตรวจเลขเคสอีกครั้ง" },
          ]);
        }
        continue;
      }

      if (text.startsWith("เปลี่ยนสถานะ ")) {
        try {
          const parts = text.split(" ");
          if (parts.length < 3) {
            await safeReply(replyToken, [
              {
                type: "text",
                text: "รูปแบบคำสั่ง: เปลี่ยนสถานะ CASE-YYYYMMDD-0001 in_progress",
              },
            ]);
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

      if (
        text.includes("ชื่อ:") &&
        text.includes("พื้นที่:") &&
        text.includes("รายละเอียด:") &&
        text.includes("เบอร์:")
      ) {
        try {
          const insertedCase = await saveHelpRequest(event.source?.userId, text);

          await safeReply(replyToken, [
            {
              type: "text",
              text:
                "ทีมงานได้รับข้อมูลแล้วครับ 🙏\n" +
                `เลขเคสของคุณคือ ${insertedCase.case_code}\n` +
                "เราจะตรวจสอบและติดต่อกลับโดยเร็วที่สุด",
            },
          ]);

          const notifyText =
            "🔔 มีเคสใหม่เข้าระบบ\n\n" +
            `เลขเคส: ${insertedCase.case_code || "-"}\n` +
            `ชื่อ: ${insertedCase.full_name || "-"}\n` +
            `โทร: ${insertedCase.phone || "-"}\n` +
            `พื้นที่: ${insertedCase.location || "-"}\n` +
            `รายละเอียด: ${insertedCase.problem || "-"}\n` +
            `สถานะ: ${insertedCase.status || "new"}\n` +
            `ระดับ: ${insertedCase.priority || "normal"}`;

          try {
            await pushTeamNotification(notifyText);

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

          await safeReply(replyToken, [
            {
              type: "text",
              text: "บันทึกข้อมูลไม่สำเร็จครับ กรุณาลองใหม่อีกครั้ง",
            },
          ]);
        }
        continue;
      }

      if (["บริจาค", "ซากาต", "ช่วยเหลือ", "ดูโครงการ"].includes(text)) {
        await safeReply(replyToken, [donationFlex], donationFallbackText);
        continue;
      }

      if (text === "กลับสู่เมนูหลัก") {
        await safeReply(replyToken, [mainMenuText]);
        continue;
      }

      if (text === "ติดต่อเจ้าหน้าที่") {
        await safeReply(replyToken, [
          {
            type: "text",
            text:
              "หากต้องการติดต่อเจ้าหน้าที่ กรุณาส่งข้อมูลดังนี้ครับ 🙏\n" +
              "- ชื่อ\n" +
              "- เบอร์โทร\n" +
              "- รายละเอียดที่ต้องการติดต่อ",
          },
        ]);
        continue;
      }

      if (text === "ขอความช่วยเหลือ") {
        await safeReply(replyToken, [
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
            "พิมพ์คำว่า 'บริจาค' เพื่อดูการ์ดโครงการช่วยเหลือแบบเลื่อนดูได้ ❤️\n" +
            "หรือพิมพ์ 'ขอความช่วยเหลือ' เพื่อส่งข้อมูลเคสครับ\n\n" +
            "ทีมงานสามารถใช้คำสั่ง:\n" +
            "- ดูเคสใหม่\n" +
            "- ดูเคสด่วน\n" +
            "- เคสวันนี้",
        },
      ]);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("WEBHOOK ERROR:", err);
    return res.sendStatus(200);
  }
});

app.listen(PORT, () => {
  console.log("✅ Server started on port " + PORT);
});