import { createRemoteBridge } from "./remote-bridge";

// The desktop preload defines `window.nicegal` before any script runs. Without it this page was
// opened in a browser over remote access. Imported first by main.ts, so no other module sees
// the bridge missing.
if (!window.nicegal) {
  window.nicegal = createRemoteBridge();
  addHomeScreenTags();
}

/** Lets a phone add Nicegal to its home screen as an app of its own. The desktop window has no use
 * for these, so only remote pages get them. */
function addHomeScreenTags(): void {
  const add = (tag: "link" | "meta", attributes: Record<string, string>): void => {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    document.head.append(element);
  };
  add("link", { rel: "manifest", href: "/manifest.webmanifest" });
  add("link", { rel: "apple-touch-icon", href: "/app-icon.png" });
  add("meta", { name: "apple-mobile-web-app-title", content: "Nicegal" });
  add("meta", { name: "mobile-web-app-capable", content: "yes" });
  add("meta", { name: "theme-color", content: "#f0f1f2" });
}
