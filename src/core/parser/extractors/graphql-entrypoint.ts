import type { ExecutionChainNode } from "../../../types/index.ts";
import type { VerticalSliceCandidate } from "./semantic-extractor.interface.ts";

export interface GraphQLDetectionInput {
  uri?: string;
  handlerName?: string;
  baseClasses?: string[];
  qualifiedTarget?: string;
}

const GRAPHQL_HANDLER_PATTERN =
  /(?:^|[.:/\\])(?:Async)?GraphQL(?:View|Controller|Handler|App|Router|Server|Middleware|Endpoint)\b|\b(?:graphqlHTTP|createYoga|expressMiddleware|apolloServer|mercurius)\b/i;

const GRAPHQL_URI_PATTERN = /(?:^|\/)graphql\/?$/i;

/**
 * Shared multi-framework predicate determining whether a route/handler represents
 * a GraphQL entrypoint across Python, TypeScript/JS, Go, and PHP adapters.
 */
export function isGraphQLRouteOrHandler(input: GraphQLDetectionInput): boolean {
  if (input.handlerName && GRAPHQL_HANDLER_PATTERN.test(input.handlerName)) {
    return true;
  }
  if (input.qualifiedTarget && GRAPHQL_HANDLER_PATTERN.test(input.qualifiedTarget)) {
    return true;
  }
  if (input.baseClasses?.some((base) => GRAPHQL_HANDLER_PATTERN.test(base))) {
    return true;
  }
  if (input.uri && GRAPHQL_URI_PATTERN.test(input.uri.trim())) {
    const combined = `${input.handlerName ?? ""} ${input.qualifiedTarget ?? ""} ${(input.baseClasses ?? []).join(" ")}`;
    return /\b(?:graphql|dispatch|schema|yoga|apollo|mercurius|strawberry|ariadne|graphene)\b/i.test(combined);
  }
  return false;
}

export interface GraphQLSliceOptions {
  domainId?: number | null;
  frameworkStyle: string;
  httpMethod: string;
  uri: string;
  routeName?: string;
  controllerClass: string;
  actionName: string;
  controllerFile: string;
  controllerLine: number;
  routeFile: string;
  routeLine: number;
  schemaSymbol?: string;
  description?: string;
  inferredAction?: boolean;
}

/**
 * Builds a standardized VerticalSliceCandidate for GraphQL endpoints so all
 * framework adapters emit consistent ingress, handler, and schema nodes.
 */
export function buildGraphQLSliceCandidate(options: GraphQLSliceOptions): VerticalSliceCandidate {
  const method = options.httpMethod.toUpperCase();
  const chain: ExecutionChainNode[] = [
    {
      stage: "ingress",
      symbol: `${method} ${options.uri}`,
      file: options.routeFile,
      line: options.routeLine,
      description: options.description ?? "GraphQL Endpoint Registration",
      relationship: {
        kind: "route_binding",
        derivation: "source",
        source: { file: options.routeFile, line: options.routeLine },
        reason: options.description ?? "GraphQL Endpoint Registration",
      },
    },
    {
      stage: "controller",
      symbol: `${options.controllerClass}::${options.actionName}`,
      file: options.controllerFile,
      line: options.controllerLine,
      description: options.inferredAction
        ? "Inherited GraphQL View Handler (line points to class)"
        : "GraphQL View Handler",
      relationship: {
        kind: "route_binding",
        derivation: options.inferredAction ? "inferred" : "source",
        source: { file: options.controllerFile, line: options.controllerLine },
        reason: options.inferredAction
          ? "Inherited GraphQL View Handler"
          : "GraphQL View Handler",
      },
    },
  ];

  if (options.schemaSymbol) {
    chain.push({
      stage: "validation",
      symbol: options.schemaSymbol,
      description: "GraphQL Schema Binding",
      relationship: {
        kind: "schema_binding",
        derivation: "source",
        source: { file: options.routeFile, line: options.routeLine },
        reason: "GraphQL Schema Binding",
      },
    });
  }

  return {
    domain_id: options.domainId ?? null,
    feature_key: null,
    http_method: method,
    route_uri: options.uri,
    route_name: options.routeName || `${options.controllerClass}.${options.actionName}`,
    controller_class: options.controllerClass,
    action_name: options.actionName,
    controller_file: options.controllerFile,
    controller_line: options.controllerLine,
    architecture_style: options.frameworkStyle,
    entry_kind: "http_route",
    execution_chain_json: JSON.stringify(chain),
  };
}

/**
 * Shared post-extraction normalizer used by slice-catalog so any framework adapter
 * emitting a GraphQL route receives a consistent `<framework>-graphql` style.
 */
export function normalizeGraphQLEntrypoints(slices: VerticalSliceCandidate[]): VerticalSliceCandidate[] {
  return slices.map((slice) => {
    if (slice.entry_kind !== "http_route") return slice;
    if (slice.architecture_style.endsWith("graphql")) return slice;
    if (
      !isGraphQLRouteOrHandler({
        uri: slice.route_uri,
        handlerName: `${slice.controller_class}.${slice.action_name}`,
      })
    ) {
      return slice;
    }
    const baseStyle = slice.architecture_style.replace(/-(?:mvc|api|drf|http)$/, "");
    const frameworkStyle = baseStyle === "mvc" ? "graphql" : `${baseStyle}-graphql`;
    return {
      ...slice,
      architecture_style: frameworkStyle,
    };
  });
}
