import { callModel } from "../models/index.js";
import { BRAND } from "../config/brand.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ mod: "content" });

/**
 * Content tools (§15 / vision "AI Marketing") — generate ready-to-publish
 * marketing copy for the customer's business: blog posts, social captions,
 * product descriptions, SEO text, ad copy, emails. Runs on a cheap model.
 */
export async function generateContent(
  request: string,
  businessContext?: string | null,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const res = await callModel("aria", {
      system:
        `You are ${BRAND.name}'s expert marketing copywriter. Write EXACTLY what the customer ` +
        `asks for — a blog post, social-media captions, product description, SEO text, ad copy ` +
        `or email — engaging, on-brand and READY TO PUBLISH. Match the customer's language. For ` +
        `captions or lists use short punchy lines with fitting emojis and 2–4 relevant hashtags ` +
        `where they help. Do NOT add preamble or explanations like "here's your content" — output ` +
        `ONLY the finished content.`,
      messages: [
        {
          role: "user",
          content: businessContext ? `About the business: ${businessContext}\n\nRequest: ${request}` : request,
        },
      ],
      maxTokens: 900,
      thinking: false,
      jobId: "content",
    });
    return res.text.trim();
  } catch (err) {
    log.warn({ err }, "content generation failed");
    return "";
  }
}
