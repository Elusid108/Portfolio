/**
 * Minimal Shopify Storefront API client.
 *
 * Used in two places:
 *  - at build time (Astro pages) to bake product data into static HTML;
 *  - in the browser (Cart island) for cart mutations and live price refresh.
 *
 * Only the *public* Storefront token is ever used. It is safe to ship in the
 * client bundle; it cannot read orders, customers or anything an Admin token
 * can. See docs/INTEGRATION.md.
 */

export const SHOPIFY_DOMAIN = import.meta.env.PUBLIC_SHOPIFY_DOMAIN as string | undefined;
export const SHOPIFY_TOKEN = import.meta.env.PUBLIC_SHOPIFY_STOREFRONT_TOKEN as string | undefined;
export const SHOPIFY_API_VERSION = (import.meta.env.PUBLIC_SHOPIFY_API_VERSION as string | undefined) || '2026-07';

export const shopifyConfigured = Boolean(SHOPIFY_DOMAIN && SHOPIFY_TOKEN);

export function storefrontEndpoint(): string {
  return `https://${SHOPIFY_DOMAIN}/api/${SHOPIFY_API_VERSION}/graphql.json`;
}

export interface Money {
  amount: string;
  currencyCode: string;
}

export interface Variant {
  id: string;
  title: string;
  availableForSale: boolean;
  price: Money;
}

export interface StorefrontProduct {
  id: string;
  handle: string;
  title: string;
  availableForSale: boolean;
  priceRange: { minVariantPrice: Money };
  featuredImage?: { url: string; altText?: string | null } | null;
  variants: { nodes: Variant[] };
}

export interface CartLine {
  id: string;
  quantity: number;
  merchandise: {
    id: string;
    title: string;
    price: Money;
    product: { title: string; handle: string };
  };
}

export interface Cart {
  id: string;
  checkoutUrl: string;
  totalQuantity: number;
  cost: { subtotalAmount: Money };
  lines: { nodes: CartLine[] };
}

async function query<T>(gql: string, variables: Record<string, unknown> = {}): Promise<T> {
  if (!shopifyConfigured) throw new Error('Shopify is not configured (PUBLIC_SHOPIFY_* env vars missing).');
  const res = await fetch(storefrontEndpoint(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': SHOPIFY_TOKEN as string,
    },
    body: JSON.stringify({ query: gql, variables }),
  });
  if (!res.ok) throw new Error(`Storefront API ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
  return json.data as T;
}

const PRODUCT_FIELDS = `
  id handle title availableForSale
  priceRange { minVariantPrice { amount currencyCode } }
  featuredImage { url altText }
  variants(first: 20) { nodes { id title availableForSale price { amount currencyCode } } }
`;

const CART_FIELDS = `
  id checkoutUrl totalQuantity
  cost { subtotalAmount { amount currencyCode } }
  lines(first: 50) { nodes { id quantity merchandise { ... on ProductVariant { id title price { amount currencyCode } product { title handle } } } } }
`;

/** Build-time: fetch one product by handle. Returns null if Shopify is not configured. */
export async function getProductByHandle(handle: string): Promise<StorefrontProduct | null> {
  if (!shopifyConfigured) return null;
  const data = await query<{ productByHandle: StorefrontProduct | null }>(
    `query ($handle: String!) { productByHandle(handle: $handle) { ${PRODUCT_FIELDS} } }`,
    { handle },
  );
  return data.productByHandle;
}

/** Runtime: create a cart with optional first lines. */
export async function cartCreate(lines: { merchandiseId: string; quantity: number }[] = []): Promise<Cart> {
  const data = await query<{ cartCreate: { cart: Cart } }>(
    `mutation ($lines: [CartLineInput!]) { cartCreate(input: { lines: $lines }) { cart { ${CART_FIELDS} } } }`,
    { lines },
  );
  return data.cartCreate.cart;
}

export async function cartGet(cartId: string): Promise<Cart | null> {
  const data = await query<{ cart: Cart | null }>(`query ($id: ID!) { cart(id: $id) { ${CART_FIELDS} } }`, { id: cartId });
  return data.cart;
}

export async function cartLinesAdd(cartId: string, lines: { merchandiseId: string; quantity: number }[]): Promise<Cart> {
  const data = await query<{ cartLinesAdd: { cart: Cart } }>(
    `mutation ($cartId: ID!, $lines: [CartLineInput!]!) { cartLinesAdd(cartId: $cartId, lines: $lines) { cart { ${CART_FIELDS} } } }`,
    { cartId, lines },
  );
  return data.cartLinesAdd.cart;
}

export async function cartLinesUpdate(cartId: string, lines: { id: string; quantity: number }[]): Promise<Cart> {
  const data = await query<{ cartLinesUpdate: { cart: Cart } }>(
    `mutation ($cartId: ID!, $lines: [CartLineUpdateInput!]!) { cartLinesUpdate(cartId: $cartId, lines: $lines) { cart { ${CART_FIELDS} } } }`,
    { cartId, lines },
  );
  return data.cartLinesUpdate.cart;
}

export async function cartLinesRemove(cartId: string, lineIds: string[]): Promise<Cart> {
  const data = await query<{ cartLinesRemove: { cart: Cart } }>(
    `mutation ($cartId: ID!, $lineIds: [ID!]!) { cartLinesRemove(cartId: $cartId, lineIds: $lineIds) { cart { ${CART_FIELDS} } } }`,
    { cartId, lineIds },
  );
  return data.cartLinesRemove.cart;
}

export function formatMoney(m: Money | undefined | null, fallback = '—'): string {
  if (!m) return fallback;
  const n = Number(m.amount);
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: m.currencyCode }).format(n);
}
