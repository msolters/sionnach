import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, SafeAreaView, ActivityIndicator,
  Platform, StatusBar, Pressable, Linking,
} from 'react-native';
import { Audio } from 'expo-av';
import LiveAudioStream from 'react-native-live-audio-stream';
import { HeroCard, QuickMatchPills, SheetMusicView } from '../src/components';
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
  const [sheetAbc, setSheetAbc] = useState('');
  const [sheetTuneId, setSheetTuneId] = useState<number | null>(null);

  const { state, processSamples, reset } = useTuneIdentifier();
  const analysisTimer = useRef<ReturnType<typeof setInterval> | null>(null);

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

  // Analysis loop
  const runAnalysis = useCallback(async () => {
    const buffer = getAudioBuffer();
    const level = getInputLevel();
    if (buffer.length < 22050 * 2) return;
    await processSamples(buffer, level);
  }, [processSamples]);

  // Start/stop recording
  const toggleRecording = useCallback(async () => {
    try {
      if (recording) {
        LiveAudioStream.stop();
        setRecording(false);
        if (analysisTimer.current) {
          clearInterval(analysisTimer.current);
          analysisTimer.current = null;
        }
        clearAudioBuffer();
        reset();
      } else {
        const { status } = await Audio.requestPermissionsAsync();
        console.log('Mic permission:', status);
        if (status !== 'granted') {
          console.warn('Microphone permission denied');
          return;
        }

        clearAudioBuffer();
        reset();

        LiveAudioStream.init({
          sampleRate: SAMPLE_RATE,
          channels: 1,
          bitsPerSample: 16,
          audioSource: Platform.OS === 'android' ? 6 : undefined,
          wavFile: '',
        });
        LiveAudioStream.on('data', (base64: string) => {
          const pcm = base64ToFloat32(base64);
          onAudioData(pcm);
        });
        LiveAudioStream.start();
        console.log('Audio stream started');

        setRecording(true);
        analysisTimer.current = setInterval(runAnalysis, ANALYSIS_INTERVAL_MS);
      }
    } catch (err) {
      console.error('toggleRecording error:', err);
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
  const tuneEntry = top ? getTuneById(top.id) : undefined;

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0d1a0f" />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {/* Header */}
        <Text style={styles.headerTitle}>Sionnach</Text>

        {/* Hero card with integrated mic button */}
        <HeroCard
          top={top}
          confidence={state.confidence}
          status={recording ? (state.status || 'listening') : 'idle'}
          tempo={state.tempo}
          tuneKey={tuneEntry?.key}
          recording={recording}
          onMicPress={toggleRecording}
        />

        {/* Quick match pills */}
        {state.predictions.length > 0 && (
          <QuickMatchPills
            predictions={state.predictions}
            confidence={state.confidence}
            lockedTuneId={state.lockedTuneId}
            sheetTuneId={sheetTuneId}
            onSelect={handleSelectTune}
          />
        )}

        {/* Sheet music */}
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
  headerTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#a8cc8c',
    textAlign: 'center',
    marginBottom: 12,
  },
});
