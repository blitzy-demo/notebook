const func = require('@jupyterlab/testutils/lib/jest-config');
const upstream = func(__dirname);

// ES modules that need special handling in Jest
const esModules = ['lib0', 'y-protocols', 'yjs', 'y-websocket'].join('|');

let local = {
  preset: 'ts-jest/presets/js-with-babel',
  transformIgnorePatterns: [
    `/node_modules/(?!${esModules}).+\\.js/(?!(@jupyterlab/.*)/)`,
  ],
  globals: {
    'ts-jest': {
      tsconfig: './tsconfig.test.json',
    },
  },
};

// Merge local configuration with upstream configuration
Object.keys(local).forEach((option) => {
  upstream[option] = local[option];
});

module.exports = upstream;