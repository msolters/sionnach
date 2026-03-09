import React, { useRef, useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, Animated, Easing } from 'react-native';
import type { Prediction } from '../types';

interface Props {
  predictions: Prediction[];
  confidence: number;
  lockedTuneId: number | null;
  sheetTuneId: number | null;
  onSelect: (tuneId: number, tuneName: string) => void;
}

const AnimatedPill = React.memo(function AnimatedPill({
  prediction,
  fillWidth,
  isTop,
  isSheet,
  confidence,
  onPress,
}: {
  prediction: Prediction;
  fillWidth: number;
  isTop: boolean;
  isSheet: boolean;
  confidence: number;
  onPress: () => void;
}) {
  const fillAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fillAnim, {
      toValue: fillWidth,
      duration: 400,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [fillWidth, fillAnim]);

  const isDraining = isTop && confidence < 0.5 && confidence > 0;
  const isReady = isTop && confidence >= 0.72;

  const borderColor = isTop ? (isReady ? '#6aaa3d' : isDraining ? '#c4973a' : '#6aaa3d')
    : '#2a3528';

  const nameColor = isTop
    ? (isReady ? '#6aaa3d' : isDraining ? '#c4973a' : '#6aaa3d')
    : '#c8e0b0';

  const fillBg = isTop
    ? (isReady ? 'rgba(106,170,61,0.18)' : isDraining ? 'rgba(196,151,58,0.15)' : 'rgba(106,170,61,0.12)')
    : 'rgba(76,140,48,0.12)';

  const animWidth = fillAnim.interpolate({
    inputRange: [0, 100],
    outputRange: ['0%', '100%'],
  });

  return (
    <Pressable style={[styles.pill, { borderColor }]} onPress={onPress}>
      <Animated.View style={[styles.fill, { width: animWidth, backgroundColor: fillBg }]} />
      {isSheet && <Text style={styles.sheetIcon}>{'\u266B'}</Text>}
      <Text style={[styles.name, { color: nameColor }]} numberOfLines={1}>
        {prediction.name}
      </Text>
    </Pressable>
  );
});

export const QuickMatchPills = React.memo(function QuickMatchPills({
  predictions, confidence, lockedTuneId, sheetTuneId, onSelect,
}: Props) {
  const slots = useRef<(number | null)[]>([null, null, null]);
  const top3 = predictions.slice(0, 3);
  const top3Ids = new Set(top3.map(p => p.id));
  const top3ById = new Map(top3.map(p => [p.id, p]));
  const topId = predictions[0]?.id;
  const maxProb = predictions[0]?.prob || 0;

  for (let i = 0; i < 3; i++) {
    if (slots.current[i] !== null && !top3Ids.has(slots.current[i]!)) {
      slots.current[i] = null;
    }
  }

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
        const fillW = isTop
          ? Math.min(confidence, 1) * 100
          : (maxProb > 0 ? (p.prob / maxProb * 100) : 0);

        return (
          <AnimatedPill
            key={`pill-${i}`}
            prediction={p}
            fillWidth={fillW}
            isTop={isTop}
            isSheet={p.id === sheetTuneId}
            confidence={confidence}
            onPress={() => onSelect(p.id, p.name)}
          />
        );
      })}
    </View>
  );
});

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
    paddingVertical: 8,
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
    fontWeight: '600',
    color: '#c8e0b0',
    flex: 1,
    textAlign: 'center',
  },
});
