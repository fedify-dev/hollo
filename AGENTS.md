Hollo coding guidelines for AI assistants
==========================================

Hollo is a federated single-user microblogging software powered by [Fedify].
It implements the [ActivityPub] protocol for federation with other platforms
(like Mastodon, Misskey, etc.) and provides Mastodon-compatible APIs for
client integration.

[Fedify]: https://fedify.dev/
[ActivityPub]: https://www.w3.org/TR/activitypub/


Project overview
----------------

 -  *Technology stack*: TypeScript (ESNext), Hono.js (web framework with JSX),
    Drizzle ORM, PostgreSQL
 -  *Package manager*: pnpm only (enforced via `packageManager` field)
 -  *Runtime*: Node.js with tsx
 -  *License*: GNU Affero General Public License v3 (AGPL-3.0)
 -  *Structure*: Single-user microblogging platform with federation
    capabilities
 -  *API*: Implements Mastodon-compatible APIs for client integration


Directory structure
-------------------

~~~~
hollo/
├── bin/                          # Entry point scripts
│   ├── server.ts                 # Main server entry point
│   └── routes.ts                 # Debug utility to list all routes
│
├── src/                          # Main application source
│   ├── api/                      # Mastodon-compatible REST APIs
│   │   ├── v1/                   # API v1 endpoints
│   │   └── v2/                   # API v2 endpoints (search, notifications)
│   │
│   ├── components/               # Hono JSX components (server-rendered)
│   │
│   ├── entities/                 # Entity serialization (DB → API response)
│   │
│   ├── federation/               # ActivityPub implementation via Fedify
│   │   ├── index.ts              # Federation setup and inbox listeners
│   │   ├── actor.ts              # Actor dispatchers (Person, Organization)
│   │   ├── inbox.ts              # Inbox activity handlers
│   │   ├── objects.ts            # Object dispatchers (Note, Article, Question)
│   │   └── ...
│   │
│   ├── import/                   # Background data import (from Mastodon exports)
│   │   ├── processors.ts         # Import item processors
│   │   └── worker.ts             # Background job worker
│   │
│   ├── oauth/                    # OAuth 2.0 / OpenID Connect implementation
│   │   ├── constants.ts          # Token sizes, expiry times
│   │   ├── middleware.ts         # Auth middleware (tokenRequired, scopeRequired)
│   │   └── endpoints/            # OAuth endpoints (metadata, revoke, userinfo)
│   │
│   ├── pages/                    # Web UI pages (Hono JSX)
│   │
│   ├── public/                   # Static assets (CSS, favicons)
│   │
│   ├── index.tsx                 # Main Hono app composition
│   ├── schema.ts                 # Drizzle ORM database schema
│   ├── db.ts                     # Database connection
│   └── ...
│
├── scripts/                      # Utility scripts
│   └── rebuild-timelines.ts      # Rebuild all home timelines
│
├── tests/                        # Test utilities and fixtures
│   ├── helpers.ts                # Database cleanup, test fixtures
│   └── helpers/                  # OAuth and web test utilities
│
├── drizzle/                      # Database migrations (SQL files)
│
└── docs/                         # Documentation site (Astro/Starlight)
~~~~


Key architectural components
----------------------------

