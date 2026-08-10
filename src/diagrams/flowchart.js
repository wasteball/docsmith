/* =====================================================================
 * Docsmith · 流程图 / 状态图
 * ---------------------------------------------------------------------
 * 解析与 SVG 绘制留在本文件。复杂流程图优先交给 ELK Layered：它会把子图
 * 当作复合节点，并完成分层、交叉最小化、端口排序和正交边路由。ELK 不可用
 * 或布局失败时，仍回退到本地轻量布局器，保证离线打开不会丢图。
 * ===================================================================== */
import {
  wrap, textWidth, esc, cleanLabel, cleanLines, plainLabel,
  svgOpen, arrowDefs, textBlock, rect, line, path, polygon, chip, chipSize, uid, round, curveD,
} from './base.js';
import { layered, tree, isTree, anchors, selfLoop } from './layout.js';
import { inlineStyle } from './theme.js';

const SHAPES = [
  [/^\[\[(.*)\]\]$/s, 'subroutine'],
  [/^\[\((.*)\)\]$/s, 'cylinder'],
  [/^\(\((.*)\)\)$/s, 'circle'],
  [/^\{\{(.*)\}\}$/s, 'hexagon'],
  [/^\[\/(.*)\/\]$/s, 'parallelogram'],
  [/^\[\\(.*)\\\]$/s, 'parallelogram'],
  [/^\{(.*)\}$/s, 'diamond'],
  [/^\[(.*)\]$/s, 'rect'],
  [/^\((.*)\)$/s, 'round'],
  [/^>(.*)\]$/s, 'flag'],
];

function nodeSize(label, shape) {
  const lines = wrap(label, shape === 'diamond' ? 18 : 26);
  const textW = lines.reduce((a, l) => Math.max(a, textWidth(plainLabel(l))), 0);
  let w = Math.max(66, textW + 40);
  let h = Math.max(40, lines.length * 19 + 24);
  if (shape === 'diamond') { w += 24; h += 12; }
  if (shape === 'circle') { w = h = Math.max(w, h); }
  return { w, h, lines };
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function parseDirectStyle(raw) {
  const style = {};
  String(raw ?? '').split(',').forEach((entry) => {
    const split = entry.indexOf(':');
    if (split < 1) return;
    const key = entry.slice(0, split).trim().toLowerCase();
    const value = entry.slice(split + 1).trim();
    if ((key === 'fill' || key === 'stroke')
      && (HEX_COLOR.test(value) || /^(none|transparent)$/i.test(value))) {
      style[key] = value.toLowerCase();
    } else if (key === 'color' && HEX_COLOR.test(value)) {
      style.color = value.toLowerCase();
    } else if (key === 'stroke-width') {
      const match = /^(\d+(?:\.\d+)?)\s*(?:px)?$/i.exec(value);
      const width = match ? Number(match[1]) : NaN;
      if (Number.isFinite(width) && width >= 0 && width <= 16) style[key] = `${width}px`;
    }
  });
  return style;
}

function styleExtra(style, mode = 'shape') {
  if (!style) return '';
  const declarations = [];
  if (mode === 'text') {
    if (style.color) declarations.push(`fill:${style.color}`);
  } else if (mode === 'stroke') {
    if (style.stroke) declarations.push(`stroke:${style.stroke}`);
    if (style['stroke-width']) declarations.push(`stroke-width:${style['stroke-width']}`);
  } else {
    if (style.fill) declarations.push(`fill:${style.fill}`);
    if (style.stroke) declarations.push(`stroke:${style.stroke}`);
    if (style['stroke-width']) declarations.push(`stroke-width:${style['stroke-width']}`);
  }
  return declarations.length ? `style="${esc(declarations.join(';'))}"` : '';
}

function drawShape(shape, p, cls = 'dg-shape', style = null) {
  const { x, y, w, h } = p;
  const shapeExtra = styleExtra(style);
  const strokeExtra = styleExtra(style, 'stroke');
  switch (shape) {
    case 'diamond':
      return polygon([[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]], cls, shapeExtra);
    case 'circle':
      return `<ellipse cx="${round(x + w / 2)}" cy="${round(y + h / 2)}" rx="${round(w / 2)}" ry="${round(h / 2)}" class="${cls}" ${shapeExtra}/>`;
    case 'round':
      return rect(x, y, w, h, h / 2, cls, shapeExtra);
    case 'cylinder':
      return rect(x, y, w, h, 10, cls, shapeExtra)
        + path(`M${round(x)} ${round(y + 9)} a${round(w / 2)} 9 0 0 0 ${round(w)} 0`, 'dg-edge', strokeExtra);
    case 'hexagon':
      return polygon([[x + 15, y], [x + w - 15, y], [x + w, y + h / 2],
        [x + w - 15, y + h], [x + 15, y + h], [x, y + h / 2]], cls, shapeExtra);
    case 'parallelogram':
      return polygon([[x + 15, y], [x + w, y], [x + w - 15, y + h], [x, y + h]], cls, shapeExtra);
    case 'flag':
      return polygon([[x, y], [x + w - 14, y], [x + w, y + h / 2], [x + w - 14, y + h], [x, y + h]], cls, shapeExtra);
    case 'subroutine':
      return rect(x, y, w, h, 4, cls, shapeExtra)
        + line(x + 7, y, x + 7, y + h, 'dg-edge', strokeExtra)
        + line(x + w - 7, y, x + w - 7, y + h, 'dg-edge', strokeExtra);
    case 'terminal':
      return `<circle cx="${round(x + w / 2)}" cy="${round(y + h / 2)}" r="${round(Math.min(w, h) / 2)}" class="dg-terminal" ${shapeExtra}/>`;
    default:
      return rect(x, y, w, h, 7, cls, shapeExtra);
  }
}

const LINK = /\s*(-{2,}>|-{3,}|-\.-+>|-\.-+|={2,}>|={3,}|--o|--x|<-->)\s*(?:\|([^|]*)\||"([^"]*)")?\s*/;

