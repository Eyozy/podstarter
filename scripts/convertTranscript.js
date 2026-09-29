import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);

const TIMING_ARROW_REGEX =
  /(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{3})/;

const LEADING_TIME_REGEX =
  /^\[?(?:(\d{1,2}):)?(\d{2}):(\d{2})(?:[,.]\d{3})?\]?[\s,，、:：-]*/;

export function formatTimestamp(hours, minutes, seconds, alwaysHours = false) {
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0 || alwaysHours) {
    const hh = String(hours).padStart(2, "0");
    return `[${hh}:${mm}:${ss}]`;
  }
  return `[${mm}:${ss}]`;
}

export function cleanCueText(rawText) {
  let speaker = null;
  let text = String(rawText || "").trim();

  const vttMatch = text.match(/^<v(?:\.[^>]+)?\s+([^>]+)>(.*?)(?:<\/v>)?$/s);
  if (vttMatch) {
    return {
      speaker: vttMatch[1].trim(),
      text: vttMatch[2].replace(/<[^>]+>/g, "").trim(),
    };
  }

  const boldMatch = text.match(/^\*\*([^*]+)\*\*[:：]?\s*(.*)$/s);
  if (boldMatch) {
    return {
      speaker: boldMatch[1].trim(),
      text: boldMatch[2].replace(/<[^>]+>/g, "").trim(),
    };
  }

  const bracketMatch = text.match(/^([\[【(])([^\]】)]+)([\]】)])[:：]?\s*(.*)$/s);
  if (bracketMatch && !/^\d{1,2}:\d{2}(?::\d{2})?$/.test(bracketMatch[2].trim())) {
    return {
      speaker: bracketMatch[2].trim(),
      text: bracketMatch[4].replace(/<[^>]+>/g, "").trim(),
    };
  }

  const colonMatch = text.match(/^([^:：\n\r]{1,25})[:：]\s*(.*)$/s);
  if (colonMatch) {
    const candidate = colonMatch[1].trim();
    if (
      !/^(https?|ftp)$/i.test(candidate) &&
      !/[。！？!?,，]/.test(candidate) &&
      !/^\d+$/.test(candidate)
    ) {
      return {
        speaker: candidate,
        text: colonMatch[2].replace(/<[^>]+>/g, "").trim(),
      };
    }
  }

  text = text.replace(/<[^>]+>/g, "").trim();
  text = text.replace(/([^\x00-\x7F])\n([^\x00-\x7F])/g, "$1$2");
  text = text.replace(/\n+/g, " ").trim();

  return { speaker, text };
}

export function parseSubtitles(content) {
  const normalized = content
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  const cues = [];

  const hasArrow = normalized.includes("-->");

  if (hasArrow) {
    const blocks = normalized.split(/\n\s*\n/);
    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed || trimmed.startsWith("WEBVTT") || trimmed.startsWith("NOTE")) {
        continue;
      }

      const lines = trimmed.split("\n").map((l) => l.trim()).filter(Boolean);
      let timeMatch = null;
      let textStartIndex = -1;

      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(TIMING_ARROW_REGEX);
        if (match) {
          timeMatch = match;
          textStartIndex = i + 1;
          break;
        }
      }

      if (!timeMatch || textStartIndex >= lines.length) continue;

      const hours = timeMatch[1] ? parseInt(timeMatch[1], 10) : 0;
      const minutes = parseInt(timeMatch[2], 10);
      const seconds = parseInt(timeMatch[3], 10);

      const rawText = lines.slice(textStartIndex).join("\n");
      const { speaker, text } = cleanCueText(rawText);

      if (text) {
        cues.push({
          timestamp: formatTimestamp(hours, minutes, seconds),
          speaker,
          text,
        });
      }
    }
  }

  if (cues.length === 0) {
    const lines = normalized.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("WEBVTT") || trimmed.startsWith("NOTE")) {
        continue;
      }

      const timeMatch = trimmed.match(LEADING_TIME_REGEX);
      if (timeMatch) {
        const hours = timeMatch[1] ? parseInt(timeMatch[1], 10) : 0;
        const minutes = parseInt(timeMatch[2], 10);
        const seconds = parseInt(timeMatch[3], 10);

        const restOfLine = trimmed.slice(timeMatch[0].length).trim();
        const { speaker, text } = cleanCueText(restOfLine);

        if (text || speaker) {
          cues.push({
            timestamp: formatTimestamp(hours, minutes, seconds),
            speaker,
            text: text || speaker,
          });
        }
      }
    }
  }

  return cues;
}

export function convertTranscript(content) {
  const cues = parseSubtitles(content);
  if (cues.length === 0) {
    return {
      cuesCount: 0,
      markdown: content.trim(),
    };
  }

  const lines = cues.map((cue) => {
    if (cue.speaker) {
      return `${cue.timestamp} **${cue.speaker}**: ${cue.text}`;
    }
    return `${cue.timestamp} ${cue.text}`;
  });

  return {
    cuesCount: cues.length,
    markdown: lines.join("\n\n"),
  };
}

export function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log("用法：node scripts/convertTranscript.js <input-file> [episode-id-or-output-path]");
    process.exit(1);
  }

  const inputPath = path.resolve(args[0]);
  if (!fs.existsSync(inputPath)) {
    console.error(`错误：找不到输入文件：${inputPath}`);
    process.exit(1);
  }

  const rawContent = fs.readFileSync(inputPath, "utf-8");
  const result = convertTranscript(rawContent);

  if (result.cuesCount === 0) {
    console.warn("警告：未能在文件中匹配到时间戳。");
  }

  const outputArg = args[1];
  if (outputArg) {
    let outPath = outputArg;
    if (!outPath.endsWith(".md")) {
      outPath = path.join(scriptDir, `../src/content/transcripts/${outputArg}.md`);
    } else {
      outPath = path.resolve(outPath);
    }

    const outDir = path.dirname(outPath);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    const markdownWithFrontmatter = `---\ntitle: "单集文字稿"\n---\n\n${result.markdown}\n`;
    fs.writeFileSync(outPath, markdownWithFrontmatter, "utf-8");
    console.log(`成功转换 ${result.cuesCount} 条发言，已写入：${outPath}`);
  } else {
    console.log(result.markdown);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath)) {
  main();
}
