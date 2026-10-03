type ModelTierId = "fast" | "balanced" | "large";

interface ImageModelInfo {
  tier: ModelTierId;
  description: string;
  /** Status bar switcher copy; the full description shows on hover. */
  compactDescription: string;
  /** Link text for the model's source page, which shows its license. */
  license?: string;
  recommended?: boolean;
}

const apache = "Apache 2.0";
const ccByNc = "CC BY-NC 4.0";

const tiers: { id: ModelTierId; label: string; description: string }[] = [
  { id: "fast", label: "Fast", description: "Best for slower GPUs" },
  { id: "balanced", label: "Balanced", description: "Fast on capable GPUs" },
  { id: "large", label: "Large", description: "Much slower indexing" },
];

export const imageModels: Record<string, ImageModelInfo> = {
  "facebook/metaclip-2-worldwide-b32": {
    tier: "fast",
    description:
      "Fast, and good for most searches. May miss small text or writing in a photo. Best choice for integrated graphics.",
    compactDescription: "Fast general search; may miss small writing.",
    license: ccByNc,
    recommended: true,
  },
  "facebook/metaclip-2-worldwide-b16": {
    tier: "balanced",
    description:
      "Reads small text or writing in a photo more reliably than B/32. About as fast with a real GPU, so it's an easy upgrade if you have one. Much slower on integrated graphics.",
    compactDescription: "Better small writing than B/32; similar speed on a GPU.",
    license: ccByNc,
  },
  "facebook/PE-Core-B16-224": {
    tier: "balanced",
    description:
      "A different model family from MetaCLIP2 that finds different matches. Try it when a search misses. Nearly as fast as B/32 on a real GPU; much slower on integrated graphics. 1.7 GB download.",
    compactDescription: "Finds different matches than MetaCLIP2. Needs a real GPU. 1.7 GB.",
    license: apache,
    recommended: true,
  },
  "google/siglip2-base-patch16-256": {
    tier: "balanced",
    description:
      "Good for scenes and poses. May miss small writing in a photo that MetaCLIP2 can find. Similar size to MetaCLIP2 B/16.",
    compactDescription:
      "Scenes and poses; weaker on small writing. Similar size to MetaCLIP2 B/16.",
    license: apache,
  },
  "facebook/dinov3-vitb16-pretrain-lvd1689m": {
    tier: "balanced",
    description:
      "Fast image search. Try Visualize to see which areas match your example. Does not search from descriptions.",
    compactDescription: "Fast image examples with Visualize. No text descriptions.",
    license: "DINOv3 license",
  },
  "facebook/metaclip-2-worldwide-l14": {
    tier: "large",
    description:
      "The most reliable MetaCLIP2 model for reading small text in a photo. Very slow to index. 3 GB download.",
    compactDescription: "Best MetaCLIP2 for small writing. Very slow indexing; 3 GB.",
    license: ccByNc,
  },
  "facebook/PE-Core-L14-336": {
    tier: "large",
    description:
      "Largest PE model. Very slow to index, slower than MetaCLIP2 L/14. 2.5 GB download.",
    compactDescription: "Largest PE model. Very slow indexing; 2.5 GB.",
    license: apache,
  },
  "deepghs/siglip_beta/smilingwolf/siglip_swinv2_base_2025_02_22_18h56m54s": {
    tier: "large",
    description:
      "Specialty model trained on Danbooru tags. Good for anime and art, less useful elsewhere. Very slow to index, slower than MetaCLIP2 L/14.",
    compactDescription:
      "Danbooru-trained for anime and art; less useful elsewhere. Very slow indexing.",
    license: apache,
  },
};

export function shortModelName(name: string): string {
  return name.replace(/ \d{3,4}(?= \(|$)/, "");
}

/** Every model stays selectable; catalog entries without info go under Balanced. */
export function groupImageModels<T extends { id: string }>(
  models: readonly T[],
): { id: ModelTierId; label: string; description: string; models: T[] }[] {
  return tiers
    .map((tier) => ({
      ...tier,
      models: models.filter((model) => (imageModels[model.id]?.tier ?? "balanced") === tier.id),
    }))
    .filter((tier) => tier.models.length > 0);
}