function parseNodeToken(tok, isState) {
  const t = tok.trim();
  if (!t) return null;
  if (isState && (t === '[*]' || t === '[ * ]')) return { id: '__start__', label: '', shape: 'terminal' };

  const m = /^([A-Za-z0-9_一-鿿぀-ヿ.·-]+)\s*([\s\S]*)$/.exec(t);
  if (!m) return null;
  const id = m[1];
  const rest = (m[2] || '').trim();
  if (!rest) return { id, label: id, shape: 'rect' };
  for (const [re, shape] of SHAPES) {
    const sm = re.exec(rest);
    if (sm) return { id, label: cleanLabel(sm[1]), shape };
  }
  return { id, label: id, shape: 'rect' };
}

export function parse(src, kind) {
  const isState = kind === 'state';
  const lines = cleanLines(src);
  const header = lines[0] || '';
  let dir = 'TD';

  const dm = /^(?:graph|flowchart)\s+(TD|TB|BT|LR|RL)/i.exec(header);
  if (dm) dir = dm[1].toUpperCase() === 'TB' ? 'TD' : dm[1].toUpperCase();
  const sd = /^\s*direction\s+(TD|TB|BT|LR|RL)/i;

  const nodes = new Map();
  const order = [];
  const edges = [];
  const groups = [];
  const stack = [];
  const nodeOwners = new Map();
  const directStyles = new Map();
  let terminalSeq = 0;

  /* subgraph 既是容器，也可以直接作为连线端点。先收集全部 ID，避免后面的
     `EXT --> P` 被 parseNodeToken 当成一个同名普通方块。 */
  const groupIds = new Set();
  let anonymousGroupSeq = 0;
  for (let i = 1; i < lines.length; i += 1) {
    const sg = /^\s*subgraph\s+(.*)$/i.exec(lines[i]);
    if (!sg) continue;
    const titled = /^([A-Za-z0-9_]+)\s*\[(.*)\]$/.exec(sg[1].trim());
    groupIds.add(titled ? titled[1] : `__group_${anonymousGroupSeq}`);
    anonymousGroupSeq += 1;
  }

  const own = (id) => {
    const group = stack[stack.length - 1];
    const ownerId = group?.id || null;
    nodeOwners.set(id, ownerId);
    if (group) {
      if (!group.nodes.includes(id)) group.nodes.push(id);
      if (!group.members.includes(id)) group.members.push(id);
    }
  };

  const ensure = (def) => {
    if (!def) return null;
    if (def.shape === 'terminal') {
      const id = `__t${terminalSeq++}`;
      const n = { id, label: '', shape: 'terminal', w: 20, h: 20, lines: [] };
      nodes.set(id, n);
      order.push(id);
      own(id);
      return n;
    }
    if (!nodes.has(def.id)) {
      const sz = nodeSize(def.label, def.shape);
      nodes.set(def.id, { id: def.id, label: def.label, shape: def.shape, ...sz });
      order.push(def.id);
      own(def.id);
    } else if (def.label !== def.id) {
      const cur = nodes.get(def.id);
      if (cur.label === def.id) Object.assign(cur, { label: def.label, shape: def.shape }, nodeSize(def.label, def.shape));
    }
    return nodes.get(def.id);
  };

  const endpoint = (tok) => {
    const t = tok.trim();
    if (groupIds.has(t)) return { id: t, isGroup: true };
    return ensure(parseNodeToken(t, isState));
  };

  for (let i = 1; i < lines.length; i += 1) {
    let ln = lines[i].trim().replace(/;$/, '');
    const dd = sd.exec(ln);
    if (dd) {
      const nextDir = dd[1].toUpperCase() === 'TB' ? 'TD' : dd[1].toUpperCase();
      if (stack.length) stack[stack.length - 1].dir = nextDir;
      else dir = nextDir;
      continue;
    }

    const sg = /^subgraph\s+(.*)$/i.exec(ln);
    if (sg) {
      const raw = sg[1].trim();
      const titled = /^([A-Za-z0-9_]+)\s*\[(.*)\]$/.exec(raw);
      const parent = stack[stack.length - 1];
      const group = { id: titled ? titled[1] : `__group_${groups.length}`,
        title: cleanLabel(titled ? titled[2] : raw), nodes: [], groups: [], members: [],
        parentId: parent?.id, dir: null };
      if (parent) {
        parent.groups.push(group.id);
        parent.members.push(group.id);
      }
      groups.push(group); stack.push(group); continue;
    }
    if (/^end$/i.test(ln)) { stack.pop(); continue; }
    const directStyle = /^style\s+([A-Za-z0-9_一-鿿぀-ヿ.·-]+)\s+(.+)$/i.exec(ln);
    if (directStyle) {
      const parsed = parseDirectStyle(directStyle[2]);
      if (Object.keys(parsed).length) {
        directStyles.set(directStyle[1], { ...(directStyles.get(directStyle[1]) || {}), ...parsed });
      }
      continue;
    }
    if (/^(classDef|class|linkStyle|click|note|state\s+\w+\s*\{)/i.test(ln)) continue;

    let tailLabel = '';
    if (isState) {
      const cm = /^(.*?)\s*:\s*(.+)$/.exec(ln);
      if (cm && LINK.test(cm[1])) { ln = cm[1]; tailLabel = cleanLabel(cm[2]); }
    }
    if (!LINK.test(ln)) {
      if (!groupIds.has(ln)) ensure(parseNodeToken(ln, isState));
      continue;
    }

    const parts = [];
    let rest = ln;
    let guard = 0;
    while (rest && guard++ < 200) {
      const m = LINK.exec(rest);
      if (!m) { parts.push({ node: rest }); break; }
      parts.push({ node: rest.slice(0, m.index) });
      parts.push({ link: m[1], label: cleanLabel(m[2] || m[3] || '') });
      rest = rest.slice(m.index + m[0].length);
    }

    let prev = null;
    for (let k = 0; k < parts.length; k += 1) {
      if (parts[k].node == null) continue;
      const n = endpoint(parts[k].node);
      if (!n) { prev = null; continue; }
      const link = parts[k - 1];
      if (prev && link && link.link) {
        edges.push({ id: `e${edges.length}`, from: prev.id, to: n.id, label: link.label || tailLabel,
          dashed: /\./.test(link.link), thick: /=/.test(link.link),
          arrow: />$/.test(link.link) || link.link === '<-->', both: link.link === '<-->' });
      }
      prev = n;
    }
  }

  if (!order.length) throw new Error('没有识别出任何节点');
  groups.forEach((group) => {
    group.nodes = group.nodes.filter((id) => nodeOwners.get(id) === group.id);
    group.members = group.members.filter((id) => groupIds.has(id) || nodeOwners.get(id) === group.id);
  });
  const styles = new Map();
  directStyles.forEach((style, id) => {
    if (groupIds.has(id) || nodes.has(id)) styles.set(id, style);
  });
  return { dir, nodes, order, edges, groups, nodeOwners, styles };
}

function directionOf(dir) {
  return { TD: 'DOWN', BT: 'UP', LR: 'RIGHT', RL: 'LEFT' }[dir] || 'DOWN';
}

function graphHierarchy(g) {
  const groupById = new Map(g.groups.map((group) => [group.id, group]));
  const owner = new Map(g.nodeOwners || []);
  if (!g.nodeOwners) {
    g.groups.forEach((group) => group.nodes.forEach((id) => owner.set(id, group.id)));
  }

  const parentContainer = (id) => groupById.has(id) ? groupById.get(id).parentId : owner.get(id);
  const commonContainer = (a, b) => {
    const ancestors = new Set();
    let cur = parentContainer(a);
    ancestors.add(cur || 'root');
    while (cur) {
      cur = groupById.get(cur)?.parentId;
      ancestors.add(cur || 'root');
    }
    cur = parentContainer(b);
    while (!ancestors.has(cur || 'root')) cur = groupById.get(cur)?.parentId;
    return cur || 'root';
  };
  const groupDirection = (group) => {
    let cur = group;
    while (cur) {
      if (cur.dir) return cur.dir;
      cur = cur.parentId ? groupById.get(cur.parentId) : null;
    }
    return g.dir;
  };
  return { groupById, owner, parentContainer, commonContainer, groupDirection };
}

function layoutOnlyEdges(g, hierarchy) {
  const byContainer = new Map(g.groups.map((group) => [group.id, []]));
  g.edges.filter((edge) => edge.from !== edge.to).forEach((edge) => {
    const container = hierarchy.commonContainer(edge.from, edge.to);
    if (container !== 'root') byContainer.get(container)?.push(edge);
  });

  const edges = [];
  g.groups.forEach((group) => {
    const children = group.members || group.nodes.concat(group.groups || []);
    if (children.length < 2 || byContainer.get(group.id)?.length) return;
    for (let i = 1; i < children.length; i += 1) {
      edges.push({ id: `__layout_${group.id}_${i}`, from: children[i - 1], to: children[i],
        container: group.id, layoutOnly: true });
    }
  });
  return edges;
}

function buildElkGraph(g, kind) {
  const hierarchy = graphHierarchy(g);
  const isState = kind === 'state';
  const edgeBuckets = new Map([['root', []], ...g.groups.map((group) => [group.id, []])]);
  const edgeItem = (edge) => {
    const size = edge.label ? chipSize(edge.label) : null;
    return { id: edge.id, sources: [edge.from], targets: [edge.to],
      labels: size ? [{ id: `${edge.id}-label`, text: edge.label, width: size.w, height: size.h,
        layoutOptions: { 'elk.edgeLabels.placement': 'CENTER' } }] : undefined };
  };

  g.edges.filter((edge) => isState || edge.from !== edge.to).forEach((edge) => {
    edgeBuckets.get(hierarchy.commonContainer(edge.from, edge.to)).push(edgeItem(edge));
  });
  layoutOnlyEdges(g, hierarchy).forEach((edge) => edgeBuckets.get(edge.container).push(edgeItem(edge)));

  const emittedNodes = new Set();
  const nodeOf = (id, container = 'root') => {
    const n = g.nodes.get(id);
    const owner = hierarchy.owner.get(id) || 'root';
    if (!n || owner !== container || emittedNodes.has(id)) return null;
    emittedNodes.add(id);
    return { id, width: n.w, height: n.h };
  };
  const groupOf = (group) => ({
    id: group.id,
    children: (group.members || group.nodes.concat(group.groups || [])).map((id) => {
      const childGroup = hierarchy.groupById.get(id);
      return childGroup ? groupOf(childGroup) : nodeOf(id, group.id);
    }).filter(Boolean),
    edges: edgeBuckets.get(group.id),
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': directionOf(hierarchy.groupDirection(group)),
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.padding': '[top=42,left=20,bottom=20,right=20]',
      'elk.spacing.nodeNode': '34',
      'elk.layered.spacing.nodeNodeBetweenLayers': '58',
      'elk.layered.cycleBreaking.strategy': 'GREEDY_MODEL_ORDER',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
    },
  });

  const rootGroups = g.groups.filter((group) => !group.parentId).map(groupOf);
  const loose = g.order.filter((id) => !hierarchy.owner.get(id)).map((id) => nodeOf(id, 'root')).filter(Boolean);
  const layoutOptions = {
    'elk.algorithm': 'layered',
    'elk.direction': directionOf(g.dir),
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.spacing.nodeNode': isState ? '54' : '42',
    'elk.layered.spacing.nodeNodeBetweenLayers': isState ? '104' : '72',
    'elk.spacing.edgeNode': isState ? '34' : '24',
    'elk.spacing.edgeEdge': isState ? '22' : '14',
    'elk.spacing.edgeLabel': isState ? '16' : '10',
    'elk.spacing.nodeSelfLoop': isState ? '34' : '18',
    'elk.layered.spacing.edgeNodeBetweenLayers': isState ? '32' : '24',
    'elk.layered.spacing.edgeEdgeBetweenLayers': isState ? '22' : '14',
    'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
    'elk.layered.cycleBreaking.strategy': 'GREEDY_MODEL_ORDER',
    'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    'elk.layered.compaction.postCompaction.strategy': 'EDGE_LENGTH',
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.layered.mergeEdges': 'false',
    'elk.padding': isState ? '[top=28,left=36,bottom=28,right=36]' : '[top=18,left=18,bottom=18,right=18]',
  };
  if (isState) {
    Object.assign(layoutOptions, {
      'elk.layered.cycleBreaking.strategy': 'GREEDY_MODEL_ORDER',
      'elk.layered.edgeRouting.selfLoopDistribution': 'NORTH_SOUTH',
      'elk.layered.edgeRouting.selfLoopOrdering': 'SEQUENCED',
      'elk.layered.edgeLabels.centerLabelPlacementStrategy': 'SPACE_EFFICIENT_LAYER',
      'elk.layered.edgeLabels.sideSelection': 'SMART_DOWN',
    });
  }
  return {
    id: 'root',
    children: rootGroups.concat(loose),
    edges: edgeBuckets.get('root'),
    layoutOptions,
  };
}

