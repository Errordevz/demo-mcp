/**
 * Reverse-engineering artifact storage.
 *
 * Reuses DEMO's existing R2 bucket (SCREENSHOTS) with the same TTL-in-metadata
 * convention as `src/web/storage.ts` — no second storage system, no new bindings.
 * The bucket is optional: when it is absent the store degrades to an in-memory
 * per-isolate cache and every artifact is still returned in the tool result.
 */

export interface ArtifactInput {
  id: string;
  analysisId: string;
  label: string;
  contentType: string;
  body: Uint8Array | string;
}

export interface StoredArtifact {
  id: string;
  analysisId: string;
  label: string;
  contentType: string;
  bytes: number;
  storageKey: string | null;
  expiresAt: string;
  /** Present only when the artifact is still inside this isolate. */
  cachedBody: Uint8Array | null;
}

export interface ReverseEngineeringStore {
  available: boolean;
  put(input: ArtifactInput, ttlSeconds: number): Promise<StoredArtifact>;
  get(id: string): Promise<StoredArtifact | null>;
  list(analysisId: string): Promise<StoredArtifact[]>;
  delete(id: string): Promise<boolean>;
}

const KEY_PREFIX = "re-analysis/";

interface BucketLike {
  put(key: string, value: ArrayBuffer | string, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string }; size?: number } | null>;
  list(options?: { prefix?: string }): Promise<{ objects: Array<{ key: string; customMetadata?: Record<string, string>; size?: number; httpMetadata?: { contentType?: string } }> }>;
  delete(key: string): Promise<void>;
}

export function artifactKey(analysisId: string, id: string): string {
  return `${KEY_PREFIX}${analysisId}/${id}`;
}

/** Create a store bound to the SCREENSHOTS bucket (or memory if unbound). */
export function createReverseEngineeringStore(bucket: BucketLike | undefined, now: () => Date = () => new Date()): ReverseEngineeringStore {
  const memory = new Map<string, StoredArtifact>();

  if (!bucket) {
    return {
      available: false,
      async put(input, ttlSeconds) {
        const body = typeof input.body === "string" ? new TextEncoder().encode(input.body) : input.body;
        const artifact: StoredArtifact = {
          id: input.id,
          analysisId: input.analysisId,
          label: input.label,
          contentType: input.contentType,
          bytes: body.byteLength,
          storageKey: null,
          expiresAt: new Date(now().getTime() + ttlSeconds * 1000).toISOString(),
          cachedBody: body,
        };
        memory.set(input.id, artifact);
        return artifact;
      },
      async get(id) {
        const found = memory.get(id) ?? null;
        if (found && new Date(found.expiresAt).getTime() < now().getTime()) {
          memory.delete(id);
          return null;
        }
        return found;
      },
      async list(analysisId) {
        return [...memory.values()].filter((entry) => entry.analysisId === analysisId && new Date(entry.expiresAt).getTime() >= now().getTime());
      },
      async delete(id) {
        return memory.delete(id);
      },
    };
  }

  return {
    available: true,
    async put(input, ttlSeconds) {
      const body = typeof input.body === "string" ? new TextEncoder().encode(input.body) : input.body;
      const key = artifactKey(input.analysisId, input.id);
      const expiresAt = new Date(now().getTime() + ttlSeconds * 1000).toISOString();
      await bucket.put(key, body as unknown as ArrayBuffer, {
        httpMetadata: { contentType: input.contentType },
        customMetadata: { analysisId: input.analysisId, label: input.label, expiresAt, bytes: String(body.byteLength) },
      });
      const artifact: StoredArtifact = {
        id: input.id,
        analysisId: input.analysisId,
        label: input.label,
        contentType: input.contentType,
        bytes: body.byteLength,
        storageKey: key,
        expiresAt,
        cachedBody: body,
      };
      memory.set(input.id, artifact);
      return artifact;
    },
    async get(id) {
      const cached = memory.get(id);
      if (cached && new Date(cached.expiresAt).getTime() >= now().getTime()) return cached;
      const listing = await bucket.list({ prefix: KEY_PREFIX });
      const found = listing.objects.find((object) => object.key.endsWith(`/${id}`));
      if (!found) return null;
      const expiresAt = found.customMetadata?.expiresAt;
      if (!expiresAt || new Date(expiresAt).getTime() < now().getTime()) return null;
      const object = await bucket.get(found.key);
      if (!object) return null;
      const artifact: StoredArtifact = {
        id,
        analysisId: found.customMetadata?.analysisId ?? "",
        label: found.customMetadata?.label ?? id,
        contentType: found.httpMetadata?.contentType ?? "application/octet-stream",
        bytes: object.size ?? 0,
        storageKey: found.key,
        expiresAt,
        cachedBody: new Uint8Array(await object.arrayBuffer()),
      };
      memory.set(id, artifact);
      return artifact;
    },
    async list(analysisId) {
      const listing = await bucket.list({ prefix: `${KEY_PREFIX}${analysisId}/` });
      return listing.objects
        .filter((object) => new Date(object.customMetadata?.expiresAt ?? 0).getTime() >= now().getTime())
        .map((object) => ({
          id: object.key.split("/").pop() ?? object.key,
          analysisId: object.customMetadata?.analysisId ?? analysisId,
          label: object.customMetadata?.label ?? object.key,
          contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
          bytes: object.size ?? 0,
          storageKey: object.key,
          expiresAt: object.customMetadata?.expiresAt ?? "",
          cachedBody: null,
        }));
    },
    async delete(id) {
      const found = [...memory.values()].find((entry) => entry.id === id);
      memory.delete(id);
      if (found?.storageKey) {
        await bucket.delete(found.storageKey);
        return true;
      }
      const listing = await bucket.list({ prefix: KEY_PREFIX });
      const match = listing.objects.find((object) => object.key.endsWith(`/${id}`));
      if (!match) return false;
      await bucket.delete(match.key);
      return true;
    },
  };
}
