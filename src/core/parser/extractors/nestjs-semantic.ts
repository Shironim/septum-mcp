import * as path from "node:path";
import ts from "typescript";
import type { ExecutionChainNode } from "../../../types/index.ts";
import { listSourceFiles, type SourceInventory } from "../../resources/source-inventory.ts";
import { probeSourcePath, readOptionalSourceFile } from "../../resources/source-files.ts";
import type { SemanticSliceExtractor, VerticalSliceCandidate } from "./semantic-extractor.interface.ts";
import { lineOf, literal, nameText, nodes, objectMember, TypeScriptBindings } from "./typescript-bindings.ts";

const methodDecorators = new Map([
  ["Get", "GET"], ["Post", "POST"], ["Put", "PUT"], ["Patch", "PATCH"], ["Delete", "DELETE"],
  ["All", "ANY"], ["Head", "HEAD"], ["Options", "OPTIONS"], ["Search", "SEARCH"], ["Propfind", "PROPFIND"],
  ["Proppatch", "PROPPATCH"], ["Mkcol", "MKCOL"], ["Copy", "COPY"], ["Move", "MOVE"], ["Lock", "LOCK"], ["Unlock", "UNLOCK"],
]);

type Decorator = { name: string; site: ts.Decorator; args: readonly ts.Expression[] };
type FileOf = (node: ts.Node) => string;

function decorators(node: ts.Node, bindings: TypeScriptBindings, owner = "@nestjs/common"): Decorator[] {
  if (!ts.canHaveDecorators(node)) return [];
  return (ts.getDecorators(node) ?? []).flatMap(site => {
    const call = site.expression;
    if (!ts.isCallExpression(call)) return [];
    const binding = bindings.packageBinding(call.expression);
    if (binding?.module !== owner && !binding?.module.startsWith(owner + "/")) return [];
    return [{ name: binding.name, site, args: call.arguments }];
  });
}

function paths(value?: ts.Expression, emptyArrayMeansRoot = false): string[] | undefined {
  if (!value) return [""];
  const values = ts.isArrayLiteralExpression(value) ? value.elements.map(literal) : [literal(value)];
  if (!values.every((item): item is string => item !== undefined)) return undefined;
  return !values.length && emptyArrayMeansRoot ? [""] : [...new Set(values)];
}

function option(object: ts.ObjectLiteralExpression, key: string): ts.Expression | "unknown" | undefined {
  const value = objectMember(object, key);
  if (value) return ts.isMethodDeclaration(value) ? "unknown" : value;
  if (object.properties.some(prop => ts.isSpreadAssignment(prop) ||
      (prop.name && (ts.isComputedPropertyName(prop.name) || nameText(prop.name) === key)))) return "unknown";
  return undefined;
}

function controllerPaths(decorator: Decorator, bindings: TypeScriptBindings): string[] | undefined {
  const value = bindings.value(decorator.args[0]);
  if (!value || !ts.isObjectLiteralExpression(value)) return paths(value);
  const pathValue = option(value, "path");
  return pathValue === "unknown" ? undefined : paths(bindings.value(pathValue));
}

function handlerRoute(decorator: Decorator, bindings: TypeScriptBindings) {
  const value = bindings.value(decorator.args[0]);
  if (decorator.name !== "RequestMapping") {
    return { method: methodDecorators.get(decorator.name), paths: paths(value, true) };
  }
  if (!value) return { method: "GET", paths: [""] };
  if (!ts.isObjectLiteralExpression(value)) return undefined;
  const pathValue = option(value, "path");
  const methodValue = option(value, "method");
  if (pathValue === "unknown" || methodValue === "unknown") return undefined;
  const request = bindings.value(methodValue);
  if (!request) return { method: "GET", paths: paths(bindings.value(pathValue), true) };
  if (!ts.isPropertyAccessExpression(request)) return undefined;
  const binding = bindings.packageBinding(request.expression);
  if (binding?.name !== "RequestMethod" ||
      !(binding.module === "@nestjs/common" || binding.module.startsWith("@nestjs/common/"))) return undefined;
  const method = request.name.text === "ALL" ? "ANY" : request.name.text;
  if (![...methodDecorators.values()].includes(method)) return undefined;
  return { method, paths: paths(bindings.value(pathValue), true) };
}

