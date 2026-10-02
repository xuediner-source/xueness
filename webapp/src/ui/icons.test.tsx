import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { IconSearch, IconXuenessMark } from "./icons";

test("named SVGs expose distinct accessible titles and decorative SVGs stay hidden", () => {
  const html = renderToStaticMarkup(<>
    <IconSearch title="Search tasks" />
    <IconXuenessMark title="Xueness" />
    <IconSearch />
  </>);
  const named = [...html.matchAll(/<svg[^>]*role="img"[^>]*aria-labelledby="([^"]+)"[^>]*><title id="([^"]+)">([^<]+)<\/title>/g)];
  assert.equal(named.length, 2);
  assert.deepEqual(named.map(match => match[3]), ["Search tasks", "Xueness"]);
  for (const match of named) assert.equal(match[1], match[2]);
  assert.notEqual(named[0][1], named[1][1]);
  assert.equal((html.match(/aria-hidden="true"/g) ?? []).length, 1);
});
