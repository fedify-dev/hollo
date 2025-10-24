# Hollo - Coding Guidelines for AI Assistants

Hollo is a federated single-user microblogging software powered by [Fedify](https://fedify.dev/). It implements ActivityPub protocol for federation with other platforms (like Mastodon, Misskey, etc.) and provides Mastodon-compatible APIs for client integration.

## Project Overview

- **Technology Stack**: TypeScript, Hono.js (Web framework), Drizzle ORM, PostgreSQL
- **Package Manager**: pnpm only (npm is not used)
- **License**: GNU Affero General Public License v3 (AGPL-3.0)
- **Structure**: Single-user microblogging platform with federation capabilities
- **API**: Implements Mastodon-compatible APIs for client integration

## Key Architectural Components

1. **API Layer** (`src/api/`): Implements Mastodon-compatible REST APIs (v1 and v2)
2. **Federation** (`src/federation/`): ActivityPub implementation for federation with other platforms
3. **Database** (`src/db.ts` and `src/schema.ts`): PostgreSQL with Drizzle ORM
4. **Components** (`src/components/`): React components for web interface
5. **Entities** (`src/entities/`): Core domain models

## Development Guidelines

### Code Style

1. **TypeScript**: Maintain strict typing throughout the codebase
2. **Biome**: Follow Biome linting rules (configured in `biome.json`)
3. **Formatting**: Use the project's established formatting patterns
4. **Comments**: Add meaningful comments for complex logic, but avoid redundant documentation
5. **File Organization**: Follow the established module structure

### Database Guidelines

1. **Migrations**: Use Drizzle migrations for database schema changes
2. **Schema Design**: Follow the existing schema patterns in `src/schema.ts`
3. **Relations**: Ensure proper relation definitions between tables
4. **Transactions**: Properly handle database transactions for operations that require atomicity

### Federation Guidelines

1. **ActivityPub**: Follow ActivityPub protocol specifications
2. **Compatibility**: Ensure compatibility with Mastodon and other ActivityPub implementations
3. **Security**: Implement proper signature verification for federated activities

### API Development

1. **Mastodon Compatibility**: Maintain compatibility with Mastodon API specifications
2. **Versioning**: Respect API versioning (v1 and v2)
3. **Error Handling**: Use consistent error response formats
4. **Authentication**: Implement proper OAuth 2.0 authentication flows

### Testing

1. **Coverage**: Aim for high test coverage for critical features
2. **Unit Tests**: Write unit tests for business logic
3. **Integration Tests**: Test API endpoints and federation functionality
4. **Mocking**: Use proper mocking for external dependencies
5. **Test Runner**: Use Vitest for testing (run with `pnpm test`)

### Security Considerations

1. **Input Validation**: Validate all user inputs using Zod or similar validation libraries
2. **Authentication**: Follow secure authentication practices
3. **Authorization**: Ensure proper access control for all resources
4. **Data Protection**: Handle sensitive data appropriately
5. **Federation Security**: Implement proper signature verification for federated activities

### Performance

1. **Database Queries**: Optimize database queries for performance
2. **Indexing**: Use appropriate database indexes
3. **Caching**: Implement caching where appropriate
4. **Pagination**: Implement proper pagination for list endpoints

## Development Commands

- **Type Check & Lint**: `pnpm check` - Runs TypeScript type checking and linting
- **Testing**: `pnpm test` - Runs automated tests using Vitest
- **Formatting**: `pnpm biome format --fix` - Formats code using Biome

## Important Notes

1. **Single-User Focus**: Hollo is designed as a single-user platform, so multi-user logic is not needed
2. **Federation**: Focus on federation capabilities is essential
3. **API Compatibility**: Maintaining Mastodon API compatibility is critical for client support
4. **AGPL Compliance**: Ensure all contributions comply with AGPL-3.0 license requirements

When modifying code or implementing new features, always consider the federated nature of the application and ensure compatibility with other ActivityPub implementations.