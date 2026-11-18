/**
 * UI preferences for the web client: theme (light default / dark), arrow-cursor
 * visibility (site overlay only), and the remote-screen chrome (rail) hide toggle.
 * Persisted in localStorage; theme is applied pre-paint by an inline script in index.html.
 */

const THEME_KEY = "remotex.theme";
const ARROW_KEY = "remotex.hideArrow";
const CHROME_KEY = "remotex.chromeHidden";

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
  if (meta) meta.setAttribute("content", theme === "dark" ? "#0f1115" : "#ffffff");
}

export function readHideArrow(): boolean {
  try { return localStorage.getItem(ARROW_KEY) === "1"; } catch { return false; }
}

export function applyHideArrow(hidden: boolean) {
  document.documentElement.classList.toggle("hide-arrow", hidden);
  const sw = document.getElementById("arrowSwitch");
  if (sw) sw.setAttribute("aria-checked", String(!hidden)); // switch ON = arrow VISIBLE
}

export function readChromeHidden(): boolean {
  try { return localStorage.getItem(CHROME_KEY) === "1"; } catch { return false; }
}

export function applyChromeHidden(hidden: boolean) {
  document.body.classList.toggle("chrome-hidden", hidden);
  const btn = document.getElementById("chromeBtn");
  if (btn) {
    btn.setAttribute("aria-pressed", String(hidden));
    btn.setAttribute("title", hidden ? "Show the bar" : "Hide the bar");
    btn.setAttribute("aria-label", hidden ? "Show the bar" : "Hide the bar");
  }
}

/** Wire the settings dialog + rail toggles. Call once on boot. */
export function initPrefs() {
  const theme = readTheme();
  applyTheme(theme);
  applyHideArrow(readHideArrow());
  applyChromeHidden(readChromeHidden());

  const settingsBtn = document.getElementById("settingsBtn");
  const overlay = document.getElementById("settingsOverlay");
  const dialog = document.getElementById("settingsDialog");
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
    if (e.key === "Escape" && overlay && !overlay.hidden) closeDialog();
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

  document.getElementById("chromeBtn")?.addEventListener("click", () => {
    const next = !readChromeHidden();
    try { localStorage.setItem(CHROME_KEY, next ? "1" : "0"); } catch { /* private mode */ }
    applyChromeHidden(next);
  });
}
