import React, { useRef, useCallback, useState, useEffect } from 'react';
import { View, Text, Pressable, Linking, StyleSheet, Animated, Easing } from 'react-native';
import { WebView } from 'react-native-webview';
import { SESSION_URL } from '../constants';
import { formatKey } from '../utils/format-key';
import { ABCJS_SOURCE } from '../assets/abcjs-source';
import type { TuneSetting } from '../types';

interface Props {
  settings: TuneSetting[];
  tuneName?: string;
  tuneType?: string;
  tuneKey?: string;
  tuneId?: number;
  initialIndex?: number;
  onExpand?: () => void;
}

const SHEET_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes">
  <script>${ABCJS_SOURCE}</script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #e8e0d0; }
    #sheet { width: 100%; padding: 10px 6px 16px; }
    #sheet svg { max-width: 100%; display: block; }

    /* Traditional engraving look: near-black on warm cream */
    #sheet svg path, #sheet svg line, #sheet svg rect,
    #sheet svg polygon, #sheet svg circle,
    #sheet svg ellipse {
      fill: #1a1a1a;
      stroke: #1a1a1a;
    }
    #sheet svg .abcjs-staff {
      stroke: #b0a898;
    }
    #sheet svg .abcjs-staff-extra {
      stroke: #b0a898;
    }
    #sheet svg text {
      fill: #1a1a1a;
      stroke: none;
    }
  </style>
</head>
<body>
  <div id="sheet"></div>
  <script>
    function handleMessage(e) {
      var data = JSON.parse(e.data);
      if (data.abc) {
        ABCJS.renderAbc('sheet', data.abc, {
          responsive: 'resize',
          staffwidth: 740,
          paddingtop: 4,
          paddingbottom: 4,
          paddingleft: 4,
          paddingright: 4,
          wrap: {
            minSpacing: 1.8,
            maxSpacing: 2.7,
            preferredMeasuresPerLine: 4,
          },
        });
        setTimeout(function() {
          var h = document.getElementById('sheet').scrollHeight;
          window.ReactNativeWebView.postMessage(JSON.stringify({ height: h }));
        }, 50);
      }
    }
    document.addEventListener('message', handleMessage);
    window.addEventListener('message', handleMessage);
    window.addEventListener('load', function() {
      window.ReactNativeWebView.postMessage(JSON.stringify({ ready: true }));
    });
  </script>
