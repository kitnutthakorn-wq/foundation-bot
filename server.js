require("dotenv").config();

const express = require("express");
const line = require("@line/bot-sdk");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

const {
  CHANNEL_ACCESS_TOKEN,
  CHANNEL_SECRET,
  DATABASE_URL
} = process.env;

if (!CHANNEL_ACCESS_TOKEN || !CHANNEL_SECRET) {
  console.error("❌ Missing LINE credentials");
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error("❌ Missing DATABASE_URL");
  process.exit(1);
}

/* -----------------------------
   LINE CONFIG
----------------------------- */

const lineConfig = {
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
  channelSecret: CHANNEL_SECRET
};

const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: CHANNEL_ACCESS_TOKEN
});

/* -----------------------------
   DATABASE
----------------------------- */

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

/* -----------------------------
   DATABASE TEST
----------------------------- */

async function initDatabase() {
  try {
    const result = await pool.query("SELECT NOW()");
    console.log("✅ Database connected:", result.rows[0].now);
  } catch (err) {
    console.error("❌ Database connection failed:", err.message);
  }
}

/* -----------------------------
   MIDDLEWARE
----------------------------- */

app.use(express.json());

/* -----------------------------
   HEALTH CHECK
----------------------------- */

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "foundation-line-bot"
  });
});

app.get("/", (req, res) => {
  res.send("Foundation LINE Bot running");
});

/* -----------------------------
   LINE WEBHOOK
----------------------------- */

app.post("/webhook", line.middleware(lineConfig), async (req, res) => {
  try {
    const events = req.body.events || [];

    await Promise.all(events.map(handleEvent));

    res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).end();
  }
});

/* -----------------------------
   HANDLE EVENT
----------------------------- */

async function handleEvent(event) {

  if (event.type !== "message") return;

  if (event.message.type !== "text") return;

  const text = event.message.text.trim();

  const replyToken = event.replyToken;

  if (text === "เมนู") {

    return reply(replyToken, `เมนูระบบมูลนิธิ

ขอความช่วยเหลือ
บริจาค

คำสั่งทีมงาน
ดูเคสใหม่
เคสด่วน
เคสวันนี้`);
  }

  if (text === "ดูเคสใหม่") {
    return reply(replyToken, "ระบบดูเคสใหม่กำลังพัฒนา");
  }

  if (text === "เคสด่วน") {
    return reply(replyToken, "ระบบเคสด่วนกำลังพัฒนา");
  }

  if (text === "เคสวันนี้") {
    return reply(replyToken, "ระบบเคสวันนี้กำลังพัฒนา");
  }

  return reply(replyToken, "พิมพ์ เมนู เพื่อดูคำสั่ง");
}

/* -----------------------------
   REPLY
----------------------------- */

async function reply(token, text) {

  try {

    await lineClient.replyMessage({
      replyToken: token,
      messages: [
        {
          type: "text",
          text
        }
      ]
    });

  } catch (err) {

    console.error("Reply error:", err);

  }
}

/* -----------------------------
   START SERVER
----------------------------- */

app.listen(PORT, () => {

  console.log("🚀 Server started");
  console.log("PORT:", PORT);

  initDatabase();

});