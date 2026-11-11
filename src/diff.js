// Compares two snapshots of the watched pages and reports changes per top-level frame.
//
// A snapshot is { pages, components, componentSets, styles } as returned by FigmaClient.getPageTrees.
// Nodes keep the same ID across versions, so we match by ID and compare a fixed list of
// properties. Anything not compared (selection, viewport, prototype data, plugin data, export
// settings...) is ignored by design.

const EPS = 0.5; // px: smaller differences are float noise

/** Flatten a snapshot: id → { node, page, top, parent, isTop, hidden, inInstance } */
export function indexSnapshot(snap) {
  const index = new Map();
  const tops = [];

  const visit = (node, ctx) => {
    const hiddenSelf = node.visible === false;
    const entry = {
      node,
      page: ctx.page,
      top: ctx.top || node,
      parent: ctx.parent,
      isTop: !ctx.top,
      hiddenAncestor: ctx.hidden,
      hidden: ctx.hidden || hiddenSelf,
      inInstance: node.id.startsWith('I'),
    };
    index.set(node.id, entry);
    if (entry.isTop) tops.push(entry);
    for (const child of node.children || []) {
      visit(child, { page: ctx.page, top: entry.top, parent: node, hidden: entry.hidden });
    }
  };

  // Frames placed inside sections still count as top-level frames.
  const visitContainer = (container, page) => {
    for (const child of container.children || []) {
      if (child.type === 'SECTION') visitContainer(child, page);
      else visit(child, { page, top: null, parent: container, hidden: false });
    }
  };

  for (const page of snap.pages || []) visitContainer(page, page.name);
  return { index, tops };
}

/**
 * @returns {{ frames: Array<{id, name, page, status: 'added'|'deleted'|'changed', changes: object[]}> }}
 */
export function compare(oldSnap, newSnap, { variables = {} } = {}) {
  const A = indexSnapshot(oldSnap);
  const B = indexSnapshot(newSnap);
  const ctx = { oldSnap, newSnap, variables };
  const frames = new Map();
  const added = new Map(); // topId → [layer names]
  const removed = new Map();

  const frameFor = (top, page, status = 'changed') => {
    if (!frames.has(top.id)) frames.set(top.id, { id: top.id, name: top.name, page, status, changes: [] });
    return frames.get(top.id);
  };
  const push = (map, key, name) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(name);
  };

  for (const [id, b] of B.index) {
    const a = A.index.get(id);
    if (b.isTop) {
      if (!a || !a.isTop) {
        frameFor(b.node, b.page, 'added');
        continue;
      }
      const changes = [...topChanges(a, b), ...nodeChanges(a, b, ctx, null)];
      if (changes.length) frameFor(b.node, b.page).changes.push(...changes);
      continue;
    }
    const topNow = b.top;
    const topBefore = A.index.get(topNow.id);
    if (!topBefore || !topBefore.isTop) continue; // whole frame is new, already reported
    if (!a) {
      // Report only the outermost new layer, and skip layers generated inside instances.
      if (!b.inInstance && b.parent && A.index.has(b.parent.id)) push(added, topNow.id, b.node.name);
      continue;
    }
    const changes = nodeChanges(a, b, ctx, b.node.name);
    if (a.top.id !== topNow.id) changes.unshift({ kind: 'reparent', node: b.node.name, old: a.top.name, new: topNow.name });
    if (changes.length) frameFor(topNow, b.page).changes.push(...changes);
  }

  const deletedFrames = [];
  for (const [id, a] of A.index) {
    if (B.index.has(id)) continue;
    if (a.isTop) {
      deletedFrames.push({ id, name: a.node.name, page: a.page, status: 'deleted', changes: [] });
      continue;
    }
    const topNow = B.index.get(a.top.id);
    if (!topNow || !topNow.isTop) continue;
    if (!a.inInstance && a.parent && B.index.has(a.parent.id)) push(removed, a.top.id, a.node.name);
  }

  for (const [topId, names] of added) {
    const t = B.index.get(topId);
    frameFor(t.node, t.page).changes.push({ kind: 'layers-added', count: names.length, names });
  }
  for (const [topId, names] of removed) {
    const t = B.index.get(topId);
    frameFor(t.node, t.page).changes.push({ kind: 'layers-removed', count: names.length, names });
  }

  // New-tree order first, then deleted frames in old order.
  const ordered = [];
  for (const t of B.tops) if (frames.has(t.node.id)) ordered.push(frames.get(t.node.id));
  ordered.push(...deletedFrames);
  return { frames: ordered.filter((f) => f.status !== 'changed' || f.changes.length) };
}

