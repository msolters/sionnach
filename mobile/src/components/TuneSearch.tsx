import React, { useCallback, useMemo, useState, useRef } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, StyleSheet, Keyboard,
} from 'react-native';
import { getAllTunes } from '../data/tune-index';
import { formatKey } from '../utils/format-key';
import type { TuneEntry } from '../types';

interface Props {
  onSelect: (tune: TuneEntry) => void;
}

const MAX_RESULTS = 30;

export function TuneSearch({ onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<TextInput>(null);

  // Build sorted tune list once (memoized)
  const allTunes = useMemo(() => {
    const tunes = getAllTunes();
    return tunes
      .filter(t => t.settings.length > 0)
      .map(t => ({ ...t, nameLower: t.name.toLowerCase() }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, []);

  const results = useMemo(() => {
    if (!query || query.length < 2) return [];
    const q = query.toLowerCase();
    const matches: typeof allTunes = [];
    for (const t of allTunes) {
      if (t.nameLower.includes(q)) {
        matches.push(t);
        if (matches.length >= MAX_RESULTS) break;
      }
    }
    return matches;
  }, [query, allTunes]);

  const handleSelect = useCallback((tune: typeof allTunes[0]) => {
    onSelect(tune);
    setQuery('');
    Keyboard.dismiss();
    setFocused(false);
  }, [onSelect]);

  const showResults = focused && results.length > 0;

  return (
    <View style={styles.container}>
      <View style={styles.inputRow}>
        <TextInput
          ref={inputRef}
          style={styles.input}
          placeholder="Search tunes..."
          placeholderTextColor="#5a7a50"
          value={query}
          onChangeText={setQuery}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 200)}
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
        />
        {query.length > 0 && (
          <Pressable
            style={styles.clearBtn}
            onPress={() => { setQuery(''); inputRef.current?.focus(); }}
          >
            <Text style={styles.clearText}>×</Text>
          </Pressable>
        )}
      </View>

      {showResults && (
        <View style={styles.results}>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            style={styles.resultsList}
            nestedScrollEnabled
          >
            {results.map(item => (
              <Pressable
                key={item.id}
                style={styles.resultRow}
                onPress={() => handleSelect(item)}
              >
                <Text style={styles.resultName} numberOfLines={1}>{item.name}</Text>
                <View style={styles.resultMeta}>
                  {item.type ? (
                    <Text style={styles.resultType}>{item.type}</Text>
                  ) : null}
                  {item.key ? (
                    <Text style={styles.resultKey}>{formatKey(item.key)}</Text>
                  ) : null}
                </View>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: 12,
    zIndex: 10,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1a2418',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2a3528',
    paddingHorizontal: 12,
  },
  input: {
    flex: 1,
    height: 40,
    color: '#c8e0b0',
    fontSize: 14,
  },
  clearBtn: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clearText: {
    fontSize: 18,
    color: '#7a9470',
    fontWeight: '700',
  },
  results: {
    backgroundColor: '#1a2418',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2a3528',
    marginTop: 4,
    maxHeight: 240,
    overflow: 'hidden',
  },
  resultsList: {
    flex: 1,
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#2a3528',
  },
  resultName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#c8e0b0',
    flex: 1,
    marginRight: 8,
  },
  resultMeta: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  resultType: {
    fontSize: 11,
    color: '#c4973a',
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  resultKey: {
    fontSize: 11,
    color: '#7a9470',
    fontWeight: '500',
  },
});
