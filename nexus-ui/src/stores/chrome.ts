// ChromeStore: route, theme, and which chrome overlay is open (one at a
// time), plus the ops->alert-drawer handoff payload. Route change closes
// chrome overlays (the hierarchy's death rule).
import { React } from "../sdk";

export function useHashRoute(): string {
  const [hash, setHash] = React.useState(() =>
    typeof location !== "undefined" ? location.hash : "",
  );
  React.useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

export type Theme = "light" | "dark";

export function resolveTheme(): Theme {
  try {
    const stored = localStorage.getItem("nx-theme");
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // storage unavailable - fall through
  }
  return "dark"; // stored choice else dark; deliberately no system-pref mode
}

export type ChromeOverlay = "menu" | "ops" | null;

export interface ChromeStore {
  route: string;
  theme: Theme;
  toggleTheme: () => void;
  overlay: ChromeOverlay;
  setOverlay: (o: ChromeOverlay) => void;
  opsAlert: string | null;
  handoffAlert: (fingerprint: string | null) => void;
}

export function useChromeStore(): ChromeStore {
  const route = useHashRoute();
  const [theme, setTheme] = React.useState<Theme>(resolveTheme);
  const [overlay, setOverlay] = React.useState<ChromeOverlay>(null);
  const [opsAlert, setOpsAlert] = React.useState<string | null>(null);
  React.useEffect(() => setOverlay(null), [route]);
  const toggleTheme = React.useCallback(() => {
    setTheme((t) => {
      const next: Theme = t === "dark" ? "light" : "dark";
      try {
        localStorage.setItem("nx-theme", next);
      } catch {
        // preference simply doesn't persist
      }
      return next;
    });
  }, []);
  return { route, theme, toggleTheme, overlay, setOverlay, opsAlert, handoffAlert: setOpsAlert };
}
