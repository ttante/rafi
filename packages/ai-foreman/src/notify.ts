import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

function isWSL(): boolean {
  try {
    return readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

/** Strip characters that break notification string literals. */
function safe(s: string): string {
  return s.replace(/["\\\n\r]/g, " ").slice(0, 120);
}

function xmlEsc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Fire a non-interactive desktop notification. Always best-effort — if the
 * platform tool is unavailable the error is silently swallowed.
 *
 * macOS  : osascript (built-in)
 * Linux  : notify-send (libnotify)
 * WSL    : powershell.exe Windows toast (no extra install required)
 */
export function fireNotification(title: string, body: string): void {
  try {
    if (process.platform === "darwin") {
      spawnSync(
        "osascript",
        ["-e", `display notification "${safe(body)}" with title "${safe(title)}"`],
        { timeout: 3000 },
      );
    } else if (isWSL()) {
      const xml = `<toast><visual><binding template="ToastGeneric"><text>${xmlEsc(title)}</text><text>${xmlEsc(body)}</text></binding></visual></toast>`;
      const ps = `$d=New-Object Windows.Data.Xml.Dom.XmlDocument;$d.LoadXml(${JSON.stringify(xml)});$t=New-Object Windows.UI.Notifications.ToastNotification($d);[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Foreman').Show($t)`;
      spawnSync("powershell.exe", ["-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps], {
        timeout: 5000,
      });
    } else if (process.platform === "linux") {
      spawnSync("notify-send", [title, body], { timeout: 3000 });
    }
  } catch {
    // best-effort — never crash the run
  }
}
