import React, { useRef } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import type { Prediction } from '../types';

interface Props {
  predictions: Prediction[];
  lockedTuneId: number | null;
  sheetTuneId: number | null;
  onSelect: (tuneId: number, tuneName: string) => void;
}

/**
 * Top-3 quick match pills with stable slot positions.
 */
export function QuickMatchPills({ predictions, lockedTuneId, sheetTuneId, onSelect }: Props) {
  const slots = useRef<(number | null)[]>([null, null, null]);
  const top3 = predictions.slice(0, 3);
  const top3Ids = new Set(top3.map(p => p.id));
  const top3ById = new Map(top3.map(p => [p.id, p]));
  const topId = predictions[0]?.id;
  const maxProb = predictions[0]?.prob || 0;

  // Vacate slots no longer in top 3
  for (let i = 0; i < 3; i++) {
    if (slots.current[i] !== null && !top3Ids.has(slots.current[i]!)) {
      slots.current[i] = null;
    }
  }

  // Assign new tunes to empty slots
  const placed = new Set(slots.current.filter(id => id !== null));
  const newTunes = top3.filter(p => !placed.has(p.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  let ni = 0;
  for (let i = 0; i < 3 && ni < newTunes.length; i++) {
    if (slots.current[i] === null) {
      slots.current[i] = newTunes[ni++].id;
    }
  }

  return (
    <View style={styles.container}>
      {slots.current.map((tuneId, i) => {
        if (tuneId === null) return null;
        const p = top3ById.get(tuneId);
        if (!p) return null;

        const isTop = p.id === topId;
        const isSheet = p.id === sheetTuneId;
        const isLocked = p.id === lockedTuneId;
        const fillW = isTop ? 100 : (maxProb > 0 ? (p.prob / maxProb * 100) : 0);

        return (
          <Pressable
            key={`pill-${i}`}
            style={[styles.pill, isLocked && styles.pillLocked]}
            onPress={() => onSelect(p.id, p.name)}
          >
            <View style={[styles.fill, { width: `${fillW}%` }]} />
            <Text style={styles.key}>{i + 1}</Text>
            {isSheet && <Text style={styles.sheetIcon}>{'\u266B'}</Text>}
            <Text style={styles.name} numberOfLines={1}>{p.name}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flexDirection: 'row', gap: 8, marginBottom: 12, flexWrap: 'wrap' },
  pill: {
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: '#1a2418',
    borderWidth: 1,
    borderColor: '#2a3528',
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
    minWidth: 80,
  },
  pillLocked: { borderColor: '#6ba3d6' },
  fill: {
    position: 'absolute',
    left: 0, top: 0, bottom: 0,
    backgroundColor: 'rgba(76, 140, 48, 0.12)',
    borderRadius: 20,
  },
  key: {
    fontSize: 10,
    fontWeight: '600',
    color: '#4a6340',
    backgroundColor: 'rgba(42, 53, 40, 0.6)',
    borderRadius: 3,
    paddingHorizontal: 4,
    fontFamily: 'monospace',
  },
  sheetIcon: { fontSize: 9, color: '#c8e0b0' },
  name: {
    fontSize: 13,
    fontWeight: '600',
    color: '#d4ddd0',
    flex: 1,
  },
});
