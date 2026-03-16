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

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

if (!CHANNEL_ACCESS_TOKEN) {
  console.error("Missing CHANNEL_ACCESS_TOKEN");
  process.exit(1);
}

/* ---------------------------
   BODY PARSER
----------------------------*/

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use(express.urlencoded({ extended: true }));

/* ---------------------------
   ROUTES
----------------------------*/

app.get("/", (req, res) => {
  res.send("Foundation Bot Running 🚀");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "foundation-line-bot",
    time: new Date().toISOString(),
  });
});

app.get("/webhook", (req, res) => {
  res.send("Webhook ready");
});

/* ---------------------------
   VERIFY SIGNATURE
----------------------------*/

function verifySignature(req) {
  if (!CHANNEL_SECRET) return true;

  const signature = req.get("x-line-signature");

  if (!signature || !req.rawBody) return false;

  const hash = crypto
    .createHmac("SHA256", CHANNEL_SECRET)
    .update(req.rawBody)
    .digest("base64");

  return hash === signature;
}

/* ---------------------------
   LINE API
----------------------------*/

async function callLineReplyApi(replyToken, messages) {
  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages,
    }),
  });

  const text = await response.text();

  console.log("LINE status:", response.status);
  console.log("LINE body:", text);

  if (!response.ok) {
    throw new Error(text);
  }
}

async function safeReply(replyToken, messages, fallback = null) {
  try {
    await callLineReplyApi(replyToken, messages);
  } catch (err) {
    console.error("Primary reply failed:", err);

    if (fallback) {
      await callLineReplyApi(replyToken, fallback);
    }
  }
}

/* ---------------------------
   FLEX CARD
----------------------------*/

function createProjectBubble(title, subtitle, image, url) {
  return {
    type: "bubble",
    hero: {
      type: "image",
      url: image,
      size: "full",
      aspectRatio: "1:1",
      aspectMode: "cover",
      action: {
        type: "uri",
        uri: url,
      },
    },
    body: {
      type: "box",
      layout: "vertical",
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
      contents: [
        {
          type: "button",
          style: "primary",
          action: {
            type: "uri",
            label: "ดูโครงการ",
            uri: url,
          },
        },
      ],
    },
  };
}

const donationFlex = {
  type: "flex",
  altText: "โครงการช่วยเหลือ",
  contents: {
    type: "carousel",
    contents: [
      createProjectBubble(
        "ซากาตเพื่อผู้ยากไร้",
        "ร่วมช่วยเหลือผู้ขาดแคลน",
        "https://img5.pic.in.th/file/secure-sv1/KCK142b3df0c343ae11c.png",
        "https://preeminent-otter-b3610c.netlify.app/projects.html?case=zakat"
      ),
      createProjectBubble(
        "การศึกษา",
        "สนับสนุนเด็กด้อยโอกาส",
        "https://img5.pic.in.th/file/secure-sv1/KCK2.png",
        "https://preeminent-otter-b3610c.netlify.app/projects.html?case=education"
      ),
      createProjectBubble(
        "ภัยพิบัติ",
        "ช่วยเหลือผู้ประสบภัย",
        "https://img5.pic.in.th/file/secure-sv1/KCK4.png",
        "https://preeminent-otter-b3610c.netlify.app/projects.html?case=disaster"
      ),
    ],
  },
};

const donationFallback = [
  {
    type: "text",
    text:
      "ดูโครงการช่วยเหลือได้ที่\nhttps://preeminent-otter-b3610c.netlify.app/projects.html",
  },
];

/* ---------------------------
   SAVE HELP REQUEST
----------------------------*/

async function saveHelpRequest(userId, text) {
  const name = text.match(/ชื่อ:(.*)/)?.[1]?.trim() || "";
  const location = text.match(/พื้นที่:(.*)/)?.[1]?.trim() || "";
  const problem = text.match(/รายละเอียด:(.*)/)?.[1]?.trim() || "";
  const phone = text.match(/เบอร์:(.*)/)?.[1]?.trim() || "";

  const { error } = await supabase.from("help_requests").insert([
    {
      line_user_id: userId,
      name,
      location,
      problem,
      phone,
    },
  ]);

  if (error) {
    console.log("SUPABASE ERROR:", error);
  }
}

/* ---------------------------
   WEBHOOK
----------------------------*/

app.post("/webhook", async (req, res) => {
  try {
    if (!verifySignature(req)) {
      return res.status(401).send("Invalid signature");
    }

    const events = req.body.events || [];

    for (const event of events) {
      if (event.type !== "message") continue;
      if (event.message.type !== "text") continue;

      const text = event.message.text.trim();
      const replyToken = event.replyToken;

      console.log("USER:", text);

      if (text === "บริจาค") {
        await safeReply(replyToken, [donationFlex], donationFallback);
        continue;
      }

      if (text === "ขอความช่วยเหลือ") {
        await safeReply(replyToken, [
          {
            type: "text",
            text:
              "กรุณาส่งข้อมูลดังนี้\n\nชื่อ:\nพื้นที่:\nรายละเอียด:\nเบอร์:",
          },
        ]);
        continue;
      }

      if (text.includes("ชื่อ:") && text.includes("พื้นที่:")) {
        await saveHelpRequest(event.source.userId, text);

        await safeReply(replyToken, [
          {
            type: "text",
            text:
              "ทีมงานได้รับข้อมูลแล้วครับ 🙏\nเราจะตรวจสอบและติดต่อกลับโดยเร็วที่สุด",
          },
        ]);

        continue;
      }

      await safeReply(replyToken, [
        {
          type: "text",
          text:
            "พิมพ์ 'บริจาค' เพื่อดูโครงการ\nหรือพิมพ์ 'ขอความช่วยเหลือ'",
        },
      ]);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(200);
  }
});

/* ---------------------------
   START SERVER
----------------------------*/

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});