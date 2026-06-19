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
  const extractor = await getExtractor();
  const out = await extractor([clean], { pooling: "mean", normalize: true });
  return Array.from(out.data as Float32Array);
}

/** Embed many strings (batched). */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
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
