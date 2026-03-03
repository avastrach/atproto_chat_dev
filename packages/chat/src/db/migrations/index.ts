// NOTE this file can be edited by hand, but it is also appended to by the migration:create command.
// It's important that every migration is exported from here with the proper name. We'd simplify
// this with kysely's FileMigrationProvider, but it doesn't play nicely with the build process.
export * as _001_initial from './001_initial'
export * as _002_add_rejoined_at from './002_add_rejoined_at'
