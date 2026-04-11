module.exports = {
  testEnvironment: 'node',
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/index.js', // Entry point tested via integration tests
    '!src/adapters/**', // Adapters tested separately
  ],
  coveragePathIgnorePatterns: ['/node_modules/'],
  testMatch: [
    '**/tests/**/__tests__/**/*.js',
    '**/tests/**/*.test.js',
    '**/tests/**/*.spec.js',
  ],
  testPathIgnorePatterns: ['/node_modules/'],
  verbose: true,
  bail: 1,
};
