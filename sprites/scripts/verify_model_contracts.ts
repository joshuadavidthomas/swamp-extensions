// SPDX-License-Identifier: MIT
/** Reject public model contracts that hide Zod schemas behind local or imported names. */
import ts from "npm:typescript@5.9.3";

const modelFiles = [
  "checkpoint.ts",
  "connector.ts",
  "organization.ts",
  "service.ts",
  "sprite.ts",
  "task.ts",
];

type ContractExpression = { label: string; expression: ts.Expression };

function namedProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment {
  const property = object.properties.find((
    item,
  ): item is ts.PropertyAssignment =>
    ts.isPropertyAssignment(item) &&
    (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) &&
    item.name.text === name
  );
  if (!property) throw new Error(`Missing literal ${name} property.`);
  return property;
}

function modelObject(source: ts.SourceFile): ts.ObjectLiteralExpression {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === "model" &&
        declaration.initializer &&
        ts.isObjectLiteralExpression(declaration.initializer)
      ) return declaration.initializer;
    }
  }
  throw new Error("Missing literal model object.");
}

function contractExpressions(
  model: ts.ObjectLiteralExpression,
): ContractExpression[] {
  const expressions: ContractExpression[] = [{
    label: "globalArguments",
    expression: namedProperty(model, "globalArguments").initializer,
  }];
  for (const sectionName of ["resources", "methods"] as const) {
    const section = namedProperty(model, sectionName).initializer;
    if (!ts.isObjectLiteralExpression(section)) {
      throw new Error(`${sectionName} must be an object literal.`);
    }
    for (const entry of section.properties) {
      if (
        !ts.isPropertyAssignment(entry) ||
        !ts.isObjectLiteralExpression(entry.initializer)
      ) {
        throw new Error(`${sectionName} entries must be object literals.`);
      }
      const entryName =
        ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)
          ? entry.name.text
          : "unknown";
      const field = sectionName === "resources" ? "schema" : "arguments";
      expressions.push({
        label: `${sectionName}.${entryName}.${field}`,
        expression: namedProperty(entry.initializer, field).initializer,
      });
    }
  }
  return expressions;
}

function isNamePosition(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  return (ts.isPropertyAssignment(parent) && parent.name === identifier) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
    (ts.isParameter(parent) && parent.name === identifier) ||
    (ts.isVariableDeclaration(parent) && parent.name === identifier);
}

function directObjectSchema(expression: ts.Expression): boolean {
  let current = expression;
  while (
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression)
  ) {
    if (
      ts.isIdentifier(current.expression.expression) &&
      current.expression.expression.text === "z"
    ) return current.expression.name.text === "object";
    current = current.expression.expression;
  }
  return false;
}

const failures: string[] = [];
for (const fileName of modelFiles) {
  const url = new URL(`../extensions/models/${fileName}`, import.meta.url);
  const source = ts.createSourceFile(
    url.pathname,
    await Deno.readTextFile(url),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const aliases = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          aliases.add(declaration.name.text);
        }
      }
    }
    if (
      ts.isImportDeclaration(statement) &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      for (const element of statement.importClause.namedBindings.elements) {
        if (!element.isTypeOnly) aliases.add(element.name.text);
      }
    }
  }
  aliases.delete("z");

  for (const contract of contractExpressions(modelObject(source))) {
    if (!directObjectSchema(contract.expression)) {
      failures.push(
        `${fileName} ${contract.label} is not a direct z.object schema`,
      );
    }
    const hidden = new Set<string>();
    const inspect = (node: ts.Node): void => {
      if (ts.isSpreadAssignment(node)) {
        failures.push(
          `${fileName} ${contract.label} contains an object spread`,
        );
      }
      if (
        ts.isIdentifier(node) && aliases.has(node.text) &&
        !isNamePosition(node)
      ) hidden.add(node.text);
      ts.forEachChild(node, inspect);
    };
    inspect(contract.expression);
    if (hidden.size) {
      failures.push(
        `${fileName} ${contract.label} hides schema content behind ${
          [...hidden].toSorted().join(", ")
        }`,
      );
    }
  }
}

if (failures.length) {
  throw new Error(
    `Model contracts are not self-contained:\n${failures.join("\n")}`,
  );
}
console.log("Verified six self-contained public model contracts.");
