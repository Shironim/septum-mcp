import { probeSourcePath, readOptionalSourceFile } from "../../resources/source-files.ts";
import { listSourceFiles, type SourceInventory } from "../../resources/source-inventory.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { ImportResolver } from "../../resolver/import-resolver.ts";
import type { ExecutionChainNode, VerticalSliceRecord } from "../../../types/index.ts";
import { BehavioralAnalyzer, type MethodBehavioralSummary } from "../behavioral-analyzer.ts";
import { blankCommentsAndStrings } from "../boundary-tracker.ts";
import { parseWithTreeSitter } from "../wasm-loader.ts";
import { readLaravelActions, readLaravelRoutes, type LaravelAction, type ParsedRoute } from "./laravel-routing.ts";
import { SchemaProviderRegistry } from "../schema/schema-provider-registry.ts";
import type {
  SemanticSliceExtractor,
  VerticalSliceCandidate,
} from "./semantic-extractor.interface.ts";

export type { ParsedRoute } from "./laravel-routing.ts";

export type LaravelSemanticExtractionResult = VerticalSliceCandidate[] & {
  slices: VerticalSliceCandidate[];
};

type ControllerDeclarations = { classes: Map<string, Map<string, LaravelAction>>; source: string };

export class LaravelSemanticExtractor implements SemanticSliceExtractor {
  public readonly id = "laravel";
  public readonly name = "Laravel MVC Semantic Extractor";

  constructor(private projectRoot: string = process.cwd(), private inventory?: SourceInventory) {}

  public canHandle(projectRoot: string, framework?: string): boolean {
    if (framework === "laravel") return true;
    return (
      fs.existsSync(path.join(projectRoot, "artisan")) ||
      fs.existsSync(path.join(projectRoot, "routes/web.php")) ||
      fs.existsSync(path.join(projectRoot, "routes/api.php"))
    );
  }

