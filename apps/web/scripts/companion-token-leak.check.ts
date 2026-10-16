import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Synthetic marker used only in checks — must not appear in browser bundles. */
const SYNTHETIC_TOKEN = "s1b-test-companion-access-token-0001";

const guardedSources = [
  "vite.config.ts",
  "vite.companionAccess.ts",
  "src/realtime/RealtimeClient.ts",
  "src/App.tsx",
  "src/memory/MemoryPanel.tsx",
];

for (const relative of guardedSources) {
  const source = readFileSync(join(webRoot, relative), "utf8");
  assert.equal(
    source.includes("VITE_COMPANION_ACCESS_TOKEN"),
    false,
    `${relative} must not use VITE_ token env`,
  );
  assert.equal(
    /import\.meta\.env\.[A-Z0-9_]*COMPANION/.test(source),
    false,
    `${relative} must not expose companion token via import.meta.env`,
  );
  if (relative === "vite.config.ts" || relative === "vite.companionAccess.ts") {
    assert.equal(
      /define\s*:\s*\{[^}]*COMPANION_ACCESS_TOKEN/.test(source),
      false,
      `${relative} must not define companion token into client bundles`,
    );
  } else {
    assert.equal(
      source.includes("COMPANION_ACCESS_TOKEN"),
      false,
      `${relative} is browser code and must not reference companion access token`,
    );
    assert.equal(
      /Authorization\s*:\s*[`'"]Bearer/.test(source),
      false,
      `${relative} must not set Companion Bearer headers in the browser`,
    );
  }
}

assert.match(
  readFileSync(join(webRoot, "vite.config.ts"), "utf8"),
  /applyCompanionProxyAuthorization/,
);
assert.match(
  readFileSync(join(webRoot, "vite.config.ts"), "utf8"),
  /127\.0\.0\.1:3000/,
);
assert.match(
  readFileSync(join(webRoot, "vite.config.ts"), "utf8"),
  /ws:\s*true/,
);

function walkFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkFiles(full, out);
      continue;
    }
    if (/\.(js|css|html|map)$/.test(entry)) {
      out.push(full);
    }
  }
}

const distDir = join(webRoot, "dist");
const skipDist = process.env.COMPANION_TOKEN_LEAK_SKIP_DIST === "1";

if (!existsSync(distDir)) {
  if (skipDist) {
    console.log(
      "[companion-token-leak] SKIP_DIST: dist/ missing (COMPANION_TOKEN_LEAK_SKIP_DIST=1)",
    );
  } else {
    assert.fail(
      "dist/ missing: run web build before companion-token-leak, or set COMPANION_TOKEN_LEAK_SKIP_DIST=1 to skip dist scan explicitly",
    );
  }
} else {
  const distFiles: string[] = [];
  walkFiles(distDir, distFiles);
  assert.ok(
    distFiles.length > 0,
    "dist/ exists but contains no js/css/html/map artifacts to scan",
  );

  for (const file of distFiles) {
    const text = readFileSync(file, "utf8");
    assert.equal(
      text.includes(SYNTHETIC_TOKEN),
      false,
      `dist must not contain synthetic test token: ${file}`,
    );
    assert.equal(
      text.includes("COMPANION_ACCESS_TOKEN"),
      false,
      `dist must not contain COMPANION_ACCESS_TOKEN: ${file}`,
    );
  }

  console.log(
    `[companion-token-leak] source guards ok; scanned ${distFiles.length} dist files`,
  );
}

if (skipDist && !existsSync(distDir)) {
  console.log("[companion-token-leak] source guards ok; dist scan skipped");
}
