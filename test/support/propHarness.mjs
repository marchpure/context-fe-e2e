// 零外部依赖的确定性随机属性测试（Property-Based Testing）与自动最小反例收缩（Shrinking）辅助模块。
// 支持固定种子默认复现，也可通过环境变量 PROP_SEED=0x... 覆写复现任意单次反例。

import assert from 'node:assert/strict';

export function resolveSeed(defaultSeed) {
  const raw = process.env.PROP_SEED;
  if (raw !== undefined && String(raw).trim() !== '') {
    const parsed = Number(String(raw).trim());
    if (Number.isFinite(parsed)) {
      return parsed >>> 0;
    }
  }
  return defaultSeed >>> 0;
}

export function formatSeed(seed) {
  return `0x${(seed >>> 0).toString(16).padStart(8, '0')}`;
}

export function createRng(seed) {
  let state = seed >>> 0;

  function nextU32() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0);
  }

  function nextFloat() {
    return nextU32() / 0x100000000;
  }

  function int(min, max) {
    const lo = Math.ceil(Math.min(min, max));
    const hi = Math.floor(Math.max(min, max));
    if (lo === hi) return lo;
    return lo + (nextU32() % (hi - lo + 1));
  }

  function bool(trueProb = 0.5) {
    return nextFloat() < trueProb;
  }

  function pick(items) {
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('rng.pick requires a non-empty array');
    }
    return items[int(0, items.length - 1)];
  }

  function shuffle(items) {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = int(0, i);
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function sample(items, count) {
    return shuffle(items).slice(0, Math.max(0, Math.min(items.length, count)));
  }

  function hex(len = 8) {
    const chars = '0123456789abcdef';
    let out = '';
    for (let i = 0; i < len; i += 1) {
      out += chars[int(0, 15)];
    }
    return out;
  }

  function slug(prefix = 'item', minLen = 3, maxLen = 10) {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const n = int(minLen, maxLen);
    let body = '';
    for (let i = 0; i < n; i += 1) {
      body += alphabet[int(0, alphabet.length - 1)];
    }
    return prefix ? `${prefix}-${body}` : body;
  }

  return {
    nextU32,
    nextFloat,
    int,
    bool,
    pick,
    shuffle,
    sample,
    hex,
    slug,
  };
}

/**
 * 通用结构化收缩器：按码点安全缩短字符串、缩减整数绝对值、裁剪数组元素并递归收缩普通对象字段。
 */
export function* shrinkValue(value) {
  if (typeof value === 'boolean') {
    if (value === true) yield false;
    return;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value === 0) return;
    yield 0;
    if (Number.isInteger(value)) {
      const half = Math.trunc(value / 2);
      if (half !== 0 && half !== value) yield half;
      const step = value > 0 ? value - 1 : value + 1;
      if (step !== 0 && step !== half) yield step;
    } else {
      const rounded = Math.trunc(value);
      if (rounded !== value) yield rounded;
    }
    return;
  }

  if (typeof value === 'string') {
    const codePoints = Array.from(value);
    if (codePoints.length === 0) return;
    yield '';
    if (codePoints.length > 1) {
      const half = Math.floor(codePoints.length / 2);
      yield codePoints.slice(0, half).join('');
      yield codePoints.slice(half).join('');
    }
    const maxDeletes = Math.min(codePoints.length, 16);
    for (let i = 0; i < maxDeletes; i += 1) {
      const idx = Math.floor((i * codePoints.length) / maxDeletes);
      yield [...codePoints.slice(0, idx), ...codePoints.slice(idx + 1)].join('');
    }
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return;
    yield [];
    if (value.length > 1) {
      const half = Math.floor(value.length / 2);
      yield value.slice(0, half);
      yield value.slice(half);
    }
    for (let i = 0; i < value.length; i += 1) {
      yield [...value.slice(0, i), ...value.slice(i + 1)];
    }
    for (let i = 0; i < value.length; i += 1) {
      for (const shrunkItem of shrinkValue(value[i])) {
        const next = [...value];
        next[i] = shrunkItem;
        yield next;
      }
    }
    return;
  }

  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    for (const key of keys) {
      for (const shrunkProp of shrinkValue(value[key])) {
        yield { ...value, [key]: shrunkProp };
      }
    }
  }
}

