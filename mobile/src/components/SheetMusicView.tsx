import React, { useRef, useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';

interface Props {
  abc: string;
  height?: number;
}

const SHEET_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
  <script src="https://cdn.jsdelivr.net/npm/abcjs@6.4.4/dist/abcjs-basic-min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: transparent; overflow: hidden; }
    #sheet { width: 100%; }
    #sheet svg { max-width: 100%; display: block; }
    .abcjs-note, .abcjs-beam, .abcjs-stem, .abcjs-rest,
    .abcjs-bar, .abcjs-brace, .abcjs-clef, .abcjs-key-signature,
    .abcjs-time-signature { fill: #d4ddd0; stroke: #d4ddd0; }
    .abcjs-staff { stroke: #3a4a38; }
  </style>
</head>
<body>
  <div id="sheet"></div>
  <script>
    document.addEventListener('message', function(e) {
      var data = JSON.parse(e.data);
      if (data.abc) {
        ABCJS.renderAbc('sheet', data.abc, {
          responsive: 'resize',
          staffwidth: 600,
          paddingtop: 0,
          paddingbottom: 0,
        });
        // Report rendered height back
        var h = document.getElementById('sheet').scrollHeight;
        window.ReactNativeWebView.postMessage(JSON.stringify({ height: h }));
      }
    });
  </script>
</body>
</html>
`;

export function SheetMusicView({ abc, height = 200 }: Props) {
  const webViewRef = useRef<WebView>(null);

  const onLoadEnd = useCallback(() => {
    if (abc && webViewRef.current) {
      webViewRef.current.postMessage(JSON.stringify({ abc }));
    }
  }, [abc]);

  // Re-send ABC when it changes
  React.useEffect(() => {
    if (abc && webViewRef.current) {
      webViewRef.current.postMessage(JSON.stringify({ abc }));
    }
  }, [abc]);

  return (
    <View style={[styles.container, { height }]}>
      <WebView
        ref={webViewRef}
        source={{ html: SHEET_HTML }}
        style={styles.webview}
        onLoadEnd={onLoadEnd}
        scrollEnabled={false}
        javaScriptEnabled
        originWhitelist={['*']}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#0d1a0f',
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#2a3528',
  },
  webview: {
    backgroundColor: 'transparent',
    flex: 1,
  },
});