function parameterProperties(node: ts.ClassLikeDeclaration): Map<string, ts.ParameterDeclaration> {
  const result = new Map<string, ts.ParameterDeclaration>();
  for (const member of node.members) {
    if (!ts.isConstructorDeclaration(member)) continue;
    for (const parameter of member.parameters) {
      if (ts.isIdentifier(parameter.name) && ts.isParameterPropertyDeclaration(parameter, member)) {
        result.set(parameter.name.text, parameter);
      }
    }
  }
  return result;
}

function thisMember(node: ts.Expression): string | undefined {
  return ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword ? node.name.text : undefined;
}

function persistenceHints(
  service: ts.ClassLikeDeclaration,
  method: ts.MethodDeclaration,
  bindings: TypeScriptBindings,
  fileOf: FileOf,
): ExecutionChainNode[] {
  if (!method.body) return [];
  const parameters = parameterProperties(service);
  for (const call of nodes(method.body, true).filter(ts.isCallExpression)) {
    const callee = call.expression;
    if (!ts.isPropertyAccessExpression(callee) || !/^(find|save|create|update|delete|upsert|remove|insert)/.test(callee.name.text)) continue;
    const receiver = callee.expression;
    const repoName = thisMember(receiver);
    const repository = repoName && parameters.get(repoName);
    let entity: string | undefined;
    let entitySource: ts.Node | undefined;
    if (repository) {
      const injection = [...decorators(repository, bindings, "@nestjs/typeorm"),
        ...decorators(repository, bindings, "@nestjs/mongoose")].find(item => ["InjectRepository", "InjectModel"].includes(item.name));
      const type = repository.type;
      const generic = type && ts.isTypeReferenceNode(type) && /^(Repository|Model)$/.test(type.typeName.getText())
        ? type.typeArguments?.[0] : undefined;
      const entityExpression = injection?.args[0] ?? (generic && ts.isTypeReferenceNode(generic) && ts.isIdentifier(generic.typeName)
        ? generic.typeName : undefined);
      if (entityExpression) {
        entity = nameText(entityExpression);
        entitySource = bindings.definition(entityExpression);
      }
    } else if (ts.isPropertyAccessExpression(receiver) && thisMember(receiver.expression) === "prisma") {
      const model = receiver.name.text;
      entity = model[0]!.toUpperCase() + model.slice(1);
    } else if (ts.isIdentifier(receiver) && /^[A-Z]/.test(receiver.text)) {
      const declaration = bindings.definition(receiver);
      if (declaration && ts.isClassLike(declaration) && declaration !== service) {
        entity = receiver.text;
        entitySource = declaration;
      }
    }
    if (!entity) continue;
    const origin = entitySource ?? call;
    return [{
      stage: "repository", symbol: entity + "Repository", file: fileOf(call), line: lineOf(call),
      description: "Persistence call on a repository or model candidate",
    }, {
      stage: "entity", symbol: entity, file: fileOf(origin), line: lineOf(origin),
      description: "Entity inferred from service source",
    }];
  }
  return [];
}

function serviceHints(
  action: ts.MethodDeclaration,
  injections: ReadonlyMap<string, ts.ParameterDeclaration>,
  bindings: TypeScriptBindings,
  fileOf: FileOf,
): ExecutionChainNode[] {
  if (!action.body) return [];
  const hints: ExecutionChainNode[] = [];
  for (const call of nodes(action.body, true).filter(ts.isCallExpression)) {
    const callee = call.expression;
    if (!ts.isPropertyAccessExpression(callee)) continue;
    const property = thisMember(callee.expression);
    const injection = property && injections.get(property);
    const type = injection ? injection.type : undefined;
    if (!type || !ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName)) continue;
    const service = bindings.definition(type.typeName);
    const method = service && ts.isClassLike(service) && service.members.find(member =>
      ts.isMethodDeclaration(member) && nameText(member.name) === callee.name.text && !!member.body,
    );
    const origin = method || call;
    hints.push({
      stage: "service", symbol: type.typeName.text + "::" + callee.name.text,
      file: fileOf(origin), line: lineOf(origin), description: "Injected Service Call",
    });
    if (method && ts.isMethodDeclaration(method) && service && ts.isClassLike(service)) {
      hints.push(...persistenceHints(service, method, bindings, fileOf));
    }
  }
  return hints;
}

export class NestJsSemanticExtractor implements SemanticSliceExtractor {
  public readonly id = "nestjs";
  public readonly name = "NestJS Modular Semantic Extractor";