function topChanges(a, b) {
  const out = [];
  if (a.node.name !== b.node.name) out.push({ kind: 'frame-renamed', node: null, old: a.node.name, new: b.node.name });
  if (a.page !== b.page) out.push({ kind: 'frame-page', node: null, old: a.page, new: b.page });
  else {
    const p = a.node.absoluteBoundingBox;
    const q = b.node.absoluteBoundingBox;
    if (p && q && (Math.abs(p.x - q.x) >= 1 || Math.abs(p.y - q.y) >= 1)) out.push({ kind: 'frame-moved', node: null });
  }
  return out;
}

function nodeChanges(a, b, ctx, nodeName) {
  const on = a.node;
  const nn = b.node;
  const out = [];
  const add = (kind, oldV, newV, extra = {}) => out.push({ kind, node: nodeName, old: oldV, new: newV, ...extra });

  if (a.hidden && b.hidden) return out;
  const wasVisible = on.visible !== false;
  const isVisible = nn.visible !== false;
  if (wasVisible !== isVisible && !(a.hiddenAncestor && b.hiddenAncestor)) add('visibility', wasVisible, isVisible);
  if (b.hidden) return out;

  if (nn.type === 'TEXT' && on.type === 'TEXT' && (on.characters ?? '') !== (nn.characters ?? '')) {
    // Figma auto-names text layers after their content; then the name adds nothing.
    const auto = (n) => n.name.trim() === (n.characters ?? '').trim();
    add('text', on.characters ?? '', nn.characters ?? '', auto(on) || auto(nn) ? { node: null } : {});
  }

  for (const which of ['fills', 'strokes']) {
    if (!Array.isArray(on[which]) && !Array.isArray(nn[which])) continue;
    const p = paintInfo(on, which, ctx.oldSnap, ctx.variables);
    const q = paintInfo(nn, which, ctx.newSnap, ctx.variables);
    if (p.key !== q.key) {
      const [o, n] = p.label === q.label ? [`${p.label} ${p.hex}`, `${q.label} ${q.hex}`] : [p.label, q.label];
      add(which === 'fills' ? 'fill' : 'stroke', o, n);
    }
  }

  const sz = sizeChange(on, nn, b.inInstance);
  if (sz) add('size', sz[0], sz[1]);

  const hasLayout = (n) => n.layoutMode && n.layoutMode !== 'NONE';
  if (hasLayout(on) || hasLayout(nn)) {
    if ((on.layoutMode || 'NONE') !== (nn.layoutMode || 'NONE')) {
      add('layout', (on.layoutMode || 'none').toLowerCase(), (nn.layoutMode || 'none').toLowerCase());
    }
    for (const prop of ['itemSpacing', 'counterAxisSpacing']) {
      if (differs(on[prop] ?? 0, nn[prop] ?? 0)) add('gap', num(on[prop] ?? 0), num(nn[prop] ?? 0));
    }
    const pa = padding(on);
    const pb = padding(nn);
    if (pa !== pb) {
      const sides = ['top', 'right', 'bottom', 'left']
        .map((side) => {
          const k = `padding${side[0].toUpperCase()}${side.slice(1)}`;
          return [side, num(on[k] ?? 0), num(nn[k] ?? 0)];
        })
        .filter(([, o, n]) => o !== n);
      add('padding', pa, pb, { sides });
    }
  }

  const ra = radius(on);
  const rb = radius(nn);
  if (ra !== rb) add('radius', ra, rb);

  if (on.type === 'INSTANCE' && nn.type === 'INSTANCE' && on.componentId !== nn.componentId) {
    const oc = ctx.oldSnap.components?.[on.componentId];
    const nc = ctx.newSnap.components?.[nn.componentId];
    if (oc?.componentSetId && oc.componentSetId === nc?.componentSetId) {
      const ov = variantProps(on);
      const nv = variantProps(nn);
      let found = false;
      for (const key of new Set([...Object.keys(ov), ...Object.keys(nv)])) {
        if (ov[key] !== nv[key]) {
          add('variant', ov[key] ?? '—', nv[key] ?? '—', { prop: key });
          found = true;
        }
      }
      if (!found) add('variant', oc.name, nc.name, { prop: 'variant' });
    } else {
      add('swap', componentName(ctx.oldSnap, on.componentId), componentName(ctx.newSnap, nn.componentId));
    }
  }
  return out;
}

