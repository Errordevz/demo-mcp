/**
 * OpenAPI 3.x / Swagger 2.0 inspector (DEMO 0.9).
 *
 * Reads a *document* — JSON or YAML — and reports what an agent needs to
 * understand an API: title/version, servers, paths, methods, parameters,
 * request bodies, response schemas, security schemes and reusable components.
 * Safety rules: the inspector NEVER calls the APIs it discovers, never
 * resolves `$ref`s to remote documents (network refs are refused, internal
 * `#/...` refs are followed locally only), and never obtains or exposes
 * credentials — security schemes are reported by *name and type*, never values.
 */

import { BrowserError } from "../core/errors.js";
import { LIMITS, clamp } from "../core/limits.js";
import { parseYamlLite } from "./yaml.js";

export interface OperationSummary {
  path: string;
  method: string;
  operationId: string | null;
  summary: string | null;
  description: string | null;
  deprecated: boolean;
  tags: string[];
  parameters: Array<{ name: string; in: string; required: boolean; type: string | null; description: string | null; schemaRef: string | null }>;
  requestBody: { required: boolean; contentTypes: string[]; schemaSummary: string | null; schemaRef: string | null } | null;
  responses: Array<{ status: string; description: string | null; contentTypes: string[]; schemaSummary: string | null; schemaRef: string | null }>;
  security: Array<Record<string, string[]>>;
}

export interface OpenApiReport {
  specification: "openapi3" | "swagger2" | "unknown";
  /** The document's spec version (the openapi/swagger key). */
  specificationVersion: string | null;
  /** The API's own version (info.version). */
  version: string | null;
  title: string | null;
  description: string | null;
  servers: Array<{ url: string; description: string | null }>;
  operations: OperationSummary[];
  securitySchemes: Array<{ name: string; type: string; scheme: string | null; in: string | null; flows: string[] | null; description: string | null; apiKeyName: string | null }>;
  components: { schemas: Array<{ name: string; type: string | null; properties: string[]; ref: string }>; parameters: number; requestBodies: number; responses: number };
  tags: Array<{ name: string; description: string | null }>;
  stats: { paths: number; operations: number; operationsByMethod: Record<string, number>; deprecated: number };
  warnings: string[];
  limitations: string[];
  notes: string[];
}

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

export function parseOpenApiDocument(source: string): { document: unknown; warnings: string[] } {
  const trimmed = source.replace(/^\uFEFF/, "").trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { document: JSON.parse(source), warnings: [] };
    } catch (error) {
      throw new BrowserError("invalid_input", `The document looked like JSON but did not parse: ${String(error instanceof Error ? error.message : error).slice(0, 160)}`, { retryable: false });
    }
  }
  const result = parseYamlLite(source);
  return { document: result.value, warnings: result.warnings };
}