  /**
   * Scan route files and build bounded vertical slices.
   */
  public async extractSlices(
    projectRootOrDomainId?: string | number,
    maybeDomainId?: number,
    signal?: AbortSignal,
    inventory?: SourceInventory
  ): Promise<LaravelSemanticExtractionResult> {
    // The registry reuses one adapter across workspaces. Keep helpers bound to
    // this invocation's root without mutating the shared adapter instance.
    if (typeof projectRootOrDomainId === "string" && (inventory || path.resolve(projectRootOrDomainId) !== path.resolve(this.projectRoot))) {
      return new LaravelSemanticExtractor(projectRootOrDomainId, inventory).extractSlices(maybeDomainId, undefined, signal);
    }
    let root = this.projectRoot;
    let domainId: number | undefined;

    if (typeof projectRootOrDomainId === "string") {
      root = projectRootOrDomainId;
      domainId = maybeDomainId;
    } else if (typeof projectRootOrDomainId === "number") {
      domainId = projectRootOrDomainId;
    }

    const standardRouteFiles = [
      path.join(root, "routes/web.php"),
      path.join(root, "routes/api.php"),
    ].filter((f) => fs.existsSync(f) && (!this.inventory || this.inventory.files.includes(f)));

    const discoveredRouteFiles = listSourceFiles(
      root,
      /(?:^|\/)(?:routes\/[^/]+\.php|[^/]+-routes\.php)$/i,
      this.inventory
    ).filter((f) => !/(?:^|\/)routes\/(?:console|channels)\.php$/i.test(f));

    const routeFiles = [...new Set([...standardRouteFiles, ...discoveredRouteFiles])];
    const includedFiles = new Set<string>();
    const parsedRoutes: ParsedRoute[] = [];

    for (const routeFile of routeFiles) {
      signal?.throwIfAborted();
      if (includedFiles.has(path.resolve(routeFile))) continue;
      const content = readOptionalSourceFile(routeFile, "utf-8");
      const relativeRouteFile = path.relative(root, routeFile).replace(/\\/g, "/");
      const routesFromFile = await this.parseRoutesContentWithIncludes(content, routeFile, root, includedFiles, signal);
      for (const r of routesFromFile) {
        if (!r.file) r.file = relativeRouteFile;
      }
      parsedRoutes.push(...routesFromFile);
    }

    const slices: Array<Omit<VerticalSliceRecord, "id" | "created_at">> = [];

    const resolver = new ImportResolver(root);
    const declarations = new Map<string, ControllerDeclarations>();
    for (const route of parsedRoutes) {
      signal?.throwIfAborted();
      const controllerInfo = await this.resolveController(route, resolver, declarations);
      signal?.throwIfAborted();

      let formRequestInfo: {
        className: string;
        filePath?: string;
        rules: Record<string, string>;
      } | null = null;

      let modelInfo: {
        className: string;
        filePath?: string;
        fillable: string[];
        casts: Record<string, string>;
      } | null = null;

      let frontendInfo: {
        target: string;
        props: string[];
      } | null = null;

      let actionServices: Array<{
        className: string;
        filePath?: string;
        isService: boolean;
      }> = [];

      let behavioralInfo: MethodBehavioralSummary | null = null;
      if (controllerInfo.action) {
        const controllerCode = controllerInfo.action.source;
        const actionBody = controllerInfo.action.body;
        behavioralInfo = BehavioralAnalyzer.analyzeMethod(actionBody);

        // 1. Detect FormRequest in method signature
        const requestClassName = this.detectFormRequestClass(controllerCode, route.actionName);
        if (requestClassName) {
          const reqFile = this.findClassFile("Requests", requestClassName);
          const rules = reqFile && fs.existsSync(reqFile) ? this.extractValidationRules(readOptionalSourceFile(reqFile, "utf-8")) : {};
          formRequestInfo = {
            className: requestClassName,
            filePath: reqFile ? path.relative(this.projectRoot, reqFile) : undefined,
            rules,
          };
        }

        // 2. Detect Model referenced in parameters or action body
        const modelClassName = this.detectModelClass(controllerCode, route.actionName, actionBody);
        if (modelClassName) {
          const modFile = this.findClassFile("Models", modelClassName);
          const modMetadata = modFile && fs.existsSync(modFile) ? this.extractModelMetadata(readOptionalSourceFile(modFile, "utf-8")) : { fillable: [], casts: {} };
          modelInfo = {
            className: modelClassName,
            filePath: modFile ? path.relative(this.projectRoot, modFile) : undefined,
            fillable: modMetadata.fillable,
            casts: modMetadata.casts,
          };
        }

        // 3. Detect Inertia Render / View Target
        frontendInfo = this.detectFrontendTarget(actionBody);

        // 4. Detect Action & Service invocations
        actionServices = this.detectActionAndServiceInvocations(
          controllerCode,
          route.actionName,
          actionBody,
          controllerInfo.constructorSource,
          controllerInfo.fileSource
        );
      }

      const chain: ExecutionChainNode[] = [
        {
          stage: "ingress",
          symbol: `${route.httpMethod.toUpperCase()} ${route.uri.startsWith("/") ? route.uri : `/${route.uri}`}`,
          file: route.file,
          line: route.line,
          description: `HTTP Route: ${route.routeName || route.uri}`,
          relationship: { kind: "declares", derivation: "source", reason: "Laravel facade call" },
        },
      ];

      if (behavioralInfo && behavioralInfo.guards.length > 0) {
        chain.push({
          stage: "guard",
          symbol: behavioralInfo.guards.join(", "),
          description: "Authorization / Security Guard",
          guards: behavioralInfo.guards,
        });
      }

      if (formRequestInfo) {
        chain.push({
          stage: "validation",
          symbol: formRequestInfo.className,
          file: formRequestInfo.filePath,
          description: "Form Request Validation",
        });
      }

      chain.push({
        stage: "controller",
        symbol: `${route.controllerClass}::${route.actionName}`,
        file: controllerInfo.filePath ? path.relative(this.projectRoot, controllerInfo.filePath) : undefined,
        line: controllerInfo.line,
        description: controllerInfo.action || route.handlerLine ? "Controller Action" : "Declared Route Target",
        ...(controllerInfo.action || route.handlerLine ? {
          relationship: { kind: "route_binding", derivation: "source", reason: "Laravel route target" } as const,
        } : {}),
        guards: behavioralInfo && behavioralInfo.guards.length > 0 ? behavioralInfo.guards : undefined,
        mutations: behavioralInfo && behavioralInfo.mutations.length > 0 ? behavioralInfo.mutations : undefined,
        transactions: behavioralInfo?.hasTransaction,
      });

      if (actionServices && actionServices.length > 0) {
        for (const asItem of actionServices) {
          chain.push({
            stage: asItem.isService ? "service" : "action",
            symbol: asItem.className,
            file: asItem.filePath,
            description: asItem.isService ? "Domain Service Invocation" : "Action Invocation",
          });
        }
      }

      if (behavioralInfo && behavioralInfo.hasTransaction) {
        chain.push({
          stage: "transaction",
          symbol: "DB::transaction",
          description: "Database Transaction Scope",
          transactions: true,
        });
      }

      if (modelInfo) {
        const schema = SchemaProviderRegistry.resolveSchema(
          root,
          modelInfo.className,
          modelInfo.filePath
        );

        const columnsSummary =
          schema && schema.fields.length > 0
            ? schema.fields.map((f) => `${f.name}:${f.type}${f.nullable ? "?" : ""}`).join(", ")
            : undefined;

        chain.push({
          stage: "entity",
          symbol: modelInfo.className,
          file: modelInfo.filePath,
          description: schema?.tableName ? `Eloquent Model (${schema.tableName})` : "Eloquent Model",
          table: schema?.tableName,
          schema_file: schema?.schemaSourceFile,
          columns_summary: columnsSummary,
          mutations: behavioralInfo && behavioralInfo.mutations.length > 0 ? behavioralInfo.mutations : undefined,
        });
      }

      if (behavioralInfo && behavioralInfo.dispatchedJobs.length > 0) {
        for (const job of behavioralInfo.dispatchedJobs) {
          const jobFile = this.findClassFile("Jobs", job);
          chain.push({
            stage: "job",
            symbol: job,
            file: jobFile ? path.relative(this.projectRoot, jobFile) : undefined,
            description: "Background Queue Job Dispatched",
            dispatches: [job],
          });
        }
      }

      if (behavioralInfo && behavioralInfo.emittedEvents.length > 0) {
        for (const evt of behavioralInfo.emittedEvents) {
          const evtFile = this.findClassFile("Events", evt);
          chain.push({
            stage: "event",
            symbol: evt,
            file: evtFile ? path.relative(this.projectRoot, evtFile) : undefined,
            description: "Domain Event Emitted",
            emits: [evt],
          });
        }
      }

      if (frontendInfo) {
        chain.push({
          stage: "egress",
          symbol: frontendInfo.target,
          description: "Inertia / Frontend Target",
          payload_props: frontendInfo.props.length > 0 ? frontendInfo.props : undefined,
        });
      }

      slices.push({
        domain_id: domainId ?? null,
        feature_key: route.routeName || null,
        http_method: route.httpMethod.toUpperCase(),
        route_uri: route.uri.startsWith("/") ? route.uri : `/${route.uri}`,
        route_name: route.routeName || null,
        controller_class: route.controllerClass,
        action_name: route.actionName,
        controller_file: controllerInfo.filePath ? path.relative(this.projectRoot, controllerInfo.filePath) : null,
        controller_line: controllerInfo.line,
        architecture_style: "mvc",
        entry_kind: "http_route",
        execution_chain_json: JSON.stringify(chain.map(node => (node.guards || node.mutations || node.emits || node.dispatches || node.transactions) ? { ...node, semantic_analysis: "lexical_heuristic" } : node)),
      });
    }

    // Also discover Omni-Trigger slices (Jobs, Console Commands, Event Listeners)
    slices.push(...this.extractJobSlices(root, domainId));
    slices.push(...this.extractCommandSlices(root, domainId));
    slices.push(...this.extractListenerSlices(root, domainId));

    return Object.assign(slices, { slices });
  }

