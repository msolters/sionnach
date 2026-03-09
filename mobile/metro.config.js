const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Allow Metro to bundle .onnx files as assets
config.resolver.assetExts.push('onnx');

module.exports = config;
