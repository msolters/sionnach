import React from 'react';
import { Pressable, Text, StyleSheet } from 'react-native';

interface Props {
  recording: boolean;
  onPress: () => void;
}

export function MicButton({ recording, onPress }: Props) {
  return (
    <Pressable
      style={[styles.button, recording && styles.recording]}
      onPress={onPress}
    >
      <Text style={styles.icon}>{recording ? '\u23F9' : '\u{1F3A4}'}</Text>
      <Text style={styles.label}>{recording ? 'Stop' : 'Start'}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#2a3528',
    borderRadius: 24,
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderWidth: 1,
    borderColor: '#4c8c30',
  },
  recording: {
    backgroundColor: 'rgba(196, 60, 60, 0.15)',
    borderColor: '#c45c3e',
  },
  icon: { fontSize: 18 },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#d4ddd0',
  },
});
