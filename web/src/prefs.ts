/**
 * Remote chrome: the top-right pull-tab toggles the icon tray; tapping outside
 * or pressing Escape collapses it. No settings UI — minimal by design.
 */

export function initPrefs() {
  const foldTab = document.getElementById("foldTab");

  const setOpen = (open: boolean) => {
    document.body.classList.toggle("menu-open", open);
    foldTab?.setAttribute("aria-pressed", String(open));
  };

  foldTab?.addEventListener("click", () => {
    setOpen(!document.body.classList.contains("menu-open"));
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setOpen(false);
  });

  /* tap anywhere outside the tab/tray collapses the tray */
  document.addEventListener("pointerdown", (e) => {
    if (!document.body.classList.contains("menu-open")) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.closest(".tray") || t.closest(".foldTab"))) return;
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
  }, true);
}
