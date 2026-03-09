import React, { useRef, useCallback, useState, useEffect } from 'react';
import {
  View, Text, Pressable, StyleSheet, StatusBar, Modal,
  useWindowDimensions,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { ABCJS_SOURCE } from '../assets/abcjs-source';
import { formatKey } from '../utils/format-key';
import type { TuneSetting } from '../types';

interface Props {
  visible: boolean;
  settings: TuneSetting[];
  tuneName?: string;
  tuneType?: string;
  tuneKey?: string;
  initialIndex?: number;
  onClose: () => void;
}

const FULLSCREEN_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes">
  <script>${ABCJS_SOURCE}</script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #e8e0d0;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
    }
    #sheet {
      width: 100%;
      padding: 12px 8px 60px;
    }
    #sheet svg {
      max-width: 100%;
      display: block;
    }
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
          staffwidth: data.staffwidth || 740,
          paddingtop: 8,
          paddingbottom: 8,
          scale: 1.0,
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

export function FullscreenSheet({
  visible, settings, tuneName, tuneType, tuneKey, initialIndex = 0, onClose,
}: Props) {
  const webViewRef = useRef<WebView>(null);
  const [settingIdx, setSettingIdx] = useState(initialIndex);
  const [landscape, setLandscape] = useState(false);
  const webViewReady = useRef(false);
  const pendingAbc = useRef<string | null>(null);
  const { width: screenW, height: screenH } = useWindowDimensions();

  const portW = Math.min(screenW, screenH);
  const portH = Math.max(screenW, screenH);
  const viewW = landscape ? portH : portW;
  const viewH = landscape ? portW : portH;

  const currentAbc = settings[settingIdx]?.abc ?? '';

  // Reset when opening
  useEffect(() => {
    if (visible) {
      setSettingIdx(initialIndex);
      setLandscape(false);
      webViewReady.current = false;
      pendingAbc.current = null;
    }
  }, [visible, initialIndex]);

  // Reset setting index when tune changes while modal is open
  const prevSettings = useRef(settings);
  useEffect(() => {
    if (visible && settings !== prevSettings.current) {
      prevSettings.current = settings;
      setSettingIdx(0);
    }
  }, [visible, settings]);

  const sendAbc = useCallback((abc: string) => {
    if (!abc) return;
    const sw = Math.max(Math.round(viewW * 0.90), 300);
    const msg = JSON.stringify({ abc, staffwidth: sw });
    if (webViewReady.current && webViewRef.current) {
      webViewRef.current.postMessage(msg);
    } else {
      pendingAbc.current = msg;
    }
  }, [viewW]);

  // Re-send ABC when orientation or setting changes
  useEffect(() => {
    if (visible && currentAbc) {
      sendAbc(currentAbc);
    }
  }, [visible, currentAbc, sendAbc]);

  const onMessage = useCallback((event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.ready) {
        webViewReady.current = true;
        if (pendingAbc.current) {
          const msg = pendingAbc.current;
          pendingAbc.current = null;
          webViewRef.current?.postMessage(msg);
        }
      }
    } catch {}
  }, []);

  const goPrev = useCallback(() => {
    setSettingIdx(i => (i > 0 ? i - 1 : settings.length - 1));
  }, [settings.length]);

  const goNext = useCallback(() => {
    setSettingIdx(i => (i < settings.length - 1 ? i + 1 : 0));
  }, [settings.length]);

  const isLandscape = landscape;

  return (
    <Modal
      visible={visible}
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <StatusBar hidden />
      <View style={st.backdrop}>
        <View style={[
          st.mainContainer,
          {
            width: viewW,
            height: viewH,
            transform: isLandscape ? [{ rotate: '-90deg' }] : [],
          },
        ]}>
          {/* Top bar */}
          <View style={st.topBar}>
            <Pressable onPress={onClose} style={st.closeBtn}>
              <Text style={st.closeBtnText}>{'\u2715'}</Text>
            </Pressable>

            {/* Title + metadata */}
            <View style={st.titleArea}>
              {tuneName ? (
                <Text style={st.title} numberOfLines={1}>{tuneName}</Text>
              ) : null}
              {(tuneType || tuneKey) ? (
                <View style={st.metaRow}>
                  {tuneType ? <Text style={st.metaType}>{tuneType}</Text> : null}
                  {tuneKey ? <Text style={st.metaKey}>{formatKey(tuneKey)}</Text> : null}
                </View>
              ) : null}
            </View>

            {/* Setting nav */}
            {settings.length > 1 ? (
              <View style={st.navRow}>
                <Pressable onPress={goPrev} style={st.navBtn}>
                  <Text style={st.navArrow}>{'\u2039'}</Text>
                </Pressable>
                <Text style={st.navLabel}>
                  {settingIdx + 1}/{settings.length}
                </Text>
                <Pressable onPress={goNext} style={st.navBtn}>
                  <Text style={st.navArrow}>{'\u203A'}</Text>
                </Pressable>
              </View>
            ) : null}

            {/* Rotate toggle */}
            <Pressable onPress={() => setLandscape(l => !l)} style={st.rotateBtn}>
              <Text style={st.rotateBtnText}>{isLandscape ? '\u21BA' : '\u21BB'}</Text>
            </Pressable>
          </View>

          {/* Sheet music */}
          <WebView
            ref={webViewRef}
            source={{ html: FULLSCREEN_HTML }}
            style={st.webview}
            onMessage={onMessage}
            scrollEnabled={true}
            javaScriptEnabled
            originWhitelist={['*']}
          />
        </View>
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: '#0d1a0f',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mainContainer: {
    backgroundColor: '#0d1a0f',
    overflow: 'hidden',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#1a2418',
    borderBottomWidth: 1,
    borderBottomColor: '#2a3528',
    gap: 10,
  },
  closeBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    backgroundColor: '#0d1a0f',
    borderWidth: 1,
    borderColor: '#2a3528',
  },
  closeBtnText: {
    fontSize: 14,
    color: '#7a9470',
    fontWeight: '700',
  },
  titleArea: {
    flex: 1,
    justifyContent: 'center',
  },
  title: {
    fontSize: 15,
    fontWeight: '700',
    color: '#c8e0b0',
  },
  metaRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 2,
  },
  metaType: {
    fontSize: 11,
    color: '#c4973a',
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  metaKey: {
    fontSize: 11,
    color: '#7a9470',
    fontWeight: '500',
  },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  navBtn: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    backgroundColor: '#0d1a0f',
    borderWidth: 1,
    borderColor: '#2a3528',
  },
  navArrow: {
    fontSize: 18,
    color: '#7a9470',
    fontWeight: '700',
  },
  navLabel: {
    fontSize: 11,
    color: '#7a9470',
    fontWeight: '500',
    letterSpacing: 1.2,
  },
  rotateBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    backgroundColor: '#0d1a0f',
    borderWidth: 1,
    borderColor: '#2a3528',
  },
  rotateBtnText: {
    fontSize: 16,
    color: '#7a9470',
    fontWeight: '700',
  },
  webview: {
    flex: 1,
    backgroundColor: '#e8e0d0',
  },
});
