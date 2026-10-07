import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { architectureViolations, baselineViolations } from "./check-architecture.mjs";

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

test("architecture boundaries reject every concrete feature client and stale exceptions", () => {
  const root = mkdtempSync(join(tmpdir(), "advoice-architecture-"));
  const file = join(root, "src", "features", "room", "Direct.ts");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, 'import "../../services/newTransportClient";');
  const edge = "src/features/room/Direct.ts -> src/services/newTransportClient";
  try {
    assert.deepEqual(architectureViolations(root, new Set()), [edge]);
    assert.deepEqual(baselineViolations(root, new Set(["obsolete edge"])), ["obsolete edge"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("architecture boundaries also reject feature imports of concrete service modules", () => {
  const root = mkdtempSync(join(tmpdir(), "advoice-architecture-"));
  const file = join(root, "src", "features", "room", "Direct.ts");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, [
    'import "../../services/backendEvents";',
    'import "../../services/recordingCoordinator";',
    'import "../../services/desktopBridge";',
    'import "../../services/roomMappers";',
  ].join("\n"));
  try {
    assert.equal(architectureViolations(root, new Set()).length, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("feature boundary rejects every service module, including a newly named transport", () => {
  const root = mkdtempSync(join(tmpdir(), "advoice-architecture-"));
  const file = join(root, "src", "features", "room", "Direct.ts");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, 'import "../../services/newTransport";');
  try {
    assert.deepEqual(architectureViolations(root, new Set()), [
      "src/features/room/Direct.ts -> src/services/newTransport",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("feature boundary also rejects a lazy concrete client import", () => {
  const root = mkdtempSync(join(tmpdir(), "advoice-architecture-"));
  const file = join(root, "src", "features", "room", "Lazy.ts");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, 'export const load = () => import("../../services/audioClient");');
  try {
    assert.deepEqual(architectureViolations(root, new Set()), [
      "src/features/room/Lazy.ts -> src/services/audioClient",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
