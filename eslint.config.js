const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    { ignores: ['node_modules/**', '.vscode-test/**'] },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: { ...globals.node }
        },
        rules: {
            'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
            // Catches `const x = x(...)`, where a local shadows an import and throws at runtime.
            // Function declarations are hoisted, so calling them before their definition is fine.
            'no-use-before-define': ['error', { functions: false, classes: true, variables: true }]
        }
    }
];