export function inspectOpenApi(document: unknown, options: { maxEndpoints?: number } = {}): OpenApiReport {
  const warnings: string[] = [];
  const limitations: string[] = [];
  const notes = [
    "DEMO read this document; it did not call any endpoint listed here and must not be asked to use credentials with them.",
    "Security schemes are reported by name/type only — DEMO never obtains, stores or exposes API credentials.",
  ];
  const maxEndpoints = clamp(options.maxEndpoints ?? LIMITS.openapiMaxEndpointsCap, 1, LIMITS.openapiMaxEndpointsCap);
  if (!document || typeof document !== "object") {
    throw new BrowserError("invalid_input", "The document root is not a mapping; this does not look like an OpenAPI/Swagger document.", { retryable: false });
  }
  const root = document as Record<string, unknown>;
  const isSwagger2 = typeof root.swagger === "string" && root.swagger.startsWith("2");
  const isOpenApi3 = typeof root.openapi === "string";
  const specification: OpenApiReport["specification"] = isOpenApi3 ? "openapi3" : isSwagger2 ? "swagger2" : "unknown";
  if (specification === "unknown") {
    warnings.push('Neither an "openapi" (3.x) nor a "swagger" (2.x) version key was found; the inspector still tried to read the document.');
  }
  const specificationVersion = (isOpenApi3 ? root.openapi : isSwagger2 ? root.swagger : null) as string | null;
  const info = asRecord(root.info);
  const title = str(info?.title, 300);
  const description = str(info?.description, 2_000);
  const version = str(info?.version, 40);

  // Servers (3.x) or host/basePath/schemes (2.x).
  const servers: Array<{ url: string; description: string | null }> = [];
  if (Array.isArray(root.servers)) {
    for (const entry of root.servers.slice(0, 20)) {
      const server = asRecord(entry);
      if (server?.url) servers.push({ url: String(server.url).slice(0, 500), description: str(server.description, 200) });
    }
  } else if (isSwagger2 && root.host) {
    const schemes = Array.isArray(root.schemes) ? (root.schemes as unknown[]).map(String) : ["https"];
    const basePath = typeof root.basePath === "string" ? root.basePath : "/";
    for (const scheme of schemes.slice(0, 5)) servers.push({ url: `${scheme}://${String(root.host)}${basePath}`, description: "derived from swagger 2.0 host/basePath/schemes" });
  }

  // Security schemes.
  const securitySchemes: OpenApiReport["securitySchemes"] = [];
  const securitySource = isOpenApi3 ? asRecord(asRecord(root.components)?.securitySchemes) : asRecord(root.securityDefinitions);
  if (securitySource) {
    for (const [name, raw] of Object.entries(securitySource).slice(0, 30)) {
      const scheme = asRecord(raw);
      if (!scheme) continue;
      const flows = scheme.flows && typeof scheme.flows === "object" ? Object.keys(scheme.flows as Record<string, unknown>).slice(0, 6) : null;
      securitySchemes.push({
        name,
        type: String(scheme.type ?? "unknown"),
        scheme: str(scheme.scheme, 60),
        in: str(scheme.in, 40),
        flows,
        description: str(scheme.description, 300),
        apiKeyName: str(scheme.name, 100),
      });
    }
  }

  // Paths.
  const operations: OperationSummary[] = [];
  const operationsByMethod: Record<string, number> = {};
  let deprecatedCount = 0;
  const paths = asRecord(root.paths) ?? {};
  outer: for (const [path, rawItem] of Object.entries(paths)) {
    const item = asRecord(rawItem);
    if (!item) continue;
    // Shared parameters at the path level.
    const sharedParams = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of HTTP_METHODS) {
      if (operations.length >= maxEndpoints) {
        warnings.push(`Endpoint listing truncated at ${maxEndpoints}.`);
        break outer;
      }
      const rawOperation = item[method];
      const operation = asRecord(rawOperation);
      if (!operation) continue;
      const params = [...sharedParams, ...(Array.isArray(operation.parameters) ? operation.parameters : [])]
        .map((entry) => describeParameter(entry, warnings))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .slice(0, 40);
      const requestBody = describeRequestBody(operation, specification);
      const responses = describeResponses(operation);
      const security = Array.isArray(operation.security)
        ? (operation.security as unknown[]).map((entry) => (asRecord(entry) ? Object.fromEntries(Object.entries(entry as Record<string, unknown>).map(([key, value]) => [key, Array.isArray(value) ? value.map(String) : []])) : {})).slice(0, 10)
        : [];
      operations.push({
        path,
        method,
        operationId: str(operation.operationId, 120),
        summary: str(operation.summary, 300),
        description: str(operation.description, 800),
        deprecated: operation.deprecated === true,
        tags: Array.isArray(operation.tags) ? (operation.tags as unknown[]).map((tag) => String(tag).slice(0, 60)).slice(0, 10) : [],
        parameters: params,
        requestBody,
        responses,
        security,
      });
      operationsByMethod[method] = (operationsByMethod[method] ?? 0) + 1;
      if (operation.deprecated === true) deprecatedCount++;
    }
  }

  // Components (3.x) / definitions (2.x).
  const schemaSource = isOpenApi3 ? asRecord(asRecord(root.components)?.schemas) : asRecord(root.definitions);
  const schemas: OpenApiReport["components"]["schemas"] = [];
  if (schemaSource) {
    for (const [name, raw] of Object.entries(schemaSource).slice(0, 300)) {
      const schema = asRecord(raw);
      const type = schema ? describeType(schema) : null;
      const properties = schema && asRecord(schema.properties) ? Object.keys(schema.properties as Record<string, unknown>).slice(0, 40) : [];
      schemas.push({ name, type, properties, ref: `#/${isOpenApi3 ? "components/schemas" : "definitions"}/${name}` });
    }
  }
  const componentsSource = asRecord(root.components);
  const globalSecurity = Array.isArray(root.security) ? (root.security as unknown[]).length : 0;
  if (globalSecurity > 0) notes.push(`The document declares ${globalSecurity} global security requirement(s); individual operations may add more.`);

  return {
    specification,
    specificationVersion: specificationVersion ? String(specificationVersion).slice(0, 40) : null,
    version,
    title,
    description,
    servers,
    operations,
    securitySchemes,
    components: {
      schemas,
      parameters: Object.keys(asRecord(componentsSource?.parameters) ?? {}).length || (isSwagger2 ? 0 : 0),
      requestBodies: Object.keys(asRecord(componentsSource?.requestBodies) ?? {}).length,
      responses: Object.keys(asRecord(componentsSource?.responses) ?? {}).length,
    },
    tags: Array.isArray(root.tags)
      ? (root.tags as unknown[]).map((entry) => ({ name: str(asRecord(entry)?.name, 80) ?? "", description: str(asRecord(entry)?.description, 300) })).slice(0, 50)
      : [],
    stats: {
      paths: Object.keys(paths).length,
      operations: operations.length,
      operationsByMethod,
      deprecated: deprecatedCount,
    },
    warnings,
    limitations: [
      ...limitations,
      "Schema references are reported, not expanded recursively (beyond property names) — read a schema with a document fetch if you need its full shape.",
      "Remote $ref targets are never fetched.",
    ],
    notes,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function describeType(schema: Record<string, unknown>): string | null {
  if (typeof schema.type === "string") {
    const format = typeof schema.format === "string" ? `(${schema.format})` : "";
    return `${schema.type}${format}`;
  }
  if (Array.isArray(schema.allOf)) return "allOf";
  if (Array.isArray(schema.oneOf)) return "oneOf";
  if (Array.isArray(schema.anyOf)) return "anyOf";
  if (schema.properties) return "object";
  if (schema.$ref) return `ref:${String(schema.$ref).slice(0, 120)}`;
  return null;
}

function schemaRefOf(schema: Record<string, unknown> | null): { summary: string | null; ref: string | null } {
  if (!schema) return { summary: null, ref: null };
  const ref = typeof schema.$ref === "string" ? schema.$ref : null;
  if (ref) {
    if (!ref.startsWith("#/")) return { summary: `unresolved remote ref (${ref.split("/")[0]?.slice(0, 40)})`, ref: null };
    return { summary: `ref ${ref.slice(0, 160)}`, ref };
  }
  return { summary: describeType(schema), ref: null };
}

function describeParameter(entry: unknown, warnings: string[]): OperationSummary["parameters"][number] | null {
  const parameter = asRecord(entry);
  if (!parameter) return null;
  if (typeof parameter.$ref === "string") {
    const ref = parameter.$ref.startsWith("#/") ? parameter.$ref : null;
    return { name: parameter.$ref.split("/").pop()?.slice(0, 100) ?? "$ref", in: "reference", required: false, type: null, description: ref ? `see ${ref.slice(0, 160)}` : "remote parameter $ref not fetched", schemaRef: ref };
  }
  const schema = asRecord(parameter.schema);
  const { summary, ref } = schemaRefOf(schema);
  return {
    name: str(parameter.name, 120) ?? "",
    in: str(parameter.in, 40) ?? "unknown",
    required: parameter.required === true,
    type: summary ?? str(parameter.type, 60),
    description: str(parameter.description, 300),
    schemaRef: ref,
  };
}

function describeRequestBody(operation: Record<string, unknown>, specification: OpenApiReport["specification"]): OperationSummary["requestBody"] | null {
  if (specification === "openapi3") {
    const body = asRecord(operation.requestBody);
    if (!body) return null;
    const content = asRecord(body.content) ?? {};
    const contentTypes = Object.keys(content).slice(0, 10);
    const first = asRecord(content[contentTypes[0] ?? ""]);
    const schema = asRecord(first?.schema);
    const { summary, ref } = schemaRefOf(schema);
    return { required: body.required === true, contentTypes, schemaSummary: summary, schemaRef: ref };
  }
  // Swagger 2: body parameters carry a schema; formData/`in: body` shape.
  const params = Array.isArray(operation.parameters) ? (operation.parameters as unknown[]) : [];
  for (const entry of params) {
    const parameter = asRecord(entry);
    if (!parameter || parameter.in !== "body") continue;
    const schema = asRecord(parameter.schema);
    const { summary, ref } = schemaRefOf(schema);
    return { required: parameter.required === true, contentTypes: ["(swagger2 body)"], schemaSummary: summary, schemaRef: ref };
  }
  return null;
}

function describeResponses(operation: Record<string, unknown>): OperationSummary["responses"] {
  const responses = asRecord(operation.responses) ?? {};
  return Object.entries(responses)
    .slice(0, 30)
    .map(([status, raw]) => {
      const response = asRecord(raw);
      if (!response) return { status, description: null, contentTypes: [], schemaSummary: null, schemaRef: null };
      const content = asRecord(response.content);
      if (content) {
        const contentTypes = Object.keys(content).slice(0, 10);
        const first = asRecord(content[contentTypes[0] ?? ""]);
        const schema = asRecord(first?.schema);
        const { summary, ref } = schemaRefOf(schema);
        return { status, description: str(response.description, 300), contentTypes, schemaSummary: summary, schemaRef: ref };
      }
      // Swagger 2: schema directly on the response.
      const schema = asRecord(response.schema);
      const { summary, ref } = schemaRefOf(schema);
      return { status, description: str(response.description, 300), contentTypes: [], schemaSummary: summary, schemaRef: ref };
    })
    .sort((a, b) => a.status.localeCompare(b.status));
}