</body>
</html>
`;

/** Animated shimmer skeleton */
const SheetSkeleton = React.memo(function SheetSkeleton() {
  const shimmer = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(shimmer, {
        toValue: 1,
        duration: 1200,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [shimmer]);

  const opacity = shimmer.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0.15, 0.35, 0.15],
  });

  return (
    <View style={skeletonStyles.container}>
      {[0, 1, 2, 3, 4].map(i => (
        <Animated.View
          key={`s1-${i}`}
          style={[skeletonStyles.staffLine, { opacity, marginTop: i === 0 ? 16 : 6 }]}
        />
      ))}
      <View style={skeletonStyles.noteRow}>
        {[40, 28, 52, 36, 44, 30, 48, 34].map((w, i) => (
          <Animated.View key={`n1-${i}`} style={[skeletonStyles.noteBlock, { opacity, width: w }]} />
        ))}
      </View>
      {[0, 1, 2, 3, 4].map(i => (
        <Animated.View
          key={`s2-${i}`}
          style={[skeletonStyles.staffLine, { opacity, marginTop: i === 0 ? 20 : 6 }]}
        />
      ))}
      <View style={skeletonStyles.noteRow}>
        {[36, 44, 30, 52, 40, 28, 46, 32].map((w, i) => (
          <Animated.View key={`n2-${i}`} style={[skeletonStyles.noteBlock, { opacity, width: w }]} />
        ))}
      </View>
      <Animated.Text style={[skeletonStyles.loadingText, { opacity }]}>
        Rendering notation...
      </Animated.Text>
    </View>
  );
});

export function SheetMusicView({
  settings, tuneName, tuneType, tuneKey, tuneId, initialIndex = 0, onExpand,
}: Props) {
  const webViewRef = useRef<WebView>(null);
  const [settingIdx, setSettingIdx] = useState(initialIndex);
  const [contentHeight, setContentHeight] = useState(200);
  const [sheetReady, setSheetReady] = useState(false);
  const webViewReady = useRef(false);
  const pendingAbc = useRef<string | null>(null);

  const readyAnim = useRef(new Animated.Value(0)).current;
  const entranceAnim = useRef(new Animated.Value(0)).current;

  const hasSettings = settings.length > 0;
  const currentAbc = settings[settingIdx]?.abc ?? '';

  // Animate entrance when tune changes
  const prevTuneId = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (hasSettings && tuneId !== prevTuneId.current) {
      prevTuneId.current = tuneId;
      setSettingIdx(0);
      setSheetReady(false);
      readyAnim.setValue(0);
      entranceAnim.setValue(0);
      Animated.timing(entranceAnim, {
        toValue: 1,
        duration: 300,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }
  }, [tuneId, hasSettings, entranceAnim, readyAnim]);

  const sendAbc = useCallback((abc: string) => {
    if (!abc) return;
    if (webViewReady.current && webViewRef.current) {
      webViewRef.current.postMessage(JSON.stringify({ abc }));
    } else {
      pendingAbc.current = abc;
    }
  }, []);

  useEffect(() => {
    if (!currentAbc) return;
    setSheetReady(false);
    readyAnim.setValue(0);
    sendAbc(currentAbc);
  }, [currentAbc, sendAbc, readyAnim]);

  const onMessage = useCallback((event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);

      if (data.ready) {
        webViewReady.current = true;
        if (pendingAbc.current) {
          const abc = pendingAbc.current;
          pendingAbc.current = null;
          if (webViewRef.current) {
            webViewRef.current.postMessage(JSON.stringify({ abc }));
          }
        }
        return;
      }

      if (data.height && data.height > 0) {
        setContentHeight(data.height + 8);
        if (!sheetReady) {
          setSheetReady(true);
          Animated.timing(readyAnim, {
            toValue: 1,
            duration: 300,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }).start();
        }
      }
    } catch {}
  }, [sheetReady, readyAnim]);

  const goPrev = useCallback(() => {
    setSettingIdx(i => (i > 0 ? i - 1 : settings.length - 1));
  }, [settings.length]);

  const goNext = useCallback(() => {
    setSettingIdx(i => (i < settings.length - 1 ? i + 1 : 0));
  }, [settings.length]);

  const entranceOpacity = entranceAnim;
  const entranceTranslateY = entranceAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [16, 0],
  });

  // CRITICAL: The tree structure is always the same regardless of hasSettings.
  // This keeps the WebView mounted in the same tree position so React never
  // unmounts/remounts it. When no settings, the outer view collapses to 0 height.
  return (
    <Animated.View style={hasSettings ? [
      styles.container,
      { opacity: entranceOpacity, transform: [{ translateY: entranceTranslateY }] },
    ] : styles.preWarm}>

      {/* Header — tune name, meta, View button */}
      {hasSettings && tuneName ? (
        <View style={styles.tuneHeader}>
          <View style={styles.tuneHeaderLeft}>
            <Text style={styles.tuneName} numberOfLines={2}>{tuneName}</Text>
            <View style={styles.metaRow}>
              {tuneType ? <Text style={styles.tuneType}>{tuneType}</Text> : null}
              {tuneKey ? <Text style={styles.tuneKeyText}>{formatKey(tuneKey)}</Text> : null}
            </View>
          </View>
          {onExpand ? (
            <Pressable style={styles.expandBtn} onPress={onExpand}>
              <Text style={styles.expandBtnText}>View</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {/* Settings navigation row */}
      {hasSettings && settings.length > 1 ? (
        <View style={styles.navRow}>
          <Pressable onPress={goPrev} style={styles.navBtn}>
            <Text style={styles.navArrow}>{'\u2039'}</Text>
          </Pressable>
          <View style={styles.navCenter}>
            <Text style={styles.navLabel}>
              Setting {settingIdx + 1} of {settings.length}
            </Text>
            {tuneId ? (
              <Pressable
                style={styles.sessionBtn}
                onPress={() => Linking.openURL(`${SESSION_URL}/${tuneId}`)}
              >
                <Text style={styles.sessionBtnText}>The Session</Text>
              </Pressable>
            ) : null}
          </View>
          <Pressable onPress={goNext} style={styles.navBtn}>
            <Text style={styles.navArrow}>{'\u203A'}</Text>
          </Pressable>
        </View>
      ) : hasSettings && tuneId ? (
        <View style={styles.navRowSingle}>
          <Pressable
            style={styles.sessionBtn}
            onPress={() => Linking.openURL(`${SESSION_URL}/${tuneId}`)}
          >
            <Text style={styles.sessionBtnText}>The Session</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Sheet music area — always rendered so WebView stays alive */}
      <View style={hasSettings ? { height: contentHeight, position: 'relative' as const } : styles.webViewPreWarm}>
        {hasSettings && !sheetReady && (
          <View style={StyleSheet.absoluteFill}>
            <SheetSkeleton />
          </View>
        )}
        <Animated.View style={hasSettings ? [StyleSheet.absoluteFill, { opacity: readyAnim }] : { flex: 1 }}>
          <WebView
            ref={webViewRef}
            source={{ html: SHEET_HTML }}
            style={styles.webview}
            onMessage={onMessage}
            scrollEnabled={true}
            javaScriptEnabled
            originWhitelist={['*']}
          />
        </Animated.View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#1a2418',
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#2a3528',
  },
  preWarm: {
    height: 1,
    overflow: 'hidden',
    opacity: 0,
  },
  webViewPreWarm: {
    height: 1,
    overflow: 'hidden',
  },
  tuneHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#2a3528',
    gap: 12,
  },
  tuneHeaderLeft: {
    flex: 1,
  },
  tuneName: {
    fontSize: 17,
    fontWeight: '700',
    color: '#c8e0b0',
  },
  metaRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 3,
  },
  tuneType: {
    fontSize: 12,
    color: '#c4973a',
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  tuneKeyText: {
    fontSize: 12,
    color: '#7a9470',
    fontWeight: '500',
  },
  expandBtn: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: '#3d7a2a',
    borderRadius: 16,
  },
  expandBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#e8f0e0',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  sessionBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    backgroundColor: '#0d1a0f',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2a3528',
  },
  sessionBtnText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#7a9470',
    letterSpacing: 0.5,
  },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#2a3528',
  },
  navCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  navRowSingle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#2a3528',
  },
  navBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    backgroundColor: '#0d1a0f',
  },
  navArrow: {
    fontSize: 22,
    color: '#7a9470',
    fontWeight: '700',
  },
  navLabel: {
    fontSize: 11,
    color: '#7a9470',
    fontWeight: '500',
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
  webview: {
    backgroundColor: '#e8e0d0',
    flex: 1,
  },
});

const skeletonStyles = StyleSheet.create({
  container: {
    padding: 14,
    backgroundColor: '#e8e0d0',
  },
  staffLine: {
    height: 1,
    backgroundColor: '#c0b8a8',
    borderRadius: 0.5,
  },
  noteRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
    paddingHorizontal: 4,
  },
  noteBlock: {
    height: 10,
    backgroundColor: '#d0c8b8',
    borderRadius: 3,
  },
  loadingText: {
    fontSize: 11,
    color: '#a09888',
    textAlign: 'center',
    marginTop: 16,
    letterSpacing: 0.5,
  },
});
