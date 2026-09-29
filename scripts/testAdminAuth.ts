import assert from "node:assert/strict";
import {
  ADMIN_SESSION_TTL_MS,
  buildAdminCookieValue,
  isValidAdminCookie,
  isValidTranscriptId,
  verifyAdminPassword,
} from "../src/utils/auth.ts";

const PASS = "s3cret-p@ss";

assert.ok(isValidAdminCookie(`podstarter_auth=${buildAdminCookieValue(PASS)}`, PASS));
assert.ok(!isValidAdminCookie("podstarter_auth=authenticated", PASS), "明文 cookie 不得通过");
assert.ok(!isValidAdminCookie("podstarter_auth=authenticated", ""), "未配置密码时不得通过");
assert.ok(!isValidAdminCookie(`podstarter_auth=${buildAdminCookieValue("wrong")}`, PASS));
assert.ok(!isValidAdminCookie(`podstarter_auth=${buildAdminCookieValue(PASS)}`, "rotated"));
assert.ok(!isValidAdminCookie("", PASS));
assert.ok(!isValidAdminCookie("other=1; podstarter_auth=", PASS));
assert.ok(!isValidAdminCookie("podstarter_auth=short", PASS));
assert.ok(!isValidAdminCookie(`podstarter_auth=${buildAdminCookieValue("")}`, ""));

assert.ok(verifyAdminPassword(PASS, PASS));
assert.ok(!verifyAdminPassword("nope", PASS));
assert.ok(!verifyAdminPassword(undefined, PASS));
assert.ok(!verifyAdminPassword("x".repeat(1_000_000), PASS), "超长输入不得抛错");

for (const attack of [
  "../../../../.github/workflows/pwn",
  "..%2f..%2fetc%2fpasswd",
  "a/../../../b",
  "a/../b",
  "/etc/passwd",
  "./../secret",
  "..",
  "a".repeat(65),
  "",
]) {
  assert.ok(!isValidTranscriptId(attack), `路径穿越未被拦截：${attack}`);
}
for (const legit of ["5e285523418a84a04627767d", "abc-123_XYZ", "0f8fad5b"]) {
  assert.ok(isValidTranscriptId(legit), `正常 ID 被误拒：${legit}`);
}

// 畸形百分号编码曾导致 decodeURIComponent 抛 URIError，整页 /admin 500
assert.ok(!isValidAdminCookie("podstarter_auth=%", PASS), "畸形编码 cookie 不得抛错");
assert.ok(!isValidAdminCookie("podstarter_auth=%E0%A4%A", PASS), "截断多字节编码不得抛错");
assert.ok(!isValidAdminCookie("podstarter_auth=123.nothex", PASS));
assert.ok(!isValidAdminCookie("podstarter_auth=.abc", PASS), "缺失签发时间不得通过");

const expired = Date.now() - ADMIN_SESSION_TTL_MS - 60_000;
assert.ok(
  !isValidAdminCookie(`podstarter_auth=${buildAdminCookieValue(PASS, expired)}`, PASS),
  "过期会话不得通过"
);
const farFuture = Date.now() + 10 * 60 * 1000;
assert.ok(
  !isValidAdminCookie(`podstarter_auth=${buildAdminCookieValue(PASS, farFuture)}`, PASS),
  "未来时间戳不得通过"
);

console.log("admin-auth 自检通过：28 项断言");
