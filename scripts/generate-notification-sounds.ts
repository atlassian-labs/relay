#!/usr/bin/env bun

/**
 * Generates Relay's bundled notification sounds.
 *
 * The sounds are synthesised here rather than sourced from a sample library so
 * their provenance is self-evident and the repository carries no third-party
 * audio licence. Re-run with `bun run sounds:generate` to reproduce them byte
 * for byte; the output is deterministic.
 *
 * Format matches what `src/notify.ts` plays through afplay/paplay: mono,
 * 44.1 kHz, 16-bit PCM.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const SAMPLE_RATE = 44_100;
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;
const PEAK = 0.28; // Headroom so the tones sit under system notification volume.

interface Partial {
  /** Frequency in Hz. */
  readonly hz: number;
  /** Start offset in seconds. */
  readonly at: number;
  /** Duration in seconds. */
  readonly seconds: number;
  /** Relative amplitude, 0..1. */
  readonly gain: number;
}

interface SoundSpec {
  readonly name: string;
  readonly seconds: number;
  readonly partials: readonly Partial[];
}

// Simple two-note motifs: rising for success, flat for a question, falling for
// an error. Frequencies are notes from an A440 equal-tempered scale.
const SOUNDS: readonly SoundSpec[] = [
  {
    name: "completion",
    seconds: 0.6,
    partials: [
      { hz: 587.33, at: 0.0, seconds: 0.26, gain: 1 }, // D5
      { hz: 880.0, at: 0.2, seconds: 0.4, gain: 0.9 }, // A5
    ],
  },
  {
    name: "elicitation",
    seconds: 0.45,
    partials: [
      { hz: 659.25, at: 0.0, seconds: 0.2, gain: 1 }, // E5
      { hz: 659.25, at: 0.24, seconds: 0.21, gain: 0.75 }, // E5 again, softer
    ],
  },
  {
    name: "error",
    seconds: 0.6,
    partials: [
      { hz: 440.0, at: 0.0, seconds: 0.26, gain: 1 }, // A4
      { hz: 329.63, at: 0.22, seconds: 0.38, gain: 0.95 }, // E4
    ],
  },
];

/**
 * Short attack and exponential decay. Without the attack ramp the waveform
 * starts at a discontinuity, which players reproduce as an audible click.
 */
function envelopeAt(offset: number, duration: number): number {
  if (offset < 0 || offset > duration) return 0;
  const attack = Math.min(0.008, duration / 4);
  const attackGain = offset < attack ? offset / attack : 1;
  return attackGain * Math.exp((-5 * offset) / duration);
}

function renderSamples(spec: SoundSpec): Float64Array {
  const total = Math.round(spec.seconds * SAMPLE_RATE);
  const samples = new Float64Array(total);

  for (const partial of spec.partials) {
    const start = Math.round(partial.at * SAMPLE_RATE);
    const length = Math.round(partial.seconds * SAMPLE_RATE);
    for (let i = 0; i < length && start + i < total; i++) {
      const seconds = i / SAMPLE_RATE;
      const envelope = envelopeAt(seconds, partial.seconds);
      samples[start + i] += Math.sin(2 * Math.PI * partial.hz * seconds) * envelope * partial.gain;
    }
  }

  // Normalise to the target peak so overlapping partials cannot clip.
  let peak = 0;
  for (const value of samples) peak = Math.max(peak, Math.abs(value));
  if (peak > 0) {
    const scale = PEAK / peak;
    for (let i = 0; i < samples.length; i++) samples[i] *= scale;
  }
  return samples;
}

function encodeWav(samples: Float64Array): Buffer {
  const bytesPerSample = BITS_PER_SAMPLE / 8;
  const dataBytes = samples.length * bytesPerSample * CHANNELS;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * CHANNELS * bytesPerSample, 28); // byte rate
  buffer.writeUInt16LE(CHANNELS * bytesPerSample, 32); // block align
  buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    buffer.writeInt16LE(Math.round(clamped * 32_767), 44 + i * bytesPerSample);
  }
  return buffer;
}

const outputDir = resolve(import.meta.dirname, "..", "src", "sounds");
await mkdir(outputDir, { recursive: true });

for (const spec of SOUNDS) {
  const wav = encodeWav(renderSamples(spec));
  const target = resolve(outputDir, `${spec.name}.wav`);
  await writeFile(target, wav);
  process.stdout.write(`Wrote ${spec.name}.wav (${wav.byteLength} bytes, ${spec.seconds}s)\n`);
}
