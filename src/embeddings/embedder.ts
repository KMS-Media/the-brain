import { pipeline, env } from "@huggingface/transformers";
import { EMBEDDING_MODEL, EMBEDDING_DIM, modelCacheDir, ensureDir } from "../config.js";

/**
 * Local embedding generation (PRD §15). Uses @huggingface/transformers with a
 * local ONNX model (default bge-small-en-v1.5, 384 dim). No cloud APIs (§3, §17).
 *
 * The pipeline is loaded lazily and cached as a module singleton — loading is
 * expensive (model load + ONNX init) and must happen at most once per process.
 */

type FeatureExtractor = (
  texts: string[],
  opts: { pooling: "mean" | "cls" | "none"; normalize: boolean },
) => Promise<{ data: Float32Array | number[]; tolist(): number[][] }>;

let extractorPromise: Promise<FeatureExtractor> | null = null;

/**
 * Deterministic hashing-vectorizer embedding used only when BRAIN_FAKE_EMBED=1
 * (the test runner sets this). It avoids loading the native ONNX model — which
 * is unstable across many short-lived processes in CI — while preserving
 * token-overlap similarity, so semantic-ordering assertions still hold.
 */
function fakeEmbed(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const t of tokens) {
    let h = 2166136261;
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx = Math.abs(h) % EMBEDDING_DIM;
    v[idx] += (h & 1) === 0 ? 1 : -1;
  }
  // Add a negligible non-integer offset to every element so the values are
  // never exact integers — otherwise Kuzu infers the bound array as INT64[]
  // and array_cosine_similarity (which requires FLOAT[]/DOUBLE[]) rejects it.
  for (let i = 0; i < EMBEDDING_DIM; i++) v[i] += 1e-6;
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
}

function useFakeEmbed(): boolean {
  return process.env.BRAIN_FAKE_EMBED === "1";
}

async function getExtractor(): Promise<FeatureExtractor> {
  if (!extractorPromise) {
    env.cacheDir = ensureDir(modelCacheDir());
    env.allowRemoteModels = process.env.BRAIN_OFFLINE === "1" ? false : true;
    extractorPromise = pipeline("feature-extraction", EMBEDDING_MODEL) as unknown as Promise<FeatureExtractor>;
  }
  return extractorPromise;
}

/** Embed a single string into a normalized vector of length EMBEDDING_DIM. */
export async function embed(text: string): Promise<number[]> {
  const clean = (text ?? "").trim();
  if (!clean) return new Array(EMBEDDING_DIM).fill(0);
  if (useFakeEmbed()) return fakeEmbed(clean);
  const extractor = await getExtractor();
  const out = await extractor([clean], { pooling: "mean", normalize: true });
  return Array.from(out.data as Float32Array);
}

/** Embed many strings (batched). */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (useFakeEmbed()) return texts.map((t) => fakeEmbed((t ?? "").trim()));
  const extractor = await getExtractor();
  const out = await extractor(
    texts.map((t) => (t ?? "").trim() || " "),
    { pooling: "mean", normalize: true },
  );
  return out.tolist();
}

/** Cosine similarity of two equal-length vectors. Inputs are assumed L2-normalized. */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export const EMBEDDING_MODEL_NAME = EMBEDDING_MODEL;
