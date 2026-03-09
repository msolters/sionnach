const { withProjectBuildGradle } = require('expo/config-plugins');

/**
 * Fix onnxruntime-react-native dynamic version resolution on EAS Build.
 * The library uses `latest.integration` which fails due to JDK XML parser
 * incompatibility on EAS build servers. Pin to the installed version instead.
 */
module.exports = function withOnnxruntimeFix(config) {
  return withProjectBuildGradle(config, (mod) => {
    if (mod.modResults.language === 'groovy') {
      const contents = mod.modResults.contents;

      // Add resolutionStrategy to force specific onnxruntime version
      const injection = `
    subprojects {
        configurations.all {
            resolutionStrategy {
                force 'com.microsoft.onnxruntime:onnxruntime-android:1.24.3'
            }
        }
    }`;

      // Insert after allprojects { ... } block
      if (!contents.includes('resolutionStrategy')) {
        mod.modResults.contents = contents + '\n' + injection + '\n';
      }
    }
    return mod;
  });
};
