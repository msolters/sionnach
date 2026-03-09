import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, SafeAreaView, ActivityIndicator,
  Platform, StatusBar, Pressable, Animated, Easing, PermissionsAndroid,
} from 'react-native';
import { useAudioRecorder } from '@siteed/expo-audio-studio';
import { HeroCard, QuickMatchPills, SheetMusicView, FullscreenSheet, TuneSearch } from '../src/components';
import { useTuneIdentifier } from '../src/hooks/useTuneIdentifier';
import { loadModel, releaseModel, isModelLoaded } from '../src/inference';
import { loadTuneData, getTuneById } from '../src/data/tune-index';
import { loadChromaFB } from '../src/data/chroma-fb';
import { initHannWindow } from '../src/dsp/stft';
import { resetCycleCount, cancelDSP } from '../src/dsp/pipeline';
import {
  onAudioData, getAudioBuffer, getInputLevel, clearAudioBuffer, resample,
} from '../src/audio/streaming-recorder';
import { ANALYSIS_INTERVAL_MS, SAMPLE_RATE, CAPTURE_SAMPLE_RATE } from '../src/constants';
import type { TuneEntry, TuneSetting } from '../src/types';

/**
 * Decode base64-encoded 16-bit PCM to Float32Array.
 */
function base64ToFloat32(base64: string): Float32Array {
  const binaryStr = atob(base64);
  const len = binaryStr.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binaryStr.charCodeAt(i);
  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
  return float32;
}

const WEB_BASE_URL = 'https://msolters.github.io/sionnach';
const STATUSBAR_HEIGHT = StatusBar.currentHeight ?? 0;

type AppPhase = 'loading' | 'ready' | 'error';


