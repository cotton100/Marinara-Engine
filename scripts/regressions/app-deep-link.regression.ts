import assert from "node:assert/strict";
import { getHashlessAppUrl, parseAppDeepLinkHash } from "../../packages/client/src/lib/app-deep-link.js";

assert.deepEqual(parseAppDeepLinkHash("#chat=abc_123-XYZ"), {
  type: "chat",
  chatId: "abc_123-XYZ",
});
assert.deepEqual(parseAppDeepLinkHash("#noodle"), { type: "noodle" });

for (const hash of ["", "#chat=", "#chat=abc&chat=def", "#chat=abc&unknown=1", "#unknown"] as const) {
  assert.equal(parseAppDeepLinkHash(hash), null, `unexpected deep-link match for ${hash}`);
}

assert.equal(
  getHashlessAppUrl({ pathname: "/marinara/", search: "?theme=dark" }),
  "/marinara/?theme=dark",
  "consuming a deep link must preserve the current path and query",
);

process.stdout.write("App deep-link regression passed.\n");
