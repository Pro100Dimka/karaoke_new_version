import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const sourceFiles = (folder) => {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:ts|tsx)$/.test(entry.name) && !/\.(?:test|spec|d)\.tsx?$/.test(entry.name))
        files.push(path);
    }
  };
  walk(join(folder, "src"));
  return files;
};

const normalized = (path) => path.replaceAll("\\", "/");
const targetOf = (root, file, specifier) =>
  specifier.startsWith(".")
    ? normalized(relative(root, resolve(dirname(file), specifier)))
    : specifier;

const importsOf = (file) => {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    extname(file) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  return source.statements.flatMap((statement) =>
    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
    statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
      ? [statement.moduleSpecifier.text]
      : [],
  );
};

const featureClient = (source, target) =>
  source.startsWith("src/features/") &&
  /^src\/services\/(?:[^/]+Client|backendEvents|recordingCoordinator|desktopBridge|roomMappers)$/.test(target);

export const featureClientEdges = (root) => sourceFiles(root).flatMap((file) => {
  const source = normalized(relative(root, file));
  return importsOf(file)
    .map((specifier) => targetOf(root, file, specifier))
    .filter((target) => featureClient(source, target))
    .map((target) => `${source} -> ${target}`);
}).sort();

export const baselineViolations = (root, existingFeatureEdges) =>
  [...existingFeatureEdges].filter((edge) => !featureClientEdges(root).includes(edge)).sort();

export const architectureViolations = (root, existingFeatureEdges) =>
  sourceFiles(root).flatMap((file) => {
    const source = normalized(relative(root, file));
    const layer = source.split("/")[1];
    const violations = [];
    if ((layer === "application" || layer === "domain") && extname(file) === ".tsx")
      violations.push(`${source} -> React component`);
    for (const specifier of importsOf(file)) {
      const target = targetOf(root, file, specifier);
      const edge = `${source} -> ${target}`;
      if (featureClient(source, target)) {
        if (!existingFeatureEdges.has(edge)) violations.push(edge);
      } else if (
        (layer === "application" || layer === "domain") &&
        (/^(?:react|react-dom|react-router-dom)(?:\/|$)/.test(target) ||
          target.startsWith("@ad-voice/ui") ||
          /^src\/(?:app|features|services|electron)\//.test(target))
      ) violations.push(edge);
      else if (layer === "services" && target.startsWith("src/features/"))
        violations.push(edge);
    }
    return violations;
  });

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  if (process.argv.includes("--print-debt")) {
    process.stdout.write(`${JSON.stringify(featureClientEdges(root), null, 2)}\n`);
  } else {
    const existing = new Set(JSON.parse(readFileSync(new URL("./architecture-baseline.json", import.meta.url), "utf8")));
    const violations = [
      ...architectureViolations(root, existing),
      ...baselineViolations(root, existing).map((edge) => `stale baseline: ${edge}`),
    ];
    if (violations.length) {
      console.error(`Architecture check failed:\n${violations.map((value) => `- ${value}`).join("\n")}`);
      process.exitCode = 1;
    } else console.log(`Architecture check passed (${existing.size} existing feature-to-client edges remain).`);
  }
}
