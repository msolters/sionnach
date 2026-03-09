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
  timeSig?: string;
}

export function HeroCard({ top, confidence, status, tempo, tuneKey, timeSig }: Props) {
  const ringState = confidence >= 0.99
    ? 'ready'
    : confidence > 0 && status === 'identifying'
      ? 'filling'
      : 'idle';

  const label = status === 'noise' ? 'Noise'
    : status === 'silence' ? 'Silence'
      : status === 'identifying' ? 'Identifying...'
        : status === 'listening' ? 'Listening...'
          : 'Play a tune...';

  return (
    <View style={styles.card}>
      <View style={styles.top}>
        <ListenRing progress={confidence} state={ringState} />
        <View style={styles.info}>
          <Text style={styles.label}>{label}</Text>
          {top && (
            <>
              <Text style={styles.name} numberOfLines={1}>{top.name}</Text>
              <View style={styles.meta}>
                {top.type ? <Text style={styles.type}>{top.type}</Text> : null}
                <Text style={styles.conf}>{(top.prob * 100).toFixed(1)}%</Text>
              </View>
            </>
          )}
        </View>
      </View>
      <View style={styles.stats}>
        <Stat label="Key" value={tuneKey ?? '--'} />
        <Stat label="Time" value={timeSig ?? '--'} />
        <Stat label="BPM" value={tempo ? `${tempo}` : '--'} />
        {top?.id ? (
          <Pressable onPress={() => Linking.openURL(`${SESSION_URL}/${top.id}`)}>
            <Text style={styles.link}>Session</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: 'rgba(42, 53, 40, 0.4)',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#2a3528',
  },
  top: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  info: { flex: 1 },
  label: { fontSize: 11, color: '#7a9470', textTransform: 'uppercase', letterSpacing: 1 },
  name: { fontSize: 18, fontWeight: '700', color: '#e8f5e0', marginTop: 2 },
  meta: { flexDirection: 'row', gap: 8, marginTop: 4 },
  type: { fontSize: 12, color: '#c4973a', fontWeight: '500' },
  conf: { fontSize: 12, color: '#6aaa3d' },
  stats: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#2a3528',
  },
  stat: { alignItems: 'center' },
  statLabel: { fontSize: 10, color: '#5a7a50', textTransform: 'uppercase' },
  statValue: { fontSize: 14, fontWeight: '600', color: '#c8e0b0', marginTop: 2 },
  link: { fontSize: 12, color: '#6ba3d6', textDecorationLine: 'underline' },
});
