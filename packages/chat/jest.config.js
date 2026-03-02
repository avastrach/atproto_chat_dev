/** @type {import('jest').Config} */
module.exports = {
  displayName: 'Chat Service',
  transform: { '^.+\\.(t|j)s$': '@swc/jest' },
  transformIgnorePatterns: ['/node_modules/.pnpm/(?!(get-port)@)'],
  testTimeout: 120000,
  setupFiles: ['<rootDir>/../../jest.setup.ts'],
  moduleNameMapper: { '^(\\.\\.?\\/.+)\\.js$': ['$1.ts', '$1.js'] },
  // Run tests serially to avoid exhausting the PostgreSQL connection pool.
  // Each test file creates its own TestNetwork with multiple DB connections.
  maxWorkers: 1,
  coverageProvider: 'v8',
  collectCoverageFrom: ['dist/**/*.js'],
  coveragePathIgnorePatterns: ['/node_modules/', 'dist/db/tables/', 'dist/db/database-schema.js', 'dist/db/migrator.js', 'dist/rate-limiter.js', 'dist/redis.js'],
}
