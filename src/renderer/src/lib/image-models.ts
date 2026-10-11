import { m } from "../../../shared/paraglide/messages.js";

type ModelTierId = "fast" | "balanced" | "large";

/** Copy is read through functions so each string is translated when shown, not at import. */
interface ImageModelInfo {
  tier: ModelTierId;
  description: () => string;
  /** Status bar switcher copy; the full description shows on hover. */
  compactDescription: () => string;
  /** Link text for the model's source page, which shows its license. */
  license?: () => string;
  recommended?: boolean;
}

const apache = (): string => m.image_model_license_apache();
const ccByNc = (): string => m.image_model_license_cc_by_nc();

const tiers: { id: ModelTierId; label: () => string; description: () => string }[] = [
  {
    id: "fast",
    label: () => m.image_model_tier_fast_label(),
    description: () => m.image_model_tier_fast_description(),
  },
  {
    id: "balanced",
    label: () => m.image_model_tier_balanced_label(),
    description: () => m.image_model_tier_balanced_description(),
  },
  {
    id: "large",
    label: () => m.image_model_tier_large_label(),
    description: () => m.image_model_tier_large_description(),
  },
];

export const imageModels: Record<string, ImageModelInfo> = {
  "facebook/metaclip-2-worldwide-b32": {
    tier: "fast",
    description: () => m.image_model_metaclip2_b32_description(),
    compactDescription: () => m.image_model_metaclip2_b32_compact(),
    license: ccByNc,
    recommended: true,
  },
  "facebook/metaclip-2-worldwide-b16": {
    tier: "balanced",
    description: () => m.image_model_metaclip2_b16_description(),
    compactDescription: () => m.image_model_metaclip2_b16_compact(),
    license: ccByNc,
  },
  "facebook/PE-Core-B16-224": {
    tier: "balanced",
    description: () => m.image_model_pe_b16_description(),
    compactDescription: () => m.image_model_pe_b16_compact(),
    license: apache,
    recommended: true,
  },
  "google/siglip2-base-patch16-256": {
    tier: "balanced",
    description: () => m.image_model_siglip2_description(),
    compactDescription: () => m.image_model_siglip2_compact(),
    license: apache,
  },
  "facebook/dinov3-vitb16-pretrain-lvd1689m": {
    tier: "balanced",
    description: () => m.image_model_dinov3_description(),
    compactDescription: () => m.image_model_dinov3_compact(),
    license: () => m.image_model_license_dinov3(),
  },
  "facebook/metaclip-2-worldwide-l14": {
    tier: "large",
    description: () => m.image_model_metaclip2_l14_description(),
    compactDescription: () => m.image_model_metaclip2_l14_compact(),
    license: ccByNc,
  },
  "facebook/PE-Core-L14-336": {
    tier: "large",
    description: () => m.image_model_pe_l14_description(),
    compactDescription: () => m.image_model_pe_l14_compact(),
    license: apache,
  },
  "deepghs/siglip_beta/smilingwolf/siglip_swinv2_base_2025_02_22_18h56m54s": {
    tier: "large",
    description: () => m.image_model_danbooru_siglip_description(),
    compactDescription: () => m.image_model_danbooru_siglip_compact(),
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
      id: tier.id,
      label: tier.label(),
      description: tier.description(),
      models: models.filter((model) => (imageModels[model.id]?.tier ?? "balanced") === tier.id),
    }))
    .filter((tier) => tier.models.length > 0);
}
