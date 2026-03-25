// ===== APPLY THAI UI (SAFE PATCH) =====
(function () {
  if (!window.UI_TH) return;

  // ===== MENU BUTTONS =====
  const btnMap = {
    dashboardBtn: UI_TH.menu.dashboard,
    commandCenterBtn: UI_TH.menu.commandCenter
  };

  function applyButtonLabels() {
    Object.keys(btnMap).forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = btnMap[id];
    });
  }

  // ===== STATUS BADGE PATCH =====
  window.statusBadge = function (status) {
    const key = status || "unknown";
    const label = UI_TH.status[key] || key;
    const cls = ["new", "in_progress", "done", "cancelled"].includes(key) ? key : "unknown";
    return `<span class="badge status-${cls}">${label}</span>`;
  };

  // ===== PRIORITY BADGE PATCH =====
  window.priorityBadge = function (priority) {
    const key = priority || "normal";
    const label = UI_TH.priority[key] || key;
    const cls = key === "urgent" ? "urgent" : "normal";
    return `<span class="badge priority-${cls}">${label}</span>`;
  };

  // ===== STATIC TEXT MAP =====
  const map = {
    "Command Center": "ศูนย์ควบคุม",
    "Executive Control System": "ระบบควบคุมระดับผู้บริหาร",
    "Crisis Panel": "ศูนย์เฝ้าระวัง",
    "Live Activity": "กิจกรรมล่าสุด",
    "Command Table": "ตารางสั่งการ",
    "Quick Command": "คำสั่งด่วน",
    "Shortcut": "ทางลัด",
    "Dashboard": "แดชบอร์ด",
    "Executive Report": "รายงานผู้บริหาร",
    "Case Board": "กระดานเคส",
    "Mark ด่วน": "ทำเครื่องหมายด่วน",
    "Mark Urgent": "ทำเครื่องหมายด่วน"
  };

  function replaceTextInElement(el) {
    if (!el) return;

    if (el.childNodes && el.childNodes.length) {
      el.childNodes.forEach(node => {
        if (node.nodeType === Node.TEXT_NODE) {
          let text = node.textContent || "";
          Object.keys(map).forEach(key => {
            if (text.includes(key)) {
              text = text.replaceAll(key, map[key]);
            }
          });
          node.textContent = text;
        }
      });
    }

    if (el instanceof HTMLElement && el.value) {
      let value = el.value;
      Object.keys(map).forEach(key => {
        if (value.includes(key)) {
          value = value.replaceAll(key, map[key]);
        }
      });
      el.value = value;
    }
  }

  function translateStaticText() {
    document.querySelectorAll("h1, h2, h3, button, div, span, option, label, th, td").forEach(el => {
      replaceTextInElement(el);
    });
  }

  function rerenderIfNeeded() {
    if (typeof refreshAll === "function") {
      refreshAll();
    } else if (typeof loadList === "function") {
      loadList();
    }
  }

  function applyThaiAll() {
    applyButtonLabels();
    translateStaticText();
  }

  // run หลัก
  setTimeout(() => {
    rerenderIfNeeded();
  }, 100);

  setTimeout(() => {
    applyThaiAll();
  }, 300);
})();
