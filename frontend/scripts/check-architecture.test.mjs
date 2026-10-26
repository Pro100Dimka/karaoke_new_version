import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  architectureViolations,
} from "./check-architecture.mjs";

test("architecture boundaries reject private service state and reverse dependencies", () => {
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
    source("features/room/Bad.tsx", 'import "../../services/audioSession";');
    source("app/Composition.ts", 'import "../services/audioSession"; import "../application/room/Bad";');
    const violations = architectureViolations(root);
    assert.equal(violations.length, 5);
    assert.match(violations.join("\n"), /application\/room\/Bad\.ts.*react/);
    assert.match(violations.join("\n"), /application\/room\/Bad\.ts.*services\/roomClient/);
    assert.match(violations.join("\n"), /domain\/State\.ts.*react/);
    assert.match(violations.join("\n"), /services\/Bad\.ts.*features\/room\/roomModel/);
    assert.match(violations.join("\n"), /features\/room\/Bad\.tsx.*services\/audioSession/);

  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("architecture boundaries reject unlisted service modules", () => {
  const root = mkdtempSync(join(tmpdir(), "advoice-architecture-"));
  const file = join(root, "src", "features", "room", "Direct.ts");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, 'import "../../services/newTransportClient";');
  const edge = "src/features/room/Direct.ts -> src/services/newTransportClient";
  try {
    assert.deepEqual(architectureViolations(root), [edge]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("architecture boundaries allow public feature APIs but reject internal mappers", () => {
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
    assert.deepEqual(architectureViolations(root), ["src/features/room/Direct.ts -> src/services/roomMappers"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("feature boundary rejects a newly named private transport", () => {
  const root = mkdtempSync(join(tmpdir(), "advoice-architecture-"));
  const file = join(root, "src", "features", "room", "Direct.ts");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, 'import "../../services/newTransport";');
  try {
    assert.deepEqual(architectureViolations(root), [
      "src/features/room/Direct.ts -> src/services/newTransport",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("feature boundary also rejects a lazy private service import", () => {
  const root = mkdtempSync(join(tmpdir(), "advoice-architecture-"));
  const file = join(root, "src", "features", "room", "Lazy.ts");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, 'export const load = () => import("../../services/audioSession");');
  try {
    assert.deepEqual(architectureViolations(root), [
      "src/features/room/Lazy.ts -> src/services/audioSession",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
