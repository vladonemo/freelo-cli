/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      ['api', 'commands', 'config', 'ui', 'lib', 'errors', 'bin', 'sdlc', 'release', 'deps', ''],
    ],
    'scope-empty': [0],
  },
};