function collectElk(node, ox, oy, pos, frames, routes, labels) {
  const x = ox + (node.x || 0);
  const y = oy + (node.y || 0);
  if (node.id && node.id !== 'root' && node.children) {
    frames.push({ id: node.id, x0: x, y0: y, x1: x + (node.width || 0), y1: y + (node.height || 0) });
  }
  if (node.children) node.children.forEach((child) => collectElk(child, x, y, pos, frames, routes, labels));
  else if (node.id) pos.set(node.id, { x, y, w: node.width || 0, h: node.height || 0 });

  (node.edges || []).forEach((edge) => {
    const sections = (edge.sections || []).map((section) =>
      [section.startPoint].concat(section.bendPoints || [], [section.endPoint]).filter(Boolean)
        .map((p) => ({ x: x + p.x, y: y + p.y })))
      .filter((points) => points.length > 1);
    routes.set(edge.id, sections);
    const label = edge.labels && edge.labels[0];
    if (label && Number.isFinite(label.x) && Number.isFinite(label.y)) {
      labels.set(edge.id, { x: x + label.x + (label.width || 0) / 2,
        y: y + label.y + (label.height || 0) / 2, w: label.width || 0, h: label.height || 0 });
    }
  });
}

function orthogonalPath(points, radius = 7) {
  if (!points || points.length < 2) return '';
  const clean = points.filter((p, i) => !i || p.x !== points[i - 1].x || p.y !== points[i - 1].y);
  if (clean.length < 2) return '';
  let d = `M${round(clean[0].x)} ${round(clean[0].y)}`;
  for (let i = 1; i < clean.length; i += 1) {
    const cur = clean[i];
    if (i === clean.length - 1) { d += ` L${round(cur.x)} ${round(cur.y)}`; continue; }
    const prev = clean[i - 1];
    const next = clean[i + 1];
    const a = Math.min(radius, Math.hypot(cur.x - prev.x, cur.y - prev.y) / 2,
      Math.hypot(next.x - cur.x, next.y - cur.y) / 2);
    const p1 = { x: cur.x - Math.sign(cur.x - prev.x) * a, y: cur.y - Math.sign(cur.y - prev.y) * a };
    const p2 = { x: cur.x + Math.sign(next.x - cur.x) * a, y: cur.y + Math.sign(next.y - cur.y) * a };
    d += ` L${round(p1.x)} ${round(p1.y)} Q${round(cur.x)} ${round(cur.y)} ${round(p2.x)} ${round(p2.y)}`;
  }
  return d;
}

