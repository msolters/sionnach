const { withProjectBuildGradle, withAppBuildGradle } = require('expo/config-plugins');

/**
 * Fix onnxruntime-react-native build issues on EAS Build:
 * 1. Pin onnxruntime-android version (dynamic resolution fails on EAS)
 * 2. Exclude duplicate libreactnative.so from onnxruntime AAR
 */
module.exports = function withOnnxruntimeFix(config) {
  // Fix 1: Force specific onnxruntime version in project build.gradle
  config = withProjectBuildGradle(config, (mod) => {
    if (mod.modResults.language === 'groovy') {
      const contents = mod.modResults.contents;
      const injection = `
    subprojects {
        configurations.all {
            resolutionStrategy {
                force 'com.microsoft.onnxruntime:onnxruntime-android:1.24.3'
            }
        }
    }`;
      if (!contents.includes('resolutionStrategy')) {
        mod.modResults.contents = contents + '\n' + injection + '\n';
      }
    }
    return mod;
  });

  // Fix 2: Add pickFirst for duplicate native libs in app build.gradle
  config = withAppBuildGradle(config, (mod) => {
    if (mod.modResults.language === 'groovy') {
      let contents = mod.modResults.contents;
      if (!contents.includes("pickFirst 'lib/")) {
        // Insert pickFirst directives inside existing packagingOptions block
        contents = contents.replace(
          /^(\s*packagingOptions\s*\{)/m,
          `$1
        pickFirst 'lib/arm64-v8a/libreactnative.so'
        pickFirst 'lib/x86_64/libreactnative.so'
        pickFirst 'lib/x86/libreactnative.so'
        pickFirst 'lib/armeabi-v7a/libreactnative.so'`
        );
        mod.modResults.contents = contents;
      }
    }
    return mod;
  });

  return config;
};