### Core layers

 -  *API layer* (*src/api/*): Implements Mastodon-compatible REST APIs
    (v1 and v2)
 -  *Federation* (*src/federation/*): ActivityPub implementation using Fedify
 -  *Database* (*src/db.ts* and *src/schema.ts*): PostgreSQL with Drizzle ORM
 -  *OAuth* (*src/oauth/*): OAuth 2.0 with OpenID Connect support
 -  *Components* (*src/components/*): Hono JSX components for server-rendered UI
 -  *Entities* (*src/entities/*): Transform database records to Mastodon API
    responses
 -  *Pages* (*src/pages/*): Web UI pages (profile, setup, dashboard, etc.)
 -  *Import system* (*src/import/*): Background job processing for data imports

### Key files

| File                        | Purpose                                   |
| --------------------------- | ----------------------------------------- |
| *src/index.tsx*             | Main Hono app that composes all routes    |
| *src/schema.ts*             | Complete Drizzle ORM schema (~1300 lines) |
| *src/federation/index.ts*   | Federation setup with inbox listeners     |
| *src/oauth/middleware.ts*   | Authentication middleware                 |
| *src/entities/status.ts*    | Status entity serialization               |


Technology stack
----------------

### Core dependencies

| Category      | Package           | Version | Purpose                        |
| ------------- | ----------------- | ------- | ------------------------------ |
| Runtime       | tsx               | ^4.21   | TypeScript executor            |
| Web framework | hono              | ^4.11   | HTTP server with JSX support   |
| Federation    | @fedify/fedify    | ~1.10   | ActivityPub implementation     |
| Database      | drizzle-orm       | ^0.45   | ORM for PostgreSQL             |
| Database      | postgres          | ^3.4    | PostgreSQL client              |
| Storage       | flydrive          | ^1.3    | S3/filesystem abstraction      |
| Validation    | zod               | ^4.2    | Schema validation (v4, not v3) |
| Auth          | argon2            | ^0.44   | Password hashing               |
| Auth          | otpauth           | ^9.4    | TOTP two-factor authentication |
| Media         | sharp             | ^0.34   | Image processing               |
| Media         | fluent-ffmpeg     | ^2.1    | Video processing               |
| Logging       | @logtape/logtape  | ~1.3    | Structured logging             |
| Monitoring    | @sentry/node      | ^10.26  | Error tracking                 |

### Development dependencies

| Package            | Purpose               |
| ------------------ | --------------------- |
| @biomejs/biome     | Linting and formatting|
| vitest             | Test runner           |
| @vitest/coverage-v8| Code coverage         |
| linkedom           | DOM testing           |
| timekeeper         | Time mocking          |


Development guidelines
----------------------

### Code style

 -  *TypeScript*: Strict mode enabled, ESNext target
 -  *JSX*: Use Hono's JSX (`jsxImportSource: "hono/jsx"`), not React
 -  *Biome*: Follow Biome linting rules (configured in *biome.json*)
 -  *Formatting*: Spaces for indentation (Biome default)
 -  *Zod*: Use Zod v4 syntax (different from v3 in some APIs)

### JSX components

Hollo uses Hono's built-in JSX support, *not* React:

~~~~ tsx
// Correct - Hono JSX (no imports needed)
export function MyComponent({ name }: { name: string }) {
  return <div>{name}</div>;
}

// Incorrect - React style
import React from 'react';  // Don't do this
~~~~

### Database guidelines

 -  *Migrations*: Always generate migrations for schema changes
 -  *Schema design*: Follow existing patterns in *src/schema.ts*
 -  *Relations*: Use Drizzle's `relations()` for defining relationships
 -  *Transactions*: Use `db.transaction()` for atomic operations
 -  *Indexes*: Add appropriate indexes for query performance

### Federation guidelines

 -  *ActivityPub*: Follow [ActivityPub] and [Activity Vocabulary] specifications
 -  *Fedify*: Use Fedify's APIs for actor/object handling
 -  *Compatibility*: Test with Mastodon, Misskey, and other implementations
 -  *Security*: Fedify handles HTTP Signatures automatically

[Activity Vocabulary]: https://www.w3.org/TR/activitystreams-vocabulary/

### API development

 -  *Mastodon compatibility*: Follow [Mastodon API documentation]
 -  *Versioning*: v1 for standard endpoints, v2 for extended features
 -  *Error handling*: Return proper HTTP status codes and error objects
 -  *Validation*: Use *@hono/zod-validator* for request validation
 -  *Authentication*: Use `tokenRequired()` and `scopeRequired()` middleware

[Mastodon API documentation]: https://docs.joinmastodon.org/api/

### OAuth implementation

The OAuth system supports:

 -  OAuth 2.0 authorization code flow with PKCE
 -  Token revocation (RFC 7009)
 -  OAuth server metadata (RFC 8414)
 -  OpenID Connect userinfo endpoint
 -  Scopes: `read`, `write`, `follow`, `push`, `profile`

### Testing

 -  *Test files*: Co-located with source (*src/**/*.test.ts*)
 -  *Runner*: Vitest with `requireAssertions: true`
 -  *Database*: Uses separate test database (*.env.test*)
 -  *Helpers*: Use *tests/helpers/* for common test utilities
 -  *Parallelism*: Tests run sequentially (file parallelism disabled)

Example test structure:

~~~~ typescript
import { describe, it, expect, beforeEach } from "vitest";
import { cleanupDatabase, createFixture } from "@/../tests/helpers";

describe("MyFeature", () => {
  beforeEach(async () => {
    await cleanupDatabase();
  });

  it("should do something", async () => {
    // Test implementation
    expect(result).toBe(expected);
  });
});
~~~~

### Security considerations

 -  *Input validation*: Validate all inputs with Zod
 -  *XSS protection*: Use *src/xss.ts* for HTML sanitization
 -  *SSRF protection*: Enabled by default (disable with `ALLOW_PRIVATE_ADDRESS`)
 -  *Password hashing*: Argon2id via *argon2* package
 -  *2FA*: TOTP support with *otpauth* package
 -  *Federation security*: HTTP Signatures handled by Fedify

### Performance

 -  *Database queries*: Use proper indexes, avoid N+1 queries
 -  *Pagination*: Use cursor-based pagination for timelines
 -  *Background jobs*: Use import worker for long-running tasks
 -  *Caching*: Fedify handles federation caching


Development commands
--------------------

### Common commands

| Command               | Description                             |
| --------------------- | --------------------------------------- |
| `pnpm dev`            | Start development server with hot reload|
| `pnpm prod`           | Start production server                 |
| `pnpm check`          | Run TypeScript type check and Biome lint|
| `pnpm test`           | Run tests with Vitest                   |
| `pnpm test:ci`        | Run tests without migrations (for CI)   |
| `pnpm check:coverage` | Run tests with coverage report          |

### Utility commands

| Command                  | Description                            |
| ------------------------ | -------------------------------------- |
| `pnpm list:routes`       | Display all registered HTTP routes     |
| `pnpm rebuild-timelines` | Rebuild all home timelines             |
| `pnpm migrate`           | Apply pending database migrations      |
| `pnpm migrate:test`      | Apply migrations to test database      |
| `pnpm migrate:generate`  | Generate migration from schema changes |

### Formatting

~~~~ bash
# Format code with Biome
pnpm biome format --write .

# Check formatting without writing
pnpm biome format .

# Lint and auto-fix
pnpm biome check --write .
~~~~


Database migrations
-------------------

Hollo uses Drizzle ORM for database schema management.  Migrations are stored
in *drizzle/* directory.

### Creating a new migration

 1. Modify the schema in *src/schema.ts*
 2. Generate a migration:

    ~~~~ bash
    pnpm migrate:generate
    ~~~~

This compares *src/schema.ts* with the current database state and generates
a SQL migration file.

Optional flags:

 -  `--name <name>`: Custom migration name
 -  `--custom`: Create empty migration for custom SQL

### Applying migrations

~~~~ bash
# Development/Production
pnpm migrate

# Test database
pnpm migrate:test
~~~~

> [!IMPORTANT]
> Migrations run automatically with `pnpm dev` and `pnpm prod`.
> Never edit migrations after they've been applied to production.
> Migration files are numbered sequentially
> (e.g., *0075_cleanup_duplicate_notifications.sql*).


Environment variables
---------------------

### Required variables

| Variable          | Description                           |
| ----------------- | ------------------------------------- |
| `DATABASE_URL`    | PostgreSQL connection string          |
| `SECRET_KEY`      | Session signing key (min 44 chars)    |
| `DRIVE_DISK`      | Storage driver: `fs` or `s3`          |
| `STORAGE_URL_BASE`| Public URL base for assets            |

### Storage configuration

Filesystem storage:

~~~~ env
DRIVE_DISK=fs
FS_STORAGE_PATH=/path/to/storage
STORAGE_URL_BASE=https://example.com/assets
~~~~

S3 storage:

~~~~ env
DRIVE_DISK=s3
AWS_ACCESS_KEY_ID=your-key
AWS_SECRET_ACCESS_KEY=your-secret
S3_REGION=us-east-1
S3_BUCKET=your-bucket
STORAGE_URL_BASE=https://your-bucket.s3.amazonaws.com
# Optional: S3_ENDPOINT_URL for MinIO, etc.
~~~~

### Optional variables

| Variable                       | Default | Description                              |
| ------------------------------ | ------- | ---------------------------------------- |
| `PORT`                         | 3000    | Server port                              |
| `BIND`                         | -       | Bind address                             |
| `NODE_TYPE`                    | all     | Node type: `all`, `web`, or `worker`     |
| `BEHIND_PROXY`                 | false   | Trust proxy headers                      |
| `LOG_LEVEL`                    | info    | Logging level                            |
| `LOG_QUERY`                    | false   | Log database queries                     |
| `LOG_FILE`                     | -       | JSON log file path                       |
| `SENTRY_DSN`                   | -       | Sentry error tracking                    |
| `HOME_URL`                     | -       | Home page redirect URL                   |
| `ALLOW_PRIVATE_ADDRESS`        | false   | Disable SSRF protection                  |
| `REMOTE_ACTOR_FETCH_POSTS`     | 10      | Posts to fetch from remote actors        |
| `REMOTE_ACTOR_STALENESS_DAYS`  | 7       | Days before remote actor data is stale   |
| `REFRESH_ACTORS_ON_INTERACTION`| false   | Refresh actors on all activity types     |


Adding new environment variables
--------------------------------

When adding a new environment variable to Hollo, update these locations:

 1. *Source code*: Add the environment variable reading logic in
    the appropriate source file (e.g., *src/logging.ts*, *src/storage.ts*).

 2. *AGENTS.md* (this file): Add the variable to the environment variables
    tables above (required or optional section as appropriate).

 3. *Documentation site*: Update the installation guides in
    *docs/src/content/docs/install/* for all languages:

     -  *docs/src/content/docs/install/* (English)
     -  *docs/src/content/docs/ja/install/* (Japanese)
     -  *docs/src/content/docs/ko/install/* (Korean)
     -  *docs/src/content/docs/zh-cn/install/* (Simplified Chinese)

 4. *Docker Compose files*: If the variable is relevant for Docker deployments:

     -  *compose.yaml*: For S3 storage configuration
     -  *compose-fs.yaml*: For filesystem storage configuration

 5. *Changelog*: Document the new variable in *CHANGES.md* under the current
    version section.


Important notes
---------------

 -  *Single-user focus*: Hollo is designed for single-user instances;
    multi-user logic is not needed
 -  *Federation first*: Always consider federation compatibility when making
    changes
 -  *API compatibility*: Mastodon API compatibility is critical for client
    support
 -  *AGPL compliance*: All contributions must comply with AGPL-3.0

When implementing features, always:

 -  Test federation with other ActivityPub implementations
 -  Verify Mastodon API compatibility with existing clients
 -  Add appropriate database indexes for new queries
 -  Include tests for new functionality


Markdown style guide
--------------------

When creating or editing Markdown documentation files in this project,
follow these style conventions to maintain consistency with existing
documentation:

### Headings

 -  *Setext-style headings*: Use underline-style for the document title
    (with `=`) and sections (with `-`):

    ~~~~
    Document Title
    ==============

    Section Name
    ------------
    ~~~~

 -  *ATX-style headings*: Use only for subsections within a section:

    ~~~~
    ### Subsection Name
    ~~~~

 -  *Heading case*: Use sentence case (capitalize only the first word and
    proper nouns) rather than Title Case:

    ~~~~
    Development commands    ← Correct
    Development Commands    ← Incorrect
    ~~~~

### Text formatting

 -  *Italics* (`*text*`): Use for package names (*@fedify/fedify*,
    *drizzle-orm*), file paths, emphasis, and to distinguish concepts
 -  *Bold* (`**text**`): Use sparingly for strong emphasis
 -  *Inline code* (`` `code` ``): Use for code spans, function names,
    variable names, and command-line options

### Lists

 -  Use ` -  ` (space-hyphen-two spaces) for unordered list items
 -  Indent nested items with 4 spaces
 -  Align continuation text with the item content:

    ~~~~
     -  *First item*: Description text that continues
        on the next line with proper alignment
     -  *Second item*: Another item
    ~~~~

### Code blocks

 -  Use four tildes (`~~~~`) for code fences instead of backticks
 -  Always specify the language identifier:

    ~~~~~
    ~~~~ typescript
    const example = "Hello, world!";
    ~~~~
    ~~~~~

 -  For shell commands, use `bash`:

    ~~~~~
    ~~~~ bash
    pnpm test
    ~~~~
    ~~~~~

### Links

 -  Use reference-style links placed at the *end of each section*
    (not at document end)
 -  Format reference links with consistent spacing:

    ~~~~
    See the [Fedify documentation] for ActivityPub details.

    [Fedify documentation]: https://fedify.dev/
    ~~~~

### GitHub alerts

Use GitHub-style alert blocks for important information:

 -  *Note*: `> [!NOTE]`
 -  *Tip*: `> [!TIP]`
 -  *Important*: `> [!IMPORTANT]`
 -  *Warning*: `> [!WARNING]`
 -  *Caution*: `> [!CAUTION]`

Continue alert content on subsequent lines with `>`:

~~~~
> [!CAUTION]
> This feature is experimental and may change in future versions.
~~~~

### Tables

Use pipe tables with proper alignment markers:

~~~~
| Package         | Description                   |
| --------------- | ----------------------------- |
| drizzle-orm     | ORM for PostgreSQL            |
~~~~

### Spacing and line length

 -  Wrap lines at approximately 80 characters for readability
 -  Use one blank line between sections and major elements
 -  Use two blank lines before Setext-style section headings
 -  Place one blank line before and after code blocks
 -  End sections with reference links (if any) followed by a blank line