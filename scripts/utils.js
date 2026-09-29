import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

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

export function atomicWriteFile(filePath, content) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(tempPath, content, "utf-8");
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    fs.rmSync(tempPath, { force: true });
    throw err;
  }
}

export function atomicWriteJson(filePath, data) {
  atomicWriteFile(filePath, JSON.stringify(data, null, 2) + "\n");
}

export function askUserConfirm(question, defaultOnNonTTY = true) {
  if (!process.stdin.isTTY) {
    console.log(`${question} [非交互环境，默认选择：${defaultOnNonTTY ? "Y" : "N"}]`);
    return Promise.resolve(defaultOnNonTTY);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === "" || normalized === "y" || normalized === "yes");
    });
  });
}
