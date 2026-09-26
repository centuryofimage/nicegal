/** A user-editable CLIP component. The wire serializer lives at the Electron boundary; this
 * deliberately represents only text while the visual editor is being brought up. */
export type VisualTextTerm = {
  id: string;
  text: string;
  polarity: "more" | "less";
  strength: number;
};

export type VisualReferenceTerm = {
  id: string;
  source: "library" | "external";
  displayName: string;
  assetId?: string;
  bytesBase64?: string;
  polarity: "more" | "less";
  strength: number;
};

/** Parses the rclip-inspired text subset. A `+` or `-` is an operator only when surrounded by
 * whitespace, so ordinary descriptions such as "red-and-white" remain ordinary CLIP text. */
export function parseVisualTextTerms(expression: string): VisualTextTerm[] {
  let source = expression.trim();
  const terms: VisualTextTerm[] = [];
  let polarity: VisualTextTerm["polarity"] = "more";
  const leadingOperator = /^([+-])\s+/.exec(source);
  if (leadingOperator) {
    polarity = leadingOperator[1] === "+" ? "more" : "less";
    source = source.slice(leadingOperator[0].length);
  }
  const chunks = source.split(/\s+([+-])\s+/);

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]?.trim() ?? "";
    if (!chunk) continue;
    if (chunk === "+" || chunk === "-") {
      polarity = chunk === "+" ? "more" : "less";
      continue;
    }
    const weighted = /^(\d+(?:\.\d+)?)\s*:\s*(.*)$/.exec(chunk);
    const strength = weighted ? Number(weighted[1]) : 1;
    const text = (weighted?.[2] ?? chunk).trim().replace(/^"(.*)"$/, "$1");
    if (!text || !Number.isFinite(strength) || strength <= 0) continue;
    terms.push({ id: `text-${index}`, text, polarity, strength });
    polarity = "more";
  }
  return terms;
}

export function isVisualComposition(expression: string): boolean {
  return /^\s*(?:-|\d+(?:\.\d+)?\s*:)/.test(expression) || /\s[+-]\s/.test(expression);
}

/** Produces an unambiguous, compact expression. Quote descriptions containing an operator so a
 * later parser round-trip retains their meaning. */
export function formatVisualTextTerms(terms: readonly VisualTextTerm[]): string {
  return terms
    .filter((term) => term.text.trim())
    .map((term, index) => {
      const operator =
        index === 0
          ? term.polarity === "less"
            ? "- "
            : ""
          : term.polarity === "less"
            ? " - "
            : " + ";
      const text = /\s[+-]\s/.test(term.text) ? `"${term.text.replaceAll('"', '\\"')}"` : term.text;
      const strength = term.strength === 1 ? "" : `${term.strength}:`;
      return `${operator}${strength}${text}`;
    })
    .join("");
}
