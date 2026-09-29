import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson } from "./utils.js";

// 构建产物中 import.meta.url 指向打包后的文件，改用 cwd 解析项目根。
const ROOT_DIR = fs.existsSync(path.join(process.cwd(), "src/data/site.defaults.json"))
  ? process.cwd()
  : path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// site.defaults.json 随模板升级，site.json 只由管理控制台写入
const SITE_DEFAULTS_PATH = path.join(ROOT_DIR, "src/data/site.defaults.json");
const SITE_CONFIG_PATH = path.join(ROOT_DIR, "src/data/site.json");

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function deepMerge(base, override) {
  if (!isPlainObject(base)) return isPlainObject(override) ? deepMerge({}, override) : override;
  const result = { ...base };
  if (!isPlainObject(override)) return result;
  for (const [key, value] of Object.entries(override)) {
    result[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return result;
}

export function loadSiteDefaults() {
  return readJsonFile(SITE_DEFAULTS_PATH, {});
}

export function loadSiteOverrides() {
  return readJsonFile(SITE_CONFIG_PATH, {});
}

export function loadSiteConfig() {
  return deepMerge(loadSiteDefaults(), loadSiteOverrides());
}

function isEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function buildOverrides(base, next) {
  if (!isPlainObject(base) || !isPlainObject(next)) {
    return isEqual(base, next) ? undefined : next;
  }
  const overrides = {};
  for (const [key, value] of Object.entries(next)) {
    const override = buildOverrides(base[key], value);
    if (override !== undefined) overrides[key] = override;
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

export function writeOverrides(fullConfig) {
  const overrides = buildOverrides(loadSiteDefaults(), fullConfig) || {};
  atomicWriteJson(SITE_CONFIG_PATH, overrides);
  return overrides;
}

export function getRssUrl() {
  const config = loadSiteConfig();
  if (!config?.podcast?.rssUrl) {
    throw new Error("Missing podcast.rssUrl in site config.");
  }
  return config.podcast.rssUrl;
}

export function normalizeSiteUrl(url) {
  return String(url || "").trim().replace(/\/+$/u, "");
}

export function resolvePublicUrl(siteUrl, value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return normalizeSiteUrl(siteUrl);
  }
  if (/^https?:\/\//iu.test(trimmed)) {
    return trimmed;
  }

  return new URL(trimmed.replace(/^\/+/u, ""), `${normalizeSiteUrl(siteUrl)}/`).toString();
}

export function getSiteUrl() {
  const config = loadSiteConfig();
  if (!config?.site?.url) {
    throw new Error("Missing site.url in site config.");
  }
  return normalizeSiteUrl(config.site.url);
}

export function resolveSiteAssetUrl(value) {
  return resolvePublicUrl(getSiteUrl(), value);
}

export function isAiEnabled() {
  return loadSiteConfig()?.features?.aiTagging === true;
}

export function isTranscriptEnabled() {
  return loadSiteConfig()?.features?.transcripts === true;
}
