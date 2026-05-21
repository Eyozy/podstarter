import "dotenv/config";
import {
  getProviderEnvPrefix,
  normalizeProvider,
  SUPPORTED_PROVIDERS,
  providerSupportsJsonResponseFormat,
} from "./ai-provider-config.js";

const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";

function readRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is missing in environment variables`);
  }
  return value;
}

export function getActiveAiInfo() {
  const provider = normalizeProvider(process.env.AI_PROVIDER);
  if (!provider) {
    throw new Error("AI_PROVIDER is missing in environment variables");
  }
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    throw new Error(
      `AI_PROVIDER must be one of: ${SUPPORTED_PROVIDERS.join(", ")}`,
    );
  }

  const prefix = getProviderEnvPrefix(provider);
  if (!prefix) {
    throw new Error(`Unsupported provider prefix for: ${provider}`);
  }

  const apiUrl = readRequiredEnv(`${prefix}_API_URL`);
  const model = readRequiredEnv(`${prefix}_MODEL`);
  return { provider, apiUrl, model };
}

function getProviderRequestConfig() {
  const { provider, apiUrl, model } = getActiveAiInfo();

  const prefix = getProviderEnvPrefix(provider);
  if (!prefix) {
    throw new Error(`Unsupported provider prefix for: ${provider}`);
  }

  const apiKey = readRequiredEnv(`${prefix}_API_KEY`);

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  if (provider === "openrouter") {
    const referer = process.env.OPENROUTER_HTTP_REFERER;
    const title = process.env.OPENROUTER_X_TITLE;
    if (referer) headers["HTTP-Referer"] = referer;
    if (title) headers["X-Title"] = title;
  }

  return { provider, apiUrl, model, headers };
}

/**
 * Sends a prompt to the AI and expects a JSON response.
 * @param {string} prompt - The user prompt.
 * @param {string} [systemPrompt="You are a helpful assistant."] - The system prompt.
 * @returns {Promise<Object>} - The parsed JSON response.
 */
export async function askAI(
  prompt,
  systemPrompt = DEFAULT_SYSTEM_PROMPT,
  options = {},
) {
  const { provider, apiUrl, model, headers } = getProviderRequestConfig();

  const { timeoutMs = 30000, temperature = 0.7 } = options;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const basePayload = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      temperature,
    };

    async function sendRequest(withResponseFormat) {
      const payload = withResponseFormat
        ? { ...basePayload, response_format: { type: "json_object" } }
        : basePayload;

      return fetch(apiUrl, {
        method: "POST",
        signal: controller.signal,
        headers,
        body: JSON.stringify(payload),
      });
    }

    // 根据 provider 能力决定请求策略：
    // - 已知支持 response_format：直接使用，无需回退
    // - 已知不支持：直接不传，无需尝试
    // - 未知 (null)：保留原有先尝试后回退策略
    const rfSupport = providerSupportsJsonResponseFormat(provider);
    let response;
    if (rfSupport === true) {
      response = await sendRequest(true);
    } else if (rfSupport === false) {
      response = await sendRequest(false);
    } else {
      response = await sendRequest(true);
      if (!response.ok && [400, 404, 415, 422].includes(response.status)) {
        response = await sendRequest(false);
      }
    }

    if (!response.ok) {
      // 避免把响应体写入日志（有些服务会在错误里返回敏感/冗长信息）
      throw new Error(`API Error: ${response.status}`);
    }

    const data = await response.json().catch(() => null);
    if (!data) {
      throw new Error("Failed to parse API response as JSON");
    }

    if (!data.choices || data.choices.length === 0) {
      throw new Error("No content received from AI");
    }

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("AI response content is empty");
    }

    try {
      return JSON.parse(content);
    } catch (e) {
      throw new Error(`Failed to parse JSON response: ${e.message}`);
    }
  } catch (error) {
    console.error("Error in askAI:", error);
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
