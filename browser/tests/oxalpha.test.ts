// SPDX-License-Identifier: LicenseRef-BSL-1.1

import assert from "node:assert/strict";
import test from "node:test";
import { appendedDomText } from "../src/oxalpha.js";

test("Ox Alpha DOM streaming emits only newly appended visible text", () => {
  assert.equal(appendedDomText("", "hello"), "hello");
  assert.equal(appendedDomText("hello", "hello world"), " world");
  assert.equal(appendedDomText("hello", "rewritten"), "");
});
