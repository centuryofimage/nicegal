export const modelDescriptions: Record<string, string> = {
  "facebook/metaclip-2-worldwide-b32":
    "Fast, and good for most searches. May miss small text or writing in a photo.",
  "facebook/metaclip-2-worldwide-b16":
    "Reads small text or writing in a photo more reliably than B/32. About as fast with a real GPU, so it's an easy upgrade if you have one.",
  "facebook/metaclip-2-worldwide-l14":
    "The most reliable MetaCLIP2 model for reading small text in a photo. Very slow to index. 3GB download.",
  "google/siglip2-base-patch16-256":
    "Good for scenes and poses. May miss small writing in a photo that MetaCLIP2 can find. Similar size to B/16.",
  "deepghs/siglip_beta/smilingwolf/siglip_swinv2_base_2025_02_22_18h56m54s":
    "Specialty model trained on Danbooru tags. Good for anime and art, less useful elsewhere. Slow as L/14.",
  "facebook/dinov3-vitb16-pretrain-lvd1689m":
    "Very fast image search. Try Visualize to see which areas match your example. Does not search from descriptions.",
};

/** Short copy for the status bar switcher; full descriptions remain available on hover. */
export const compactModelDescriptions: Record<string, string> = {
  "facebook/metaclip-2-worldwide-b32": "Fast general search; may miss small writing.",
  "facebook/metaclip-2-worldwide-b16": "Better small writing than B/32; similar speed on a GPU.",
  "facebook/metaclip-2-worldwide-l14":
    "Best MetaCLIP2 for small writing. Very slow indexing; 3 GB.",
  "google/siglip2-base-patch16-256":
    "Scenes and poses; weaker on small writing. Similar size to B/16.",
  "deepghs/siglip_beta/smilingwolf/siglip_swinv2_base_2025_02_22_18h56m54s":
    "Danbooru-trained for anime and art; less useful elsewhere. Slow as L/14.",
  "facebook/dinov3-vitb16-pretrain-lvd1689m":
    "Very fast image examples with Visualize. No text descriptions.",
};

export function shortModelName(name: string): string {
  return name.replace(/ \d{3,4}(?= \(|$)/, "");
}

export const modelLicenses: Record<string, { label: string; url: string }> = {
  "facebook/metaclip-2-worldwide-b32": {
    label: "CC BY-NC 4.0",
    url: "https://creativecommons.org/licenses/by-nc/4.0/",
  },
  "facebook/metaclip-2-worldwide-b16": {
    label: "CC BY-NC 4.0",
    url: "https://creativecommons.org/licenses/by-nc/4.0/",
  },
  "facebook/metaclip-2-worldwide-l14": {
    label: "CC BY-NC 4.0",
    url: "https://creativecommons.org/licenses/by-nc/4.0/",
  },
  "google/siglip2-base-patch16-256": {
    label: "Apache 2.0",
    url: "https://www.apache.org/licenses/LICENSE-2.0",
  },
  "facebook/dinov3-vitb16-pretrain-lvd1689m": {
    label: "DINOv3 license",
    url: "https://ai.meta.com/resources/models-and-libraries/dinov3-license",
  },
};