function routeSections(route) {
  if (!route?.length) return [];
  return Array.isArray(route[0]) ? route : [route];
}

function midpointOf(points) {
  if (!points || points.length < 2) return { x: 0, y: 0 };
  const lengths = [];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const n = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    lengths.push(n); total += n;
  }
  let want = total / 2;
  for (let i = 0; i < lengths.length; i += 1) {
    if (want <= lengths[i]) {
      const t = lengths[i] ? want / lengths[i] : 0;
      return { x: points[i].x + (points[i + 1].x - points[i].x) * t,
        y: points[i].y + (points[i + 1].y - points[i].y) * t };
    }
    want -= lengths[i];
  }
  return points[points.length - 1];
}

function endpointBox(L, id) {
  const node = L.pos.get(id);
  if (node) return node;
  const frame = (L.frames || []).find((item) => item.id === id);
  return frame ? { x: frame.x0, y: frame.y0, w: frame.x1 - frame.x0, h: frame.y1 - frame.y0 } : null;
}

function renderLaidOut(g, L, kind) {
  const placedLabels = [];
  const labelPos = new Map();
  let padLeft = 0; let padTop = 0; let padRight = 0; let padBottom = 0;
  for (const e of g.edges) {
    if (!e.label) continue;
    const size = chipSize(e.label);
    const route = L.routes && L.routes.get(e.id);
    const sections = routeSections(route);
    const points = sections.flat();
    const a = endpointBox(L, e.from); const b = endpointBox(L, e.to);
    const elkPlaced = L.labels && L.labels.has(e.id);
    let preferred = elkPlaced ? L.labels.get(e.id) : null;
    if (!preferred && points.length > 1) preferred = midpointOf(points);
    if (!preferred && a && b) {
      if (e.from === e.to) preferred = { x: a.x + a.w + 30, y: a.y + a.h * 0.3 + 6 };
      else {
        const horizontal = g.dir === 'LR' || g.dir === 'RL';
        const pt = anchors(a, b, !horizontal);
        const cv = curveD(pt.x1, pt.y1, pt.x2, pt.y2, horizontal);
        preferred = { x: cv.mx, y: cv.my };
      }
    }
    if (!preferred) preferred = { x: L.width / 2, y: L.height / 2 };
    let cx = preferred.x; let cy = preferred.y;
    const overlaps = (x, y) => placedLabels.some((p) => Math.abs(p.x - x) < (p.w + size.w) / 2 + 8
      && Math.abs(p.y - y) < (p.h + size.h) / 2 + 6);
    if (!elkPlaced && overlaps(cx, cy)) {
      const vertical = points.length > 1
        ? Math.abs(points[points.length - 1].y - points[0].y) >= Math.abs(points[points.length - 1].x - points[0].x)
        : true;
      for (let step = 1; step <= 8; step += 1) {
        const delta = step * (vertical ? size.w + 12 : size.h + 10);
        const tries = vertical ? [[cx - delta, cy], [cx + delta, cy]] : [[cx, cy - delta], [cx, cy + delta]];
        const free = tries.find((p) => !overlaps(p[0], p[1]));
        if (free) { cx = free[0]; cy = free[1]; break; }
      }
    }
    placedLabels.push({ x: cx, y: cy, w: size.w, h: size.h });
    labelPos.set(e.id, { x: cx, y: cy });
    padLeft = Math.max(padLeft, size.w / 2 - cx + 12);
    padTop = Math.max(padTop, size.h / 2 - cy + 12);
    padRight = Math.max(padRight, cx + size.w / 2 - L.width + 12);
    padBottom = Math.max(padBottom, cy + size.h / 2 - L.height + 12);
  }
  padLeft = Math.max(0, Math.ceil(padLeft)); padTop = Math.max(0, Math.ceil(padTop));
  padRight = Math.max(0, Math.ceil(padRight)); padBottom = Math.max(0, Math.ceil(padBottom));
  if (padLeft || padTop) {
    L.pos.forEach((p) => { p.x += padLeft; p.y += padTop; });
    (L.frames || []).forEach((f) => { f.x0 += padLeft; f.x1 += padLeft; f.y0 += padTop; f.y1 += padTop; });
    if (L.routes) L.routes.forEach((route) => routeSections(route).forEach((points) =>
      points.forEach((p) => { p.x += padLeft; p.y += padTop; })));
    labelPos.forEach((p) => { p.x += padLeft; p.y += padTop; });
  }
  const id = uid('fc');
  const out = [svgOpen(L.width + padLeft + padRight, L.height + padTop + padBottom,
    kind === 'state' ? 'dg-state' : 'dg-flow'), inlineStyle(), arrowDefs(id)];
  const groupById = new Map(g.groups.map((group) => [group.id, group]));

  for (const f of L.frames || []) {
    const group = groupById.get(f.id);
    const authored = g.styles?.get(f.id);
    out.push(rect(f.x0, f.y0, f.x1 - f.x0, f.y1 - f.y0, 10, 'dg-group', styleExtra(authored)));
    out.push(`<text x="${round(f.x0 + 14)}" y="${round(f.y0 + 22)}" class="dg-group-title" text-anchor="start" ${styleExtra(authored, 'text')}>${esc(group ? group.title : '')}</text>`);
  }

  const chips = [];
  for (const e of g.edges) {
    const a = endpointBox(L, e.from); const b = endpointBox(L, e.to);
    if (!a || !b) continue;
    let cls = 'dg-edge'; if (e.dashed) cls += ' dashed'; if (e.thick) cls += ' thick';
    const marker = e.arrow ? ` marker-end="url(#${id}-arrow)"` : '';
    const sections = routeSections(L.routes && L.routes.get(e.id));
    if (sections.length) {
      sections.forEach((points, index) => {
        const isFirst = index === 0;
        const isLast = index === sections.length - 1;
        const markers = (isLast ? marker : '')
          + (isFirst && e.both ? ` marker-start="url(#${id}-arrow)"` : '');
        out.push(path(orthogonalPath(points), cls, markers));
      });
      if (e.label) {
        const m = labelPos.get(e.id) || midpointOf(sections.flat());
        chips.push(chip(m.x, m.y, e.label));
      }
    } else if (e.from === e.to) {
      out.push(path(selfLoop(a), cls, marker));
      if (e.label) { const m = labelPos.get(e.id) || { x: a.x + a.w + 30, y: a.y + a.h * 0.3 + 6 }; chips.push(chip(m.x, m.y, e.label)); }
    } else {
      const horizontal = g.dir === 'LR' || g.dir === 'RL';
      const pt = anchors(a, b, !horizontal); const cv = curveD(pt.x1, pt.y1, pt.x2, pt.y2, horizontal);
      out.push(path(cv.d, cls, marker + (e.both ? ` marker-start="url(#${id}-arrow)"` : '')));
      if (e.label) { const m = labelPos.get(e.id) || cv; chips.push(chip(m.x ?? m.mx, m.y ?? m.my, e.label)); }
    }
  }
  out.push(...chips);

  for (const nid of g.order) {
    const p = L.pos.get(nid); const n = g.nodes.get(nid);
    if (!p || !n) continue;
    const authored = g.styles?.get(nid);
    out.push(drawShape(n.shape, p, 'dg-shape', authored));
    if (n.lines?.length && n.shape !== 'terminal') {
      out.push(textBlock(p.x + p.w / 2, p.y + p.h / 2, n.lines, 'dg-text', 18,
        styleExtra(authored, 'text')));
    }
  }
  out.push('</svg>');
  return out.join('');
}

