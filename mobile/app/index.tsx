import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, SafeAreaView, ActivityIndicator,
} from 'react-native';
import { HeroCard, QuickMatchPills, SheetMusicView, MicButton } from '../src/components';
import { useTuneIdentifier } from '../src/hooks/useTuneIdentifier';
import { loadModel, releaseModel } from '../src/inference';
import { loadTuneData, getTuneById } from '../src/data/tune-index';
import { loadChromaFB } from '../src/data/chroma-fb';
import { initHannWindow } from '../src/dsp/stft';
import {
  onAudioData, getAudioBuffer, getInputLevel, clearAudioBuffer,
} from '../src/audio/streaming-recorder';
import { ANALYSIS_INTERVAL_MS } from '../src/constants';

// Base URL for loading assets from the web app deployment
const WEB_BASE_URL = 'https://msolters.github.io/sionnach';

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
      // Stop
      setRecording(false);
      if (analysisTimer.current) {
        clearInterval(analysisTimer.current);
        analysisTimer.current = null;
      }
      // TODO: Stop react-native-live-audio-stream
      clearAudioBuffer();
      reset();
    } else {
      // Start
      clearAudioBuffer();
      reset();
      setRecording(true);

      // TODO: Start react-native-live-audio-stream with onAudioData callback
      // LiveAudioStream.init({ sampleRate: 22050, channels: 1, bitsPerSample: 16 });
      // LiveAudioStream.start();
      // LiveAudioStream.on('data', (base64: string) => {
      //   const pcm = base64ToFloat32(base64);
      //   onAudioData(pcm);
      // });

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

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <Text style={styles.title}>Sionnach</Text>

        <HeroCard
          top={top}
          confidence={state.confidence}
          status={state.status}
          tempo={state.tempo}
          tuneKey={tuneEntry?.key}
        />

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
  container: { flex: 1, backgroundColor: '#0d1a0f' },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, gap: 12 },
  splash: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
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
  micRow: {
    alignItems: 'center',
    marginVertical: 4,
  },
});
