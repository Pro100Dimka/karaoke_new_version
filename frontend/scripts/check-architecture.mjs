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
      else if (
        /\.(?:ts|tsx)$/.test(entry.name) &&
        !/\.(?:test|spec|d)\.tsx?$/.test(entry.name)
      )
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
  const imports = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      imports.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    )
      imports.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
};

// Features may use public service APIs directly. Transport state and mappers stay internal.
const publicServices = new Set([
  "audioClient", "pythonClient", "desktopClient", "desktopBridge",
  "recordingCoordinator", "keyboardLightingClient", "backendEvents", "socialClient",
].map((name) => `src/services/${name}`));
const privateService = (source, target) =>
  source.startsWith("src/features/") && target.startsWith("src/services/") &&
  !publicServices.has(target);

export const architectureViolations = (root) =>
  sourceFiles(root).flatMap((file) => {
    const source = normalized(relative(root, file));
    const layer = source.split("/")[1];
    const violations = [];
    if (
      ["application", "domain"].includes(layer) &&
      extname(file) === ".tsx"
    )
      violations.push(`${source} -> React component`);
    for (const specifier of importsOf(file)) {
      const target = targetOf(root, file, specifier);
      const edge = `${source} -> ${target}`;
      if (privateService(source, target)) violations.push(edge);
      else if (
        ["application", "domain"].includes(layer) &&
        (/^(?:react|react-dom|react-router-dom)(?:\/|$)/.test(target) ||
          target.startsWith("@neo-ui-kit/react") ||
          /^src\/(?:app|features|services|electron)\//.test(target))
      )
        violations.push(edge);
      else if (layer === "services" && target.startsWith("src/features/"))
        violations.push(edge);
    }
    return violations;
  });

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = process.cwd();
  const violations = architectureViolations(root);
  if (violations.length) {
    console.error(`Architecture check failed:\n${violations.map((value) => `- ${value}`).join("\n")}`);
    process.exitCode = 1;
  } else console.log("Architecture check passed.");
}
