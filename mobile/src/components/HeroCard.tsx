import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Easing } from 'react-native';
import { ListenRing } from './ListenRing';
import { formatKey } from '../utils/format-key';
import type { Prediction } from '../types';

interface Props {
  top: Prediction | null;
  confidence: number;
  status: string;
  recording: boolean;
  audioLevel?: number;
  tuneKey?: string;
  tempo?: number | null;
  showDebug?: boolean;
}

const RING_SIZE = 56;

export const HeroCard = React.memo(function HeroCard({
  top, confidence, status, recording, audioLevel = 0, tuneKey, tempo, showDebug = false,
}: Props) {
  const revealAnim = useRef(new Animated.Value(0)).current;
  const infoOpacity = useRef(new Animated.Value(0)).current;
  const wasRecording = useRef(false);
  const hadTune = useRef(false);

  // Card reveal/hide
  useEffect(() => {
    if (recording && !wasRecording.current) {
      infoOpacity.setValue(0);
      Animated.timing(revealAnim, {
        toValue: 1, duration: 400,
        easing: Easing.out(Easing.cubic), useNativeDriver: true,
      }).start();
    } else if (!recording && wasRecording.current) {
      Animated.parallel([
        Animated.timing(revealAnim, {
          toValue: 0, duration: 300,
          easing: Easing.in(Easing.cubic), useNativeDriver: true,
        }),
        Animated.timing(infoOpacity, {
          toValue: 0, duration: 200, useNativeDriver: true,
        }),
      ]).start();
    }
    wasRecording.current = recording;
  }, [recording, revealAnim, infoOpacity]);

  // Fade info in/out when tune found/lost
  useEffect(() => {
    if (!recording) return;
    const hasTune = !!top;
    if (hasTune && !hadTune.current) {
      Animated.timing(infoOpacity, {
        toValue: 1, duration: 350,
        easing: Easing.out(Easing.cubic), useNativeDriver: true,
      }).start();
    } else if (!hasTune && hadTune.current) {
      Animated.timing(infoOpacity, {
        toValue: 0, duration: 250, useNativeDriver: true,
      }).start();
    }
    hadTune.current = hasTune;
  }, [!!top, recording, infoOpacity]);

  // Flash on prediction change
  useEffect(() => {
    if (!recording || !top?.id) return;
    Animated.sequence([
      Animated.timing(infoOpacity, {
        toValue: 0.5, duration: 80, useNativeDriver: true,
      }),
      Animated.timing(infoOpacity, {
        toValue: 1, duration: 250, useNativeDriver: true,
      }),
    ]).start();
  }, [top?.id, infoOpacity, recording]);

  // Status label
  let label: string;
  if (status === 'silence') label = 'Play a tune...';
  else if (status === 'noise') label = 'Hearing noise...';
  else if (confidence >= 0.72) label = 'Current Tune';
  else if (confidence >= 0.3) label = 'Identifying...';
  else if (status === 'identifying') label = 'Identifying...';
  else if (status === 'listening' && audioLevel > 0.01) label = 'Listening...';
  else if (status === 'listening') label = 'Listening...';
  else label = 'Play a tune...';

  // Below lock threshold: show raw composite confidence so the ring
  // visibly progresses. At/above lock: ramp to 1.0 so the ring fills
  // completely — the user should see "fully confident."
  const ringTarget = confidence >= 0.72
    ? 1.0
    : confidence;

  const cardOpacity = revealAnim.interpolate({
    inputRange: [0, 0.3, 1],
    outputRange: [0, 0.5, 1],
  });
  const cardScale = revealAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.95, 1],
  });

  const hasTune = !!top;

  return (
    <Animated.View
      style={[styles.card, { opacity: cardOpacity, transform: [{ scale: cardScale }] }]}
    >
      {/* Centered row: ring alone, or ring + info */}
      <View style={[styles.row, hasTune && styles.rowWithInfo]}>
        <View style={styles.ringWrap}>
          <ListenRing target={ringTarget} confidence={confidence} active={recording} tempo={tempo} size={RING_SIZE} />
        </View>

        {hasTune && (
          <Animated.View style={[styles.info, { opacity: infoOpacity }]}>
            <Text style={styles.label}>{label}</Text>
            <Text style={styles.tuneName} numberOfLines={2}>{top.name}</Text>
            <View style={styles.metaRow}>
              {top.type ? (
                <Text style={styles.tuneType}>{top.type}</Text>
              ) : null}
              {tuneKey ? (
                <Text style={styles.tuneKeyText}>{formatKey(tuneKey!)}</Text>
              ) : null}
              {tempo ? (
                <Text style={styles.tempoText}>{tempo} bpm</Text>
              ) : null}
            </View>
          </Animated.View>
        )}
      </View>

      {/* Centered status label — only when no tune */}
      {!hasTune && (
        <Text style={styles.centerLabel}>{label}</Text>
      )}

      {/* Debug: audio level bar (long-press header to toggle) */}
      {recording && showDebug && (
        <View style={styles.debugRow}>
          <View style={styles.levelBarBg}>
            <View style={[styles.levelBarFill, { width: `${Math.min(audioLevel * 500, 100)}%` }]} />
          </View>
          <Text style={styles.debugText}>
            lvl:{audioLevel.toFixed(3)} conf:{confidence.toFixed(2)} {status}
          </Text>
        </View>
      )}
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#1a2418',
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: '#2a3528',
    marginBottom: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  rowWithInfo: {
    justifyContent: 'flex-start',
  },
  ringWrap: {
    // Reserve space for the audio glow overflow so it doesn't
    // visually collide with adjacent text.
    padding: 14,
  },
  info: {
    flex: 1,
    justifyContent: 'center',
  },
  label: {
    fontSize: 11,
    color: '#7a9470',
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    fontWeight: '500',
  },
  tuneName: {
    fontSize: 20,
    fontWeight: '700',
    color: '#c8e0b0',
    marginTop: 3,
  },
  metaRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 3,
    alignItems: 'center',
  },
  tuneType: {
    fontSize: 13,
    color: '#c4973a',
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  tuneKeyText: {
    fontSize: 12,
    color: '#7a9470',
    fontWeight: '500',
  },
  tempoText: {
    fontSize: 12,
    color: '#7a9470',
    fontWeight: '500',
  },
  centerLabel: {
    fontSize: 11,
    color: '#7a9470',
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    fontWeight: '500',
    textAlign: 'center',
    marginTop: 4,
  },
  debugRow: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  levelBarBg: {
    height: 4,
    width: 60,
    backgroundColor: '#2a3528',
    borderRadius: 2,
    overflow: 'hidden',
  },
  levelBarFill: {
    height: 4,
    backgroundColor: '#6aaa3d',
    borderRadius: 2,
  },
  debugText: {
    fontSize: 9,
    color: '#5a7a50',
    fontFamily: 'monospace',
  },
});
