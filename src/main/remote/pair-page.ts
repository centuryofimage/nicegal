/** The only page an unpaired browser can load. Plain form post, no script. */
export function pairPage(options: { deviceName: string; error?: string }): string {
  const error = options.error
    ? `<p class="error" role="alert">${escapeHtml(options.error)}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Connect to Nicegal</title>
<style>
  :root { --bg: #f0f0f0; --panel: #fff; --text: #1a1a1a; --muted: #5c5c5c; --border: #adadad;
    --accent: #0067c0; --accent-text: #fff; --error: #c42b1c; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #202020; --panel: #2b2b2b; --text: #f3f3f3; --muted: #a8a8a8;
      --border: #5c5c5c; --accent: #4cc2ff; --accent-text: #000; --error: #ff99a4; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 16px; background: var(--bg); color: var(--text);
    font: 15px/1.4 "Segoe UI", system-ui, -apple-system, sans-serif; }
  form { width: 100%; max-width: 340px; background: var(--panel); border: 1px solid var(--border);
    border-radius: 4px; padding: 16px; display: grid; gap: 10px; }
  h1 { font-size: 18px; font-weight: 600; margin: 0; }
  p { margin: 0; color: var(--muted); }
  label { display: grid; gap: 3px; font-size: 13px; }
  input { font: inherit; padding: 7px 8px; border: 1px solid var(--border); border-radius: 3px;
    background: var(--bg); color: var(--text); width: 100%; }
  input[name=code] { font-size: 24px; letter-spacing: 6px; text-align: center; }
  button { font: inherit; padding: 8px; border: 0; border-radius: 3px; background: var(--accent);
    color: var(--accent-text); font-weight: 600; }
  .error { color: var(--error); }
</style>
</head>
<body>
<form method="post" action="/pair">
  <h1>Connect to Nicegal</h1>
  <p>On your PC, open Settings, then Remote access, and select Pair a device.</p>
  ${error}
  <label>Pairing code
    <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}"
      maxlength="6" required autofocus>
  </label>
  <label>Name for this device
    <input name="name" maxlength="60" value="${escapeHtml(options.deviceName)}" required>
  </label>
  <button type="submit">Connect</button>
</form>
</body>
</html>`;
}

/** The browser's everyday name. iOS browsers all run WebKit but say which app they are. */
export function guessBrowser(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  if (/Edg(A|iOS)?\//.test(ua)) return "Edge";
  if (/SamsungBrowser\//.test(ua)) return "Samsung Internet";
  if (/OPR\/|Opera/.test(ua)) return "Opera";
  if (/Firefox\/|FxiOS\//.test(ua)) return "Firefox";
  if (/Chrome\/|CriOS\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return "Browser";
}

/** A readable default name, e.g. "iPhone" or "Android phone", from the browser's user agent. */
export function guessDeviceName(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android phone" : "Android tablet";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Linux/.test(ua)) return "Linux PC";
  return "Browser";
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
}
