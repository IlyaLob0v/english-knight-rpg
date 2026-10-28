type Attrs = Record<string, string | ((e: Event) => unknown)>;

/** Tiny element helper: attributes, `on*` listeners and text or element children. Text is never parsed as HTML. */
export function el(tag: string, attrs: Attrs = {}, ...children: (string | Node)[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "function") node.addEventListener(k.slice(2), v as EventListener);
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}
