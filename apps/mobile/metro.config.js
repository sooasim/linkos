// Metro: consume the pure domain package (@linkos/domain) straight from the monorepo source.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const domainRoot = path.resolve(projectRoot, "../../packages/domain");

const config = getDefaultConfig(projectRoot);
config.watchFolders = [domainRoot];
config.resolver.extraNodeModules = { "@linkos/domain": domainRoot }; // package.json main → ./src/index.ts
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];

module.exports = config;
