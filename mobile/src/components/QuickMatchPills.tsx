import React, { useRef } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import type { Prediction } from '../types';

interface Props {
  predictions: Prediction[];
  confidence: number;
  lockedTuneId: number | null;
  sheetTuneId: number | null;
  onSelect: (tuneId: number, tuneName: string) => void;
}

/**
 * Top-3 quick match pills with stable slot positions.
 * Matches web app behavior exactly.
 */
export function QuickMatchPills({ predictions, confidence, lockedTuneId, sheetTuneId, onSelect }: Props) {
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

  // Assign new tunes to empty slots (alphabetical, leftmost first)
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
        if (tuneId === null) return <View key={`empty-${i}`} style={styles.pillEmpty} />;
        const p = top3ById.get(tuneId);
        if (!p) return <View key={`empty-${i}`} style={styles.pillEmpty} />;

        const isTop = p.id === topId;
        const isSheet = p.id === sheetTuneId;
        const isLocked = p.id === lockedTuneId;

        // Top pill fill mirrors ring display; others use probability ratio
        const fillW = isTop
          ? Math.min(confidence, 1) * 100
          : (maxProb > 0 ? (p.prob / maxProb * 100) : 0);

        // Color states match web app
        const isDraining = isTop && confidence < 0.5 && confidence > 0;
        const isReady = isTop && confidence >= 0.99;

        const borderColor = isLocked ? '#6ba3d6'
          : isTop ? (isReady ? '#6aaa3d' : isDraining ? '#c4973a' : '#6aaa3d')
            : '#2a3528';

        const nameColor = isTop
          ? (isReady ? '#6aaa3d' : isDraining ? '#c4973a' : '#6aaa3d')
          : '#c8e0b0';

        const fillBg = isTop
          ? (isReady ? 'rgba(106,170,61,0.18)' : isDraining ? 'rgba(196,151,58,0.15)' : 'rgba(106,170,61,0.12)')
          : 'rgba(76,140,48,0.12)';

        return (
          <Pressable
            key={`pill-${i}`}
            style={[styles.pill, { borderColor }]}
            onPress={() => onSelect(p.id, p.name)}
          >
            <View style={[styles.fill, { width: `${fillW}%`, backgroundColor: fillBg }]} />
            {isSheet && <Text style={styles.sheetIcon}>{'\u266B'}</Text>}
            <Text style={[styles.name, { color: nameColor }]} numberOfLines={1}>{p.name}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
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
    gap: 4,
    flex: 1,
    minWidth: 80,
  },
  pillEmpty: {
    flex: 1,
    minWidth: 80,
  },
  fill: {
    position: 'absolute',
    left: 0, top: 0, bottom: 0,
    borderRadius: 20,
  },
  sheetIcon: {
    fontSize: 9,
    color: '#c8e0b0',
    marginRight: 2,
  },
  name: {
    fontSize: 13,
    fontWeight: '500',
    color: '#c8e0b0',
    flex: 1,
    textAlign: 'center',
  },
});
