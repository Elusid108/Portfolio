import { defineCollection, reference, z } from 'astro:content';
import { glob } from 'astro/loaders';

// Product families group products that share firmware/software, e.g. the
// PixelDecode boards. Order controls placement on the home page.
const families = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/families' }),
  schema: z.object({
    name: z.string(),
    tagline: z.string(),
    category: z.enum(['hardware', 'software', 'systems', 'tooling', 'lighting', 'art']),
    order: z.number().default(100),
    heroImage: z.string().optional(),
    portfolioSlug: z.string().optional(), // matching chrismoore.me/projects/<slug>/
  }),
});

// A product is one purchasable thing. `shopifyHandle` links it to Shopify; the
// build fetches live price/variants when PUBLIC_SHOPIFY_* env vars are set,
// otherwise `placeholderPrice` is shown.
const products = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/products' }),
  schema: z.object({
    name: z.string(),
    sku: z.string(),
    family: reference('families'),
    summary: z.string(),
    shopifyHandle: z.string().optional(),
    placeholderPrice: z.number().optional(),
    specs: z.record(z.string(), z.string()).default({}),
    images: z.array(z.string()).default([]),
    firmware: z.array(reference('firmware')).default([]),
    software: z.array(reference('software')).default([]),
    featured: z.boolean().default(false),
    order: z.number().default(100),
  }),
});

const firmware = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/firmware' }),
  schema: z.object({
    name: z.string(),
    version: z.string(),
    date: z.coerce.date(),
    targets: z.array(z.string()).default([]), // e.g. ["PXD-8", "PXD-16"]
    downloadUrl: z.string().url().optional(),
    sha256: z.string().optional(),
    webInstallerManifest: z.string().url().optional(), // ESP Web Tools manifest
    repo: z.string().url().optional(),
    ota: z.boolean().default(false),
  }),
});

const software = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/software' }),
  schema: z.object({
    name: z.string(),
    summary: z.string(),
    platforms: z.array(z.enum(['windows', 'macos', 'linux', 'web', 'raspberry-pi'])).default([]),
    version: z.string().optional(),
    repo: z.string().url().optional(),
    releaseUrl: z.string().url().optional(),
    appUrl: z.string().url().optional(),
    screenshots: z.array(z.string()).default([]),
  }),
});

const services = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/services' }),
  schema: z.object({
    name: z.string(),
    summary: z.string(),
    quoteEmail: z.string().email().optional(),
    startingPrice: z.number().optional(),
    relatedApps: z.array(reference('software')).default([]),
    order: z.number().default(100),
  }),
});

export const collections = { families, products, firmware, software, services };