function fallbackLayout(g) {
  const hierarchy = graphHierarchy(g);
  const leavesOf = (id) => {
    const group = hierarchy.groupById.get(id);
    if (!group) return g.nodes.has(id) ? [id] : [];
    return (group.members || group.nodes.concat(group.groups || [])).flatMap(leavesOf);
  };
  const mapEndpoint = (id, source) => {
    if (!hierarchy.groupById.has(id)) return id;
    const leaves = leavesOf(id);
    return leaves[source ? leaves.length - 1 : 0];
  };
  const mappedEdges = g.edges.map((edge) => ({ ...edge,
    from: mapEndpoint(edge.from, true), to: mapEndpoint(edge.to, false) }))
    .filter((edge) => edge.from && edge.to);
  layoutOnlyEdges(g, hierarchy).forEach((edge) => mappedEdges.push({ ...edge,
    from: mapEndpoint(edge.from, true), to: mapEndpoint(edge.to, false) }));

  const useTree = !g.groups.length && isTree(g.order, mappedEdges);
  const L = useTree ? tree(g.nodes, g.order, mappedEdges, { dir: g.dir })
    : layered(g.nodes, g.order, mappedEdges, { dir: g.dir });
  const frames = [];
  for (const group of g.groups) {
    const ps = leavesOf(group.id).map((n) => L.pos.get(n)).filter(Boolean);
    if (!ps.length) continue;
    frames.push({ id: group.id, x0: Math.min(...ps.map((p) => p.x)) - 14,
      y0: Math.min(...ps.map((p) => p.y)) - 30,
      x1: Math.max(...ps.map((p) => p.x + p.w)) + 14,
      y1: Math.max(...ps.map((p) => p.y + p.h)) + 14 });
  }
  const shiftX = Math.max(0, ...frames.map((f) => -f.x0));
  const shiftY = Math.max(0, ...frames.map((f) => -f.y0));
  if (shiftX || shiftY) {
    L.pos.forEach((p) => { p.x += shiftX; p.y += shiftY; });
    frames.forEach((f) => { f.x0 += shiftX; f.x1 += shiftX; f.y0 += shiftY; f.y1 += shiftY; });
  }
  return { ...L, frames, width: Math.max(L.width + shiftX, ...frames.map((f) => f.x1 + 14)),
    height: Math.max(L.height + shiftY, ...frames.map((f) => f.y1 + 14)) };
}

function renderWithElk(g, kind) {
  if (typeof window === 'undefined' || typeof window.ELK !== 'function') return Promise.resolve(renderLaidOut(g, fallbackLayout(g), kind));
  const elk = new window.ELK();
  return elk.layout(buildElkGraph(g, kind), { layoutOptions: { 'elk.algorithm': 'layered' } }).then((result) => {
    const pos = new Map(); const frames = []; const routes = new Map(); const labels = new Map();
    collectElk(result, 0, 0, pos, frames, routes, labels);
    return renderLaidOut(g, { pos, frames, routes, labels,
      width: result.width || 1, height: result.height || 1 }, kind);
  }).catch(() => renderLaidOut(g, fallbackLayout(g), kind));
}

export function render(src, kind = 'flow') {
  const g = parse(src, kind);
  if (kind === 'flow' && !g.groups.length && isTree(g.order, g.edges)) {
    return renderLaidOut(g, fallbackLayout(g), kind);
  }
  return renderWithElk(g, kind);
}
