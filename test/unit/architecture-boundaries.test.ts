import { describe, expect, it } from "bun:test";
import { Glob } from "bun";
import { dirname, join, relative, resolve } from "node:path";

// Section 6.1: the domain depends on no ORM type and no NestJS decorator. Enforced here instead of by
// inspection: a closed list of what each inner layer may import.

const SRC = resolve(import.meta.dir, "../../src");

/** Every module specifier of a file: static imports, re-exports, side-effect and dynamic imports. */
export function specifiers(code: string): string[] {
  const out: string[] = [];
  for (const re of [/\bfrom\s+["']([^"']+)["']/g, /\bimport\s+["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g]) {
    for (const m of code.matchAll(re)) out.push(m[1]!);
  }
  return out;
}

interface Rule {
  layer: string;
  /** src/ folders a relative import may land in. */
  layers: string[];
  /** Bare packages allowed (exact names). */
  packages: string[];
}

const RULES: Rule[] = [
  { layer: "domain", layers: ["domain"], packages: ["decimal.js"] },
  { layer: "application", layers: ["domain", "application"], packages: ["canonicalize", "node:async_hooks", "node:crypto"] },
];

async function violations(rule: Rule): Promise<string[]> {
  const found: string[] = [];
  const dir = join(SRC, rule.layer);
  for await (const file of new Glob("**/*.ts").scan(dir)) {
    const path = join(dir, file);
    for (const spec of specifiers(await Bun.file(path).text())) {
      if (spec.startsWith(".")) {
        const target = relative(SRC, resolve(dirname(path), spec)).split(/[\\/]/)[0]!;
        if (!rule.layers.includes(target)) found.push(`${rule.layer}/${file} -> ${spec} (layer ${target})`);
      } else if (!rule.packages.includes(spec)) {
        found.push(`${rule.layer}/${file} -> ${spec}`);
      }
    }
  }
  return found;
}

describe("layer boundaries (section 6.1)", () => {
  for (const rule of RULES) {
    it(`${rule.layer} imports only ${[...rule.layers.map((l) => `src/${l}`), ...rule.packages].join(", ")}`, async () => {
      const files = await Array.fromAsync(new Glob("**/*.ts").scan(join(SRC, rule.layer)));
      expect(files.length).toBeGreaterThan(0);
      expect(await violations(rule)).toEqual([]);
    });
  }

  it("the scanner sees every import form (so an empty list means something)", () => {
    const code = [
      `import { Entity } from "@mikro-orm/core";`,
      `import type { X } from '../infrastructure/x';`,
      `export { Y } from "@nestjs/common";`,
      `import "reflect-metadata";`,
      `const m = await import("pg");`,
      `const r = require("fs");`,
    ].join("\n");
    expect(specifiers(code)).toEqual(["@mikro-orm/core", "../infrastructure/x", "@nestjs/common", "reflect-metadata", "pg", "fs"]);
  });
});