// ---------- property helpers ----------

function differs(x, y) {
  return Math.abs((Number(x) || 0) - (Number(y) || 0)) >= EPS;
}

export function num(v) {
  const r = Math.round(Number(v) * 10) / 10;
  return String(Object.is(r, -0) ? 0 : r);
}

function padding(n) {
  const v = [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft].map((x) => num(x ?? 0));
  if (v.every((x) => x === v[0])) return v[0];
  if (v[0] === v[2] && v[1] === v[3]) return `${v[0]} ${v[1]}`;
  return v.join(' ');
}

function radius(n) {
  if (Array.isArray(n.rectangleCornerRadii)) {
    const v = n.rectangleCornerRadii.map(num);
    return v.every((x) => x === v[0]) ? v[0] : v.join(' ');
  }
  return num(n.cornerRadius ?? 0);
}

const NO_OWN_SIZE = new Set(['TEXT', 'GROUP', 'BOOLEAN_OPERATION', 'SECTION']);

/** Size changes, skipping axes whose size comes from content (hug/fill) or from a parent. */
function sizeChange(on, nn, inInstance) {
  if (inInstance || NO_OWN_SIZE.has(nn.type)) return null;
  const p = on.absoluteBoundingBox;
  const q = nn.absoluteBoundingBox;
  if (!p || !q) return null;
  const wChanged = !derivedAxis(nn, 'width') && differs(p.width, q.width);
  const hChanged = !derivedAxis(nn, 'height') && differs(p.height, q.height);
  if (!wChanged && !hChanged) return null;
  return [`${num(p.width)}×${num(p.height)}`, `${num(q.width)}×${num(q.height)}`];
}

function derivedAxis(n, axis) {
  const sizing = axis === 'width' ? n.layoutSizingHorizontal : n.layoutSizingVertical;
  if (sizing === 'HUG' || sizing === 'FILL') return true;
  if (!n.layoutMode || n.layoutMode === 'NONE') return false;
  const primary = (n.layoutMode === 'HORIZONTAL') === (axis === 'width');
  const mode = primary ? n.primaryAxisSizingMode : n.counterAxisSizingMode;
  return (mode ?? 'AUTO') === 'AUTO';
}

function variantProps(n) {
  const out = {};
  for (const [k, v] of Object.entries(n.componentProperties || {})) {
    if (v?.type === 'VARIANT') out[k.split('#')[0]] = String(v.value);
  }
  return out;
}

function componentName(snap, id) {
  const c = snap.components?.[id];
  if (!c) return 'unknown component';
  const set = c.componentSetId && snap.componentSets?.[c.componentSetId];
  return set ? `${set.name} (${c.name})` : c.name;
}

export function toHex(color, opacity = 1) {
  const h = (x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0');
  const alpha = (color.a ?? 1) * opacity;
  const hex = `#${h(color.r)}${h(color.g)}${h(color.b)}`.toUpperCase();
  return alpha < 0.995 ? `${hex} ${Math.round(alpha * 100)}%` : hex;
}

export function lookupVariable(variables, id) {
  if (!id) return null;
  if (variables[id]) return variables[id];
  const key = id.match(/^VariableID:([^/]+)\//)?.[1];
  return (key && variables[`key:${key}`]) || null;
}

/** Name priority: variable name → style name → hex. `key` also includes the hex so value edits show up. */
function paintInfo(node, which, snap, variables) {
  const paints = (node[which] || []).filter((p) => p.visible !== false);
  if (!paints.length) return { key: 'none', label: 'none', hex: '' };
  const styleKeys = which === 'fills' ? ['fill', 'fills'] : ['stroke', 'strokes'];
  const styleId = styleKeys.map((k) => node.styles?.[k]).find(Boolean);
  const styleName = styleId ? snap.styles?.[styleId]?.name : null;
  const parts = paints.map((p) => {
    const hex = p.type === 'SOLID' && p.color ? toHex(p.color, p.opacity ?? 1) : p.type.startsWith('GRADIENT') ? 'gradient' : p.type.toLowerCase();
    return { hex, name: lookupVariable(variables, p.boundVariables?.color?.id) };
  });
  const hex = parts.map((x) => x.hex).join(' + ');
  const label = parts.length === 1 ? parts[0].name || styleName || hex : styleName || parts.map((x) => x.name || x.hex).join(' + ');
  const key = parts.map((x) => `${x.hex}|${x.name || ''}`).join(';') + `|${styleName || ''}`;
  return { key, label, hex };
}
