/**
 * UI preferences for the web client: theme (light default / dark) and arrow-cursor
 * visibility (site overlay only). Theme is applied pre-paint by an inline script in
 * index.html and persisted in localStorage. The rail expands/collapses locally.
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

/** Wire the settings dialog, the rail tab (click + drag-outward to collapse), and outside-tap close. */
export function initPrefs() {
  applyTheme(readTheme());
  applyHideArrow(readHideArrow());

  const gearBtn = document.getElementById("settingsRailBtn");
  const overlay = document.getElementById("settingsOverlay");
  const closeBtn = document.getElementById("settingsClose");
  const arrowSwitch = document.getElementById("arrowSwitch");
  const foldTab = document.getElementById("foldTab");

  const openDialog = () => {
    if (!overlay) return;
    overlay.hidden = false;
    overlay.classList.remove("closing");
    closeBtn?.focus();
  };
  const closeDialog = () => {
    if (!overlay) return;
    if (document.activeElement && (document.activeElement as HTMLElement).blur) (document.activeElement as HTMLElement).blur();
    overlay.classList.add("closing");
    window.setTimeout(() => {
      overlay.hidden = true;
      overlay.classList.remove("closing");
    }, 200);
  };

  gearBtn?.addEventListener("click", openDialog);
  closeBtn?.addEventListener("click", closeDialog);
  overlay?.addEventListener("click", (e) => { if (e.target === overlay) closeDialog(); });

  const setMenuOpen = (open: boolean) => {
    document.body.classList.toggle("menu-open", open);
    foldTab?.setAttribute("aria-pressed", String(open));
  };

  /* fold tab: click toggles; drag outward (away from the screen) collapses */
  let dragStartX: number | null = null;
  let dragMoved = 0;
  foldTab?.addEventListener("pointerdown", (e) => {
    dragStartX = e.clientX;
    dragMoved = 0;
    try { foldTab.setPointerCapture(e.pointerId); } catch { /* old browsers */ }
    e.preventDefault();
  });
  foldTab?.addEventListener("pointermove", (e) => {
    if (dragStartX === null) return;
    dragMoved = e.clientX - dragStartX;
    if (dragMoved > 34) { // pulled outward — collapse
      setMenuOpen(false);
      dragStartX = null;
    }
  });
  const endDrag = (e: PointerEvent) => {
    if (dragStartX === null) return;
    const moved = Math.abs((e.clientX ?? 0) - dragStartX);
    dragStartX = null;
    if (moved < 8) setMenuOpen(!document.body.classList.contains("menu-open")); // treat as a tap
  };
  foldTab?.addEventListener("pointerup", endDrag);
  foldTab?.addEventListener("pointercancel", () => { dragStartX = null; });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (overlay && !overlay.hidden) closeDialog();
      setMenuOpen(false);
    }
  });

  /* tap outside the rail collapses it (capture phase wins over the video handlers) */
  document.addEventListener("pointerdown", (e) => {
    if (!document.body.classList.contains("menu-open")) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.closest(".rail") || t.closest("#settingsOverlay"))) return;
    e.preventDefault();
    e.stopPropagation();
    setMenuOpen(false);
  }, true);

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
}
