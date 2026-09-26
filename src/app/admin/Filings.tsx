"use client";

import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field, TextAreaField } from "@/components/ui/Field";
import { cx } from "@/components/ui/Layout";
import {
  createFiling,
  createProduct,
  createVariant,
  updateFilingStatus,
  uploadProductImage,
  type ActionResult,
} from "@/lib/db/admin";
import type {
  AdminFiling,
  AdminImage,
  AdminProduct,
  AdminVariant,
  FilingStatus,
} from "@/lib/db/queries";
import { money } from "@/lib/format";
import styles from "./admin.module.css";

/**
 * The Filings pane: every filing, expanding inline to its products, and each
 * product to its variants and images.
 *
 * The page hands over the catalogue once. After that this component is the
 * source of truth: each action returns the row it wrote, and that row is
 * spliced into local state — no refetch, no route per step.
 *
 * Nothing here is a security boundary. Hiding the status control from staff is
 * a courtesy; updateFilingStatus() checks requireOwner() on the server whatever
 * this renders.
 */
export function FilingsPane({
  initial,
  canPublish,
}: {
  initial: AdminFiling[];
  /** Owner only. Mirrors the server's check so staff are not offered a button that will refuse them. */
  canPublish: boolean;
}) {
  const [filings, setFilings] = useState(initial);
  const [creating, setCreating] = useState(false);

  function patchFiling(id: string, change: (f: AdminFiling) => AdminFiling) {
    setFilings((all) => all.map((f) => (f.id === id ? change(f) : f)));
  }

  function patchProduct(
    filingId: string,
    productId: string,
    change: (p: AdminProduct) => AdminProduct,
  ) {
    patchFiling(filingId, (f) => ({
      ...f,
      products: f.products.map((p) => (p.id === productId ? change(p) : p)),
    }));
  }

  const nextNumber = filings.reduce((n, f) => Math.max(n, f.number), 0) + 1;

  return (
    <>
      <div className={styles.toolrow}>
        <Button
          compact
          variant={creating ? "ghost" : "solid"}
          aria-expanded={creating}
          onClick={() => setCreating((c) => !c)}
        >
          {creating ? "Cancel" : "New filing"}
        </Button>
      </div>

      {creating && (
        <NewFilingForm
          suggested={nextNumber}
          onCreated={(filing) => {
            setFilings((all) =>
              [filing, ...all].sort((a, b) => b.number - a.number),
            );
            setCreating(false);
          }}
        />
      )}

      {filings.length === 0 ? (
        <EmptyState title="No filings yet">
          Create a filing, add products to it, then schedule it. Nothing goes
          live until you publish it.
        </EmptyState>
      ) : (
        <ul className={styles.filings}>
          {filings.map((filing) => (
            <FilingRow
              key={filing.id}
              filing={filing}
              alsoLive={filings.filter(
                (f) => f.status === "live" && f.id !== filing.id,
              )}
              canPublish={canPublish}
              onStatus={(status) =>
                patchFiling(filing.id, (f) => ({ ...f, status }))
              }
              onProduct={(product) =>
                patchFiling(filing.id, (f) => ({
                  ...f,
                  products: [...f.products, product],
                }))
              }
              onVariant={(productId, variant) =>
                patchProduct(filing.id, productId, (p) => ({
                  ...p,
                  variants: [...p.variants, variant],
                }))
              }
              onImage={(productId, image) =>
                patchProduct(filing.id, productId, (p) => ({
                  ...p,
                  images: [...p.images, image],
                }))
              }
            />
          ))}
        </ul>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------
   Rows
   ------------------------------------------------------------------------- */

function FilingRow({
  filing,
  alsoLive,
  canPublish,
  onStatus,
  onProduct,
  onVariant,
  onImage,
}: {
  filing: AdminFiling;
  alsoLive: AdminFiling[];
  canPublish: boolean;
  onStatus: (status: FilingStatus) => void;
  onProduct: (product: AdminProduct) => void;
  onVariant: (productId: string, variant: AdminVariant) => void;
  onImage: (productId: string, image: AdminImage) => void;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const count = filing.products.length;

  return (
    <li className={cx(styles.filing, "rough")}>
      <button
        type="button"
        className={styles.rowhead}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={styles.rowtitle}>Filing {pad(filing.number)}</span>
        <span className={styles.rowname}>{filing.title}</span>
        <span className={styles.badge} data-status={filing.status}>
          {filing.status}
        </span>
        <span className="mono">
          {count} {count === 1 ? "product" : "products"}
        </span>
        <span className={styles.chev} aria-hidden="true">
          {open ? "−" : "+"}
        </span>
      </button>

      {/* hidden, not unmounted: a half-filled form survives collapsing. */}
      <div id={bodyId} className={styles.rowbody} hidden={!open}>
        <StatusControl
          filing={filing}
          alsoLive={alsoLive}
          canPublish={canPublish}
          onChanged={onStatus}
        />

        <h3 className={styles.subhead}>Products</h3>
        {count === 0 ? (
          <p className={styles.quiet}>No products in this filing yet.</p>
        ) : (
          <ul className={styles.products}>
            {filing.products.map((product) => (
              <ProductRow
                key={product.id}
                product={product}
                onVariant={(v) => onVariant(product.id, v)}
                onImage={(i) => onImage(product.id, i)}
              />
            ))}
          </ul>
        )}

        <NewProductForm filingId={filing.id} onCreated={onProduct} />
      </div>
    </li>
  );
}

function ProductRow({
  product,
  onVariant,
  onImage,
}: {
  product: AdminProduct;
  onVariant: (variant: AdminVariant) => void;
  onImage: (image: AdminImage) => void;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const stock = product.variants.reduce((n, v) => n + v.stock, 0);
  const images = product.images.length;

  return (
    <li className={styles.product}>
      <button
        type="button"
        className={styles.rowhead}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={styles.rowname}>{product.name}</span>
        <span className="mono">{product.kind}</span>
        <span className="mono">{money(product.priceCents)}</span>
        <span className="mono">
          {stock} in stock / {images} {images === 1 ? "image" : "images"}
        </span>
        <span className={styles.chev} aria-hidden="true">
          {open ? "−" : "+"}
        </span>
      </button>

      <div id={bodyId} className={styles.rowbody} hidden={!open}>
        <h4 className={styles.subhead}>Variants</h4>
        {product.variants.length === 0 ? (
          <p className={styles.quiet}>
            No variants yet. Nothing can be bought until there is one.
          </p>
        ) : (
          <div className={styles.tablescroll}>
            <table className={styles.minitable}>
              <thead>
                <tr>
                  <th>Size</th>
                  <th>Color</th>
                  <th>SKU</th>
                  <th>Stock</th>
                </tr>
              </thead>
              <tbody>
                {product.variants.map((v) => (
                  <tr key={v.id}>
                    <td>{v.size}</td>
                    <td>{v.color}</td>
                    <td>{v.sku}</td>
                    <td>{v.stock}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <NewVariantForm productId={product.id} onCreated={onVariant} />

        <h4 className={styles.subhead}>Images</h4>
        {images === 0 ? (
          <p className={styles.quiet}>No images yet.</p>
        ) : (
          <ul className={styles.thumbs}>
            {product.images.map((image) => (
              <li key={image.id}>
                <a
                  href={imageSrc(image.r2Key)}
                  target="_blank"
                  rel="noreferrer"
                  title={image.r2Key}
                >
                  {/* Plain <img> on purpose. next/image would route through the
                      OpenNext optimiser, which needs a Cloudflare Images
                      binding this app deliberately does not have — see
                      src/lib/images.ts. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={imageSrc(image.r2Key)}
                    alt={product.name}
                    loading="lazy"
                  />
                </a>
              </li>
            ))}
          </ul>
        )}
        <ImageUploadForm productId={product.id} onUploaded={onImage} />
      </div>
    </li>
  );
}

/* -------------------------------------------------------------------------
   Status
   ------------------------------------------------------------------------- */

const NEXT_STEP: Record<
  FilingStatus,
  { to: FilingStatus; label: string } | null
> = {
  draft: { to: "scheduled", label: "Schedule" },
  scheduled: { to: "live", label: "Take live" },
  live: { to: "closed", label: "Close" },
  closed: null,
};

function StatusControl({
  filing,
  alsoLive,
  canPublish,
  onChanged,
}: {
  filing: AdminFiling;
  alsoLive: AdminFiling[];
  canPublish: boolean;
  onChanged: (status: FilingStatus) => void;
}) {
  const { pending, error, submit } = useSubmit();
  // Going live takes a second click. It is the one step customers see.
  const [armed, setArmed] = useState(false);
  const step = NEXT_STEP[filing.status];

  if (!step) {
    return <p className={styles.quiet}>Closed. This filing is finished.</p>;
  }
  if (!canPublish) {
    return (
      <p className={styles.quiet}>
        Only the owner can move a filing from {filing.status} to {step.to}.
      </p>
    );
  }

  const { to, label } = step;

  function advance() {
    void submit(
      () => updateFilingStatus({ filingId: filing.id, status: to }),
      (row) => {
        setArmed(false);
        onChanged(row.status);
      },
    );
  }

  return (
    <div className={styles.statusrow}>
      {to === "live" && armed ? (
        <>
          <Button compact disabled={pending} onClick={advance}>
            {pending ? "..." : `Confirm: take Filing ${pad(filing.number)} live`}
          </Button>
          <Button compact variant="ghost" onClick={() => setArmed(false)}>
            Cancel
          </Button>
        </>
      ) : (
        <Button
          compact
          variant="ghost"
          disabled={pending}
          onClick={to === "live" ? () => setArmed(true) : advance}
        >
          {pending ? "..." : label}
        </Button>
      )}

      {/* filings_one_live_idx refuses a second live filing, and the server
          names the one in the way. Say it here too, before the click, from
          what this console already holds — the server stays the authority. */}
      {to === "live" && armed && alsoLive.length > 0 && (
        <p className={styles.warn}>
          {alsoLive.map((f) => `Filing ${pad(f.number)}`).join(", ")} is still
          live. Only one filing can be live at a time, so close it first.
        </p>
      )}

      <p className={styles.status} role="status">
        {error}
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------
   Forms
   ------------------------------------------------------------------------- */

function NewFilingForm({
  suggested,
  onCreated,
}: {
  suggested: number;
  onCreated: (filing: AdminFiling) => void;
}) {
  const { pending, error, submit } = useSubmit();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    void submit(
      () =>
        createFiling({
          number: Number(form.get("number")),
          title: String(form.get("title") ?? ""),
        }),
      onCreated,
    );
  }

  return (
    <form className={cx(styles.editor, "rough")} onSubmit={onSubmit}>
      <div className={styles.formgrid}>
        <Field
          id="nf-number"
          name="number"
          label="Filing number"
          type="number"
          min={1}
          max={999}
          step={1}
          defaultValue={suggested}
          required
        />
        <Field
          id="nf-title"
          name="title"
          label="Title"
          type="text"
          maxLength={120}
          placeholder="What this drop is called"
          required
        />
      </div>
      <Button type="submit" compact disabled={pending}>
        {pending ? "..." : "Create filing"}
      </Button>
      <p className={styles.status} role="status">
        {error}
      </p>
    </form>
  );
}

function NewProductForm({
  filingId,
  onCreated,
}: {
  filingId: string;
  onCreated: (product: AdminProduct) => void;
}) {
  const { pending, error, submit } = useSubmit();
  const id = useId();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const el = e.currentTarget;
    const form = new FormData(el);
    void submit(
      () =>
        createProduct({
          filingId,
          name: String(form.get("name") ?? ""),
          slug: String(form.get("slug") ?? ""),
          kind: String(form.get("kind") ?? ""),
          description: String(form.get("description") ?? ""),
          // Typed in dollars, stored in cents. Rounding absorbs float noise
          // (0.1 * 100 is 10.000000000000002); the server rejects anything
          // that is still not a whole, non-negative number.
          priceCents: Math.round(Number(form.get("price")) * 100),
        }),
      (product) => {
        el.reset();
        onCreated(product);
      },
    );
  }

  return (
    <form className={styles.addform} onSubmit={onSubmit}>
      <h4 className={styles.subhead}>Add a product</h4>
      <div className={styles.formgrid}>
        <Field id={`${id}-name`} name="name" label="Name" maxLength={120} required />
        <Field
          id={`${id}-slug`}
          name="slug"
          label="Slug"
          maxLength={80}
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          hint="Lowercase and dashes, like void-stamp-hood. Unique across the shop."
          required
        />
        <Field
          id={`${id}-kind`}
          name="kind"
          label="Kind"
          maxLength={40}
          hint="The label on the grid: Tee, Hood."
          required
        />
        <Field
          id={`${id}-price`}
          name="price"
          label="Price (USD)"
          type="number"
          inputMode="decimal"
          min={0}
          step={0.01}
          required
        />
      </div>
      <TextAreaField
        id={`${id}-description`}
        name="description"
        label="Description"
        maxLength={2000}
        rows={3}
      />
      <Button type="submit" compact disabled={pending}>
        {pending ? "..." : "Add product"}
      </Button>
      <p className={styles.status} role="status">
        {error}
      </p>
    </form>
  );
}

function NewVariantForm({
  productId,
  onCreated,
}: {
  productId: string;
  onCreated: (variant: AdminVariant) => void;
}) {
  const { pending, error, submit } = useSubmit();
  const id = useId();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const el = e.currentTarget;
    const form = new FormData(el);
    void submit(
      () =>
        createVariant({
          productId,
          size: String(form.get("size") ?? ""),
          color: String(form.get("color") ?? ""),
          sku: String(form.get("sku") ?? ""),
          stock: Number(form.get("stock")),
        }),
      (variant) => {
        el.reset();
        onCreated(variant);
      },
    );
  }

  return (
    <form className={styles.addform} onSubmit={onSubmit}>
      <div className={styles.formgrid}>
        <Field id={`${id}-size`} name="size" label="Size" maxLength={16} required />
        <Field id={`${id}-color`} name="color" label="Color" maxLength={40} required />
        <Field
          id={`${id}-sku`}
          name="sku"
          label="SKU"
          maxLength={64}
          hint="Unique across the shop, like DGN-002-M-BLK."
          required
        />
        <Field
          id={`${id}-stock`}
          name="stock"
          label="Stock"
          type="number"
          min={0}
          step={1}
          required
        />
      </div>
      <Button type="submit" compact disabled={pending}>
        {pending ? "..." : "Add variant"}
      </Button>
      <p className={styles.status} role="status">
        {error}
      </p>
    </form>
  );
}

/**
 * Mirrors MAX_IMAGE_BYTES in src/lib/images.ts, which is server-only and so
 * cannot be imported here. The server enforces its own copy; this one exists
 * because a file over serverActions.bodySizeLimit is refused before the action
 * runs, and that refusal arrives with no message worth showing.
 */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

function ImageUploadForm({
  productId,
  onUploaded,
}: {
  productId: string;
  onUploaded: (image: AdminImage) => void;
}) {
  const { pending, error, submit, fail } = useSubmit();
  const id = useId();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const el = e.currentTarget;
    const form = new FormData(el);

    const file = form.get("file");
    if (file instanceof File && file.size > MAX_UPLOAD_BYTES) {
      fail("Images are capped at 8 MB.");
      return;
    }

    form.set("productId", productId);
    void submit(
      () => uploadProductImage(form),
      (image) => {
        el.reset();
        onUploaded(image);
      },
    );
  }

  return (
    <form className={styles.addform} onSubmit={onSubmit}>
      <Field
        id={`${id}-file`}
        name="file"
        label="Upload an image"
        type="file"
        accept="image/jpeg,image/png,image/webp,image/avif,image/gif"
        hint="JPEG, PNG, WebP, AVIF or GIF, up to 8 MB."
        required
      />
      <Button type="submit" compact disabled={pending}>
        {pending ? "Uploading..." : "Upload"}
      </Button>
      <p className={styles.status} role="status">
        {error}
      </p>
    </form>
  );
}

/* -------------------------------------------------------------------------
   Plumbing
   ------------------------------------------------------------------------- */

/** Pending flag and last error for one form, kept the way SignInPanel keeps them. */
function useSubmit() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit<T>(
    call: () => Promise<ActionResult<T>>,
    onDone: (data: T) => void,
  ) {
    setPending(true);
    setError("");
    try {
      const result = await call();
      if (result.ok) onDone(result.data);
      else setError(result.error);
    } catch {
      // A thrown action error arrives with its message stripped, so there is
      // nothing more specific to say. Expected failures never land here —
      // they come back as { ok: false }.
      setError("That did not go through. Reload and try again.");
    } finally {
      setPending(false);
    }
  }

  return { pending, error, submit, fail: setError };
}

/**
 * Where src/app/images/[...key]/route.ts serves a key. Each segment is encoded
 * on its own so the slash between product and file stays a path separator.
 */
function imageSrc(key: string): string {
  return `/images/${key.split("/").map(encodeURIComponent).join("/")}`;
}

const pad = (n: number) => String(n).padStart(3, "0");
