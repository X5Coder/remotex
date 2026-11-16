/**
 * LocalMouseWatch — Windows WH_MOUSE_LL low-level hook (Win64/Win32).
 *
 * Why this exists: on the same machine, the agent and the web page see THE SAME physical
 * mouse events through the browser; position-based heuristics can never tell "the person at
 * THIS machine touched the trackpad" from "the remote page relayed its own pointer".
 * The WH_MOUSE_LL hook receives every mouse report BEFORE any app processes it, and
 * — crucially — reports carry LLMHF_INJECTED / LLMHF_LOWER_IL_INJECTED when the event was
 * synthesized via SendInput (which is what the input injector uses). Physical USB/Bluetooth
 * mice and laptop trackpads always arrive with flags == 0.
 *
 * This module is the ONLY source of truth for "the local user is at the mouse RIGHT NOW".
 * Whenever a physical report arrives, the local desktop owns the cursor: the transparent
 * system arrow is restored instantly and immediately, exactly once per physical burst
 * (throttling is done by the consumer).
 *
 * The hook runs in a dedicated worker-thread message loop because low-level hooks are
 * dispatched to the installing thread's message queue. The worker never returns from
 * GetMessageW — it is a pure daemon.
 *
 * NOT for input injection — the hook only observes. Every event is passed to the next
 * hook via CallNextHookEx.
 */
const IS_WIN = process.platform === "win32";

export interface LocalMouseWatch {
  /** uninstalls the hook and stops the message loop */
  stop(): void;
}

export type PhysicalMouseHandler = (x: number, y: number) => void;

/* ------------------------------ worker entry ------------------------------ */

function runWatcher(onPhysical: PhysicalMouseHandler, onArmed: (ok: boolean) => void): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const koffi = require("koffi") as typeof import("koffi");

  const POINT = koffi.struct("POINT", { x: "long", y: "long" });
  const MSLLHOOKSTRUCT = koffi.struct("MSLLHOOKSTRUCT", {
    pt: POINT,
    mouseData: "uint32",
    flags: "uint32",
    time: "uint32",
    dwExtraInfo: "uintptr",
  });
  const MSG = koffi.struct("MSG", {
    hwnd: "uintptr",
    message: "uint32",
    wParam: "uintptr",
    lParam: "intptr",
    time: "uint32",
    pt: POINT,
  });
  const HookProc = koffi.proto("intptr __stdcall HookProc(int nCode, uintptr wParam, void *lParam)");

  const user32 = koffi.load("user32.dll");
  const kernel32 = koffi.load("kernel32.dll");

  const GetModuleHandleW = kernel32.func("GetModuleHandleW", "uintptr", ["str16"]);
  const SetWindowsHookExW = user32.func("SetWindowsHookExW", "uintptr", ["int32", koffi.pointer(HookProc), "uintptr", "uint32"]);
  const UnhookWindowsHookEx = user32.func("UnhookWindowsHookEx", "int32", ["uintptr"]);
  const CallNextHookEx = user32.func("CallNextHookEx", "uintptr", ["uintptr", "int32", "uintptr", "void *"]);
  const GetMessageW = user32.func("GetMessageW", "int32", ["MSG *", "uintptr", "uint32", "uint32"]);
  const TranslateMessage = user32.func("TranslateMessage", "int32", ["MSG *"]);
  const DispatchMessageW = user32.func("DispatchMessageW", "uintptr", ["MSG *"]);

  const WH_MOUSE_LL = 14;
  const LLMHF_INJECTED = 0x00000001;
  const LLMHF_LOWER_IL_INJECTED = 0x00000002;

  const MOUSE_MESSAGES = new Set([
    0x0200, // WM_MOUSEMOVE
    0x0201, 0x0202, 0x0203, // WM_LBUTTONDOWN / UP / DBLCLK
    0x0204, 0x0205, 0x0206, // WM_RBUTTONDOWN / UP / DBLCLK
    0x0207, 0x0208, 0x0209, // WM_MBUTTONDOWN / UP / DBLCLK
    0x020B, 0x020C, 0x020D, // WM_XBUTTONDOWN / UP / DBLCLK
    0x020A, 0x020E,         // WM_MOUSEWHEEL / WM_MOUSEHWHEEL
  ]);

  const moduleHandle = GetModuleHandleW("");

  let hook = 0;
  const callback = koffi.register((nCode: number, wParam: number, lParam: unknown) => {
    try {
      if (nCode === 0 /* HC_ACTION */) {
        const wp = wParam >>> 0;
        if (MOUSE_MESSAGES.has(wp) && lParam) {
          const s = koffi.decode(lParam, MSLLHOOKSTRUCT) as { pt: { x: number; y: number }; flags: number };
          const flags = Number(s.flags);
          if ((flags & (LLMHF_INJECTED | LLMHF_LOWER_IL_INJECTED)) === 0) {
            // physical report — the local person is driving
            const x = Number(s.pt?.x ?? 0), y = Number(s.pt?.y ?? 0);
            try { onPhysical(x, y); } catch { /* never throw into Windows */ }
          }
        }
      }
    } catch { /* never throw into Windows */ }
    return CallNextHookEx(hook, nCode, wParam, lParam as never);
  }, koffi.pointer(HookProc));

  hook = Number(SetWindowsHookExW(WH_MOUSE_LL, callback, moduleHandle, 0)) >>> 0;
  if (!hook) {
    koffi.unregister(callback);
    onArmed(false);
    return;
  }
  // armed — tell the parent BEFORE the message loop blocks this thread forever
  onArmed(true);

  const msg = {} as Record<string, unknown>;
  for (;;) {
    const r = GetMessageW(msg as never, 0, 0, 0);
    if (r <= 0) break; // WM_QUIT or error — leave the loop
    TranslateMessage(msg as never);
    DispatchMessageW(msg as never);
  }

  if (hook) UnhookWindowsHookEx(hook);
  koffi.unregister(callback);
}

