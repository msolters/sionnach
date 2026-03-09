import React, { useEffect, useRef, useMemo } from 'react';
import { Animated, Easing, StyleSheet } from 'react-native';
import { normalizedLevelAnim } from '../audio/streaming-recorder';

interface Props {
  size: number;
  active: boolean;
}

const NUM_RINGS = 3;
const BASE_PERIOD = 1600; // ms for innermost ring cycle

/**
 * Audio-reactive oscillator rings around the listen ring.
 * Pure native-driven Animated loops — no JS computation per frame.
 * Each ring pulses at a slightly different rate; their opacity scales
 * with the audio level so they're visible when there's sound and
 * fade out in silence.
 */
export const RingWaveform = React.memo(function RingWaveform({ size, active }: Props) {
  // One pulse anim per ring, each at a different frequency
  const pulses = useRef(
    Array.from({ length: NUM_RINGS }, () => new Animated.Value(0)),
  ).current;

  // Combined opacity: pulse * audioLevel — fully native-driven
  const opacities = useMemo(() =>
    pulses.map(pulse =>
      Animated.multiply(
        pulse.interpolate({
          inputRange: [0, 0.5, 1],
          outputRange: [0.15, 0.7, 0.15],
        }),
        normalizedLevelAnim.interpolate({
          inputRange: [0, 0.1, 0.4, 1],
          outputRange: [0.05, 0.4, 0.8, 1],
        }),
      ),
    ),
  [pulses]);

  // Scale: each ring breathes between 1.0 and a max, staggered
  const scales = useMemo(() =>
    pulses.map((pulse, i) => {
      const maxScale = 1.08 + i * 0.06; // 1.08, 1.14, 1.20
      return pulse.interpolate({
        inputRange: [0, 0.5, 1],
        outputRange: [1, maxScale, 1],
      });
    }),
  [pulses]);

  useEffect(() => {
    if (!active) {
      pulses.forEach(p => p.setValue(0));
      return;
    }

    const loops = pulses.map((pulse, i) => {
      // Stagger periods: 1600ms, 2200ms, 2800ms
      const period = BASE_PERIOD + i * 600;
      // Offset start so rings aren't in sync
      pulse.setValue(i * 0.33);
      const loop = Animated.loop(
        Animated.timing(pulse, {
          toValue: 1,
          duration: period,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      );
      loop.start();
      return loop;
    });

    return () => loops.forEach(l => l.stop());
  }, [active, pulses]);

  const ringSize = size + 14;

  return (
    <>
      {pulses.map((_, i) => (
        <Animated.View
          key={i}
          pointerEvents="none"
          style={[
            styles.ring,
            {
              width: ringSize,
              height: ringSize,
              borderRadius: ringSize / 2,
              opacity: opacities[i],
              transform: [{ scale: scales[i] }],
            },
          ]}
        />
      ))}
    </>
  );
});

const styles = StyleSheet.create({
  ring: {
    position: 'absolute',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.6)',
    backgroundColor: 'transparent',
  },
});
