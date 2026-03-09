import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, SafeAreaView, ActivityIndicator,
  Platform, StatusBar,
} from 'react-native';
import { Audio } from 'expo-av';
import LiveAudioStream from 'react-native-live-audio-stream';
import { HeroCard, QuickMatchPills, SheetMusicView, MicButton } from '../src/components';
import { useTuneIdentifier } from '../src/hooks/useTuneIdentifier';
import { loadModel, releaseModel } from '../src/inference';
import { loadTuneData, getTuneById } from '../src/data/tune-index';
import { loadChromaFB } from '../src/data/chroma-fb';
import { initHannWindow } from '../src/dsp/stft';
import {
  onAudioData, getAudioBuffer, getInputLevel, clearAudioBuffer,
} from '../src/audio/streaming-recorder';
import { ANALYSIS_INTERVAL_MS, SAMPLE_RATE } from '../src/constants';

/**
 * Decode base64-encoded 16-bit PCM to Float32Array.
 * react-native-live-audio-stream emits base64 strings of raw PCM bytes.
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

// Base URL for loading assets from the web app deployment
const WEB_BASE_URL = 'https://msolters.github.io/sionnach';

const STATUSBAR_HEIGHT = StatusBar.currentHeight ?? 0;

type AppPhase = 'loading' | 'ready' | 'error';

export default function HomeScreen() {
  const [phase, setPhase] = useState<AppPhase>('loading');
  const [loadStatus, setLoadStatus] = useState('Initializing...');
  const [recording, setRecording] = useState(false);
  const [inputLevel, setInputLevel] = useState(0);
  const [sheetAbc, setSheetAbc] = useState('');
  const [sheetTuneId, setSheetTuneId] = useState<number | null>(null);

  const { state, processSamples, reset } = useTuneIdentifier();
  const analysisTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const levelTimer = useRef<ReturnType<typeof setInterval> | null>(null);

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

  // Analysis loop: process accumulated audio at regular intervals
  const runAnalysis = useCallback(async () => {
    const buffer = getAudioBuffer();
    const level = getInputLevel();
    if (buffer.length < 22050 * 2) return; // need at least 2s

    await processSamples(buffer, level);
  }, [processSamples]);

  // Start/stop recording
  const toggleRecording = useCallback(async () => {
    if (recording) {
      // Stop — remove listener before stopping to prevent stale callbacks
      LiveAudioStream.stop();
      (LiveAudioStream as any).removeAllListeners?.('data');
      setRecording(false);
      if (analysisTimer.current) {
        clearInterval(analysisTimer.current);
        analysisTimer.current = null;
      }
      if (levelTimer.current) {
        clearInterval(levelTimer.current);
        levelTimer.current = null;
      }
      setInputLevel(0);
      clearAudioBuffer();
      reset();
    } else {
      // Request mic permission
      const { status } = await Audio.requestPermissionsAsync();
      if (status !== 'granted') {
        console.warn('Microphone permission denied');
        return;
      }

      // Configure audio session (iOS needs this for recording)
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
      });

      clearAudioBuffer();
      reset();

      // Init and start streaming audio capture
      LiveAudioStream.init({
        sampleRate: SAMPLE_RATE,
        channels: 1,
        bitsPerSample: 16,
        audioSource: Platform.OS === 'android' ? 6 : undefined, // VOICE_RECOGNITION on Android
        wavFile: '', // not used — we stream via 'data' events, not file output
      });
      LiveAudioStream.on('data', (base64: string) => {
        const pcm = base64ToFloat32(base64);
        onAudioData(pcm);
      });
      LiveAudioStream.start();

      setRecording(true);

      // Poll input level at ~15fps for visual feedback
      levelTimer.current = setInterval(() => {
        setInputLevel(getInputLevel());
      }, 66);

      analysisTimer.current = setInterval(runAnalysis, ANALYSIS_INTERVAL_MS);
    }
  }, [recording, runAnalysis, reset]);

  // Load sheet music when locked tune changes
  useEffect(() => {
    if (state.lockedTuneId && state.lockedTuneId !== sheetTuneId) {
      const entry = getTuneById(state.lockedTuneId);
      if (entry && entry.settings.length > 0) {
        setSheetAbc(entry.settings[0].abc);
        setSheetTuneId(state.lockedTuneId);
      }
    }
  }, [state.lockedTuneId, sheetTuneId]);

  const handleSelectTune = useCallback((tuneId: number, tuneName: string) => {
    const entry = getTuneById(tuneId);
    if (entry && entry.settings.length > 0) {
      setSheetAbc(entry.settings[0].abc);
      setSheetTuneId(tuneId);
    }
  }, []);

  // Loading screen
  if (phase !== 'ready') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.splash}>
          <Text style={styles.title}>Sionnach</Text>
          <Text style={styles.subtitle}>Irish Tune Identifier</Text>
          {phase === 'loading' && <ActivityIndicator color="#4c8c30" size="large" />}
          <Text style={styles.loadStatus}>{loadStatus}</Text>
        </View>
      </SafeAreaView>
    );
  }

  const top = state.predictions[0] ?? null;
  const tuneEntry = top ? getTuneById(top.id) : undefined;

  // Audio level bar: scale 0-1, clamped
  const levelWidth = Math.min(1, inputLevel * 8); // amplify for visibility

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0d1a0f" />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <Text style={styles.title}>Sionnach</Text>

        <HeroCard
          top={top}
          confidence={state.confidence}
          status={recording ? state.status || 'listening' : 'idle'}
          tempo={state.tempo}
          tuneKey={tuneEntry?.key}
        />

        {/* Audio level indicator */}
        {recording && (
          <View style={styles.levelContainer}>
            <View style={[styles.levelBar, { width: `${levelWidth * 100}%` }]} />
          </View>
        )}

        <View style={styles.micRow}>
          <MicButton recording={recording} onPress={toggleRecording} />
        </View>

        {state.predictions.length > 0 && (
          <QuickMatchPills
            predictions={state.predictions}
            lockedTuneId={state.lockedTuneId}
            sheetTuneId={sheetTuneId}
            onSelect={handleSelectTune}
          />
        )}

        {sheetAbc ? (
          <SheetMusicView abc={sheetAbc} height={250} />
        ) : null}
      </ScrollView>
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
  scrollContent: { padding: 16, gap: 12 },
  splash: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
    paddingTop: Platform.OS === 'android' ? STATUSBAR_HEIGHT : 0,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#c8e0b0',
    textAlign: 'center',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#7a9470',
    textAlign: 'center',
  },
  loadStatus: {
    fontSize: 12,
    color: '#5a7a50',
    textAlign: 'center',
    marginTop: 8,
  },
  levelContainer: {
    height: 4,
    backgroundColor: '#1a2a1a',
    borderRadius: 2,
    overflow: 'hidden',
  },
  levelBar: {
    height: '100%',
    backgroundColor: '#4c8c30',
    borderRadius: 2,
  },
  micRow: {
    alignItems: 'center',
    marginVertical: 4,
  },
});
