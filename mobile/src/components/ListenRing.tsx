import React, { useEffect, useRef } from 'react';
import Svg, { Circle, Path } from 'react-native-svg';

interface Props {
  /** 0-1 target fill amount (from confidence ratio) */
  target: number;
  size?: number;
}

const R = 34;
const CIRCUMFERENCE = 2 * Math.PI * R;

export function ListenRing({ target, size = 44 }: Props) {
  const displayRef = useRef(0);
  const [display, setDisplay] = React.useState(0);

  // Lerp display toward target (fill faster, drain slower — matches web app)
  useEffect(() => {
    const id = setInterval(() => {
      const cur = displayRef.current;
      const diff = target - cur;
      if (Math.abs(diff) < 0.005) {
        displayRef.current = target;
        setDisplay(target);
      } else {
        const speed = diff < 0 ? 0.08 : 0.15;
        displayRef.current = cur + diff * speed;
        setDisplay(displayRef.current);
      }
    }, 16);
    return () => clearInterval(id);
  }, [target]);

  const offset = CIRCUMFERENCE * (1 - Math.max(0, Math.min(1, display)));
  const isDraining = target < display - 0.01 && display < 0.99;
  const isReady = display >= 0.99;

  const strokeColor = isReady
    ? '#6aaa3d'
    : isDraining
      ? '#c4973a'
      : '#4c8c30';

  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 80 80"
      style={{ transform: [{ rotate: '-90deg' }] }}
    >
      {/* Background circle */}
      <Circle
        cx={40} cy={40} r={R}
        fill="rgba(13, 26, 15, 0.6)"
        stroke="rgba(42, 53, 40, 0.6)"
        strokeWidth={5}
      />
      {/* Fill circle */}
      <Circle
        cx={40} cy={40} r={R}
        fill="none"
        stroke={strokeColor}
        strokeWidth={5}
        strokeLinecap="round"
        strokeDasharray={`${CIRCUMFERENCE}`}
        strokeDashoffset={offset}
      />
    </Svg>
  );
}

/**
 * Return ring state for pill coloring (matches web app logic)
 */
export function getRingState(display: number, target: number): 'idle' | 'filling' | 'draining' | 'ready' {
  if (display >= 0.99) return 'ready';
  if (target < display - 0.01) return 'draining';
  if (display > 0.01) return 'filling';
  return 'idle';
}
