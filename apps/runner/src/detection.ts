export interface PageSignals {
  url: string;
  title: string;
  text: string;
  status: number | null;
  passwordFields: number;
  otpFields: number;
  captchaElements: number;
}

export interface AttentionDetection {
  score: number;
  requiresLogin: boolean;
  reason: "login_required" | "verification_required" | "robot_verification" | null;
  signals: string[];
}

const urlTerms = /(^|[./_?&=-])(sign[-_]?in|log[-_]?in|register|sign[-_]?up|auth(?:enticate|entication)?|verify|verification|captcha|challenge)(?=$|[./_?&=-])/i;
const strongText = /(登录|登入|注册|验证码|安全验证|人机验证|扫码登录|短信验证|访问受限|sign\s*in|log\s*in|verification\s+code|security\s+check|verify\s+you(?:'re| are)\s+human|unusual\s+traffic)/i;
const challengeText = /(captcha|recaptcha|hcaptcha|turnstile|cloudflare|机器人|人机|安全验证|unusual traffic|checking your browser|verify you are human)/i;

export function classifyPage(page: PageSignals): AttentionDetection {
  let score = 0;
  const signals: string[] = [];
  const parsed = new URL(page.url);
  const urlSample = `${parsed.hostname}${parsed.pathname}${parsed.search}`;
  if (urlTerms.test(urlSample)) { score += 60; signals.push("login_url"); }
  if (page.passwordFields > 0) { score += 65; signals.push("password_field"); }
  if (page.otpFields > 0) { score += page.text.trim().length < 5000 ? 45 : 20; signals.push("verification_field"); }
  if (page.captchaElements > 0) { score += 75; signals.push("captcha_widget"); }
  const sample = `${page.title}\n${page.text.slice(0, 20000)}`;
  if (challengeText.test(sample)) { score += 55; signals.push("challenge_text"); }
  else if (strongText.test(sample)) { score += 30; signals.push("login_text"); }
  if (page.status === 401) { score += 55; signals.push("http_401"); }
  if (page.status === 403 || page.status === 429) { score += 35; signals.push(`http_${page.status}`); }
  const reason = signals.includes("captcha_widget") || signals.includes("challenge_text")
    ? "robot_verification"
    : signals.includes("verification_field")
      ? "verification_required"
      : signals.length ? "login_required" : null;
  return { score, requiresLogin: score >= 60, reason, signals };
}
