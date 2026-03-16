require("dotenv").config();

const express = require("express");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;

if (!CHANNEL_ACCESS_TOKEN) {
  console.error("Missing CHANNEL_ACCESS_TOKEN in .env");
  process.exit(1);
}

app.use(express.json());

app.get("/", (req, res) => {
  res.status(200).send("Foundation Bot Running 🚀");
});

async function replyMessage(replyToken, messages) {
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
}

const projectCarousel = {
  type: "template",
  altText: "โครงการช่วยเหลือของมูลนิธิ",
  template: {
    type: "image_carousel",
    columns: [
      {
        imageUrl: "https://img5.pic.in.th/file/secure-sv1/KCK142b3df0c343ae11c.png",
        action: {
          type: "uri",
          label: "ดูโครงการ",
          uri: "https://preeminent-otter-b3610c.netlify.app/projects.html?case=zakat"
        }
      },
      {
        imageUrl: "https://img5.pic.in.th/file/secure-sv1/KCK2.png",
        action: {
          type: "uri",
          label: "ดูโครงการ",
          uri: "https://preeminent-otter-b3610c.netlify.app/projects.html?case=education"
        }
      },
      {
        imageUrl: "https://img5.pic.in.th/file/secure-sv1/KCK3.png",
        action: {
          type: "uri",
          label: "ดูโครงการ",
          uri: "https://preeminent-otter-b3610c.netlify.app/projects.html?case=housing"
        }
      },
      {
        imageUrl: "https://img5.pic.in.th/file/secure-sv1/KCK4.png",
        action: {
          type: "uri",
          label: "ดูโครงการ",
          uri: "https://preeminent-otter-b3610c.netlify.app/projects.html?case=disaster"
        }
      },
      {
        imageUrl: "https://img2.pic.in.th/KCK54af3446f47283561.png",
        action: {
          type: "uri",
          label: "ดูโครงการ",
          uri: "https://preeminent-otter-b3610c.netlify.app/projects.html?case=masjid"
        }
      },
      {
        imageUrl: "https://img5.pic.in.th/file/secure-sv1/KCK6.png",
        action: {
          type: "uri",
          label: "ดูโครงการ",
          uri: "https://preeminent-otter-b3610c.netlify.app/projects.html?case=orphan"
        }
      },
      {
        imageUrl: "https://img5.pic.in.th/file/secure-sv1/KCK7.png",
        action: {
          type: "uri",
          label: "ดูโครงการ",
          uri: "https://preeminent-otter-b3610c.netlify.app/projects.html?case=foundation"
        }
      },
      {
        imageUrl: "https://img5.pic.in.th/file/secure-sv1/KCK8.png",
        action: {
          type: "message",
          label: "กลับเมนูหลัก",
          text: "กลับสู่เมนูหลัก"
        }
      }
    ]
  }
};

app.post("/webhook", async (req, res) => {
  try {
    console.log("=== WEBHOOK IN ===");
    console.log(JSON.stringify(req.body, null, 2));

    const events = req.body.events || [];

    for (const event of events) {
      if (event.type !== "message") continue;
      if (!event.message || event.message.type !== "text") continue;

      const text = event.message.text.trim();
      console.log("User text:", text);

      if (["บริจาค", "ซากาต", "ช่วยเหลือ", "ดูโครงการ"].includes(text)) {
        await replyMessage(event.replyToken, [projectCarousel]);
        continue;
      }

      if (text === "กลับสู่เมนูหลัก") {
        await replyMessage(event.replyToken, [
          {
            type: "text",
            text: "เมนูหลักพร้อมใช้งานครับ 🙏\nพิมพ์:\n- บริจาค\n- ดูโครงการ\n- ติดต่อเจ้าหน้าที่\n- ขอความช่วยเหลือ\n- เกี่ยวกับมูลนิธิ"
          }
        ]);
        continue;
      }

      if (text === "ติดต่อเจ้าหน้าที่") {
        await replyMessage(event.replyToken, [
          {
            type: "text",
            text: "หากต้องการติดต่อเจ้าหน้าที่ กรุณาส่งชื่อ เบอร์โทร และรายละเอียดที่ต้องการติดต่อเข้ามาได้เลยครับ 🙏"
          }
        ]);
        continue;
      }

      if (text === "ขอความช่วยเหลือ") {
        await replyMessage(event.replyToken, [
          {
            type: "text",
            text: "กรุณาส่งข้อมูลดังนี้\n- ชื่อผู้ขอความช่วยเหลือ\n- พื้นที่ที่อยู่\n- รายละเอียดปัญหา\n- เบอร์ติดต่อกลับ"
          }
        ]);
        continue;
      }

      if (text === "เกี่ยวกับมูลนิธิ") {
        await replyMessage(event.replyToken, [
          {
            type: "text",
            text: "มูลนิธิของเราดำเนินงานเพื่อช่วยเหลือผู้ยากไร้ สนับสนุนเคสเร่งด่วน และสร้างโอกาสให้ผู้ขาดแคลนในสังคม ❤️"
          }
        ]);
        continue;
      }

      await replyMessage(event.replyToken, [
        {
          type: "text",
          text: "พิมพ์คำว่า 'บริจาค' เพื่อดูโครงการช่วยเหลือแบบเลื่อนดูได้ ❤️"
        }
      ]);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("WEBHOOK ERROR:", err);
    res.sendStatus(200);
  }
});

app.listen(PORT, () => {
  console.log("Server started on port " + PORT);
});