  public canHandle(projectRoot: string, framework?: string): boolean {
    if (framework === "nestjs" || probeSourcePath(path.join(projectRoot, "nest-cli.json")) === "file") return true;
    const manifest = path.join(projectRoot, "package.json");
    if (probeSourcePath(manifest) !== "file") return false;
    try {
      const pkg = JSON.parse(readOptionalSourceFile(manifest, "utf-8"));
      const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
      return !!(dependencies["@nestjs/common"] || dependencies["@nestjs/core"]);
    } catch { return false; }
  }

  public async extractSlices(
    projectRoot: string,
    domainId?: number,
    signal?: AbortSignal,
    inventory?: SourceInventory,
  ): Promise<VerticalSliceCandidate[]> {
    const root = path.resolve(projectRoot);
    const files = listSourceFiles(root, /\.[cm]?[jt]sx?$/, inventory).filter(file => !/\.d\.[cm]?ts$/.test(file));
    const bindings = new TypeScriptBindings(root, new Set(files), signal);
    const fileOf = (node: ts.Node) => path.relative(root, node.getSourceFile().fileName).replace(/\\/g, "/");
    const slices: VerticalSliceCandidate[] = [];

    for (const file of files) {
      signal?.throwIfAborted();
      const unit = bindings.load(file);
      if (!unit) continue;
      const relPath = fileOf(unit.source);
      for (const node of unit.source.statements) {
        if (!ts.isClassDeclaration(node) || node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AbstractKeyword)) continue;
        const declared = decorators(node, bindings);
        const controller = declared.find(item => item.name === "Controller");
        if (!controller) continue;
        const prefixes = controllerPaths(controller, bindings);
        if (!prefixes?.length) continue;
        const controllerClass = nameText(node.name) ?? "AnonymousController";
        const classGuards = declared.filter(item => item.name === "UseGuards");
        const injections = parameterProperties(node);

        for (const member of node.members) {
          signal?.throwIfAborted();
          if (!ts.isMethodDeclaration(member) || !member.body ||
              member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)) continue;
          const action = nameText(member.name);
          if (!action) continue;
          const declared = decorators(member, bindings);
          const registration = declared.find(item => methodDecorators.has(item.name) || item.name === "RequestMapping");
          if (!registration) continue;
          const route = handlerRoute(registration, bindings);
          if (!route?.method || !route.paths?.length) continue;

          const actionLine = lineOf(member.name);
          const chain: ExecutionChainNode[] = [];
          const guards = new Map<string, ts.Expression>();
          for (const dec of [...classGuards, ...declared.filter(item => item.name === "UseGuards")]) {
            for (const guard of dec.args) guards.set(guard.getText(), guard);
          }
          for (const [symbol, guard] of guards) {
            chain.push({ stage: "guard", symbol, file: relPath, line: lineOf(guard), description: "NestJS Guard Argument" });
          }
          for (const param of member.parameters) {
            if (!decorators(param, bindings).some(item => item.name === "Body")) continue;
            const type = param.type;
            if (type && ts.isTypeReferenceNode(type) && !["Record", "Array", "Promise"].includes(type.typeName.getText())) {
              chain.push({ stage: "validation", symbol: type.typeName.getText(), description: "DTO Validation" });
            }
          }
          chain.push({
            stage: "controller", symbol: controllerClass + "::" + action, file: relPath, line: actionLine,
            description: "NestJS Controller Action",
          }, ...serviceHints(member, injections, bindings, fileOf));

          const routes = new Set(prefixes.flatMap(prefix => route.paths!.map(subpath =>
            "/" + [prefix, subpath].map(value => value.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/"),
          )));
          for (const uri of routes) {
            const ingress: ExecutionChainNode = {
              stage: "ingress", symbol: route.method + " " + uri, file: relPath, line: lineOf(registration.site),
              description: "NestJS Route Decorator",
            };
            slices.push({
              domain_id: domainId ?? null,
              feature_key: `nest.${controllerClass.toLowerCase().replace("controller", "")}.${action}`,
              http_method: route.method, route_uri: uri, route_name: `${controllerClass}.${action}`,
              controller_class: controllerClass, action_name: action, controller_file: relPath,
              controller_line: actionLine, architecture_style: "mvc", entry_kind: "http_route",
              execution_chain_json: JSON.stringify([ingress, ...chain]),
            });
          }
        }
      }
    }
    return slices;
  }
}
