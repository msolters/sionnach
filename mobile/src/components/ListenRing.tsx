import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, View, Text, StyleSheet } from 'react-native';
import { RingWaveform } from './RingWaveform';

interface Props {
  /** 0-1 target fill amount (confidence) */
  target: number;
  /** 0-1 raw confidence from identifier (drives thinking/locked state) */
  confidence: number;
  /** whether we're actively listening */
  active?: boolean;
  /** detected BPM, enables beat-synced pulsing */
  tempo?: number | null;
  size?: number;
}

/**
 * Visual states:
 *   listening  — confidence == 0, waveform oscillating around ring
 *   thinking   — 0 < confidence < 0.72, amber pulse + fill advancing + emoji
 *   locked     — confidence >= 0.72, solid green, stable
 *
 * Audio reactivity: SVG oscilloscope waveform (RingWaveform) drawn around
 * the ring perimeter at 30fps from raw PCM samples.
 */

export const ListenRing = React.memo(function ListenRing({
  target, confidence, active = false, tempo, size = 80,
}: Props) {
  const fillAnim = useRef(new Animated.Value(0)).current;
  const thinkAnim = useRef(new Animated.Value(0)).current;
  const lockFlash = useRef(new Animated.Value(0)).current;
  const prevTarget = useRef(0);
  const wasLocked = useRef(false);

  // Emoji cycling
  const THINK_EMOJIS = ['\ud83e\udd14', '\ud83e\udd8a', '\ud83c\udfbb', '\ud83e\udd41', '\ud83c\udfb6'];
  const [emojiIdx, setEmojiIdx] = useState(0);
  const emojiScale = useRef(new Animated.Value(1)).current;
  const emojiRotate = useRef(new Animated.Value(0)).current;

  const isThinking = active && confidence > 0 && confidence < 0.72;
  const isLocked = active && confidence >= 0.72;

  // ── Thinking pulse: amber inner glow, native-driven ──
  useEffect(() => {
    if (!isThinking) {
      if (!isLocked) thinkAnim.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(thinkAnim, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(thinkAnim, {
          toValue: 0.2,
          duration: 700,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [isThinking, isLocked, thinkAnim]);

  // ── Emoji cycling: bounce-spin then switch emoji ──
  useEffect(() => {
    if (!isThinking) {
      setEmojiIdx(0);
      emojiScale.setValue(1);
      emojiRotate.setValue(0);
      return;
    }
    // First emoji (thinking) shows immediately; cycle starts after 2.5s
    const timer = setInterval(() => {
      // Bounce-and-spin out
      Animated.parallel([
        Animated.sequence([
          Animated.timing(emojiScale, {
            toValue: 1.4,
            duration: 200,
            easing: Easing.out(Easing.back(2)),
            useNativeDriver: true,
          }),
          Animated.timing(emojiScale, {
            toValue: 0,
            duration: 150,
            easing: Easing.in(Easing.quad),
            useNativeDriver: true,
          }),
        ]),
        Animated.timing(emojiRotate, {
          toValue: 1,
          duration: 350,
          easing: Easing.inOut(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start(() => {
        // Switch emoji, then bounce-spin in
        setEmojiIdx(i => (i + 1) % THINK_EMOJIS.length);
        emojiRotate.setValue(0);
        Animated.sequence([
          Animated.timing(emojiScale, {
            toValue: 1.3,
            duration: 200,
            easing: Easing.out(Easing.back(3)),
            useNativeDriver: true,
          }),
          Animated.timing(emojiScale, {
            toValue: 1,
            duration: 200,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
        ]).start();
      });
    }, 2500);
    return () => clearInterval(timer);
  }, [isThinking, emojiScale, emojiRotate]);

  // ── Lock flash: one-shot when confidence hits 0.99 ──
  useEffect(() => {
    if (isLocked && !wasLocked.current) {
      Animated.timing(thinkAnim, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }).start();
      Animated.sequence([
        Animated.timing(lockFlash, {
          toValue: 1,
          duration: 150,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(lockFlash, {
          toValue: 0,
          duration: 600,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start();
    }
    wasLocked.current = isLocked;
  }, [isLocked, thinkAnim, lockFlash]);


  // ── Fill bar (confidence) ──
  // Animate smoothly over the inter-cycle gap (~1.5-2.5s) so the ring
  // appears to be continuously progressing, not jumping in steps.
  // Dropping is faster so the user sees the amber transition promptly.
  useEffect(() => {
    const filling = target > prevTarget.current;
    const delta = Math.abs(target - prevTarget.current);
    prevTarget.current = target;

    // Large drops (lock break) = fast. Small changes = smooth over full cycle.
    let duration: number;
    if (!filling && delta > 0.3) {
      duration = 400;  // Quick drop on lock break / tune change
    } else if (filling) {
      duration = 1200;  // Steadily fills across the inter-cycle gap
    } else {
      duration = 800;   // Moderate drain
    }

    Animated.timing(fillAnim, {
      toValue: target,
      duration,
      easing: filling ? Easing.out(Easing.quad) : Easing.inOut(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [target, fillAnim]);

  // ── Derived styles ──
  const fillColor = fillAnim.interpolate({
    inputRange: [0, 0.3, 0.7, 0.99, 1],
    outputRange: isThinking
      ? ['#5a4a20', '#8a7a30', '#9a8a35', '#6aaa3d', '#7abb4d']
      : ['#3a5a30', '#4c8c30', '#5a9a38', '#6aaa3d', '#7abb4d'],
  });

  const fillWidth = fillAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  const borderStyle = isLocked
    ? '#4c8c30'
    : isThinking
      ? '#6a5a20'
      : '#2a3528';

  const ringThickness = 5;
  const innerSize = size - ringThickness * 2;

  return (
    <View
      style={[
        styles.outer,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
        },
      ]}
    >
      {/* Oscilloscope waveform around the ring — real-time PCM visualization */}
      <RingWaveform size={size} active={active} />

      {/* Lock flash — brief bright glow on lock-on */}
      <Animated.View
        style={[
          styles.glow,
          {
            width: size + 20,
            height: size + 20,
            borderRadius: (size + 20) / 2,
            backgroundColor: 'rgba(122,187,77,0.25)',
            opacity: lockFlash,
          },
        ]}
      />

      {/* Ring track */}
      <View style={[
        styles.ring,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderColor: borderStyle,
          borderWidth: 2,
        },
      ]}>
        {/* Fill bar */}
        <Animated.View
          style={[styles.fill, { width: fillWidth, backgroundColor: fillColor }]}
        />
      </View>

      {/* Inner circle */}
      <View
        style={[
          styles.inner,
          {
            width: innerSize,
            height: innerSize,
            borderRadius: innerSize / 2,
          },
        ]}
      />

      {/* Thinking amber pulse inside ring (native-driven) */}
      <Animated.View
        style={[
          styles.thinkInner,
          {
            width: innerSize,
            height: innerSize,
            borderRadius: innerSize / 2,
            opacity: thinkAnim.interpolate({
              inputRange: [0, 1],
              outputRange: [0, 0.2],
            }),
          },
        ]}
      />

      {/* Thinking emoji — cycles with bounce-spin, fades on lock */}
      <Animated.Text
        style={[
          styles.thinkEmoji,
          {
            fontSize: innerSize * 0.45,
            opacity: thinkAnim.interpolate({
              inputRange: [0, 0.3, 1],
              outputRange: [0, 0.7, 1],
            }),
            transform: [
              { scale: emojiScale },
              { rotate: emojiRotate.interpolate({
                inputRange: [0, 1],
                outputRange: ['0deg', '360deg'],
              })},
            ],
          },
        ]}
      >
        {THINK_EMOJIS[emojiIdx]}
      </Animated.Text>
    </View>
  );
});

const styles = StyleSheet.create({
  outer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  glow: {
    position: 'absolute',
  },
  ring: {
    position: 'absolute',
    backgroundColor: '#1a2a18',
    overflow: 'hidden',
  },
  fill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
  },
  inner: {
    backgroundColor: '#0d1a0f',
    position: 'absolute',
  },
  thinkInner: {
    position: 'absolute',
    backgroundColor: '#c4973a',
  },
  thinkEmoji: {
    position: 'absolute',
    textAlign: 'center',
  },
});
