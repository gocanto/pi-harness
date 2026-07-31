# Modules, Class Shapes, and Dependency Injection

The rules (concern slices, the four shapes, thin glue, composition root) live
in [../SKILL.md](../SKILL.md) — this file carries the complete worked examples.

## A concern slice, end to end

A slice owns one capability: its types, classes, serialization, and barrel.

```txt
src/
  kernel/                 # ports, constants, ONE composition root
    ports.ts              # FileSystem, HttpClient, Clock, ...
    runtime.ts            # the only file allowed to touch ambient I/O
  secrets/                # a concern slice
    dto.ts                # immutable DTO (shape 1)
    client.ts             # transport adapter (shape 3)
    formatter.ts          # static-only utility (shape 4)
    index.ts              # the slice's public barrel
  deploy/                 # another slice; never imports ../secrets/* internals
    deployer.ts           # orchestrator/service (shape 2)
    index.ts
```

Slices depend on `kernel/` and their own files — never sideways on another
slice's internals. Shared behaviour moves down into `kernel/` or a lower slice.

## Shape 1 — Immutable DTO

Private constructor, static `parse()`/`from()` factory, `readonly` fields
behind getters, `withX()` copies. No I/O, no dependencies.

```ts
import { z } from 'zod';

const EnvConfigSchema = z.object({
	appName: z.string().min(1),
	region: z.string().min(1),
	replicas: z.number()
		.int()
		.positive(),
});

/** A validated, immutable deployment environment configuration. */
export class EnvConfig {
	private constructor(private readonly props: Readonly<z.infer<typeof EnvConfigSchema>>) {}

	/** Parse a config from untrusted input (file contents, API payloads). */
	static parse(input: unknown): Result<EnvConfig, InvalidEnvConfig> {
		const parsed = EnvConfigSchema.safeParse(input);

		if (!parsed.success) {
			return err(new InvalidEnvConfig(parsed.error));
		}

		return ok(new EnvConfig(parsed.data));
	}

	get appName(): string {
		return this.props.appName;
	}

	get replicas(): number {
		return this.props.replicas;
	}

	/** Return a copy with a different replica count. */
	withReplicas(replicas: number): EnvConfig {
		return new EnvConfig({ ...this.props, replicas });
	}
}
```

Invalid instances are unconstructable: the constructor is private and the only
factory parses.

## Shape 2 — Orchestrator / service

Owns a capability. Dependencies injected through the constructor as
`private readonly` fields; public action methods; composition over inheritance.

```ts
/** The slice of the store this service actually needs (consumer-narrow). */
type ReleaseStore = {
	latest(app: string): Promise<Result<Release, ReleaseLookupError>>;
	record(release: Release): Promise<Result<void, ReleaseStoreError>>;
};

/** Deploys an application to its configured environment. */
export class Deployer {
	constructor(
		private readonly store: ReleaseStore,
		private readonly uploader: ArtifactUploader,
		private readonly clock: Clock,
	) {}

	/** Deploy the given build; returns the recorded release. */
	async deploy(config: EnvConfig, build: BuildArtifact): Promise<Result<Release, DeployError>> {
		const uploaded = await this.uploader.upload(build);

		if (isErr(uploaded)) {
			return uploaded;
		}

		const release = Release.make(config.appName, uploaded.value, this.clock.now());

		const recorded = await this.store.record(release);

		return isErr(recorded) ? recorded : ok(release);
	}
}
```

Pure decision logic lives in private methods (or in the DTOs); the public
method sequences the effects. An aggregate deps object injected once and held
as one `private readonly` field is fine too — what is banned is threading a
`deps` bag through free functions.

## Shape 3 — Transport / adapter

Talks to the outside world. All I/O goes through an injected port interface so
the adapter is testable with a fake; wire details stay private; external
failures are classified into the slice's typed errors.

```ts
/** Port defined in kernel/ports.ts — the adapter depends on it, not on fetch. */
type HttpClient = {
	send(request: HttpRequest): Promise<HttpResponse>;
};

/** Reads and writes secrets in the remote secrets store. */
export class SecretsClient {
	constructor(
		private readonly http: HttpClient,
		private readonly baseUrl: Url,
	) {}

	/** Fetch a secret by name. */
	async get(name: SecretName): Promise<Result<Redacted<string>, SecretsStoreError>> {
		const response = await this.http.send(this.getRequest(name));
		if (response.status === 404) {
			return err(new SecretNotFound(name));
		}
		if (response.status !== 200) {
			return err(new SecretsStoreUnavailable("get", response.status));
		}
		return ok(redacted(this.parseBody(response)));
	}

	private getRequest(name: SecretName): HttpRequest {
		// wire details (paths, headers, auth) stay private to the adapter
		...
	}
}
```

