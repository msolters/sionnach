import React from 'react';
import { View, Text, StyleSheet, Pressable, Linking } from 'react-native';
import { ListenRing } from './ListenRing';
import { SESSION_URL } from '../constants';
import type { Prediction } from '../types';

interface Props {
  top: Prediction | null;
  confidence: number;
  status: string;
  tempo: number | null;
  tuneKey?: string;
  recording: boolean;
  onMicPress: () => void;
}

export function HeroCard({ top, confidence, status, tempo, tuneKey, recording, onMicPress }: Props) {
  // Ring label logic — matches web app exactly
  let label: string;
  if (status === 'noise') label = 'Noise';
  else if (status === 'silence') label = 'Silence';
  else if (confidence >= 0.99) label = 'Current Tune';
  else if (confidence >= 0.3) label = 'Identifying...';
  else if (status === 'listening') label = 'Listening...';
  else if (!recording) label = 'Stopped';
  else label = 'Play a tune...';

  return (
    <View style={styles.card}>
      {/* Top row: ring + info + session link */}
      <View style={styles.topRow}>
        <ListenRing target={confidence} size={44} />
        <View style={styles.info}>
          <Text style={styles.label}>{label}</Text>
          {top && (
            <>
              <Text style={styles.tuneName} numberOfLines={1}>{top.name}</Text>
              <View style={styles.meta}>
                {top.type ? <Text style={styles.tuneType}>{top.type}</Text> : null}
              </View>
            </>
          )}
        </View>
        {top?.id ? (
          <Pressable
            style={styles.sessionBtn}
            onPress={() => Linking.openURL(`${SESSION_URL}/${top.id}`)}
          >
            <Text style={styles.sessionBtnText}>Session</Text>
          </Pressable>
        ) : null}
      </View>

      {/* Stats row: Key, Time, BPM, mic button */}
      <View style={styles.statsRow}>
        <Stat label="Key" value={tuneKey ?? '--'} />
        <Stat label="Time" value="--" />
        <Stat label="BPM" value={tempo ? `${tempo}` : '--'} unit={tempo ? 'BPM' : undefined} />
        <Pressable
          style={[styles.micBtn, recording ? styles.micBtnRec : styles.micBtnIdle]}
          onPress={onMicPress}
        >
          <Text style={styles.micBtnText}>{recording ? 'Stop' : 'Start'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <View style={styles.statValueRow}>
        <Text style={styles.statValue}>{value}</Text>
        {unit && <Text style={styles.statUnit}>{unit}</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#1a2418',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#2a3528',
    marginBottom: 12,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  info: { flex: 1 },
  label: {
    fontSize: 10,
    color: '#7a9470',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  tuneName: {
    fontSize: 22,
    fontWeight: '700',
    color: '#c8e0b0',
    marginTop: 2,
  },
  meta: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  tuneType: {
    fontSize: 13,
    color: '#c4973a',
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  sessionBtn: {
    paddingVertical: 7,
    paddingHorizontal: 16,
    backgroundColor: '#3d7a2a',
    borderRadius: 8,
  },
  sessionBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#d4ddd0',
  },
  statsRow: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#2a3528',
    alignItems: 'center',
  },
  stat: {},
  statLabel: {
    fontSize: 10,
    color: '#7a9470',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  statValueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 3,
  },
  statValue: {
    fontSize: 18,
    fontWeight: '700',
    color: '#c8e0b0',
    marginTop: 2,
  },
  statUnit: {
    fontSize: 12,
    color: '#7a9470',
    fontWeight: '400',
  },
  micBtn: {
    marginLeft: 'auto',
    paddingVertical: 5,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  micBtnIdle: {
    backgroundColor: '#3d7a2a',
  },
  micBtnRec: {
    backgroundColor: '#8c3030',
  },
  micBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#d4ddd0',
  },
});
