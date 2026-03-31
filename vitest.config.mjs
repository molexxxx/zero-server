import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        testTimeout: 30000,
        coverage: {
            provider: 'v8',
            include: ['lib/**/*.js', 'index.js'],
            reporter: ['text', 'json-summary'],
            reportsDirectory: './coverage',
        },
    },
});
