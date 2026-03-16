require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.CHANNEL_SECRET || "";
const BASE_URL = process.env.BASE_URL || "";

if (!CHANNEL_ACCESS_TOKEN) {
  console.error("Missing CHANNEL_ACCESS_TOKEN in environment variables");
  process.exit(1);
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

function verifyLineSignature(req) {
  if (!CHANNEL_SECRET) return true; // allow deploy even if secret not set yet

  const signature = req.headers["x-line-signature"];
  if (!signature || !req.rawBody) return false;

  const digest = crypto
    .createHmac("SHA256", CHANNEL_SECRET)
    .update(req.rawBody)
    .digest("base64");

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
  } catch {
    return false;
  }
}

app.get("/", (_req, res) => {
  res.status(200).send("Foundation Bot Running 🚀");
});

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, service: "foundation-bot" });
});

app.get("/webhook", (_req, res) => {
  res.status(200).send("Webhook endpoint is ready. LINE will call this endpoint with POST.");
});

async function callLineReplyApi(replyToken, messages) {
  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });

  const text = await response.text();
  console.log("LINE reply status:", response.status);
  console.log("LINE reply body:", text);

  if (!response.ok) {
    throw new Error(`LINE reply failed: ${response.status} ${text}`);
  }
}

async function safeReply(replyToken, primaryMessages, fallbackMessages) {
  try {
    await callLineReplyApi(replyToken, primaryMessages);
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

function projectLinksMessage() {
  return {
    type: "text",
    text:
      "โครงการช่วยเหลือของมูลนิธิ\n\n" +
      "1) ซากาต\nhttps://preeminent-otter-b3610c.netlify.app/projects.html?case=zakat\n\n" +
      "2) การศึกษา\nhttps://preeminent-otter-b3610c.netlify.app/projects.html?case=education\n\n" +
      "3) ที่อยู่อาศัย\nhttps://preeminent-otter-b3610c.netlify.app/projects.html?case=housing\n\n" +
      "4) ภัยพิบัติ\nhttps://preeminent-otter-b3610c.netlify.app/projects.html?case=disaster",
    quickReply: {
      items: [
        {
          type: "action",
          action: { type: "message", label: "เมนูหลัก", text: "กลับสู่เมนูหลัก" },
        },
        {
          type: "action",
          action: { type: "message", label: "ติดต่อเจ้าหน้าที่", text: "ติดต่อเจ้าหน้าที่" },
        },
      ],
    },
  };
}

function moreProjectLinksMessage() {
  return {
    type: "text",
    text:
      "โครงการเพิ่มเติม\n\n" +
      "5) มัสยิด\nhttps://preeminent-otter-b3610c.netlify.app/projects.html?case=masjid\n\n" +
      "6) เด็กกำพร้า\nhttps://preeminent-otter-b3610c.netlify.app/projects.html?case=orphan\n\n" +
      "7) มูลนิธิ\nhttps://preeminent-otter-b3610c.netlify.app/projects.html?case=foundation",
  };
}

function mainMenuMessage() {
  return {
    type: "text",
    text:
      "เมนูหลักพร้อมใช้งานครับ 🙏\n\nเลือกพิมพ์คำสั่งได้เลย:\n- บริจาค\n- ดูโครงการ\n- ติดต่อเจ้าหน้าที่\n- ขอความช่วยเหลือ\n- เกี่ยวกับมูลนิธิ",
    quickReply: {
      items: [
        {
          type: "action",
          action: { type: "message", label: "บริจาค", text: "บริจาค" },
        },
        {
          type: "action",
          action: { type: "message", label: "ดูโครงการ", text: "ดูโครงการ" },
        },
        {
          type: "action",
          action: { type: "message", label: "ขอความช่วยเหลือ", text: "ขอความช่วยเหลือ" },
        },
      ],
    },
  };
}

function normalizeText(text) {
  return String(text || "").trim().toLowerCase();
}

app.post("/webhook", async (req, res) => {
  try {
    if (!verifyLineSignature(req)) {
      console.error("Invalid LINE signature");
      return res.sendStatus(401);
    }

    console.log("=== WEBHOOK IN ===");
    console.log(JSON.stringify(req.body, null, 2));

    const events = Array.isArray(req.body.events) ? req.body.events : [];

    for (const event of events) {
      if (event.type !== "message") continue;
      if (!event.replyToken || !event.message || event.message.type !== "text") continue;

      const text = normalizeText(event.message.text);
      console.log("User text:", text);

      if (["บริจาค", "ซากาต", "ช่วยเหลือ", "ดูโครงการ"].includes(text)) {
        await safeReply(
          event.replyToken,
          [projectLinksMessage(), moreProjectLinksMessage()],
          [{ type: "text", text: "ระบบตอบกลับได้แล้วครับ ✅ กรุณาพิมพ์ 'ดูโครงการ' อีกครั้ง" }]
        );
        continue;
      }

      if (text === "กลับสู่เมนูหลัก" || text === "เมนูหลัก") {
        await safeReply(event.replyToken, [mainMenuMessage()]);
        continue;
      }

      if (text === "ติดต่อเจ้าหน้าที่") {
        await safeReply(event.replyToken, [
          {
            type: "text",
            text: "หากต้องการติดต่อเจ้าหน้าที่ กรุณาส่งชื่อ เบอร์โทร และรายละเอียดที่ต้องการติดต่อเข้ามาได้เลยครับ 🙏",
          },
        ]);
        continue;
      }

      if (text === "ขอความช่วยเหลือ") {
        await safeReply(event.replyToken, [
          {
            type: "text",
            text: "กรุณาส่งข้อมูลดังนี้\n- ชื่อผู้ขอความช่วยเหลือ\n- พื้นที่ที่อยู่\n- รายละเอียดปัญหา\n- เบอร์ติดต่อกลับ",
          },
        ]);
        continue;
      }

      if (text === "เกี่ยวกับมูลนิธิ") {
        await safeReply(event.replyToken, [
          {
            type: "text",
            text: "มูลนิธิของเราดำเนินงานเพื่อช่วยเหลือผู้ยากไร้ สนับสนุนเคสเร่งด่วน และสร้างโอกาสให้ผู้ขาดแคลนในสังคม ❤️",
          },
        ]);
        continue;
      }

      await safeReply(event.replyToken, [
        {
          type: "text",
          text: "พิมพ์คำว่า 'บริจาค' หรือ 'ดูโครงการ' เพื่อดูโครงการช่วยเหลือครับ ❤️",
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
  console.log(`Server started on port ${PORT}`);
  if (BASE_URL) console.log(`Configured BASE_URL: ${BASE_URL}`);
});
