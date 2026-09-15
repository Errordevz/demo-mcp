/**
 * Minimal stand-in for the `cloudflare:workers` module so the Worker entrypoint
 * (which exports the Durable Object class) can be imported in Node tests.
 * Only used by vitest via `resolve.alias`.
 */
export class DurableObject<Env = unknown> {
  protected ctx: unknown;
  protected env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
