// The GoHighLevel code is kept for migration only. Nothing the portal runs may import it or read GHL_* settings.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function walk(entry: string, out: string[] = []) {
  if (!statSync(entry).isDirectory()) {
    if (/\.(ts|tsx)$/.test(entry)) out.push(entry);
    return out;
  }
  for (const name of readdirSync(entry)) walk(path.join(entry, name), out);
  return out;
}

// Everything that runs: the API server, its Vercel entry, and all browser code (portal and booking page).
const runtime = [...walk("server"), ...walk("api"), ...walk("src"), "server.ts"].filter((f) => !f.split(path.sep).includes("legacy"));

describe("legacy GoHighLevel isolation", () => {
  it("has runtime files to check", () => {
    expect(runtime.length).toBeGreaterThan(20);
  });

  it("no portal runtime file imports the legacy GoHighLevel module", () => {
    const offenders = runtime.filter((f) => /from\s+["'][^"']*(legacy\/ghl|integrations\/ghl)[^"']*["']|import\(["'][^"']*legacy\//.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("no portal runtime file reads a GHL_* environment variable or calls the GoHighLevel API", () => {
    const offenders = runtime.filter((f) => /GHL_[A-Z_]+|leadconnectorhq\.com/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
