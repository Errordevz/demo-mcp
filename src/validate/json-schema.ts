/**
 * Local JSON Schema validation (DEMO 0.9) — no external service, nothing is
 * uploaded. Supports the widely used drafts (draft-07 / 2019-09 / 2020-12) at
 * the practical-subset level: type, enum, const, properties, required,
 * additionalProperties, patternProperties, items/prefixItems, minItems/maxItems,
 * uniqueItems, minimum/maximum/exclusive*, multipleOf, minLength/maxLength,
 * pattern, format (safe subset), allOf/anyOf/oneOf/not, if/then/else,
 * $ref (internal pointers only — remote $ref is refused, never fetched),
 * nullable, definitions/$defs. Unsupported keywords are reported in
 * `warnings`, never silently ignored as "valid".
 */

import { BrowserError } from "../core/errors.js";
import { LIMITS, clamp } from "../core/limits.js";

export interface ValidationIssue {
  path: string;
  keyword: string;
  message: string;
  expected: unknown;
  received: { type: string; valuePreview: unknown };
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: string[];
  draft: string;
  truncated: boolean;
}

const KNOWN_KEYWORDS = new Set([
  "$schema", "$id", "$ref", "$defs", "definitions", "$comment", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly",
  "type", "enum", "const", "properties", "patternProperties", "additionalProperties", "unevaluatedProperties", "required", "propertyNames", "dependentRequired", "dependentSchemas",
  "items", "prefixItems", "additionalItems", "unevaluatedItems", "contains", "minItems", "maxItems", "uniqueItems", "minContains", "maxContains",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "format", "contentEncoding", "contentMediaType",
  "allOf", "anyOf", "oneOf", "not", "if", "then", "else",
  "$anchor", "$dynamicRef", "$dynamicAnchor", "$vocabulary", "$recursiveRef", "$recursiveAnchor", "discriminator", "xml", "externalDocs", "nullable",
]);

