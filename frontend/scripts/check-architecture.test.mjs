import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { architectureViolations } from "./check-architecture.mjs";

test("architecture boundaries reject concrete clients and reverse dependencies", () => {
  const root = mkdtempSync(join(tmpdir(), "advoice-architecture-"));
  const source = (path, contents) => {
    const file = join(root, "src", path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, contents);
  };
  try {
    source("application/room/Bad.ts", 'import "react"; import "../../services/roomClient";');
    source("domain/State.ts", 'import "react";');
    source("services/Bad.ts", 'import "../features/room/roomModel";');
    source("features/room/Bad.tsx", 'import "../../services/audioClient";');
    source("app/Composition.ts", 'import "../services/audioClient"; import "../application/room/Bad";');
    const violations = architectureViolations(root, new Set());
    assert.equal(violations.length, 5);
    assert.match(violations.join("\n"), /application\/room\/Bad\.ts.*react/);
    assert.match(violations.join("\n"), /application\/room\/Bad\.ts.*services\/roomClient/);
    assert.match(violations.join("\n"), /domain\/State\.ts.*react/);
    assert.match(violations.join("\n"), /services\/Bad\.ts.*features\/room\/roomModel/);
    assert.match(violations.join("\n"), /features\/room\/Bad\.tsx.*services\/audioClient/);
    assert.equal(
      architectureViolations(root, new Set(["src/features/room/Bad.tsx -> src/services/audioClient"])).length,
      4,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
