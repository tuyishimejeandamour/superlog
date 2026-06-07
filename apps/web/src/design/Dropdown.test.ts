import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("non-searchable dropdown focuses its popover so keyboard navigation works", async () => {
  const source = await readFile(new URL("./Dropdown.tsx", import.meta.url), "utf8");

  assert.match(source, /const listRef = useRef<HTMLDivElement>\(null\)/);
  assert.match(source, /listRef\.current\?\.focus\(\)/);
  assert.match(source, /ref=\{listRef\}/);
  assert.match(source, /tabIndex=\{-1\}/);
  assert.match(source, /onKeyDown=\{onKey\}/);
});
