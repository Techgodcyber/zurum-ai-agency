/**
 * Brand identity. Single source of truth for the product name so it's easy to
 * rename later (nothing hardcodes "Zurum" elsewhere — import from here).
 */
export const BRAND = {
  name: "Zurum",
  tagline: "Describe it. Zurum builds it.",
  /** How the bot introduces itself on first contact. */
  greeting:
    "Hi, I'm Zurum 👋 Tell me about the website you want — what it's for and " +
    "any style or pages you have in mind — and I'll build it for you.",
} as const;
