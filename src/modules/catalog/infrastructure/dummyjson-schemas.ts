import { z } from 'zod';

const httpURL = z.url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol));
const nonnegative = z.number().nonnegative();
const integer = z.number().int().nonnegative();
const slug = z.string().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

// Unknown keys (including reviews and prices) are stripped rather than copied.
export const externalProductSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().trim().min(1),
  description: z.string().nullable().optional(),
  thumbnail: httpURL.nullable().optional(),
  category: slug.optional(),
  brand: z.string().optional(),
  sku: z.string().optional(),
  tags: z.array(z.string()).optional(),
  images: z.array(httpURL).optional(),
  dimensions: z.object({ width: nonnegative, height: nonnegative, depth: nonnegative }).optional(),
  weight: nonnegative.optional(),
  stock: integer.optional(),
  availabilityStatus: z.string().optional(),
  warrantyInformation: z.string().optional(),
  shippingInformation: z.string().optional(),
  returnPolicy: z.string().optional(),
  minimumOrderQuantity: integer.optional(),
  meta: z.object({
    createdAt: z.iso.datetime().optional(), updatedAt: z.iso.datetime().optional(),
    barcode: z.string().optional(), qrCode: httpURL.optional(),
  }).optional(),
}).transform(({ id, title, description, thumbnail, ...attributes }) => ({
  id, title, description: description ?? null,
  imageUrl: thumbnail ?? attributes.images?.[0] ?? null,
  attributes,
}));

export const externalPageSchema = z.object({
  products: z.array(externalProductSchema).max(100),
  total: integer,
  skip: integer,
  limit: integer,
}).refine((page) => page.products.length <= page.total
  && (page.limit === 0 || page.products.length <= page.limit));

export const categoriesSchema = z.array(slug);
