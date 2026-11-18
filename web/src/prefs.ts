/**
 * UI preferences for the web client: theme (light default / dark) and arrow-cursor
 * visibility (site overlay only). Persisted in localStorage; theme is applied
 * pre-paint by an inline script in index.html.
 */

const THEME_KEY = "remotex.theme";
const ARROW_KEY = "remotex.hideArrow";

export type Theme = "light" | "dark";

export function readTheme(): Theme {
  try { return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light"; } catch { return "light"; }
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelectorAll<HTMLElement>("[data-theme-btn]").forEach((btn) => {
    btn.classList.toggle("isOn", btn.dataset.themeBtn === theme);
  });
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#000000" : "#ffffff");
}

export function readHideArrow(): boolean {
  try { return localStorage.getItem(ARROW_KEY) === "1"; } catch { return false; }
}

export function applyHideArrow(hidden: boolean) {
  document.documentElement.classList.toggle("hide-arrow", hidden);
  const sw = document.getElementById("arrowSwitch");
  if (sw) sw.setAttribute("aria-checked", String(!hidden)); // switch ON = arrow VISIBLE
}

/** Wire the gear button, the settings dialog, and the right-edge controls handle. Call once on boot. */
export function initPrefs() {
  applyTheme(readTheme());
  applyHideArrow(readHideArrow());

  const settingsBtn = document.getElementById("settingsBtn");
  const overlay = document.getElementById("settingsOverlay");
  const closeBtn = document.getElementById("settingsClose");
  const arrowSwitch = document.getElementById("arrowSwitch");

  const openDialog = () => {
    if (!overlay) return;
    overlay.hidden = false;
    overlay.classList.remove("closing");
    closeBtn?.focus();
  };
  const closeDialog = () => {
    if (!overlay) return;
    overlay.classList.add("closing");
    window.setTimeout(() => {
      overlay.hidden = true;
      overlay.classList.remove("closing");
    }, 200);
  };

  settingsBtn?.addEventListener("click", openDialog);
  closeBtn?.addEventListener("click", closeDialog);
  overlay?.addEventListener("click", (e) => { if (e.target === overlay) closeDialog(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (overlay && !overlay.hidden) closeDialog();
      document.body.classList.remove("menu-open");
    }
  });

  document.querySelectorAll<HTMLElement>("[data-theme-btn]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next: Theme = btn.dataset.themeBtn === "dark" ? "dark" : "light";
      try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
      applyTheme(next);
    });
  });

  arrowSwitch?.addEventListener("click", () => {
    const next = !readHideArrow();
    try { localStorage.setItem(ARROW_KEY, next ? "1" : "0"); } catch { /* private mode */ }
    applyHideArrow(next);
  });

  /* right-edge handle toggles the floating controls menu */
  const handle = document.getElementById("edgeHandle");
  handle?.addEventListener("click", () => {
    const open = document.body.classList.toggle("menu-open");
    handle.setAttribute("aria-pressed", String(open));
  });
  /* tap anywhere outside the menu closes it (capture phase so it wins over the screen handler) */
  document.addEventListener("pointerdown", (e) => {
    if (!document.body.classList.contains("menu-open")) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.closest(".rail") || t.closest("#edgeHandle"))) return;
    e.preventDefault();
    e.stopPropagation();
    document.body.classList.remove("menu-open");
    handle?.setAttribute("aria-pressed", "false");
  }, true);
}
