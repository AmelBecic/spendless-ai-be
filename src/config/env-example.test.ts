// `.env.example` is the only documentation of what a deploy must provide, so it
// drifts silently the moment someone adds a var to the schema and forgets it.
// This pins the two together in both directions.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENV_KEYS } from "./env";

// Read by tooling/tests straight from process.env rather than through the app's
// schema, so they legitimately appear in .env.example without being schema keys.
const NON_SCHEMA_KEYS = ["TEST_DATABASE_URL"];

interface Assignment {
  key: string;
  value: string;
}

/** Assignment lines only — comments and prose are ignored. */
function assignments(contents: string): Assignment[] {
  return contents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .flatMap((line) => {
      const separator = line.indexOf("=");
      if (separator === -1) return [];
      const key = line.slice(0, separator).trim();
      // A trailing `# ...` note documents the value, it isn't part of it.
      const value =
        line
          .slice(separator + 1)
          .split("#")[0]
          ?.trim() ?? "";
      return key === "" ? [] : [{ key, value }];
    });
}

describe(".env.example", () => {
  const contents = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
  const documented = assignments(contents);
  const documentedKeys = documented.map(({ key }) => key);

  it("documents every variable the env schema reads", () => {
    const missing = ENV_KEYS.filter((key) => !documentedKeys.includes(key));
    expect(missing).toEqual([]);
  });

  it("documents nothing the app does not read", () => {
    const known = new Set<string>([...ENV_KEYS, ...NON_SCHEMA_KEYS]);
    expect(documentedKeys.filter((key) => !known.has(key))).toEqual([]);
  });

  it("carries no real values — the template ships placeholders only", () => {
    // Every documented key must be blank or an obviously-inert local default;
    // a populated secret here would be a committed credential.
    const inert = /^(development|test|production|3000)$/;
    const populated = documented.filter(({ value }) => value !== "" && !inert.test(value));

    expect(populated).toEqual([]);
  });
});
