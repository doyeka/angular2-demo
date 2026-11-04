/**
 * Downloadable model registry. Sizes are exact (bytes) and used to verify
 * downloads; sha256 is fetched from the Hub's `x-linked-etag` at download time.
 */
export interface ModelEntry {
  id: string;
  label: string;
  repo: string;
  file: string;
  sizeBytes: number;
  /** Context to allocate on device. KV cache dominates RAM beyond the weights. */
  nCtx: number;
  minRamGb: number;
  notes: string;
  default?: boolean;
}

export const MODELS: ModelEntry[] = [
  {
    id: 'qwen3-4b-instruct-2507-q4km',
    label: 'Qwen3 4B Instruct 2507 (Q4_K_M)',
    repo: 'unsloth/Qwen3-4B-Instruct-2507-GGUF',
    file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    sizeBytes: 2_497_281_120,
    nCtx: 8192,
    minRamGb: 6,
    notes: 'Default. Non-thinking instruct model with strong native tool calling for its size.',
    default: true,
  },
  {
    id: 'qwen3-1.7b-q4km',
    label: 'Qwen3 1.7B (Q4_K_M)',
    repo: 'unsloth/Qwen3-1.7B-GGUF',
    file: 'Qwen3-1.7B-Q4_K_M.gguf',
    sizeBytes: 1_107_409_472,
    nCtx: 8192,
    minRamGb: 4,
    notes: 'Fallback for low-RAM devices. Extraction quality drops; grammar + grounding carry more weight.',
  },
];

export const modelUrl = (m: ModelEntry) => `https://huggingface.co/${m.repo}/resolve/main/${m.file}`;
export const defaultModel = () => MODELS.find((m) => m.default)!;
