export const SUPPORTED_PROVIDERS = [
  "deepseek",
  "openrouter",
  "xai",
  "zhipu",
  "openai-compatible",
];

const PROVIDER_CAPABILITIES = {
  deepseek: { supportsJsonResponseFormat: true },
  openrouter: { supportsJsonResponseFormat: null }, // 取决于下游模型，保留回退
  xai: { supportsJsonResponseFormat: true },
  zhipu: { supportsJsonResponseFormat: false },
  "openai-compatible": { supportsJsonResponseFormat: null }, // 用户自定义，保留回退
};

export function normalizeProvider(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return null;
  return value;
}

const PROVIDER_ENV_PREFIXES = {
  deepseek: "DEEPSEEK",
  openrouter: "OPENROUTER",
  xai: "XAI",
  zhipu: "ZHIPU",
  "openai-compatible": "OPENAI_COMPATIBLE",
};

export function getProviderEnvPrefix(provider) {
  return PROVIDER_ENV_PREFIXES[provider] || null;
}

export function getSupportedProvidersText() {
  return SUPPORTED_PROVIDERS.join(" | ");
}

export function providerSupportsJsonResponseFormat(provider) {
  return PROVIDER_CAPABILITIES[provider]?.supportsJsonResponseFormat ?? null;
}
