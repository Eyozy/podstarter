/**
 * 共享工具函数，供 tag-episodes.js 和 normalize-tags.js 复用。
 */

/**
 * 将原始标签列表规范化：去除无效值、应用别名映射、过滤不在白名单内的标签、去重。
 * @param {string[]} rawTags - 原始标签数组
 * @param {Record<string, string>} aliases - 别名映射表（旧名 → 新名）
 * @param {Set<string>} allowedTags - 允许的标签白名单
 * @param {boolean} [stripHash=false] - 是否去除标签前的 # 前缀（normalize-tags 场景需要）
 * @returns {string[]}
 */
export function normalizeTags(rawTags, aliases, allowedTags, stripHash = false) {
  if (!Array.isArray(rawTags)) {
    return [];
  }

  const normalized = [];
  for (const rawTag of rawTags) {
    if (rawTag === null || rawTag === undefined) {
      continue;
    }
    let trimmed = String(rawTag).trim();
    if (stripHash) {
      trimmed = trimmed.replace(/^#/, "");
    }
    if (!trimmed) {
      continue;
    }
    const mapped = aliases[trimmed] || trimmed;
    if (!allowedTags.has(mapped)) {
      continue;
    }
    if (!normalized.includes(mapped)) {
      normalized.push(mapped);
    }
  }
  return normalized;
}

/**
 * 用 fallbackTags 补足 primaryTags，确保标签数量在 [minCount, maxCount] 范围内。
 * @param {string[]} primaryTags - 主要标签
 * @param {string[]} fallbackTags - 备用标签（当主要标签不足时补充）
 * @param {number} minCount - 最少标签数
 * @param {number} maxCount - 最多标签数
 * @returns {string[]}
 */
export function fillTags(primaryTags, fallbackTags, minCount, maxCount) {
  const tags = [...primaryTags];
  for (const tag of fallbackTags) {
    if (tags.length >= maxCount) {
      break;
    }
    if (!tags.includes(tag)) {
      tags.push(tag);
    }
  }

  if (tags.length > maxCount) {
    return tags.slice(0, maxCount);
  }

  return tags.length >= minCount ? tags : tags.slice(0, Math.max(minCount, 1));
}
