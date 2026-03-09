import React from 'react';
import Svg, { Circle } from 'react-native-svg';

interface Props {
  /** 0-1 fill amount */
  progress: number;
  /** Ring state determines color */
  state: 'idle' | 'filling' | 'draining' | 'ready';
  size?: number;
}

const STROKE_COLORS = {
  idle: '#2a3528',
  filling: '#4c8c30',
  draining: '#c4973a',
  ready: '#6aaa3d',
};

export function ListenRing({ progress, state, size = 44 }: Props) {
  const r = 34;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - Math.max(0, Math.min(1, progress)));

  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 80 80"
      style={{ transform: [{ rotate: '-90deg' }] }}
    >
      <Circle
        cx={40}
        cy={40}
        r={r}
        fill="rgba(13, 26, 15, 0.6)"
        stroke="rgba(42, 53, 40, 0.6)"
        strokeWidth={5}
      />
      <Circle
        cx={40}
        cy={40}
        r={r}
        fill="none"
        stroke={STROKE_COLORS[state]}
        strokeWidth={5}
        strokeLinecap="round"
        strokeDasharray={`${circumference}`}
        strokeDashoffset={offset}
      />
    </Svg>
  );
}
