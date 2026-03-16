require("dotenv").config();

const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.CHANNEL_SECRET || "";

if (!CHANNEL_ACCESS_TOKEN) {
  console.error("Missing CHANNEL_ACCESS_TOKEN in environment variables");
  process.exit(1);
}

/**
 * เก็บ raw body ไว้สำหรับ verify ลายเซ็น LINE
 */
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

app.get("/webhook", (req, res) => {
  res.status(200).send("Webhook endpoint is ready ✅");
});

/**
 * ตรวจลายเซ็นจาก LINE
 * ถ้าไม่มี CHANNEL_SECRET จะข้ามการตรวจ
 */
function verifySignature(req) {
  if (!CHANNEL_SECRET) {
    console.warn("CHANNEL_SECRET not set, skipping signature verification");
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

/**
 * เรียก LINE Reply API
 */
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

  const resultText = await response.text();

  console.log("LINE reply status:", response.status);
  console.log("LINE reply body:", resultText);

  if (!response.ok) {
    throw new Error(`LINE reply failed: ${response.status} ${resultText}`);
  }

  return resultText;
}

/**
 * reply แบบปลอดภัย
 * ถ้า Flex พัง จะ fallback เป็น text
 */
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

/**
 * สร้าง bubble card
 */
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

/**
 * Flex Carousel 7 โครงการ
 */
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
        "มัสยิด",
        "ร่วมสร้างศาสนสถานเพื่อชุมชน",
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
        "มูลนิธิ",
        "สนับสนุนภารกิจช่วยเหลือสังคม",
        "https://img5.pic.in.th/file/secure-sv1/KCK7.png",
        "https://preeminent-otter-b3610c.netlify.app/projects.html?case=foundation"
      ),
    ],
  },
};

/**
 * fallback กรณี Flex ไม่ผ่าน
 */
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

/**
 * เมนูหลัก
 */
const mainMenuText = {
  type: "text",
  text:
    "เมนูหลักพร้อมใช้งานครับ 🙏\n\n" +
    "พิมพ์คำสั่งได้เลย เช่น\n" +
    "- บริจาค\n" +
    "- ดูโครงการ\n" +
    "- ติดต่อเจ้าหน้าที่\n" +
    "- ขอความช่วยเหลือ\n" +
    "- เกี่ยวกับมูลนิธิ",
};

app.post("/webhook", async (req, res) => {
  try {
    if (!verifySignature(req)) {
      console.error("Invalid LINE signature");
      return res.status(401).send("Invalid signature");
    }

    console.log("=== WEBHOOK IN ===");
    console.log(JSON.stringify(req.body, null, 2));

    const events = req.body.events || [];

    for (const event of events) {
      if (event.type !== "message") continue;
      if (!event.message || event.message.type !== "text") continue;

      const replyToken = event.replyToken;
      const text = event.message.text.trim();

      console.log("User text:", text);

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
              "- ชื่อผู้ขอความช่วยเหลือ\n" +
              "- พื้นที่ที่อยู่\n" +
              "- รายละเอียดปัญหา\n" +
              "- เบอร์ติดต่อกลับ",
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
            "พิมพ์คำว่า 'บริจาค' เพื่อดูการ์ดโครงการช่วยเหลือแบบเลื่อนดูได้ ❤️",
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
  console.log("Server started on port " + PORT);
});