/**
 * Kill cache + Regenerate menu + Version control Flex
 * Golden-safe patch
 *
 * ใช้แนวคิด versioned flex เพื่อลดโอกาส LINE ใช้ message cache เก่า
 * และบังคับให้ทุกปุ่มของเมนูทีมงานเปิด LIFF เวอร์ชันล่าสุด
 */

/* =========================
   VERSION CONTROL
========================= */
const TEAM_MENU_VERSION = process.env.TEAM_MENU_VERSION || "v1";

/* =========================
   LIFF URL
========================= */
function getTeamLiffUrl() {
  if (process.env.TEAM_LIFF_URL) {
    return String(process.env.TEAM_LIFF_URL).trim();
  }

  if (process.env.TEAM_LIFF_ID) {
    return `https://liff.line.me/${String(process.env.TEAM_LIFF_ID).trim()}`;
  }

  return "https://liff.line.me/2009446483-VtE4rtgZ";
}

function getVersionedTeamLiffUrl() {
  const baseUrl = getTeamLiffUrl();
  const joiner = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${joiner}v=${encodeURIComponent(TEAM_MENU_VERSION)}`;
}

/* =========================
   TEAM MENU FLEX
========================= */
function buildTeamMenuFlex() {
  const teamLiffUrl = getVersionedTeamLiffUrl();
  const invisibleNonce = `${TEAM_MENU_VERSION}-${Date.now()}`;

  return {
    type: "flex",
    altText: `เมนูทีมงาน (${TEAM_MENU_VERSION})`,
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
            action: {
              type: "uri",
              label: "เปิดศูนย์ปฏิบัติการ",
              uri: teamLiffUrl
            },
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
              },
              {
                type: "text",
                text: invisibleNonce,
                size: "xxs",
                color: "#FFFFFF",
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
              buildVersionedMenuCard("ดูเคสใหม่", "รายการเคสที่เพิ่งเข้าระบบล่าสุด", "#0B7C86", "#E9F8FA"),
              buildVersionedMenuCard("เคสด่วน", "ตรวจสอบเคสเร่งด่วนที่ต้องรีบดำเนินการ", "#C56608", "#FFF7ED"),
              buildVersionedMenuCard("ค้นหาเคส", "ค้นหาด้วยเลขเคสหรือเบอร์โทร", "#163C72", "#F8FAFC"),
              buildVersionedMenuCard("เคสวันนี้", "สรุปรายการเคสที่เข้ามาในวันนี้", "#1F8F4D", "#F0FDF4")
            ]
          },
          {
            type: "button",
            style: "primary",
            height: "sm",
            color: "#0B7C86",
            action: {
              type: "uri",
              label: "เปิดศูนย์ปฏิบัติการ",
              uri: teamLiffUrl
            }
          },
          {
            type: "box",
            layout: "horizontal",
            spacing: "md",
            contents: [
              {
                type: "button",
                style: "secondary",
                color: "#FFFFFF",
                action: {
                  type: "uri",
                  label: "เคสด่วนเต็มจอ",
                  uri: teamLiffUrl
                }
              },
              {
                type: "button",
                style: "secondary",
                color: "#FFFFFF",
                action: {
                  type: "uri",
                  label: "ค้นหาเต็มจอ",
                  uri: teamLiffUrl
                }
              }
            ]
          },
          {
            type: "text",
            text: `ver: ${TEAM_MENU_VERSION}`,
            size: "xs",
            color: "#5F7285",
            align: "center"
          },
          {
            type: "text",
            text: "แนะนำให้ทีมกดการ์ดนี้ในแอปไลน์ เพื่อใช้งาน LIFF แบบไม่เด้งหน้า login",
            size: "xs",
            color: "#5F7285",
            wrap: true,
            align: "center"
          }
        ]
      }
    }
  };
}

function buildVersionedMenuCard(title, subtitle, accentColor, bgColor) {
  const teamLiffUrl = getVersionedTeamLiffUrl();

  return {
    type: "box",
    layout: "vertical",
    backgroundColor: bgColor,
    borderColor: accentColor,
    borderWidth: "2px",
    cornerRadius: "18px",
    paddingAll: "14px",
    action: {
      type: "uri",
      label: title,
      uri: teamLiffUrl
    },
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
            color: accentColor,
            weight: "bold",
            size: "lg",
            flex: 1
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
        color: "#5F7285",
        size: "sm",
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
            backgroundColor: accentColor,
            cornerRadius: "999px",
            contents: []
          },
          {
            type: "box",
            layout: "vertical",
            width: "14px",
            height: "5px",
            backgroundColor: "#B9D4D9",
            cornerRadius: "999px",
            contents: []
          },
          {
            type: "box",
            layout: "vertical",
            width: "10px",
            height: "5px",
            backgroundColor: "#D7E7EA",
            cornerRadius: "999px",
            contents: []
          }
        ]
      }
    ]
  };
}

/* =========================
   REGENERATE MENU
========================= */
async function sendFreshTeamMenu(replyToken) {
  const flex = buildTeamMenuFlex();
  return client.replyMessage(replyToken, flex);
}

/* =========================
   WEBHOOK EXAMPLE
========================= */
/**
 * ใช้ใน message handler เดิมของคุณ
 *
 * if (text === "เมนูทีมงาน") {
 *   return sendFreshTeamMenu(event.replyToken);
 * }
 *
 * หรือถ้ามี postback/quick action ที่เรียกเมนูทีมงาน
 * ให้เปลี่ยนไปเรียก sendFreshTeamMenu(...) แทนการส่ง flex เก่า
 */