export default function HomeScreen() {
  const [phase, setPhase] = useState<AppPhase>('loading');
  const [loadStatus, setLoadStatus] = useState('Initializing...');
  const [recording, setRecording] = useState(false);
  const [hasEverStarted, setHasEverStarted] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [sheetSettings, setSheetSettings] = useState<TuneSetting[]>([]);
  const [sheetTuneId, setSheetTuneId] = useState<number | null>(null);
  const [sheetTuneName, setSheetTuneName] = useState('');
  const [sheetTuneType, setSheetTuneType] = useState('');
  const [sheetTuneKey, setSheetTuneKey] = useState('');
  const [debugMsg, setDebugMsg] = useState('');
  const [showDebug, setShowDebug] = useState(false);
  const [fullscreenSheet, setFullscreenSheet] = useState(false);

  // Sheet music lock: when user taps a pill or searches, lock sheet for 30s
  const sheetLockUntil = useRef(0);
  const sheetLockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { state, processSamples, reset } = useTuneIdentifier();
  const analysisActive = useRef(false);
  const analysisRunning = useRef(false);
  const audioEventCount = useRef(0);

  const btnScale = useRef(new Animated.Value(1)).current;

  const {
    startRecording: startAudioRecording,
    stopRecording: stopAudioRecording,
    isRecording,
  } = useAudioRecorder();

  // Clean up any leaked recording session from a previous hot-reload
  useEffect(() => {
    (async () => {
      try {
        // If the library thinks a recording is already in progress
        // (stale native session from hot-reload), stop it first
        if (isRecording) {
          console.log('Cleaning up leaked recording session from previous mount');
          await stopAudioRecording();
        }
      } catch (err) {
        console.warn('Cleanup of stale recording failed (safe to ignore):', err);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load all resources on mount
  useEffect(() => {
    (async () => {
      try {
        setLoadStatus('Loading tune data...');
        await loadTuneData(WEB_BASE_URL);

        setLoadStatus('Loading filter bank...');
        await loadChromaFB(WEB_BASE_URL);
        initHannWindow();

        setLoadStatus('Loading model...');
        await loadModel();

        setPhase('ready');
      } catch (err) {
        console.error('Init failed:', err);
        setLoadStatus(`Error: ${err}`);
        setPhase('error');
      }
    })();

    return () => { releaseModel(); };
  }, []);

  // Stop recording on unmount (hot-reload safety)
  // Uses a ref so the cleanup always has the latest stopAudioRecording
  const stopRecRef = useRef(stopAudioRecording);
  stopRecRef.current = stopAudioRecording;
  const recordingRef = useRef(false);
  recordingRef.current = recording;

  useEffect(() => {
    return () => {
      if (recordingRef.current) {
        console.log('Unmount: stopping active recording');
        analysisActive.current = false;
        cancelDSP();
        stopRecRef.current().catch(err =>
          console.warn('Unmount stop recording failed:', err)
        );
        clearAudioBuffer();
      }
    };
  }, []);

  // Analysis loop — self-scheduling to prevent overlap
  const runAnalysisLoop = useCallback(async () => {
    if (!analysisActive.current || analysisRunning.current || !isModelLoaded()) {
      console.log(`Analysis skip: active=${analysisActive.current} running=${analysisRunning.current} model=${isModelLoaded()}`);
      if (analysisActive.current && !analysisRunning.current) {
        // Model not loaded yet — retry
        setTimeout(runAnalysisLoop, ANALYSIS_INTERVAL_MS);
      }
      return;
    }
    analysisRunning.current = true;
    try {
      const fullBuffer = getAudioBuffer();
      const level = getInputLevel();
      if (fullBuffer.length >= SAMPLE_RATE * 2) {
        const maxSamples = SAMPLE_RATE * 8;
        const buffer = fullBuffer.length > maxSamples
          ? fullBuffer.subarray(fullBuffer.length - maxSamples)
          : fullBuffer;
        const t0 = Date.now();
        await processSamples(buffer, level);
        console.log(`Analysis cycle: ${Date.now() - t0}ms, buffer: ${buffer.length} samples`);
      }
    } catch (err) {
      console.error('Analysis error:', err);
    } finally {
      analysisRunning.current = false;
      if (analysisActive.current) {
        setTimeout(runAnalysisLoop, ANALYSIS_INTERVAL_MS);
      }
    }
  }, [processSamples]);

  // Start/stop recording
  const toggleRecording = useCallback(async () => {
    // Button bounce
    Animated.sequence([
      Animated.timing(btnScale, {
        toValue: 0.9,
        duration: 80,
        useNativeDriver: true,
      }),
      Animated.timing(btnScale, {
        toValue: 1,
        duration: 150,
        easing: Easing.out(Easing.back(2)),
        useNativeDriver: true,
      }),
    ]).start();

    try {
      // Guard: if library has a stale session our state doesn't know about, kill it
      if (!recording && isRecording) {
        console.log('Clearing stale recording session before start');
        try { await stopAudioRecording(); } catch {}
      }

      if (recording) {
        analysisActive.current = false;
        cancelDSP(); // Abort any in-progress DSP immediately
        await stopAudioRecording();
        setRecording(false);
        clearAudioBuffer();
        reset();
        resetCycleCount();
      } else {
        clearAudioBuffer();
        reset();
        audioEventCount.current = 0;

        // Ensure mic permission on Android
        setDebugMsg('Requesting mic permission...');
        if (Platform.OS === 'android') {
          const granted = await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
            {
              title: 'Microphone Permission',
              message: 'Sionnach needs microphone access to identify tunes.',
              buttonPositive: 'OK',
            }
          );
          setDebugMsg(`Permission: ${granted}`);
          if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
            setDebugMsg(`Permission DENIED: ${granted}`);
            return;
          }
        }

        setDebugMsg('Calling startRecording...');
        const result = await startAudioRecording({
          sampleRate: CAPTURE_SAMPLE_RATE,
          channels: 1,
          encoding: 'pcm_16bit',
          interval: 200,
          onAudioStream: async (event) => {
            audioEventCount.current++;
            const data = event.data;
            let pcm: Float32Array;
            if (typeof data === 'string') {
              pcm = base64ToFloat32(data);
            } else if (data instanceof Float32Array) {
              pcm = data;
            } else {
              setDebugMsg(`Bad data type: ${typeof data}`);
              return;
            }
            if (audioEventCount.current <= 3) {
              setDebugMsg(`Audio #${audioEventCount.current}: ${pcm.length} samples`);
            }
            const resampled = resample(pcm, CAPTURE_SAMPLE_RATE, SAMPLE_RATE);
            onAudioData(resampled);
            const lvl = getInputLevel();
            setAudioLevel(lvl);
          },
        });
        setDebugMsg(`Started: ${result?.fileUri?.slice(-20) ?? 'no result'}`);

        setRecording(true);
        setHasEverStarted(true);
        analysisActive.current = true;
        setTimeout(runAnalysisLoop, ANALYSIS_INTERVAL_MS);
      }
    } catch (err: any) {
      setDebugMsg(`ERROR: ${err?.message ?? err}`);
      console.error('toggleRecording error:', err);
    }
  }, [recording, runAnalysisLoop, reset, startAudioRecording, stopAudioRecording, btnScale]);

  // Helper: update sheet music display
  const showTuneSheet = useCallback((entry: TuneEntry) => {
    if (entry.settings.length > 0) {
      setSheetSettings(entry.settings);
      setSheetTuneId(entry.id);
      setSheetTuneName(entry.name);
      setSheetTuneType(entry.type);
      setSheetTuneKey(entry.key);
    }
  }, []);

  // Auto-update sheet music when a tune locks on — BUT respect user lock
  useEffect(() => {
    if (state.lockedTuneId && state.lockedTuneId !== sheetTuneId) {
      // If sheet is user-locked, don't override
      if (Date.now() < sheetLockUntil.current) return;
      const entry = getTuneById(state.lockedTuneId);
      if (entry) showTuneSheet(entry);
    }
  }, [state.lockedTuneId, sheetTuneId, showTuneSheet]);

  // User taps a pill — show that tune's sheet music + lock for 30s
  const handleSelectTune = useCallback((tuneId: number, _tuneName: string) => {
    const entry = getTuneById(tuneId);
    if (entry) {
      showTuneSheet(entry);
      sheetLockUntil.current = Date.now() + 30_000;
      // Clear any existing timer and set a new one to force re-render when lock expires
      if (sheetLockTimer.current) clearTimeout(sheetLockTimer.current);
      sheetLockTimer.current = setTimeout(() => {
        sheetLockTimer.current = null;
        // When lock expires, if there's a locked tune, switch to it
        if (state.lockedTuneId && state.lockedTuneId !== sheetTuneId) {
          const current = getTuneById(state.lockedTuneId);
          if (current) showTuneSheet(current);
        }
      }, 30_000);
    }
  }, [showTuneSheet, state.lockedTuneId, sheetTuneId]);

  // User searches and selects a tune — show sheet music + lock for 30s
  const handleSearchSelect = useCallback((tune: TuneEntry) => {
    showTuneSheet(tune);
    sheetLockUntil.current = Date.now() + 30_000;
    if (sheetLockTimer.current) clearTimeout(sheetLockTimer.current);
    sheetLockTimer.current = setTimeout(() => {
      sheetLockTimer.current = null;
      if (state.lockedTuneId) {
        const current = getTuneById(state.lockedTuneId);
        if (current) showTuneSheet(current);
      }
    }, 30_000);
  }, [showTuneSheet, state.lockedTuneId]);

  // Loading / error screen
  if (phase !== 'ready') {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="light-content" backgroundColor="#0d1a0f" />
        <View style={styles.splash}>
          <Text style={styles.splashTitle}>Sionnach</Text>
          <Text style={styles.splashSubtitle}>Irish Tune Identifier</Text>
          {phase === 'loading' && <ActivityIndicator color="#4c8c30" size="large" />}
          <Text style={styles.loadStatus}>{loadStatus}</Text>
        </View>
      </SafeAreaView>
    );
  }

  const top = state.predictions[0] ?? null;
  const topEntry = top ? getTuneById(top.id) : undefined;

  // Before first start: clean welcome screen
  if (!hasEverStarted) {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="light-content" backgroundColor="#0d1a0f" />
        <View style={styles.welcomeContent}>
          <Text style={styles.headerTitle}>Sionnach</Text>
          <Text style={styles.welcomeSubtitle}>Irish Tune Identifier</Text>
        </View>
        <View style={styles.bottomBar}>
          <Animated.View style={{ transform: [{ scale: btnScale }] }}>
            <Pressable style={styles.startBtn} onPress={toggleRecording}>
              <Text style={styles.startBtnText}>Start Listening</Text>
            </Pressable>
          </Animated.View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0d1a0f" />

      {/* Scrollable content */}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <Pressable onLongPress={() => setShowDebug(d => !d)}>
          <Text style={styles.headerTitle}>Sionnach</Text>
        </Pressable>

        <TuneSearch onSelect={handleSearchSelect} />

        <HeroCard
          top={top}
          confidence={state.confidence}
          status={recording ? (state.status || 'listening') : 'idle'}
          recording={recording}
          audioLevel={audioLevel}
          tuneKey={topEntry?.key}
          tempo={state.tempo}
          showDebug={showDebug}
        />


        {state.predictions.length > 0 && (
          <QuickMatchPills
            predictions={state.predictions}
            confidence={state.confidence}
            lockedTuneId={state.lockedTuneId}
            sheetTuneId={sheetTuneId}
            onSelect={handleSelectTune}
          />
        )}

        <SheetMusicView
          settings={sheetSettings}
          tuneName={sheetTuneName}
          tuneType={sheetTuneType}
          tuneKey={sheetTuneKey}
          tuneId={sheetTuneId ?? undefined}
          onExpand={sheetSettings.length > 0 ? () => setFullscreenSheet(true) : undefined}
        />

        {/* Spacer so content doesn't hide behind bottom button */}
        <View style={{ height: 90 }} />
      </ScrollView>

      {/* Bottom-anchored button */}
      <View style={styles.bottomBar}>
        <Animated.View style={{ transform: [{ scale: btnScale }] }}>
          <Pressable
            style={recording ? styles.stopBtn : styles.startBtn}
            onPress={toggleRecording}
          >
            <Text style={recording ? styles.stopBtnText : styles.startBtnText}>
              {recording ? 'Stop' : 'Start'}
            </Text>
          </Pressable>
        </Animated.View>
      </View>

      <FullscreenSheet
        visible={fullscreenSheet}
        settings={sheetSettings}
        tuneName={sheetTuneName}
        tuneType={sheetTuneType}
        tuneKey={sheetTuneKey}
        onClose={() => setFullscreenSheet(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0d1a0f',
    paddingTop: Platform.OS === 'android' ? STATUSBAR_HEIGHT : 0,
  },
  scroll: { flex: 1 },
  scrollContent: { padding: 16 },
  splash: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  splashTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#a8cc8c',
    textAlign: 'center',
  },
  splashSubtitle: {
    fontSize: 13,
    color: '#7a9470',
    textAlign: 'center',
  },
  loadStatus: {
    fontSize: 12,
    color: '#5a7a50',
    textAlign: 'center',
    marginTop: 8,
  },
  welcomeContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  welcomeSubtitle: {
    fontSize: 14,
    color: '#7a9470',
    textAlign: 'center',
    letterSpacing: 0.5,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#a8cc8c',
    textAlign: 'center',
    marginBottom: 12,
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingBottom: Platform.OS === 'android' ? 20 : 34,
    paddingTop: 12,
    alignItems: 'center',
    backgroundColor: 'rgba(13, 26, 15, 0.95)',
    borderTopWidth: 1,
    borderTopColor: '#2a3528',
  },
  startBtn: {
    paddingVertical: 12,
    paddingHorizontal: 48,
    borderRadius: 28,
    backgroundColor: '#3d7a2a',
  },
  startBtnText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#e8f0e0',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  stopBtn: {
    paddingVertical: 12,
    paddingHorizontal: 48,
    borderRadius: 28,
    backgroundColor: '#8c3030',
  },
  stopBtnText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#e8f0e0',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
});
