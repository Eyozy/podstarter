export const SUPPORTED_PROVIDERS = [
  "deepseek",
  "openrouter",
  "xai",
  "zhipu",
  "openai-compatible",
];

/**
 * 各 provider 的能力配置。
 * supportsJsonResponseFormat: 是否支持 OpenAI 风格的 response_format: { type: "json_object" }。
 * - true：直接使用，无需回退重试。
 * - false：不传 response_format，让模型在系统提示中遵循 JSON 格式要求。
 * - null / undefined：未知，保留原有"先尝试后回退"策略。
 */
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

export function getProviderEnvPrefix(provider) {
  return provider === "deepseek"
    ? "DEEPSEEK"
    : provider === "openrouter"
      ? "OPENROUTER"
      : provider === "xai"
        ? "XAI"
        : provider === "zhipu"
          ? "ZHIPU"
          : provider === "openai-compatible"
            ? "OPENAI_COMPATIBLE"
            : null;
}

export function getSupportedProvidersText() {
  return SUPPORTED_PROVIDERS.join(" | ");
}

/**
 * 查询指定 provider 是否支持 response_format: { type: "json_object" }。
 * @param {string} provider
 * @returns {boolean | null} true=支持, false=不支持, null=未知（走回退策略）
 */
export function providerSupportsJsonResponseFormat(provider) {
  return PROVIDER_CAPABILITIES[provider]?.supportsJsonResponseFormat ?? null;
}