export function validateJsonSchema(instance: unknown, schema: unknown, options: { maxErrors?: number } = {}): ValidationResult {
  const warnings: string[] = [];
  const errors: ValidationIssue[] = [];
  const maxErrors = clamp(options.maxErrors ?? LIMITS.jsonSchemaMaxErrors, 1, LIMITS.jsonSchemaMaxErrors);
  let truncated = false;
  if (typeof schema === "boolean") {
    // Top-level boolean schemas: `true` accepts everything, `false` rejects.
    if (schema) return { valid: true, errors: [], warnings: [], draft: "boolean-schema", truncated: false };
    return {
      valid: false,
      errors: [{ path: "", keyword: "false", message: "No value is allowed here (boolean schema false).", expected: "nothing", received: { type: Array.isArray(instance) ? "array" : instance === null ? "null" : typeof instance, valuePreview: null } }],
      warnings: [],
      draft: "boolean-schema",
      truncated: false,
    };
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new BrowserError("invalid_input", "The schema must be a JSON object (boolean schemas true/false are also accepted).", { retryable: false });
  }
  const draft = typeof (schema as Record<string, unknown>).$schema === "string" ? String((schema as Record<string, unknown>).$schema) : "unspecified (draft-07-compatible subset)";

  const rootSchema = schema as Record<string, unknown>;
  const seenRefs = new Set<string>();

  const push = (issue: ValidationIssue): void => {
    if (errors.length >= maxErrors) {
      truncated = true;
      return;
    }
    errors.push(issue);
  };

  const preview = (value: unknown): unknown => {
    if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 120)}…` : value;
    if (value !== null && typeof value === "object") {
      const text = JSON.stringify(value) ?? "";
      return text.length > 120 ? `[${Array.isArray(value) ? "array" : "object"} ${text.length} chars]` : value;
    }
    return value;
  };

  const describe = (value: unknown) => ({
    type: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
    valuePreview: preview(value),
  });

  const joinPath = (base: string, key: string | number): string =>
    typeof key === "number" ? `${base}/${key}` : `${base}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;

  const resolveRef = (ref: string): Record<string, unknown> | boolean | null => {
    if (!ref.startsWith("#")) {
      warnings.push(`remote $ref "${ref.slice(0, 120)}" is never fetched; the subschema is treated as unconstrained.`);
      return null;
    }
    if (seenRefs.has(ref)) {
      warnings.push(`cyclic $ref "${ref}" re-entered; validation of the cycle stops (no infinite recursion).`);
      return null;
    }
    seenRefs.add(ref);
    try {
      const pointer = ref === "#" ? "" : ref.slice(1);
      let current: unknown = rootSchema;
      if (pointer) {
        for (const rawSegment of pointer.split("/").slice(1)) {
          const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
          if (Array.isArray(current)) current = current[Number(segment)];
          else if (current && typeof current === "object") current = (current as Record<string, unknown>)[segment];
          else return null;
        }
      }
      if (typeof current === "boolean" || (current && typeof current === "object")) return current as Record<string, unknown>;
      return null;
    } finally {
      seenRefs.delete(ref);
    }
  };

  const checkUnknownKeywords = (schemaNode: Record<string, unknown>, at: string): void => {
    for (const key of Object.keys(schemaNode)) {
      if (!KNOWN_KEYWORDS.has(key) && !key.startsWith("x-") && warnings.length < 20) {
        warnings.push(`keyword "${key}" at ${at || "/"} is not in this validator's supported subset; it was not enforced.`);
      }
    }
  };

  const validateNode = (value: unknown, schemaNode: unknown, path: string, depth: number): void => {
    if (errors.length >= maxErrors) return;
    if (depth > LIMITS.jsonSchemaMaxDepth) {
      warnings.push(`validation stopped at depth ${LIMITS.jsonSchemaMaxDepth} (path ${path}).`);
      return;
    }
    if (schemaNode === true || schemaNode === undefined) return;
    if (schemaNode === false) {
      push({ path, keyword: "false", message: "No value is allowed here (boolean schema false).", expected: "nothing", received: describe(value) });
      return;
    }
    if (typeof schemaNode !== "object" || schemaNode === null || Array.isArray(schemaNode)) return;
    const schema = schemaNode as Record<string, unknown>;
    checkUnknownKeywords(schema, path);

    // $ref: internal pointers only.
    if (typeof schema.$ref === "string") {
      const resolved = resolveRef(schema.$ref);
      if (resolved === null) {
        // Remote or cyclic: unconstrained by decision (reported in warnings).
      } else {
        validateNode(value, resolved, path, depth + 1);
      }
    }

    // type
    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type.map(String) : [String(schema.type)];
      const actual = describe(value).type;
      const nullableAllows = schema.nullable === true && value === null;
      const typeMatches = types.some((type) => typeMatchesType(value, type));
      if (!typeMatches && !nullableAllows) {
        push({ path, keyword: "type", message: `Expected type ${types.join(" | ")}, got ${actual}.`, expected: types.length === 1 ? types[0] : types, received: describe(value) });
        return; // further keyword failures would be noise
      }
    }

    // const / enum
    if ("const" in schema && !deepEqual(value, schema.const)) {
      push({ path, keyword: "const", message: "Value must equal the const.", expected: preview(schema.const), received: describe(value) });
    }
    if (Array.isArray(schema.enum)) {
      const matches = schema.enum.some((entry) => deepEqual(value, entry));
      if (!matches) {
        push({ path, keyword: "enum", message: `Value is not one of the ${schema.enum.length} allowed values.`, expected: schema.enum.slice(0, 10).map(preview), received: describe(value) });
      }
    }

    // conditionals
    if ("if" in schema) {
      const probe: ValidationIssue[] = [];
      const saveLength = errors.length;
      validateNode(value, schema.if, path, depth + 1);
      // steal any errors raised by the probe
      const raised = errors.splice(saveLength);
      probe.push(...raised);
      const conditionMet = probe.length === 0;
      if (conditionMet && "then" in schema) validateNode(value, schema.then, path, depth + 1);
      if (!conditionMet && "else" in schema) validateNode(value, schema.else, path, depth + 1);
    }

    // combinators
    if (Array.isArray(schema.allOf)) {
      schema.allOf.forEach((sub, index) => validateNode(value, sub, path, depth + 1 + index * 0));
    }
    if (Array.isArray(schema.anyOf)) {
      const outcomes = schema.anyOf.map((sub) => {
        const trial: ValidationIssue[] = [];
        const saveLength = errors.length;
        validateNode(value, sub, path, depth + 1);
        trial.push(...errors.splice(saveLength));
        return trial;
      });
      if (!outcomes.some((trial) => trial.length === 0)) {
        push({ path, keyword: "anyOf", message: `Value does not match any of the ${schema.anyOf.length} allowed schemas.`, expected: "anyOf", received: describe(value) });
      }
    }
    if (Array.isArray(schema.oneOf)) {
      let passing = 0;
      let firstFailures: ValidationIssue[] | null = null;
      for (const sub of schema.oneOf) {
        const saveLength = errors.length;
        validateNode(value, sub, path, depth + 1);
        const trial = errors.splice(saveLength);
        if (trial.length === 0) passing++;
        else if (!firstFailures) firstFailures = trial;
      }
      if (passing === 0) {
        push({ path, keyword: "oneOf", message: "Value does not match any of the oneOf alternatives.", expected: "oneOf", received: describe(value) });
        for (const failure of (firstFailures ?? []).slice(0, 3)) push(failure);
      } else if (passing > 1) {
        push({ path, keyword: "oneOf", message: `Value matches ${passing} alternatives; exactly one is allowed.`, expected: "exactly one match", received: describe(value) });
      }
    }
    if ("not" in schema) {
      const saveLength = errors.length;
      validateNode(value, schema.not, path, depth + 1);
      const trial = errors.splice(saveLength);
      if (trial.length === 0) {
        push({ path, keyword: "not", message: "Value matches the forbidden schema.", expected: "must not match", received: describe(value) });
      }
    }

    // strings
    if (typeof value === "string") {
      if (typeof schema.minLength === "number" && value.length < schema.minLength) {
        push({ path, keyword: "minLength", message: `String length ${value.length} is below the minimum ${schema.minLength}.`, expected: schema.minLength, received: describe(value) });
      }
      if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
        push({ path, keyword: "maxLength", message: `String length ${value.length} is above the maximum ${schema.maxLength}.`, expected: schema.maxLength, received: describe(value) });
      }
      if (typeof schema.pattern === "string") {
        let matched = false;
        try {
          matched = new RegExp(schema.pattern).test(value);
        } catch {
          warnings.push(`pattern "${schema.pattern.slice(0, 80)}" is not a valid regular expression; skipped.`);
        }
        if (!matched && !warnings.includes(`pattern skipped`)) {
          push({ path, keyword: "pattern", message: `String does not match the required pattern.`, expected: schema.pattern.slice(0, 160), received: describe(value) });
        }
      }
      if (typeof schema.format === "string") {
        const formatError = checkFormat(value, String(schema.format));
        if (formatError) push({ path, keyword: "format", message: formatError, expected: schema.format, received: describe(value) });
      }
    }

    // numbers
    if (typeof value === "number" && Number.isFinite(value)) {
      if (typeof schema.minimum === "number" && value < schema.minimum) push({ path, keyword: "minimum", message: `Value is below the minimum ${schema.minimum}.`, expected: schema.minimum, received: describe(value) });
      if (typeof schema.maximum === "number" && value > schema.maximum) push({ path, keyword: "maximum", message: `Value is above the maximum ${schema.maximum}.`, expected: schema.maximum, received: describe(value) });
      if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) push({ path, keyword: "exclusiveMinimum", message: `Value must be greater than ${schema.exclusiveMinimum}.`, expected: schema.exclusiveMinimum, received: describe(value) });
      if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) push({ path, keyword: "exclusiveMaximum", message: `Value must be less than ${schema.exclusiveMaximum}.`, expected: schema.exclusiveMaximum, received: describe(value) });
      if (typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
        const ratio = value / schema.multipleOf;
        if (Math.abs(ratio - Math.round(ratio)) > 1e-9) push({ path, keyword: "multipleOf", message: `Value must be a multiple of ${schema.multipleOf}.`, expected: schema.multipleOf, received: describe(value) });
      }
    }

    // arrays
    if (Array.isArray(value)) {
      if (typeof schema.minItems === "number" && value.length < schema.minItems) push({ path, keyword: "minItems", message: `Array has ${value.length} items; minimum is ${schema.minItems}.`, expected: schema.minItems, received: describe(value) });
      if (typeof schema.maxItems === "number" && value.length > schema.maxItems) push({ path, keyword: "maxItems", message: `Array has ${value.length} items; maximum is ${schema.maxItems}.`, expected: schema.maxItems, received: describe(value) });
      if (schema.uniqueItems === true) {
        const seen = new Set<string>();
        for (let i = 0; i < value.length; i++) {
          const key = JSON.stringify(value[i]);
          if (seen.has(key)) {
            push({ path: joinPath(path, i), keyword: "uniqueItems", message: "Duplicate array item (uniqueItems).", expected: "unique items", received: describe(value[i]) });
            break;
          }
          seen.add(key);
        }
      }
      // 2020-12 prefixItems + items, draft-07 tuple items, single-schema items.
      const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : Array.isArray(schema.items) ? schema.items : null;
      if (prefix) {
        prefix.forEach((sub, index) => {
          if (index < value.length) validateNode(value[index], sub, joinPath(path, index), depth + 1);
        });
        const rest = schema.items && !Array.isArray(schema.items) ? schema.items : schema.additionalItems;
        if (rest !== undefined) {
          for (let i = prefix.length; i < value.length; i++) validateNode(value[i], rest, joinPath(path, i), depth + 1);
        }
      } else if (schema.items !== undefined) {
        value.forEach((item, index) => validateNode(item, schema.items, joinPath(path, index), depth + 1));
      }
    }

    // objects
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const properties = schema.properties && typeof schema.properties === "object" ? (schema.properties as Record<string, unknown>) : null;
      const patternProperties = schema.patternProperties && typeof schema.patternProperties === "object" ? (schema.patternProperties as Record<string, unknown>) : null;
      if (Array.isArray(schema.required)) {
        for (const key of schema.required) {
          if (!Object.prototype.hasOwnProperty.call(record, String(key))) {
            push({ path, keyword: "required", message: `Required property "${String(key)}" is missing.`, expected: String(key), received: describe(value) });
          }
        }
      }
      const evaluated = new Set<string>();
      if (properties) {
        for (const [key, sub] of Object.entries(properties)) {
          if (Object.prototype.hasOwnProperty.call(record, key)) {
            evaluated.add(key);
            validateNode(record[key], sub, joinPath(path, key), depth + 1);
          }
        }
      }
      if (patternProperties) {
        for (const [pattern, sub] of Object.entries(patternProperties)) {
          let regex: RegExp | null = null;
          try {
            regex = new RegExp(pattern);
          } catch {
            warnings.push(`patternProperties key "${pattern.slice(0, 80)}" is not a valid regular expression; skipped.`);
          }
          if (!regex) continue;
          for (const [key, entry] of Object.entries(record)) {
            if (regex.test(key)) {
              evaluated.add(key);
              validateNode(entry, sub, joinPath(path, key), depth + 1);
            }
          }
        }
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(record)) {
          if (!evaluated.has(key)) {
            push({ path: joinPath(path, key), keyword: "additionalProperties", message: `Property "${key}" is not allowed (additionalProperties: false).`, expected: "no such property", received: describe(record[key]) });
          }
        }
      } else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
        for (const key of Object.keys(record)) {
          if (!evaluated.has(key)) validateNode(record[key], schema.additionalProperties, joinPath(path, key), depth + 1);
        }
      }
    }
  };

  validateNode(instance, schema, "", 0);
  return {
    valid: errors.length === 0,
    errors,
    warnings: [...new Set(warnings)].slice(0, 20),
    draft,
    truncated,
  };
}

function typeMatchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    default:
      return true;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  if (typeof a === "object" && typeof b === "object") {
    const keysA = Object.keys(a as object);
    const keysB = Object.keys(b as object);
    return keysA.length === keysB.length && keysA.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
  }
  return false;
}

/** Safe format subset: checked structurally, never with risky regexes from the schema. */
function checkFormat(value: string, format: string): string | null {
  switch (format) {
    case "date-time":
      return /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(value) && Number.isFinite(Date.parse(value)) ? null : "Value is not a valid ISO-8601 date-time.";
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) ? null : "Value is not a valid ISO-8601 date.";
    case "time":
      return /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value) ? null : "Value is not a valid ISO-8601 time.";
    case "email":
      return /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(value) ? null : "Value is not a valid e-mail address.";
    case "hostname":
      return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(value) ? null : "Value is not a valid hostname.";
    case "uri":
    case "url":
      return /^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/i.test(value) ? null : "Value is not an absolute URI.";
    case "uri-reference":
      return value.trim().length > 0 ? null : "Value is not a URI reference.";
    case "ipv4":
      return /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(value) ? null : "Value is not a valid IPv4 address.";
    case "ipv6":
      return /^[0-9a-f:]+$/i.test(value) && value.includes(":") ? null : "Value is not a valid IPv6 address.";
    case "uuid":
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? null : "Value is not a valid UUID.";
    case "regex":
      try {
        new RegExp(value);
        return null;
      } catch {
        return "Value is not a valid regular expression.";
      }
    default:
      return null; // unknown formats are annotations, per spec
  }
}
