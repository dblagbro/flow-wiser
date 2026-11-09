module.exports = {
    extends: [
        'eslint:recommended',
        'plugin:markdown/recommended',
        'plugin:react/recommended',
        'plugin:react/jsx-runtime',
        'plugin:react-hooks/recommended',
        'plugin:jsx-a11y/recommended',
        'plugin:prettier/recommended'
    ],
    settings: {
        react: {
            version: 'detect'
        }
    },
    parser: '@typescript-eslint/parser',
    ignorePatterns: [
        '**/node_modules',
        '**/dist',
        '**/build',
        '**/coverage',
        '**/package-lock.json',
        // Secret material must never be read by a linter.
        //
        // `pnpm lint` globs **/*.json, which matched a credential export sitting in the
        // working directory. ESLint opened it; only a root-owned 0600 file mode stopped
        // the read (EACCES), which also broke the lint gate outright. Had the file been
        // readable, ESLint would have parsed it and could have echoed its contents into
        // an error message, a log, or CI output.
        //
        // .gitignore does not apply to ESLint. These patterns mirror the secret section
        // of .gitignore -- keep the two in step. See AGENTS.md section 9.
        '**/flowise-credentials-backup-*.json',
        '**/*credentials-backup*',
        '**/*.sqlite',
        '**/*.sqlite3',
        '**/.env',
        '**/.env.*',
        '**/*service-account*.json',
        '**/*secret*.json',
        '**/*.pem',
        '**/*.key'
    ],
    plugins: ['unused-imports'],
    rules: {
        '@typescript-eslint/explicit-module-boundary-types': 'off',
        'no-unused-vars': 'off',
        'unused-imports/no-unused-imports': 'warn',
        'unused-imports/no-unused-vars': ['warn', { vars: 'all', varsIgnorePattern: '^_', args: 'after-used', argsIgnorePattern: '^_' }],
        'no-undef': 'off',
        'no-console': [process.env.CI ? 'error' : 'warn', { allow: ['warn', 'error', 'info'] }],
        'prettier/prettier': 'error',
        'no-control-regex': 0 // Used to match control regex's in user input
    }
}