function failureSite(error) {
  const frame = String(error?.stack || '').split(/\n\s+at /, 2)[1]?.split('\n')[0];
  return `${error?.name || 'Error'}:${error?.code ?? ''}:${frame ?? ''}`;
}

function formatFailureMessage({ name, seedHex, file, caseIndex, runs, shrinkSteps, witness, error }) {
  const replayCmd = `PROP_SEED=${seedHex} node --test ${file || 'test/*.property.test.mjs'}`;
  const serialized = JSON.stringify(witness);
  const compactWitness =
    serialized && serialized.length > 900 ? `${serialized.slice(0, 900)}...` : serialized;
  return [
    `[Property Counterexample] ${name}`,
    `  seed: ${seedHex} (replay: ${replayCmd})`,
    `  case: #${caseIndex + 1} / ${runs} (shrunk in ${shrinkSteps} step(s))`,
    `  minimalWitness: ${compactWitness}`,
    `  reason: ${error?.message || String(error)}`,
  ].join('\n');
}

export function assertProperty(
  { name, seed: defaultSeed, runs = 200, file = '', generate, shrink = shrinkValue, maxShrinkProbes = 240 },
  checkFn
) {
  const seed = resolveSeed(defaultSeed);
  const seedHex = formatSeed(seed);
  const rng = createRng(seed);

  for (let i = 0; i < runs; i += 1) {
    const sample = generate(rng, i);
    try {
      checkFn(sample, i);
    } catch (initialError) {
      const initialFailure = failureSite(initialError);
      let best = sample;
      let bestError = initialError;
      let shrinkSteps = 0;
      let probes = 0;

      shrinkLoop: while (probes < maxShrinkProbes) {
        let improved = false;
        for (const candidate of shrink(best)) {
          probes += 1;
          if (probes > maxShrinkProbes) break shrinkLoop;
          try {
            checkFn(candidate, i);
          } catch (candidateError) {
            if (failureSite(candidateError) !== initialFailure) continue;
            best = candidate;
            bestError = candidateError;
            shrinkSteps += 1;
            improved = true;
            break;
          }
        }
        if (!improved) break;
      }

      throw new assert.AssertionError({
        message: formatFailureMessage({
          name,
          seedHex,
          file,
          caseIndex: i,
          runs,
          shrinkSteps,
          witness: best,
          error: bestError,
        }),
      });
    }
  }

  return { seed, seedHex, runs };
}

export async function assertPropertyAsync(
  { name, seed: defaultSeed, runs = 200, file = '', generate, shrink = shrinkValue, maxShrinkProbes = 200 },
  checkFn
) {
  const seed = resolveSeed(defaultSeed);
  const seedHex = formatSeed(seed);
  const rng = createRng(seed);

  for (let i = 0; i < runs; i += 1) {
    const sample = generate(rng, i);
    try {
      await checkFn(sample, i);
    } catch (initialError) {
      const initialFailure = failureSite(initialError);
      let best = sample;
      let bestError = initialError;
      let shrinkSteps = 0;
      let probes = 0;

      shrinkLoop: while (probes < maxShrinkProbes) {
        let improved = false;
        for (const candidate of shrink(best)) {
          probes += 1;
          if (probes > maxShrinkProbes) break shrinkLoop;
          try {
            await checkFn(candidate, i);
          } catch (candidateError) {
            if (failureSite(candidateError) !== initialFailure) continue;
            best = candidate;
            bestError = candidateError;
            shrinkSteps += 1;
            improved = true;
            break;
          }
        }
        if (!improved) break;
      }

      throw new assert.AssertionError({
        message: formatFailureMessage({
          name,
          seedHex,
          file,
          caseIndex: i,
          runs,
          shrinkSteps,
          witness: best,
          error: bestError,
        }),
      });
    }
  }

  return { seed, seedHex, runs };
}
