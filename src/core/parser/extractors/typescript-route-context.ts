import ts from "typescript";
import type { ExecutionChainNode } from "../../../types/index.ts";
import { lineOf, nameText, nodes, TypeScriptBindings, type Handler } from "./typescript-bindings.ts";

/** Selected handler-local service and persistence hints for Hono and Elysia. */
export function routeContext(
  handler: Handler,
  bindings: TypeScriptBindings,
  fileOf: (node: ts.Node) => string,
): ExecutionChainNode[] {
  const calls = (body?: ts.Node): ts.CallExpression[] => {
    if (!body) return [];
    return [body, ...nodes(body, true)].filter(ts.isCallExpression);
  };
  const context: ExecutionChainNode[] = [];
  const handlerCalls = calls(handler.node.body);
  let serviceCalls: ts.CallExpression[] = [];
  const serviceCall = handlerCalls.find(call =>
    ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.expression) &&
    /(?:service|usecase)$/i.test(call.expression.expression.text),
  );
  if (serviceCall && ts.isPropertyAccessExpression(serviceCall.expression)) {
    const receiver = serviceCall.expression.expression;
    const method = serviceCall.expression.name.text;
    const symbol = receiver.getText() + "::" + method;
    const definition = bindings.definition(receiver);
    const member = definition && ts.isClassLike(definition) ? definition.members.find(candidate =>
      ts.isMethodDeclaration(candidate) && nameText(candidate.name) === method,
    ) : undefined;
    const location = member ?? serviceCall;
    context.push({
      stage: "service", symbol, file: fileOf(location), line: lineOf(location),
      description: "Service call by receiver naming pattern",
    });
    if (member && ts.isMethodDeclaration(member)) serviceCalls = calls(member.body);
  }

  for (const call of [...handlerCalls, ...serviceCalls]) {
    const callee = call.expression;
    if (!ts.isPropertyAccessExpression(callee)) continue;
    const owner = callee.expression;
    const prisma = ts.isPropertyAccessExpression(owner) && ts.isIdentifier(owner.expression) &&
      owner.expression.text === "prisma" && /^(find|create|update|delete|upsert)/.test(callee.name.text);
    const drizzle = ts.isIdentifier(owner) && owner.text === "db" && /^(insert|select|update|delete)$/.test(callee.name.text);
    const argument = call.arguments[0];
    const entityName = prisma ? owner.name.text : drizzle && argument && ts.isIdentifier(argument) ? argument.text : undefined;
    if (!entityName) continue;
    const symbol = entityName[0]!.toUpperCase() + entityName.slice(1);
    context.push({
      stage: "repository", symbol: symbol + "Repository", file: fileOf(call), line: lineOf(call),
      description: prisma ? "Prisma query naming pattern" : "Drizzle query naming pattern",
    }, {
      stage: "entity", symbol, file: fileOf(call), line: lineOf(call), description: "Entity inferred from query naming",
    });
    break;
  }
  return context;
}