  public async parseRoutesContent(content: string, signal?: AbortSignal): Promise<ParsedRoute[]> {
    if (!content.trim()) return [];
    // Direct parser callers also supply PHP snippets without the opening tag.
    const source = /^\s*<\?php\b/i.test(content) ? content : "<?php " + content;
    const routes = await parseWithTreeSitter("php", source, root => readLaravelRoutes(root, signal));
    signal?.throwIfAborted();
    if (!routes) throw new Error("Laravel route AST extraction failed.");
    return routes;
  }

  private async parseRoutesContentWithIncludes(
    content: string,
    routeFile: string,
    projectRoot: string,
    includedFiles: Set<string>,
    signal?: AbortSignal,
    visited = new Set<string>()
  ): Promise<ParsedRoute[]> {
    if (!content.trim()) return [];
    const absRoute = path.resolve(routeFile);
    if (visited.has(absRoute)) return [];
    visited.add(absRoute);

    const relRoute = path.relative(projectRoot, absRoute).replace(/\\/g, "/");
    const pendingIncludes: Array<{ targetFile: string; prefix: string; name: string }> = [];
    const source = /^\s*<\?php\b/i.test(content) ? content : "<?php " + content;
    const routes = await parseWithTreeSitter("php", source, (root) =>
      readLaravelRoutes(root, signal, (spec, group) => {
        const cleaned = spec.replace(/^['"]|['"]$/g, "").trim();
        if (!cleaned) return undefined;
        const target = path.resolve(path.dirname(absRoute), cleaned);
        if (probeSourcePath(target) === "file") {
          pendingIncludes.push({ targetFile: target, prefix: group.prefix, name: group.name });
        }
        return undefined;
      })
    );
    signal?.throwIfAborted();
    if (!routes) throw new Error("Laravel route AST extraction failed.");
    for (const r of routes) r.file = relRoute;

    for (const inc of pendingIncludes) {
      includedFiles.add(path.resolve(inc.targetFile));
      const incContent = readOptionalSourceFile(inc.targetFile, "utf-8");
      const incRoutes = await this.parseRoutesContentWithIncludes(incContent, inc.targetFile, projectRoot, includedFiles, signal, visited);
      for (const r of incRoutes) {
        const joinedUri = "/" + [inc.prefix, r.uri].map((v) => v.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
        r.uri = joinedUri;
        if (inc.name && r.routeName) r.routeName = inc.name + r.routeName;
        routes.push(r);
      }
    }

    return routes;
  }

  private async resolveController(
    route: ParsedRoute,
    resolver: ImportResolver,
    declarations: Map<string, ControllerDeclarations>,
  ): Promise<{ filePath?: string; line: number; action?: LaravelAction; constructorSource?: string; fileSource?: string }> {
    if (route.handlerLine && route.file) {
      return { filePath: path.join(this.projectRoot, route.file), line: route.handlerLine };
    }
    if (["Closure", "View"].includes(route.controllerClass) || route.controllerTarget === "") return { line: 0 };

    const target = route.controllerTarget;
    const shortName = (target ?? route.controllerClass).split("\\").at(-1)!;
    let candidates: string[] = [];
    if (target) {
      const source = route.file ?? "routes/web.php";
      const resolution = resolver.resolve(target, source);
      if (resolution.status === "resolved") {
        candidates = resolution.targets.flatMap(item => item.files).map(file => path.resolve(this.projectRoot, file));
      } else if (resolution.reason === "php_namespace_not_mapped" && target.startsWith("App\\Http\\Controllers\\") &&
          probeSourcePath(path.join(this.projectRoot, "composer.json")) === "missing") {
        candidates = [path.join(this.projectRoot, "app", target.slice(4).replace(/\\/g, "/") + ".php")];
      }
    } else {
      candidates = ["", "Api", "Admin"].map(directory =>
        path.join(this.projectRoot, "app/Http/Controllers", directory, shortName + ".php"));
    }
    if (candidates.every((c) => probeSourcePath(c) !== "file") && this.inventory) {
      const namespaceTail = (target ?? route.controllerClass).replace(/^\\/, "").replace(/\\/g, "/");
      const tailMatches = this.inventory.files.filter(
        (f) => f.endsWith(`/${namespaceTail}.php`) || f.endsWith(`/${shortName}.php`)
      );
      if (tailMatches.length > 0) candidates.push(...tailMatches);
    }
    const matches = [...new Set(candidates)].filter(file => probeSourcePath(file) === "file");
    if (matches.length !== 1) return { line: 0 };
    const filePath = matches[0]!;
    let declaration = declarations.get(filePath);
    if (!declaration) {
      const source = readOptionalSourceFile(filePath, "utf-8");
      const classes = await parseWithTreeSitter("php", source, readLaravelActions);
      if (!classes) throw new Error("Laravel controller AST extraction failed for " + path.relative(this.projectRoot, filePath));
      declaration = { classes, source };
      declarations.set(filePath, declaration);
    }
    const { classes, source: fileSource } = declaration;
    const targetKey = target?.toLowerCase();
    const names = [...classes.keys()].filter(name => name.split("\\").at(-1) === shortName.toLowerCase());
    const selected = targetKey
      ? classes.get(targetKey)
      : names.length === 1 ? classes.get(names[0]!) : undefined;
    const action = selected?.get(route.actionName.toLowerCase());
    if (!action) return { line: 0 };
    return { filePath, line: action.line, action, constructorSource: selected?.get("__construct")?.source, fileSource };
  }

  private extractActionBody(controllerCode: string, actionName: string): string {
    const cleanCode = blankCommentsAndStrings(controllerCode, { hashComments: true });
    const fnRegex = new RegExp(`(?:public\\s+)?function\\s+${actionName}\\s*\\([^{]*\\)\\s*\\{`, "i");
    const match = fnRegex.exec(cleanCode);
    if (!match) return "";

    const startIndex = match.index + match[0].length;
    let braceDepth = 1;
    let endIndex = startIndex;

    while (braceDepth > 0 && endIndex < cleanCode.length) {
      const char = cleanCode[endIndex];
      if (char === "{") braceDepth++;
      else if (char === "}") braceDepth--;
      endIndex++;
    }

    return controllerCode.substring(startIndex, endIndex - 1);
  }

  private detectFormRequestClass(controllerCode: string, actionName: string): string | null {
    const paramRegex = new RegExp(`public\\s+function\\s+${actionName}\\s*\\(([^)]*)\\)`, "i");
    const match = paramRegex.exec(controllerCode);
    if (!match) return null;

    const params = match[1];
    // Find class names ending with Request
    const reqMatch = params.match(/([A-Za-z0-9_]+Request)\s+\$/);
    if (reqMatch && reqMatch[1] !== "Request") {
      return reqMatch[1];
    }
    return null;
  }

  private detectModelClass(controllerCode: string, actionName: string, actionBody: string): string | null {
    // 1. Method signature type-hints: (Order $order)
    const paramRegex = new RegExp(`public\\s+function\\s+${actionName}\\s*\\(([^)]*)\\)`, "i");
    const match = paramRegex.exec(controllerCode);
    if (match) {
      const parts = match[1].split(",");
      for (const p of parts) {
        const pMatch = p.trim().match(/^([A-Z][A-Za-z0-9_]+)\s+\$/);
        if (
          pMatch &&
          !pMatch[1].endsWith("Request") &&
          pMatch[1] !== "Request" &&
          !/(Action|Service|UseCase)$/i.test(pMatch[1])
        ) {
          return pMatch[1];
        }
      }
    }

    // 2. Action body static calls: Order::find(), Order::create(), Order::query()
    const staticModelMatch = actionBody.match(/([A-Z][A-Za-z0-9_]+)::(?:find|findOrFail|create|where|query)\s*\(/);
    if (staticModelMatch && !["Inertia", "Route", "DB", "Auth", "Log", "Response"].includes(staticModelMatch[1])) {
      return staticModelMatch[1];
    }

    return null;
  }

  private detectFrontendTarget(actionBody: string): { target: string; props: string[] } | null {
    // 1. Inertia::render('Orders/Show', ['order' => $order])
    const inertiaMatch = actionBody.match(/Inertia::render\s*\(\s*['"]([^'"]+)['"](?:\s*,\s*\[([\s\S]*?)\])?\s*\)/);
    if (inertiaMatch) {
      const pageComponent = inertiaMatch[1]; // e.g. "Orders/Show"
      const rawProps = inertiaMatch[2] || "";

      // Extract prop keys: 'order' => ... or "order" => ... or order => ...
      const propMatches = rawProps.matchAll(/['"]?([A-Za-z0-9_]+)['"]?\s*=>/g);
      const props: string[] = [];
      for (const pm of propMatches) {
        if (!props.includes(pm[1])) {
          props.push(pm[1]);
        }
      }

      // Check for Vue, TSX, JSX files in resources/js/Pages
      const possibleExtensions = [".vue", ".tsx", ".jsx", ".svelte"];
      let frontendPath = `resources/js/Pages/${pageComponent}`;
      for (const ext of possibleExtensions) {
        const fullCandidate = path.join(this.projectRoot, `resources/js/Pages/${pageComponent}${ext}`);
        if (fs.existsSync(fullCandidate)) {
          frontendPath = `resources/js/Pages/${pageComponent}${ext}`;
          break;
        }
      }
      if (!frontendPath.includes(".")) {
        frontendPath += ".vue"; // Default inertia convention
      }

      return {
        target: frontendPath,
        props,
      };
    }

    // 2. view('orders.show', compact('order'))
    const viewMatch = actionBody.match(/view\s*\(\s*['"]([^'"]+)['"]/);
    if (viewMatch) {
      const viewPath = viewMatch[1].replace(/\./g, "/");
      return {
        target: `resources/views/${viewPath}.blade.php`,
        props: [],
      };
    }

    return null;
  }

  private detectActionAndServiceInvocations(
    controllerCode: string,
    actionName: string,
    actionBody: string,
    constructorSource?: string,
    fileSource: string = controllerCode
  ): Array<{
    className: string;
    filePath?: string;
    isService: boolean;
  }> {
    const detected = new Map<string, { className: string; filePath?: string; isService: boolean }>();

    // 1. Check method parameters of actionName
    const methodRegex = new RegExp(
      `(?:public|protected|private)?\\s*function\\s+${actionName}\\s*\\(([^)]*)\\)`,
      "i"
    );
    const methodMatch = controllerCode.match(methodRegex);
    if (methodMatch && methodMatch[1]) {
      const params = methodMatch[1].split(",");
      for (const param of params) {
        const cleanParam = param.trim().replace(/^(?:public|protected|private)?\s*(?:readonly)?\s*/i, "").trim();
        const parts = cleanParam.split(/\s+/);
        if (parts.length >= 2) {
          const typehint = parts[0].replace(/^\\/, "").trim();
          if (/(Action|Service|UseCase)$/i.test(typehint)) {
            const shortName = typehint.split("\\").pop() || typehint;
            const isService = /Service$/i.test(shortName);
            const folder = isService ? "Services" : "Actions";
            const file = this.findClassFile(folder, shortName);
            detected.set(shortName, {
              className: shortName,
              filePath: file ? path.relative(this.projectRoot, file) : undefined,
              isService,
            });
          }
        }
      }
    }

    // 2. Check constructor injection
    const ctorMatch = constructorSource?.match(/function\s+__construct\s*\(([^)]*)\)/i);
    if (ctorMatch && ctorMatch[1]) {
      const params = ctorMatch[1].split(",");
      for (const param of params) {
        const cleanParam = param.trim().replace(/^(?:public|protected|private)?\s*(?:readonly)?\s*/i, "").trim();
        const parts = cleanParam.split(/\s+/);
        if (parts.length >= 2) {
          const typehint = parts[0].replace(/^\\/, "").trim();
          if (/(Action|Service|UseCase)$/i.test(typehint)) {
            const shortName = typehint.split("\\").pop() || typehint;
            const isService = /Service$/i.test(shortName);
            const propName = shortName.charAt(0).toLowerCase() + shortName.slice(1);
            if (
              actionBody.includes(shortName) ||
              actionBody.includes(`$this->${propName}`) ||
              actionBody.toLowerCase().includes(propName.toLowerCase())
            ) {
              const folder = isService ? "Services" : "Actions";
              const file = this.findClassFile(folder, shortName);
              detected.set(shortName, {
                className: shortName,
                filePath: file ? path.relative(this.projectRoot, file) : undefined,
                isService,
              });
            }
          }
        }
      }
    }

    // 3. Check static calls or class instantiations inside actionBody
    const actionServicePattern = /\b([A-Z][a-zA-Z0-9_]*(?:Action|Service|UseCase))\b(?:::|::class|\s*\(|\s*;)/g;
    let match: RegExpExecArray | null;
    while ((match = actionServicePattern.exec(actionBody)) !== null) {
      const cls = match[1];
      if (!detected.has(cls)) {
        const isService = /Service$/i.test(cls);
        const folder = isService ? "Services" : "Actions";
        const file = this.findClassFile(folder, cls);
        detected.set(cls, {
          className: cls,
          filePath: file ? path.relative(this.projectRoot, file) : undefined,
          isService,
        });
      }
    }

    // 4. Also scan 'use' imports in controller for App\Actions\... or App\Services\...
    const usePattern = /use\s+App\\(Actions|Services)\\(?:[a-zA-Z0-9_\\]+\\)?([A-Z][a-zA-Z0-9_]*);/g;
    while ((match = usePattern.exec(fileSource)) !== null) {
      const folder = match[1];
      const cls = match[2];
      if (actionBody.includes(cls) && !detected.has(cls)) {
        const isService = folder === "Services" || /Service$/i.test(cls);
        const file = this.findClassFile(folder, cls);
        detected.set(cls, {
          className: cls,
          filePath: file ? path.relative(this.projectRoot, file) : undefined,
          isService,
        });
      }
    }

    return Array.from(detected.values());
  }

  private findClassFile(
    subDir: "Requests" | "Models" | "Jobs" | "Events" | "Listeners" | "Console/Commands" | "Actions" | "Services" | string,
    className: string
  ): string | null {
    const directPath = path.join(this.projectRoot, `app/${subDir}/${className}.php`);
    if (fs.existsSync(directPath)) return directPath;

    // Direct app/ fallback for older Laravel
    const flatPath = path.join(this.projectRoot, `app/${className}.php`);
    if (fs.existsSync(flatPath)) return flatPath;

    if (className.includes("\\")) {
      const res = new ImportResolver(this.projectRoot).resolve(className, path.join(this.projectRoot, "routes/web.php"));
      if (res.status === "resolved" && res.targets[0]?.files?.[0]) {
        return path.resolve(this.projectRoot, res.targets[0].files[0]);
      }
    }

    return null;
  }

  private extractValidationRules(requestCode: string): Record<string, string> {
    const rules: Record<string, string> = {};
    const body = this.extractActionBody(requestCode, "rules");
    if (!body) return rules;

    // Match 'status' => 'in:pending,paid' or 'status' => ['required', 'string']
    const rulePairRegex = /['"]([A-Za-z0-9_]+)['"]\s*=>\s*(?:['"]([^'"]+)['"]|\[([^\]]+)\])/g;
    let rm;
    while ((rm = rulePairRegex.exec(body)) !== null) {
      const field = rm[1];
      const singleRule = rm[2];
      const arrayRules = rm[3];
      if (singleRule) {
        rules[field] = singleRule;
      } else if (arrayRules) {
        rules[field] = arrayRules.replace(/['"\s]/g, "").replace(/,/g, "|");
      }
    }

    return rules;
  }

  private extractModelMetadata(modelCode: string): { fillable: string[]; casts: Record<string, string> } {
    const fillable: string[] = [];
    const casts: Record<string, string> = {};

    // Match protected $fillable = [...]
    const fillableMatch = modelCode.match(/\$fillable\s*=\s*\[([^\]]*)\]/);
    if (fillableMatch) {
      const items = fillableMatch[1].matchAll(/['"]([A-Za-z0-9_]+)['"]/g);
      for (const it of items) {
        fillable.push(it[1]);
      }
    }

    // Match protected $casts = [...]
    const castsMatch = modelCode.match(/\$casts\s*=\s*\[([^\]]*)\]/);
    if (castsMatch) {
      const castItems = castsMatch[1].matchAll(/['"]([A-Za-z0-9_]+)['"]\s*=>\s*(?:['"]([^'"]+)['"]|([A-Za-z0-9_]+)::class)/g);
      for (const ci of castItems) {
        casts[ci[1]] = ci[2] || ci[3];
      }
    }

    return { fillable, casts };
  }

  private extractJobSlices(
    root: string,
    domainId?: number
  ): Array<Omit<VerticalSliceRecord, "id" | "created_at">> {
    const jobsDir = path.join(root, "app/Jobs");
    if (!fs.existsSync(jobsDir)) return [];

    const jobFiles = listSourceFiles(jobsDir, /\.php$/, this.inventory).filter(file => path.dirname(file) === jobsDir).map(file => path.basename(file));
    const slices: Array<Omit<VerticalSliceRecord, "id" | "created_at">> = [];

    for (const file of jobFiles) {
      const fullPath = path.join(jobsDir, file);
      const content = readOptionalSourceFile(fullPath, "utf-8");
      const classMatch = content.match(/class\s+([A-Za-z0-9_]+)/);
      if (!classMatch) continue;

      const className = classMatch[1];
      const actionBody = this.extractActionBody(content, "handle");
      const behavior = BehavioralAnalyzer.analyzeMethod(actionBody);

      const chain: ExecutionChainNode[] = [
        {
          stage: "ingress",
          symbol: `JOB ${className}`,
          file: path.relative(this.projectRoot, fullPath),
          description: `Queue Worker Trigger: ${className}`,
        },
        {
          stage: "controller",
          symbol: `${className}::handle`,
          file: path.relative(this.projectRoot, fullPath),
          description: "Queue Job Handler",
          mutations: behavior.mutations.length ? behavior.mutations : undefined,
          transactions: behavior.hasTransaction,
        },
      ];

      if (behavior.hasTransaction) {
        chain.push({
          stage: "transaction",
          symbol: "DB::transaction",
          description: "Database Transaction Scope",
          transactions: true,
        });
      }

      for (const evt of behavior.emittedEvents) {
        const evtFile = this.findClassFile("Events", evt);
        chain.push({
          stage: "event",
          symbol: evt,
          file: evtFile ? path.relative(this.projectRoot, evtFile) : undefined,
          description: "Domain Event Emitted",
          emits: [evt],
        });
      }

      slices.push({
        domain_id: domainId ?? null,
        feature_key: `job:${className}`,
        http_method: "JOB",
        route_uri: `job:${className}`,
        route_name: `queue.${this.toSnakeCase(className)}`,
        controller_class: className,
        action_name: "handle",
        controller_file: path.relative(this.projectRoot, fullPath),
        controller_line: 1,
        architecture_style: "clean",
        entry_kind: "queue_job",
        execution_chain_json: JSON.stringify(chain.map(node => (node.guards || node.mutations || node.emits || node.dispatches || node.transactions) ? { ...node, semantic_analysis: "lexical_heuristic" } : node)),
      });
    }

    return slices;
  }

  private extractCommandSlices(
    root: string,
    domainId?: number
  ): Array<Omit<VerticalSliceRecord, "id" | "created_at">> {
    const commandsDir = path.join(root, "app/Console/Commands");
    if (!fs.existsSync(commandsDir)) return [];

    const files = listSourceFiles(commandsDir, /\.php$/, this.inventory).filter(file => path.dirname(file) === commandsDir).map(file => path.basename(file));
    const slices: Array<Omit<VerticalSliceRecord, "id" | "created_at">> = [];

    for (const file of files) {
      const fullPath = path.join(commandsDir, file);
      const content = readOptionalSourceFile(fullPath, "utf-8");
      const classMatch = content.match(/class\s+([A-Za-z0-9_]+)/);
      if (!classMatch) continue;

      const className = classMatch[1];
      const sigMatch = content.match(/protected\s+\$signature\s*=\s*['"]([^'"]+)['"]/);
      const commandSignature = sigMatch ? sigMatch[1].split(/\s+/)[0] : this.toSnakeCase(className);

      const handleMatch = content.match(/\bfunction\s+handle\s*\(/);
      const handleLine = handleMatch && handleMatch.index !== undefined
        ? content.slice(0, handleMatch.index).split("\n").length
        : 1;
      const actionBody = this.extractActionBody(content, "handle");
      const behavior = BehavioralAnalyzer.analyzeMethod(actionBody);

      const chain: ExecutionChainNode[] = [
        {
          stage: "ingress",
          symbol: `CLI ${commandSignature}`,
          file: path.relative(this.projectRoot, fullPath),
          line: handleLine,
          description: `Console Command: ${commandSignature}`,
        },
        {
          stage: "controller",
          symbol: `${className}::handle`,
          file: path.relative(this.projectRoot, fullPath),
          line: handleLine,
          description: "Command Execution Handler",
          mutations: behavior.mutations.length ? behavior.mutations : undefined,
          transactions: behavior.hasTransaction,
        },
      ];

      if (behavior.hasTransaction) {
        chain.push({
          stage: "transaction",
          symbol: "DB::transaction",
          description: "Database Transaction Scope",
          transactions: true,
        });
      }

      for (const job of behavior.dispatchedJobs) {
        const jobFile = this.findClassFile("Jobs", job);
        chain.push({
          stage: "job",
          symbol: job,
          file: jobFile ? path.relative(this.projectRoot, jobFile) : undefined,
          description: "Dispatched Background Worker",
          dispatches: [job],
        });
      }

      slices.push({
        domain_id: domainId ?? null,
        feature_key: `command:${commandSignature}`,
        http_method: "CLI",
        route_uri: `command:${commandSignature}`,
        route_name: `cli.${commandSignature}`,
        controller_class: className,
        action_name: "handle",
        controller_file: path.relative(this.projectRoot, fullPath),
        controller_line: handleLine,
        architecture_style: "clean",
        entry_kind: "scheduled_command",
        execution_chain_json: JSON.stringify(chain.map(node => (node.guards || node.mutations || node.emits || node.dispatches || node.transactions) ? { ...node, semantic_analysis: "lexical_heuristic" } : node)),
      });
    }

    return slices;
  }

  private extractListenerSlices(
    root: string,
    domainId?: number
  ): Array<Omit<VerticalSliceRecord, "id" | "created_at">> {
    const listenersDir = path.join(root, "app/Listeners");
    if (!fs.existsSync(listenersDir)) return [];

    const files = listSourceFiles(listenersDir, /\.php$/, this.inventory).filter(file => path.dirname(file) === listenersDir).map(file => path.basename(file));
    const slices: Array<Omit<VerticalSliceRecord, "id" | "created_at">> = [];

    for (const file of files) {
      const fullPath = path.join(listenersDir, file);
      const content = readOptionalSourceFile(fullPath, "utf-8");
      const classMatch = content.match(/class\s+([A-Za-z0-9_]+)/);
      if (!classMatch) continue;

      const className = classMatch[1];
      const actionBody = this.extractActionBody(content, "handle");
      const behavior = BehavioralAnalyzer.analyzeMethod(actionBody);

      const eventParamMatch = content.match(/public\s+function\s+handle\s*\(\s*([A-Za-z0-9_]+)\s+\$event\s*\)/i);
      const listenedEvent = eventParamMatch ? eventParamMatch[1] : undefined;

      const chain: ExecutionChainNode[] = [
        {
          stage: "ingress",
          symbol: `EVENT ${listenedEvent || className}`,
          file: path.relative(this.projectRoot, fullPath),
          description: `Event Listener Trigger${listenedEvent ? ` for [${listenedEvent}]` : ""}`,
        },
        {
          stage: "controller",
          symbol: `${className}::handle`,
          file: path.relative(this.projectRoot, fullPath),
          description: "Event Listener Handler",
          mutations: behavior.mutations.length ? behavior.mutations : undefined,
          transactions: behavior.hasTransaction,
        },
      ];

      if (behavior.hasTransaction) {
        chain.push({
          stage: "transaction",
          symbol: "DB::transaction",
          description: "Database Transaction Scope",
          transactions: true,
        });
      }

      for (const job of behavior.dispatchedJobs) {
        const jobFile = this.findClassFile("Jobs", job);
        chain.push({
          stage: "job",
          symbol: job,
          file: jobFile ? path.relative(this.projectRoot, jobFile) : undefined,
          description: "Dispatched Background Worker",
          dispatches: [job],
        });
      }

      slices.push({
        domain_id: domainId ?? null,
        feature_key: `listener:${className}`,
        http_method: "EVENT",
        route_uri: `event:${className}`,
        route_name: `event.${this.toSnakeCase(className)}`,
        controller_class: className,
        action_name: "handle",
        controller_file: path.relative(this.projectRoot, fullPath),
        controller_line: 1,
        architecture_style: "clean",
        entry_kind: "event_listener",
        execution_chain_json: JSON.stringify(chain.map(node => (node.guards || node.mutations || node.emits || node.dispatches || node.transactions) ? { ...node, semantic_analysis: "lexical_heuristic" } : node)),
      });
    }

    return slices;
  }

  private toSnakeCase(str: string): string {
    return str
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
      .toLowerCase();
  }
}
