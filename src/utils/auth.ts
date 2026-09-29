import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ENV_PATH = path.join(process.cwd(), ".env");

export const ADMIN_COOKIE_NAME = "podstarter_auth";
export const ADMIN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function isSafeId(id: unknown): boolean {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(id);
}
export const isValidTranscriptId = isSafeId;

export function readEnvMap(): Record<string, string> {
  const envMap: Record<string, string> = {};
  try {
    if (fs.existsSync(ENV_PATH)) {
      for (const line of fs.readFileSync(ENV_PATH, "utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        envMap[key] = val;
      }
    }
  } catch {}
  return envMap;
}

export function resolveAdminPassword(): string {
  let pass = String(process.env.ADMIN_PASSWORD || readEnvMap().ADMIN_PASSWORD || "").trim();
  if ((pass.startsWith('"') && pass.endsWith('"')) || (pass.startsWith("'") && pass.endsWith("'"))) {
    pass = pass.slice(1, -1).trim();
  }
  return pass;
}

function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function verifyAdminPassword(candidate: unknown, password: string): boolean {
  return safeEqual(String(candidate ?? ""), password);
}

function signSession(password: string, issuedAt: number): string {
  return createHmac("sha256", password)
    .update(`podstarter-admin-session:${issuedAt}`)
    .digest("hex");
}

export function buildAdminCookieValue(password: string, issuedAt = Date.now()): string {
  return encodeURIComponent(`${issuedAt}.${signSession(password, issuedAt)}`);
}

function parseSessionCookie(raw: string): { issuedAt: number; signature: string } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }

  const sepIdx = decoded.indexOf(".");
  if (sepIdx === -1) return null;

  const issuedAt = Number(decoded.slice(0, sepIdx));
  const signature = decoded.slice(sepIdx + 1);
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0 || !/^[0-9a-f]{64}$/u.test(signature)) {
    return null;
  }

  return { issuedAt, signature };
}

export function isValidAdminCookie(cookieHeader: string, password: string): boolean {
  if (!password) return false;

  const raw = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${ADMIN_COOKIE_NAME}=`));
  if (!raw) return false;

  const session = parseSessionCookie(raw.slice(ADMIN_COOKIE_NAME.length + 1));
  if (!session) return false;

  const now = Date.now();
  if (now - session.issuedAt > ADMIN_SESSION_TTL_MS) return false;
  if (session.issuedAt - now > 60_000) return false;

  return safeEqual(session.signature, signSession(password, session.issuedAt));
}