/* ------------------------------ worker glue ------------------------------ */

if (require.main === module || process.env.REMOTEX_LOCAL_MOUSE_WATCH === "1") {
  // worker entry: post physical events to the parent until the parent dies / tells us to stop
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { parentPort } = require("worker_threads") as typeof import("worker_threads");
  parentPort?.on("message", (m: unknown) => {
    if (m === "stop") process.exit(0); // exiting the process drops the hook (it dies with the process)
  });
  runWatcher(
    (x, y) => parentPort?.postMessage({ kind: "physical", x, y }),
    (ok) => parentPort?.postMessage({ kind: "ready", info: { ok } })
  );
}

/* ------------------------------ main (electron) API ------------------------------ */

export function startLocalMouseWatch(onPhysical: PhysicalMouseHandler): LocalMouseWatch | null {
  if (!IS_WIN) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Worker } = require("worker_threads") as typeof import("worker_threads");
    const worker = new Worker(__filename, {
      env: { ...process.env, REMOTEX_LOCAL_MOUSE_WATCH: "1" },
    });
    let stopped = false;
    worker.on("message", (m: unknown) => {
      const msg = m as { kind?: string; x?: number; y?: number; info?: unknown };
      if (msg?.kind === "physical" && typeof msg.x === "number" && typeof msg.y === "number") {
        try { onPhysical(msg.x, msg.y); } catch { /* consumer must never throw */ }
      } else if (msg?.kind === "ready") {
        if (!(msg.info as { ok?: boolean } | undefined)?.ok) console.warn("[local-mouse] WH_MOUSE_LL hook could not be installed — local grab detection disabled");
        else console.log("[local-mouse] WH_MOUSE_LL hook active — physical mouse movement restores local cursor ownership");
      }
    });
    worker.on("error", (err) => console.error("[local-mouse] watch worker error:", err));
    worker.on("exit", (code) => { if (!stopped && code !== 0) console.error("[local-mouse] watch worker exited with code", code); });
    return {
      stop() {
        if (stopped) return;
        stopped = true;
        try { worker.postMessage("stop"); } catch { /* already gone */ }
        setImmediate(() => { try { void worker.terminate(); } catch { /* fine */ } });
      },
    };
  } catch (err) {
    console.error("[local-mouse] watch unavailable:", err);
    return null;
  }
}