## Shape 4 — Static-only utility

Pure serialization/parsing/formatting grouped under a class namespace. Prefer
this over a loose `utils.ts` of free functions.

```ts
/** Formats key/value pairs as dotenv file contents. */
export class DotenvFormatter {
	private constructor() {}

	/** Render entries as dotenv lines, quoting values that need it. */
	static format(entries: ReadonlyArray<readonly [string, string]>): string {
		return entries.map(([key, value]) => `${key}=${DotenvFormatter.quote(value)}`).join('\n');
	}

	private static quote(value: string): string {
		return /[\s#"']/.test(value) ? JSON.stringify(value) : value;
	}
}
```

## Thin framework glue

Framework entrypoints keep functional signatures because the framework demands
them, but they only resolve dependencies, call a service, and serialize:

```ts
// HTTP handler (Hono-style — same idea for any router)
app.post('/deploys', async (c) => {
	const deps = serverDeps(c);

	const input = DeployRequestDto.parse(await c.req.json());

	if (isErr(input)) {
		return c.json(ErrorSerializer.toPayload(input.error), 400);
	}

	const deployed = await new Deployer(deps.store, deps.uploader, deps.clock).deploy(input.value.config, input.value.build);

	return isErr(deployed) ? c.json(ErrorSerializer.toPayload(deployed.error), 502) : c.json(ReleaseSerializer.toPayload(deployed.value));
});
```

Vue components and composables follow the same rule: `<script setup>` stays
reactive glue; non-render logic lives in injected service classes (provided
via `InjectionKey`, see [testing.md](testing.md)) or stores backed by them.

## Consumer-narrow interfaces

Depend on the smallest shape the module actually uses; let concrete adapters
be wider. TypeScript's structural typing makes this free — `ReleaseStore`
above is satisfied by any object with those two methods, so a wide
`PostgresReleases` adapter needs no `implements` clause.

## Composition root

Exactly one place constructs concrete adapters and reaches ambient I/O
(`fetch`, `process.env`, `Date.now`, `crypto`, database singletons):

```ts
// kernel/runtime.ts — the ONLY file that touches ambient I/O
export function makeRuntime(): Runtime {
	const http = new FetchHttpClient(fetch);
	const clock = { now: () => new Date() };
	const config = AppConfig.parse(process.env);

	if (isErr(config)) {
		throw new StartupMisconfiguration(config.error); // startup defect: throwing is correct
	}

	return {
		deployer: new Deployer(new PostgresReleases(config.value.db), new R2Uploader(http), clock),
	};
}
```

Everything below the root receives its dependencies; nothing below it imports
the root.

## Barrels and aliases

Each slice exposes its public classes through `index.ts`; the package
`src/index.ts` re-exports by concern; `package.json` `exports` maps `.` and
per-concern subpaths. Consumers import from the package/concern barrel via
repo aliases, never with `./`/`../` specifiers and never by deep-importing a
sibling slice's internals.

Adding a new public entrypoint is a three-way update kept in sync: the
workspace alias table, the matching tsconfig `paths` entry, and the package's
`exports` map. The concrete file locations are repo-specific — see the Local
reference section in [../SKILL.md](../SKILL.md).

## Adapter reuse audit — worked example

Task: the `deploy` slice needs to read one secret at deploy time.

1. **Reuse as-is?** `SecretsClient.get` already exists. Define a narrow type
   in the deploy slice — `type SecretReader = Pick<SecretsClient, "get">` —
   and inject the existing client. **Yes → done. No new adapter, no ADR.**
2. **Extend?** Only if the need were a new operation that belongs to the
   secrets capability (e.g. `list()`): add the method to `SecretsClient`.
3. **New adapter?** Only if the operation is a genuinely different capability
   (e.g. sealed-box encryption against a different service). Then create it —
   and write an ADR recording what was checked and why reuse/extension did
   not fit (format: `.agents/skills/domain-modeling/ADR-FORMAT.md`).

## Quick Reference

| Decision             | Rule                                                   |
| -------------------- | ------------------------------------------------------ |
| New behaviour        | pick the slice; pick the simplest of the four shapes   |
| Data carrier         | shape 1: private ctor + static `parse`, `withX` copies |
| Capability with deps | shape 2: constructor injection, `private readonly`     |
| External system      | shape 3: I/O behind an injected port, typed errors out |
| Pure helpers         | shape 4: static-only class, never `utils.ts`           |
| Framework entrypoint | thin: resolve deps → call service → serialize          |
| Dependency type      | consumer-narrow structural type; adapters stay wider   |
| Ambient I/O          | composition root only                                  |
| Imports              | package/concern barrel via aliases; never `./`/`../`   |
| New adapter          | only after the reuse audit; ADR if it survives         |
