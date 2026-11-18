/**
 * Connect screen â€” Device ID + Password + Connect. Nothing else.
 * Device ID is remembered (it never changes). Password is never persisted.
 */
const ROOM_KEY = "remotex.roomId.v2"; // v2: format changed (6 digits) â€” old entries are ignored

export class ConnectController {
  private form = document.getElementById("connectForm") as HTMLFormElement;
  private roomId = document.getElementById("roomId") as HTMLInputElement;
  private password = document.getElementById("password") as HTMLInputElement;
  private connectBtn = document.getElementById("connectBtn") as HTMLButtonElement;
  private label = this.connectBtn.querySelector(".connectLabel") as HTMLSpanElement;
  private root = document.getElementById("connectScreen") as HTMLDivElement;

  constructor(private onConnect: (roomId: string, password: string) => void) {
    this.roomId.title = "6-digit Device ID shown in the RemoteX window";
    this.password.title = "6-letter password shown in the RemoteX window";
    // the Device ID is remembered (it never changes) â€” but only if it matches the
    // CURRENT 6-digit format; a stale value from before the format change is discarded
    try {
      const saved = localStorage.getItem(ROOM_KEY);
      if (saved && /^\d{6}$/.test(saved)) this.roomId.value = saved;
      else localStorage.removeItem(ROOM_KEY);
    } catch { /* private mode */ }
    this.roomId.addEventListener("input", () => {
      this.roomId.value = this.roomId.value.replace(/\D/g, "").slice(0, 6);
      this.syncButton();
    });
    // passwords are 12 CAPITAL letters â€” force the keyboard into caps + strip everything else
    this.password.addEventListener("input", () => {
      this.password.value = this.password.value.toUpperCase().replace(/[^A-Z]/g, "");
      this.syncButton();
    });
    this.syncButton();
    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      const roomId = this.roomId.value.trim();
      const password = this.password.value.trim().toUpperCase();
      if (!roomId || !password) return;
      try { localStorage.setItem(ROOM_KEY, roomId); } catch { /* private mode */ }
      this.onConnect(roomId, password);
    });
  }

  show() { this.root.hidden = false; }
  hide() { this.root.hidden = true; }

  /** busy = connecting; button label turns into "Connectingâ€¦" and a spinner joins it */
  setBusy(busy: boolean) {
    this.connectBtn.disabled = busy || !this.roomId.value.trim() || !this.password.value.trim();
    this.connectBtn.classList.toggle("is-busy", busy);
    this.label.textContent = busy ? "Connectingâ€¦" : "Connect";
    this.roomId.disabled = busy;
    this.password.disabled = busy;
  }

  /** back to idle (after a failure) */
  reset() {
    this.setBusy(false);
    this.password.value = "";
    this.syncButton();
  }

  private syncButton = () => {
    // strict: exactly 6 digits + exactly 6 CAPS letters â€” anything else stays disabled
    this.connectBtn.disabled = !/^\d{6}$/.test(this.roomId.value.trim()) || !/^[A-Z]{6}$/.test(this.password.value.trim());
  };
}

