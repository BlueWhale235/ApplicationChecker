import type { LocalPageSnapshot, ScriptRuleApplication } from "@application-checker/contracts";
import { LOCAL_AUTO_APPLY_THRESHOLD, recognizeLocalPage } from "@application-checker/local-status";
import type { AttentionDetection } from "./detection.js";

function isMokahrUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === "mokahr.com" || hostname.endsWith(".mokahr.com");
  } catch {
    return false;
  }
}

/**
 * MokaHR status pages sometimes contain dormant authentication controls. Only
 * soft, in-page signals may be deferred until local recognition has inspected
 * the captured status page; explicit auth routes and real challenges stay hard.
 */
export function isSoftMokahrLoginDetection(detection: AttentionDetection, url: string): boolean {
  if (!detection.requiresLogin || !isMokahrUrl(url)) return false;
  const hardSignals = new Set([
    "login_url",
    "captcha_widget",
    "challenge_text",
    "http_401",
    "http_403",
    "http_429",
  ]);
  return !detection.signals.some((signal) => hardSignals.has(signal));
}

export function effectiveLoginRequired(
  detection: AttentionDetection,
  snapshot: LocalPageSnapshot | null,
  applications: Pick<ScriptRuleApplication, "id" | "jobTitle">[],
): boolean {
  if (!detection.requiresLogin) return false;
  if (!snapshot || !isSoftMokahrLoginDetection(detection, snapshot.url)) return true;

  const recognition = recognizeLocalPage(snapshot, applications);
  return !(recognition.adapterId === "mokahr"
    && recognition.results.some((result) => result.matched && result.confidence >= LOCAL_AUTO_APPLY_THRESHOLD));
}
