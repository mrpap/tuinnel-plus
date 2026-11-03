// Tiny DOM helpers shared by the dashboard.

/** Event names each element got from h(), so patch() can move handlers across. */
const handlers = new WeakMap();

/** Build an element. Children may be strings (inserted as text, never HTML) or nodes. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  const events = new Set();
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) { el[k] = v; events.add(k); }
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  if (events.size) handlers.set(el, events);
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const present = (children) => children.flat().filter((c) => c !== null && c !== undefined && c !== false);

/** replaceChildren that skips null/false (the DOM would print them as text). */
export function fill(el, ...children) {
  el.replaceChildren(...present(children));
}

/**
 * Like fill(), but reuses the nodes already there wherever the new markup has
 * the same kind of node. For parts redrawn on a timer or live event: a click
 * is lost if the button under the pointer is swapped between press and release.
 */
export function patch(el, ...children) {
  const next = present(children).map((c) => (c instanceof Node ? c : document.createTextNode(String(c))));
  next.forEach((n, i) => {
    const old = el.childNodes[i];
    if (!old) el.append(n);
    else if (!sameKind(old, n)) old.replaceWith(n);
    else morph(old, n);
  });
  while (el.childNodes.length > next.length) el.lastChild.remove();
}

function sameKind(a, b) {
  return a.nodeType === b.nodeType && a.nodeName === b.nodeName && a.namespaceURI === b.namespaceURI;
}

function morph(old, n) {
  if (old.nodeType !== Node.ELEMENT_NODE) {
    if (old.nodeValue !== n.nodeValue) old.nodeValue = n.nodeValue;
    return;
  }
  for (const { name } of [...old.attributes]) if (!n.hasAttribute(name)) old.removeAttribute(name);
  for (const { name, value } of [...n.attributes]) if (old.getAttribute(name) !== value) old.setAttribute(name, value);
  // Attributes alone don't reset these once the element has been used.
  if ('disabled' in old) old.disabled = n.disabled;

  const was = handlers.get(old) ?? new Set();
  const now = handlers.get(n) ?? new Set();
  for (const k of was) if (!now.has(k)) old[k] = null;
  for (const k of now) old[k] = n[k];
  if (now.size) handlers.set(old, now);
  else handlers.delete(old);

  patch(old, ...n.childNodes);
}
