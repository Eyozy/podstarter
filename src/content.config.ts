import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const transcriptsCollection = defineCollection({
  loader: glob({
    base: "./src/content/transcripts",
    pattern: "**/*.md",
  }),
  schema: z.object({
    title: z.string().optional(),
    contributors: z.array(z.string()).optional(),
  }).optional(),
});

export const collections = {
  transcripts: transcriptsCollection,
};
