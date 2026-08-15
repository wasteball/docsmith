/* =====================================================================
 * Docsmith · 流程图 / 状态图
 * ---------------------------------------------------------------------
 * 解析与 SVG 绘制留在本文件。复杂流程图优先交给 ELK Layered：它会把子图
 * 当作复合节点，并完成分层、交叉最小化、端口排序和正交边路由。ELK 不可用
 * 或布局失败时，仍回退到本地轻量布局器，保证离线打开不会丢图。
 * ===================================================================== */
import {
  wrap, wrapToWidth, textWidth, esc, cleanLabel, cleanLines, plainLabel,
  svgOpen, arrowDefs, textBlock, rect, line, path, polygon, chip, chipSize, uid, round, curveD, userClass,
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
  [/^\(\[(.*)\]\)$/s, 'round'],
  [/^\((.*)\)$/s, 'round'],
  [/^>(.*)\]$/s, 'flag'],
];

function nodeSize(label, shape) {
  const lines = wrapToWidth(label, shape === 'diamond' ? 250 : 260, 13);
  const textW = lines.reduce((a, l) => Math.max(a, textWidth(plainLabel(l)) * 1.08), 0);
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

function drawShape(shape, p, cls = 'dg-shape', style = null, extra = '') {
  const { x, y, w, h } = p;
  const shapeExtra = `${styleExtra(style)} ${extra}`.trim();
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

function splitNodeClasses(raw) {
  const classes = [];
  let body = String(raw ?? '').trim();
  /* `A[文字]:::entry:::wide` 是 Mermaid 的节点级 class 简写。必须先剥掉，
     否则整个 `[文字]:::entry` 都匹配不到 SHAPES，节点就只剩一个 A。 */
  let match;
  while ((match = /\s*:::\s*([A-Za-z0-9_-]+)\s*$/.exec(body))) {
    classes.unshift(match[1]);
    body = body.slice(0, match.index).trim();
  }
  return { body, classes };
}

function parseNodeToken(tok, isState) {
  const split = splitNodeClasses(tok);
  const t = split.body;
  if (!t) return null;
  if (isState && (t === '[*]' || t === '[ * ]')) {
    return { id: '__start__', label: '', shape: 'terminal', classes: split.classes };
  }

  const m = /^([A-Za-z0-9_一-鿿぀-ヿ.·-]+)\s*([\s\S]*)$/.exec(t);
  if (!m) return null;
  const id = m[1];
  const rest = (m[2] || '').trim();
  if (!rest) return { id, label: id, shape: 'rect', classes: split.classes };
  for (const [re, shape] of SHAPES) {
    const sm = re.exec(rest);
    if (sm) return { id, label: cleanLabel(sm[1]), shape, classes: split.classes };
  }
  return { id, label: id, shape: 'rect', classes: split.classes };
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
  const classDefs = new Map();
  const classAssignments = new Map();
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

  const assignClasses = (id, names) => {
    if (!names?.length) return;
    const current = classAssignments.get(id) || [];
    names.forEach((name) => { if (name && !current.includes(name)) current.push(name); });
    classAssignments.set(id, current);
  };

  const ensure = (def) => {
    if (!def) return null;
    if (def.shape === 'terminal') {
      const id = `__t${terminalSeq++}`;
      const n = { id, label: '', shape: 'terminal', w: 20, h: 20, lines: [] };
      nodes.set(id, n);
      order.push(id);
      assignClasses(id, def.classes);
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
    assignClasses(def.id, def.classes);
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
    const classDef = /^classDef\s+([A-Za-z0-9_-]+)\s+(.+)$/i.exec(ln);
    if (classDef) {
      const parsed = parseDirectStyle(classDef[2]);
      if (Object.keys(parsed).length) classDefs.set(classDef[1], parsed);
      continue;
    }
    const classLine = /^class\s+([^\s]+)\s+(.+)$/i.exec(ln);
    if (classLine) {
      const names = classLine[2].split(',').map((name) => name.trim()).filter(Boolean);
      classLine[1].split(',').map((id) => id.trim()).filter(Boolean)
        .forEach((id) => assignClasses(id, names));
      continue;
    }
    if (/^(linkStyle|click|note|state\s+\w+\s*\{)/i.test(ln)) continue;

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
  const classes = new Map();
  classAssignments.forEach((names, id) => {
    if (!groupIds.has(id) && !nodes.has(id)) return;
    classes.set(id, names.slice());
    const inherited = names.reduce((all, name) => ({ ...all, ...(classDefs.get(name) || {}) }), {});
    if (Object.keys(inherited).length) styles.set(id, inherited);
  });
  directStyles.forEach((style, id) => {
    if (groupIds.has(id) || nodes.has(id)) styles.set(id, { ...(styles.get(id) || {}), ...style });
  });
  return { dir, nodes, order, edges, groups, nodeOwners, styles, classes, classDefs };
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

  /* 自环交给绘制层绕节点排布。让 ELK 参与自环路由会把每一层都撑高，
     一个状态图里只要有几个异常分支，主流程就会被拉成几屏高。 */
  g.edges.filter((edge) => edge.from !== edge.to).forEach((edge) => {
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
    },
  });

  const rootGroups = g.groups.filter((group) => !group.parentId).map(groupOf);
  const loose = g.order.filter((id) => !hierarchy.owner.get(id)).map((id) => nodeOf(id, 'root')).filter(Boolean);
  const largeCompound = rootGroups.length >= 4 && g.order.length >= 18;
  const layoutOptions = {
    'elk.algorithm': 'layered',
    'elk.direction': directionOf(largeCompound && g.dir === 'TD' ? 'LR' : g.dir),
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.spacing.nodeNode': isState ? '46' : (largeCompound ? '64' : '42'),
    'elk.spacing.componentComponent': largeCompound ? '86' : '48',
    'elk.layered.spacing.nodeNodeBetweenLayers': isState ? '48' : (largeCompound ? '92' : '72'),
    'elk.spacing.edgeNode': isState ? '28' : '24',
    'elk.spacing.edgeEdge': isState ? '18' : '14',
    'elk.spacing.edgeLabel': isState ? '12' : '10',
    'elk.spacing.nodeSelfLoop': isState ? '24' : '18',
    'elk.layered.spacing.edgeNodeBetweenLayers': isState ? '24' : '24',
    'elk.layered.spacing.edgeEdgeBetweenLayers': isState ? '18' : '14',
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

function collectElk(node, ox, oy, pos, frames, routes, labels, parentId = 'root') {
  const x = ox + (node.x || 0);
  const y = oy + (node.y || 0);
  if (node.id && node.id !== 'root' && node.children) {
    frames.push({ id: node.id, parentId, x0: x, y0: y,
      x1: x + (node.width || 0), y1: y + (node.height || 0) });
  }
  const childParent = node.id && node.id !== 'root' && node.children ? node.id : parentId;
  if (node.children) {
    node.children.forEach((child) => collectElk(child, x, y, pos, frames, routes, labels, childParent));
  } else if (node.id) pos.set(node.id, { x, y, w: node.width || 0, h: node.height || 0 });

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

function stateSelfLoopGeometry(p, index = 0) {
  const side = index % 2 ? -1 : 1;
  const spread = 34 + Math.floor(index / 2) * 22;
  const x = side > 0 ? p.x + p.w : p.x;
  const y1 = p.y + p.h * 0.28;
  const y2 = p.y + p.h * 0.72;
  const outer = x + side * spread;
  return {
    d: `M${round(x)} ${round(y1)} C${round(outer)} ${round(y1 - 10)}, ${round(outer)} ${round(y2 + 10)}, ${round(x)} ${round(y2)}`,
    label: { x: outer + side * 10, y: p.y + p.h / 2 },
  };
}

function authoredClasses(g, id) {
  return (g.classes?.get(id) || []).map(userClass).filter(Boolean).join(' ');
}

function boxesOverlap(a, b, gap = 0) {
  return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x
    && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
}

function labelObstacleBoxes(L, edge) {
  const boxes = [];
  L.pos.forEach((p) => {
    /* 边标签也不能覆盖自己的起止节点。ELK 对自环和回退边给出的建议位置
       有时贴着节点中心，若把端点排除，碰撞检查就看不见最明显的遮挡。 */
    boxes.push({ x: p.x, y: p.y, w: p.w, h: p.h });
  });
  (L.frames || []).forEach((frame) => {
    /* 子图标题占据容器顶边。标签不能压在标题上；框体其余部分是可用画布，
       不能把整块 frame 都当障碍，否则容器里的边永远找不到落点。 */
    boxes.push({ x: frame.x0 + 8, y: frame.y0 + 6,
      w: Math.max(0, frame.x1 - frame.x0 - 16), h: 24 });
  });
  return boxes;
}

function candidateLabelPoints(preferred, points, size) {
  const out = [preferred];
  if (points.length > 1) {
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1]; const b = points[i];
      const dx = b.x - a.x; const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < Math.min(size.w, size.h) + 12) continue;
      out.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      const horizontal = Math.abs(dx) >= Math.abs(dy);
      const offset = horizontal ? size.h / 2 + 8 : size.w / 2 + 8;
      if (horizontal) {
        out.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - offset });
        out.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + offset });
      } else {
        out.push({ x: (a.x + b.x) / 2 - offset, y: (a.y + b.y) / 2 });
        out.push({ x: (a.x + b.x) / 2 + offset, y: (a.y + b.y) / 2 });
      }
    }
  }
  return out;
}

function renderLaidOut(g, L, kind) {
  const placedLabels = [];
  const labelPos = new Map();
  const selfLoopIndex = new Map();
  const loopsPerNode = new Map();
  g.edges.forEach((edge) => {
    if (edge.from !== edge.to) return;
    const index = loopsPerNode.get(edge.from) || 0;
    selfLoopIndex.set(edge.id, index);
    loopsPerNode.set(edge.from, index + 1);
  });
  let padLeft = 0; let padTop = 0; let padRight = 0; let padBottom = 0;
  for (const e of g.edges) {
    if (!e.label) continue;
    const size = chipSize(e.label);
    const route = L.routes && L.routes.get(e.id);
    const sections = routeSections(route);
    const points = sections.flat();
    const a = endpointBox(L, e.from); const b = endpointBox(L, e.to);
    const elkPlaced = L.labels && L.labels.has(e.id);
    /* 状态图的主流程边默认把说明放到线的左侧：主轴保持干净，读者可以从上
       到下先扫状态，再按需读取推进条件。回退边与自环仍保留 ELK/自环位置。 */
    let preferred = null;
    if (kind === 'state' && e.from !== e.to && points.length > 1) {
      const start = points[0]; const end = points[points.length - 1];
      const nearMainAxis = Math.abs(end.x - start.x) < Math.max(28, size.w * 0.35)
        && end.y > start.y;
      if (nearMainAxis) {
        const middle = midpointOf(points);
        preferred = { x: Math.min(start.x, end.x) - size.w / 2 - 18, y: middle.y };
      }
    }
    if (!preferred && elkPlaced) preferred = L.labels.get(e.id);
    if (!preferred && points.length > 1) preferred = midpointOf(points);
    if (!preferred && a && b) {
      if (e.from === e.to) preferred = stateSelfLoopGeometry(a, selfLoopIndex.get(e.id) || 0).label;
      else {
        const horizontal = g.dir === 'LR' || g.dir === 'RL';
        const pt = anchors(a, b, !horizontal);
        const cv = curveD(pt.x1, pt.y1, pt.x2, pt.y2, horizontal);
        preferred = { x: cv.mx, y: cv.my };
      }
    }
    /* 没有 ELK 路由的简单图由本地布局器负责。其边标签应像 Mermaid 一样位于
       两个 rank 之间，而不是严格压在曲线上；斜线尤其要把标签放到节点间隙。 */
    if (!elkPlaced && e.from !== e.to && a && b) {
      const horizontal = g.dir === 'LR' || g.dir === 'RL';
      preferred = horizontal
        ? { x: (a.x + a.w + b.x) / 2, y: (a.y + a.h / 2 + b.y + b.h / 2) / 2 }
        : { x: (a.x + a.w / 2 + b.x + b.w / 2) / 2, y: (a.y + a.h + b.y) / 2 };
    }
    if (!preferred) preferred = { x: L.width / 2, y: L.height / 2 };
    let cx = preferred.x; let cy = preferred.y;
    const obstacles = labelObstacleBoxes(L, e);
    const occupied = (x, y) => {
      const box = { x: x - size.w / 2, y: y - size.h / 2, w: size.w, h: size.h };
      return placedLabels.some((placed) => boxesOverlap(box,
        { x: placed.x - placed.w / 2, y: placed.y - placed.h / 2, w: placed.w, h: placed.h }, 8))
        || obstacles.some((obstacle) => boxesOverlap(box, obstacle, 6));
    };
    /* ELK 的标签位置只是建议。复杂图里它偶尔会把 chip 放到节点或子图标题上，
       所以无论位置来自 ELK 还是本地中点，都统一做一次碰撞检查。优先沿真实路由
       的长线段寻找落点；找不到才在原点附近细步移动，避免标签被甩到图的外侧。 */
    if (occupied(cx, cy)) {
      const candidates = candidateLabelPoints(preferred, points, size);
      const free = candidates.find((candidate) => !occupied(candidate.x, candidate.y));
      if (free) { cx = free.x; cy = free.y; }
      else {
        const vertical = points.length > 1
          ? Math.abs(points[points.length - 1].y - points[0].y) >= Math.abs(points[points.length - 1].x - points[0].x)
          : true;
        const stepSize = 10;
        for (let step = 1; step <= 18; step += 1) {
          const delta = step * stepSize;
          const tries = vertical ? [[cx - delta, cy], [cx + delta, cy]] : [[cx, cy - delta], [cx, cy + delta]];
          const shifted = tries.find((point) => !occupied(point[0], point[1]));
          if (shifted) { cx = shifted[0]; cy = shifted[1]; break; }
        }
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
  const engine = L.engine || 'local';
  const quality = L.quality || {};
  const qualityAttrs = Object.entries(quality).filter(([, value]) => Number.isFinite(value))
    .map(([key, value]) => ` data-routing-${esc(key)}="${round(value)}"`).join('');
  const svgRoot = svgOpen(L.width + padLeft + padRight, L.height + padTop + padBottom,
    kind === 'state' ? 'dg-state' : 'dg-flow').replace(' role="img"',
    ` data-layout-engine="${esc(engine)}"${qualityAttrs} role="img"`);
  const out = [svgRoot, inlineStyle(), arrowDefs(id)];
  const groupById = new Map(g.groups.map((group) => [group.id, group]));

  for (const f of L.frames || []) {
    const group = groupById.get(f.id);
    const authored = g.styles?.get(f.id);
    const authoredClass = authoredClasses(g, f.id);
    out.push(rect(f.x0, f.y0, f.x1 - f.x0, f.y1 - f.y0, 10,
      `dg-group${authoredClass ? ` ${authoredClass}` : ''}`, styleExtra(authored)));
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
        const edgeData = ` data-edge-id="${esc(e.id)}" data-edge-from="${esc(e.from)}" data-edge-to="${esc(e.to)}"`;
        /* 白色 underlay 在不可避免的交叉处形成清楚断口：这是两条线跨过，不是
           一个连接点。它同时让打印/PDF/PNG 保持可读，不依赖 hover。 */
        out.push(path(orthogonalPath(points), 'dg-edge-casing', edgeData));
        out.push(path(orthogonalPath(points), 'dg-edge-hit', edgeData));
        out.push(path(orthogonalPath(points), cls, markers + edgeData));
      });
      if (e.label) {
        const m = labelPos.get(e.id) || midpointOf(sections.flat());
        chips.push(chip(m.x, m.y, e.label));
      }
    } else if (e.from === e.to) {
      const loop = kind === 'state'
        ? stateSelfLoopGeometry(a, selfLoopIndex.get(e.id) || 0)
        : { d: selfLoop(a), label: { x: a.x + a.w + 30, y: a.y + a.h * 0.3 + 6 } };
      out.push(path(loop.d, cls, marker));
      if (e.label) { const m = labelPos.get(e.id) || loop.label; chips.push(chip(m.x, m.y, e.label)); }
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
    const authoredClass = authoredClasses(g, nid);
    out.push(drawShape(n.shape, p, `dg-shape${authoredClass ? ` ${authoredClass}` : ''}`, authored,
      `data-node-id="${esc(nid)}" tabindex="0"`));
    if (n.lines?.length && n.shape !== 'terminal') {
      out.push(textBlock(p.x + p.w / 2, p.y + p.h / 2, n.lines, 'dg-text', 18,
        styleExtra(authored, 'text')));
    }
  }
  out.push('</svg>');
  return out.join('');
}

function permutations(items) {
  if (items.length > 7) return [items.slice()];
  const out = [];
  const visit = (prefix, rest) => {
    if (!rest.length) { out.push(prefix); return; }
    rest.forEach((item, index) => visit(prefix.concat(item), rest.slice(0, index).concat(rest.slice(index + 1))));
  };
  visit([], items.slice());
  return out;
}

/* 根级复合图按“入口 → 核心处理带 → 下游”排成二维架构图。先收缩 SCC，
   但 SCC 内的分组沿横向展开，而不是塞进一列：闭环仍然清楚，整图也不会被
   拉成 3500px 长链。每个 band 的顺序再按真实跨组边做确定性优化。 */
function layoutCompoundRoot(nodes, order, edges, dir = 'TD') {
  const sourceIndex = new Map(order.map((id, i) => [id, i]));
  const outgoing = new Map(order.map((id) => [id, []]));
  edges.forEach((edge) => outgoing.get(edge.from)?.push(edge.to));
  let seq = 0; const index = new Map(); const low = new Map(); const stack = []; const active = new Set(); const components = [];
  const visit = (id) => {
    index.set(id, seq); low.set(id, seq); seq += 1; stack.push(id); active.add(id);
    (outgoing.get(id) || []).forEach((to) => {
      if (!index.has(to)) { visit(to); low.set(id, Math.min(low.get(id), low.get(to))); }
      else if (active.has(to)) low.set(id, Math.min(low.get(id), index.get(to)));
    });
    if (low.get(id) !== index.get(id)) return;
    const component = []; let item;
    do { item = stack.pop(); active.delete(item); component.push(item); } while (item !== id);
    component.sort((a, b) => sourceIndex.get(a) - sourceIndex.get(b));
    components.push(component);
  };
  order.forEach((id) => { if (!index.has(id)) visit(id); });

  const componentOf = new Map();
  components.forEach((component, i) => component.forEach((id) => componentOf.set(id, i)));
  /* SCC 里挑一条“主阅读链”。用户源码顺序只负责同分时稳定；真正的顺序由
     内部边决定。三组闭环会得到 业务→通信→对话，唯一回边是 对话→业务。 */
  components.forEach((component, componentIndex) => {
    if (component.length < 2 || component.length > 7) return;
    const internal = edges.filter((edge) => componentOf.get(edge.from) === componentIndex
      && componentOf.get(edge.to) === componentIndex);
    const chainScore = (candidate) => {
      const at = new Map(candidate.map((id, i) => [id, i])); let value = 0;
      internal.forEach((edge) => {
        const from = at.get(edge.from); const to = at.get(edge.to); const weight = edge.weight || 1;
        value += Math.abs(to - from) * weight;
        if (to <= from) value += 10000 * weight;
      });
      return value;
    };
    components[componentIndex] = permutations(component).reduce((best, candidate) =>
      chainScore(candidate) < chainScore(best) ? candidate : best, component);
  });
  const dag = new Map(components.map((_, i) => [i, new Set()]));
  const indeg = components.map(() => 0); const rank = components.map(() => 0);
  const componentSpan = components.map((component) => component.length >= 3 ? 2 : 1);
  edges.forEach((edge) => {
    const a = componentOf.get(edge.from); const b = componentOf.get(edge.to);
    if (a === b || dag.get(a).has(b)) return;
    dag.get(a).add(b); indeg[b] += 1;
  });
  const componentOrder = (i) => Math.min(...components[i].map((id) => sourceIndex.get(id)));
  const queue = components.map((_, i) => i).filter((i) => !indeg[i])
    .sort((a, b) => componentOrder(a) - componentOrder(b));
  while (queue.length) {
    const current = queue.shift();
    dag.get(current).forEach((to) => {
      rank[to] = Math.max(rank[to], rank[current] + componentSpan[current]); indeg[to] -= 1;
      if (!indeg[to]) { queue.push(to); queue.sort((a, b) => componentOrder(a) - componentOrder(b)); }
    });
  }

  const bands = [];
  components.forEach((component, i) => {
    const r = rank[i];
    if (component.length >= 3) {
      const split = Math.ceil(component.length / 2);
      if (!bands[r]) bands[r] = []; bands[r].push(...component.slice(0, split));
      if (!bands[r + 1]) bands[r + 1] = []; bands[r + 1].push(...component.slice(split));
    } else {
      if (!bands[r]) bands[r] = []; bands[r].push(...component);
    }
  });
  for (let i = bands.length - 1; i >= 0; i -= 1) if (!bands[i]?.length) bands.splice(i, 1);
  const vertical = dir === 'TD' || dir === 'BT';
  const GAP_CROSS = 150; const GAP_DEPTH = 154; const PAD = 46;
  const place = () => {
    const crossSizes = bands.map((band) => band.reduce((sum, id) =>
      sum + (vertical ? nodes.get(id).w : nodes.get(id).h), 0) + GAP_CROSS * Math.max(0, band.length - 1));
    const depthSizes = bands.map((band) => Math.max(...band.map((id) => vertical ? nodes.get(id).h : nodes.get(id).w)));
    const maxCross = Math.max(...crossSizes); const pos = new Map(); let depth = PAD;
    bands.forEach((band, bandIndex) => {
      let cross = PAD + (maxCross - crossSizes[bandIndex]) / 2;
      band.forEach((id) => {
        const node = nodes.get(id); const depthOffset = (depthSizes[bandIndex] - (vertical ? node.h : node.w)) / 2;
        pos.set(id, vertical
          ? { x: cross, y: depth + depthOffset, w: node.w, h: node.h }
          : { x: depth + depthOffset, y: cross, w: node.w, h: node.h });
        cross += (vertical ? node.w : node.h) + GAP_CROSS;
      });
      depth += depthSizes[bandIndex] + GAP_DEPTH;
    });
    const crossExtent = maxCross + PAD * 2; const depthExtent = depth - GAP_DEPTH + PAD;
    return { pos, width: vertical ? crossExtent : depthExtent, height: vertical ? depthExtent : crossExtent };
  };
  const bandOf = new Map();
  bands.forEach((band, bandIndex) => band.forEach((id) => bandOf.set(id, bandIndex)));
  const properCross = (a, b, c, d) => {
    const orient = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    return orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0;
  };
  const score = () => {
    const layout = place(); let value = 0; const segments = [];
    edges.forEach((edge) => {
      const a = layout.pos.get(edge.from); const b = layout.pos.get(edge.to); if (!a || !b) return;
      const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }; const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      const weight = edge.weight || 1; const sameBand = bandOf.get(edge.from) === bandOf.get(edge.to);
      /* SCC 内只有少量边不可避免地逆行。让同 band 的主链沿阅读方向展开，
         比把所有成员按距离围成一团更重要；这样“业务→通信→对话”只留下
         “对话→业务”一条清楚的回边。 */
      const forward = sameBand
        ? (vertical ? bc.x - ac.x : bc.y - ac.y)
        : (vertical ? bc.y - ac.y : bc.x - ac.x);
      value += (Math.abs(bc.x - ac.x) + Math.abs(bc.y - ac.y)) * weight;
      if (forward < -1) value += (sameBand ? 5200 : 900) * weight;
      if (Math.abs(bc.x - ac.x) > 1 && Math.abs(bc.y - ac.y) > 1) value += 90 * weight;
      segments.push({ a: ac, b: bc, edge, weight });
    });
    for (let i = 0; i < segments.length; i += 1) for (let j = i + 1; j < segments.length; j += 1) {
      const a = segments[i]; const b = segments[j];
      if (a.edge.from === b.edge.from || a.edge.from === b.edge.to
        || a.edge.to === b.edge.from || a.edge.to === b.edge.to) continue;
      if (properCross(a.a, a.b, b.a, b.b)) value += 7000 * Math.min(a.weight, b.weight);
    }
    return value;
  };
  for (let pass = 0; pass < 4; pass += 1) bands.forEach((band, bandIndex) => {
    if (band.length < 2) return;
    const componentIds = new Set(band.map((id) => componentOf.get(id)));
    if (componentIds.size === 1 && components[[...componentIds][0]].length >= 3) return;
    const original = band;
    bands[bandIndex] = permutations(band).reduce((best, candidate) => {
      bands[bandIndex] = candidate; const candidateScore = score();
      bands[bandIndex] = best; const bestScore = score();
      return candidateScore < bestScore ? candidate : best;
    }, original);
  });
  const result = place();
  if (dir === 'BT') result.pos.forEach((p) => { p.y = result.height - p.y - p.h; });
  if (dir === 'RL') result.pos.forEach((p) => { p.x = result.width - p.x - p.w; });
  return result;
}

function segmentHitsBox(a, b, box) {
  const eps = 0.01;
  if (Math.abs(a.x - b.x) < eps) {
    const x = a.x; const y0 = Math.min(a.y, b.y); const y1 = Math.max(a.y, b.y);
    return x > box.x + eps && x < box.x + box.w - eps && y1 > box.y + eps && y0 < box.y + box.h - eps;
  }
  const y = a.y; const x0 = Math.min(a.x, b.x); const x1 = Math.max(a.x, b.x);
  return y > box.y + eps && y < box.y + box.h - eps && x1 > box.x + eps && x0 < box.x + box.w - eps;
}

function segmentConflictCost(a, b, routed) {
  let cost = 0;
  routed.forEach((points) => {
    for (let i = 1; i < points.length; i += 1) {
      const c = points[i - 1]; const d = points[i];
      const abVertical = Math.abs(a.x - b.x) < 0.01; const cdVertical = Math.abs(c.x - d.x) < 0.01;
      if (abVertical !== cdVertical) {
        const vertical = abVertical ? [a, b] : [c, d]; const horizontal = abVertical ? [c, d] : [a, b];
        const vx = vertical[0].x; const hy = horizontal[0].y;
        if (vx > Math.min(horizontal[0].x, horizontal[1].x) + 1 && vx < Math.max(horizontal[0].x, horizontal[1].x) - 1
          && hy > Math.min(vertical[0].y, vertical[1].y) + 1 && hy < Math.max(vertical[0].y, vertical[1].y) - 1) cost += 1100;
      } else if (abVertical) {
        if (Math.abs(a.x - c.x) < 1 && Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y))
          - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) > 2) cost += 360;
      } else if (Math.abs(a.y - c.y) < 1 && Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x))
        - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) > 2) cost += 360;
    }
  });
  return cost;
}

function routeQuality(routes) {
  const entries = [...routes.entries()].flatMap(([edgeId, route]) =>
    routeSections(route).map((points) => ({ edgeId, points })));
  let crossings = 0; let overlaps = 0; let length = 0; let bends = 0;
  entries.forEach(({ points }) => {
    bends += Math.max(0, points.length - 2);
    for (let i = 1; i < points.length; i += 1) length += Math.abs(points[i].x - points[i - 1].x)
      + Math.abs(points[i].y - points[i - 1].y);
  });
  /* 只比较不同逻辑边。一个逻辑边将来即使由 trunk/branch 拆成多个 section，
     section 彼此的接点和共线段也不是用户看到的“边冲突”。 */
  for (let i = 0; i < entries.length; i += 1) for (let j = i + 1; j < entries.length; j += 1) {
    if (entries[i].edgeId === entries[j].edgeId) continue;
    const left = entries[i].points; const right = entries[j].points;
    for (let a = 1; a < left.length; a += 1) for (let b = 1; b < right.length; b += 1) {
      const p = left[a - 1]; const q = left[a]; const r = right[b - 1]; const s = right[b];
      const pqV = Math.abs(p.x - q.x) < 0.01; const rsV = Math.abs(r.x - s.x) < 0.01;
      if (pqV !== rsV) {
        const v = pqV ? [p, q] : [r, s]; const h = pqV ? [r, s] : [p, q];
        if (v[0].x > Math.min(h[0].x, h[1].x) + 1 && v[0].x < Math.max(h[0].x, h[1].x) - 1
          && h[0].y > Math.min(v[0].y, v[1].y) + 1 && h[0].y < Math.max(v[0].y, v[1].y) - 1) crossings += 1;
      } else if (pqV && Math.abs(p.x - r.x) < 1 && Math.min(Math.max(p.y, q.y), Math.max(r.y, s.y))
        - Math.max(Math.min(p.y, q.y), Math.min(r.y, s.y)) > 2) overlaps += 1;
      else if (!pqV && Math.abs(p.y - r.y) < 1 && Math.min(Math.max(p.x, q.x), Math.max(r.x, s.x))
        - Math.max(Math.min(p.x, q.x), Math.min(r.x, s.x)) > 2) overlaps += 1;
    }
  }
  return { crossings, overlaps, bends, length: Math.round(length) };
}

function simplifyOrthogonal(points) {
  const clean = [];
  points.forEach((point) => {
    const last = clean[clean.length - 1];
    if (!last || Math.abs(last.x - point.x) > 0.01 || Math.abs(last.y - point.y) > 0.01) clean.push(point);
  });
  for (let i = clean.length - 2; i > 0; i -= 1) {
    const a = clean[i - 1]; const b = clean[i]; const c = clean[i + 1];
    if ((Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - c.x) < 0.01)
      || (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - c.y) < 0.01)) clean.splice(i, 1);
  }
  return clean;
}

function portAssignments(g, layout) {
  const requests = new Map();
  const add = (id, side, edge, other, source) => {
    const key = `${id}:${side}`;
    if (!requests.has(key)) requests.set(key, []);
    requests.get(key).push({ edge, other, source });
  };
  const specs = new Map();
  g.edges.filter((edge) => edge.from !== edge.to).forEach((edge) => {
    const a = endpointBox(layout, edge.from); const b = endpointBox(layout, edge.to); if (!a || !b) return;
    const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }; const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const horizontal = Math.abs(bc.x - ac.x) >= Math.abs(bc.y - ac.y);
    const sourceSide = horizontal ? (bc.x >= ac.x ? 'right' : 'left') : (bc.y >= ac.y ? 'bottom' : 'top');
    const targetSide = horizontal ? (bc.x >= ac.x ? 'left' : 'right') : (bc.y >= ac.y ? 'top' : 'bottom');
    specs.set(edge.id, { sourceSide, targetSide });
    add(edge.from, sourceSide, edge, bc, true); add(edge.to, targetSide, edge, ac, false);
  });
  const points = new Map();
  requests.forEach((items, key) => {
    const split = key.lastIndexOf(':'); const id = key.slice(0, split); const side = key.slice(split + 1);
    const box = endpointBox(layout, id); if (!box) return;
    const verticalSide = side === 'left' || side === 'right';
    items.sort((a, b) => verticalSide ? a.other.y - b.other.y : a.other.x - b.other.x);
    items.forEach((item, index) => {
      const ratio = (index + 1) / (items.length + 1);
      const point = verticalSide
        ? { x: side === 'left' ? box.x : box.x + box.w, y: box.y + box.h * ratio }
        : { x: box.x + box.w * ratio, y: side === 'top' ? box.y : box.y + box.h };
      const keyId = `${item.edge.id}:${item.source ? 'source' : 'target'}`;
      points.set(keyId, { ...point, side });
    });
  });
  return { specs, points };
}

function routeOrthogonal(startPort, endPort, obstacles, routed, lanes = []) {
  const clearance = 16;
  const move = { left: [-clearance, 0], right: [clearance, 0], top: [0, -clearance], bottom: [0, clearance] };
  const start = { x: startPort.x + move[startPort.side][0], y: startPort.y + move[startPort.side][1] };
  const end = { x: endPort.x + move[endPort.side][0], y: endPort.y + move[endPort.side][1] };
  const xs = new Set([start.x, end.x]); const ys = new Set([start.y, end.y]);
  lanes.forEach((lane) => { if (lane.axis === 'x') xs.add(lane.value); else ys.add(lane.value); });
  obstacles.forEach((box) => {
    xs.add(box.x); xs.add(box.x + box.w); ys.add(box.y); ys.add(box.y + box.h);
  });
  /* 已路由边本身只参与冲突成本，不再把每一个弯点注入网格。否则第 N 条边会
     继承前 N-1 条边的全部坐标，搜索空间和无意义弯折都会指数式膨胀。 */
  const xList = [...xs].sort((a, b) => a - b); const yList = [...ys].sort((a, b) => a - b);
  const nodes = new Map();
  xList.forEach((x, xi) => yList.forEach((y, yi) => {
    if (!obstacles.some((box) => x > box.x + 0.01 && x < box.x + box.w - 0.01 && y > box.y + 0.01 && y < box.y + box.h - 0.01)) {
      nodes.set(`${xi}:${yi}`, { x, y, xi, yi });
    }
  }));
  const startId = `${xList.indexOf(start.x)}:${yList.indexOf(start.y)}`; const endId = `${xList.indexOf(end.x)}:${yList.indexOf(end.y)}`;
  if (!nodes.has(startId) || !nodes.has(endId)) return [startPort, start, { x: end.x, y: start.y }, end, endPort];
  const keyOf = (id, dir) => `${id}|${dir || '-'}`;
  const dist = new Map([[keyOf(startId, ''), 0]]); const previous = new Map(); const open = [{ id: startId, dir: '', score: 0 }];
  let winner = null;
  while (open.length) {
    open.sort((a, b) => a.score - b.score); const current = open.shift();
    const stateKey = keyOf(current.id, current.dir); if (current.score !== dist.get(stateKey)) continue;
    if (current.id === endId) { winner = current; break; }
    const node = nodes.get(current.id); const neighbours = [[node.xi - 1, node.yi, 'h'], [node.xi + 1, node.yi, 'h'], [node.xi, node.yi - 1, 'v'], [node.xi, node.yi + 1, 'v']];
    neighbours.forEach(([xi, yi, dir]) => {
      const id = `${xi}:${yi}`; const next = nodes.get(id); if (!next) return;
      if (obstacles.some((box) => segmentHitsBox(node, next, box))) return;
      const length = Math.abs(next.x - node.x) + Math.abs(next.y - node.y);
      /* 复杂架构图首先要短而直。交叉已用 casing 明确表达，因此不能为了避开一处
         交叉，把边推成跨越半张图的矩形回路；每个额外弯折应承担明显成本。 */
      const bend = current.dir && current.dir !== dir ? 190 : 0;
      const score = current.score + length + bend + segmentConflictCost(node, next, routed);
      const nextKey = keyOf(id, dir);
      if (score >= (dist.get(nextKey) ?? Infinity)) return;
      dist.set(nextKey, score); previous.set(nextKey, { key: stateKey, point: node });
      open.push({ id, dir, score });
    });
  }
  if (!winner) return [startPort, start, { x: end.x, y: start.y }, end, endPort];
  const reversed = [nodes.get(winner.id)]; let cursor = keyOf(winner.id, winner.dir);
  while (previous.has(cursor)) { const step = previous.get(cursor); reversed.push(step.point); cursor = step.key; }
  return simplifyOrthogonal([startPort].concat(reversed.reverse(), [endPort]));
}

function routeCompoundEdges(g, layout) {
  const routes = new Map(); const routed = []; const hierarchy = graphHierarchy(g);
  /* 先把局部边和跨组边分开。跨组路由时允许穿越起/终分组内部，但局部边只把
     自己组内的节点当障碍。旧实现把全图 24 个节点都塞给每一条局部边，导致
     对话层内部一条短线也可能绕到整张图外侧。 */
  const routeBatch = (batch, routedPaths, lanes, crossGroup) => {
    batch.forEach(({ edge }) => {
      const start = ports.points.get(`${edge.id}:source`); const end = ports.points.get(`${edge.id}:target`); if (!start || !end) return;
      const allowed = new Set([...ancestors(edge.from), ...ancestors(edge.to)]);
      const ownerIds = new Set([hierarchy.owner.get(edge.from), hierarchy.owner.get(edge.to)]);
      const obstacles = [];
      layout.pos.forEach((box, id) => {
        if (id === edge.from || id === edge.to) return;
        if (!crossGroup && !ownerIds.has(hierarchy.owner.get(id))) return;
        obstacles.push({ x: box.x - 10, y: box.y - 10, w: box.w + 20, h: box.h + 20 });
      });
      if (crossGroup) frameById.forEach((frame, id) => {
        if (allowed.has(id)) obstacles.push({ x: frame.x0 + 8, y: frame.y0 + 5,
          w: Math.max(0, frame.x1 - frame.x0 - 16), h: 27 });
        else obstacles.push({ x: frame.x0 - 8, y: frame.y0 - 8,
          w: frame.x1 - frame.x0 + 16, h: frame.y1 - frame.y0 + 16 });
      });
      const points = routeOrthogonal(start, end, obstacles, routedPaths, lanes);
      routes.set(edge.id, [points]); routedPaths.push(points);
    });
  };
  const rootFrames = (layout.frames || []).filter((frame) => !frame.parentId || frame.parentId === 'root');
  const laneSpacing = 9; const laneValues = [];
  const addLanes = (from, to, axis) => {
    if (to <= from) return;
    for (let value = from; value <= to; value += laneSpacing) laneValues.push({ axis, value });
  };
  const intervals = (axis) => {
    const start = axis === 'x' ? 'x0' : 'y0'; const end = axis === 'x' ? 'x1' : 'y1';
    const sorted = rootFrames.slice().sort((a, b) => a[start] - b[start]); const gaps = [];
    let frontier = sorted[0]?.[end] ?? 0;
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i][start] > frontier) gaps.push([frontier + 16, sorted[i][start] - 16]);
      frontier = Math.max(frontier, sorted[i][end]);
    }
    return gaps;
  };
  intervals('x').forEach(([from, to]) => addLanes(from, to, 'x'));
  intervals('y').forEach(([from, to]) => addLanes(from, to, 'y'));
  addLanes(14, Math.max(14, Math.min(...rootFrames.map((frame) => frame.x0)) - 16), 'x');
  addLanes(Math.max(...rootFrames.map((frame) => frame.x1)) + 16, layout.width - 14, 'x');
  addLanes(14, Math.max(14, Math.min(...rootFrames.map((frame) => frame.y0)) - 16), 'y');
  addLanes(Math.max(...rootFrames.map((frame) => frame.y1)) + 16, layout.height - 14, 'y');
  const ports = portAssignments(g, layout);
  const frameById = new Map((layout.frames || []).map((frame) => [frame.id, frame]));
  const ancestors = (id) => {
    const allowed = new Set(); let owner = hierarchy.groupById.has(id) ? id : hierarchy.owner.get(id);
    while (owner) { allowed.add(owner); owner = hierarchy.groupById.get(owner)?.parentId; }
    return allowed;
  };
  const centerOf = (id) => {
    const box = endpointBox(layout, id);
    return box ? { x: box.x + box.w / 2, y: box.y + box.h / 2 } : { x: 0, y: 0 };
  };
  const orderedEdges = g.edges.filter((edge) => edge.from !== edge.to).map((edge, index) => {
    const a = centerOf(edge.from); const b = centerOf(edge.to);
    const sameOwner = hierarchy.owner.get(edge.from) === hierarchy.owner.get(edge.to);
    return { edge, index, sameOwner, span: Math.abs(a.x - b.x) + Math.abs(a.y - b.y) };
  }).sort((a, b) => a.span - b.span || a.index - b.index);
  const local = orderedEdges.filter((item) => item.sameOwner);
  const global = orderedEdges.filter((item) => !item.sameOwner);
  const localRouted = [];
  routeBatch(local, localRouted, [], false);
  routed.push(...localRouted);
  routeBatch(global, routed, laneValues, true);
  return routes;
}

function groupedFallbackLayout(g) {
  const hierarchy = graphHierarchy(g);
  const rootId = 'root';
  const isDescendant = (id, containerId) => {
    if (containerId === rootId) return true;
    let current = hierarchy.groupById.has(id) ? id : hierarchy.owner.get(id);
    while (current) {
      if (current === containerId) return true;
      current = hierarchy.groupById.get(current)?.parentId;
    }
    return false;
  };
  const childAt = (id, containerId) => {
    if (containerId === rootId) {
      let current = hierarchy.groupById.has(id) ? id : hierarchy.owner.get(id);
      if (!current) return hierarchy.groupById.has(id) ? null : id;
      while (hierarchy.groupById.get(current)?.parentId) current = hierarchy.groupById.get(current).parentId;
      return current;
    }
    if (hierarchy.groupById.has(id)) {
      let current = id;
      while (hierarchy.groupById.get(current)?.parentId !== containerId) {
        current = hierarchy.groupById.get(current)?.parentId;
        if (!current) return null;
      }
      return current;
    }
    let owner = hierarchy.owner.get(id);
    if (owner === containerId) return id;
    while (owner && hierarchy.groupById.get(owner)?.parentId !== containerId) owner = hierarchy.groupById.get(owner)?.parentId;
    return owner || null;
  };
  const memo = new Map();
  const layoutContainer = (containerId) => {
    if (memo.has(containerId)) return memo.get(containerId);
    const group = containerId === rootId ? null : hierarchy.groupById.get(containerId);
    const childIds = containerId === rootId
      ? g.groups.filter((item) => !item.parentId).map((item) => item.id)
        .concat(g.order.filter((id) => !hierarchy.owner.get(id)))
      : (group?.members || group?.nodes.concat(group?.groups || []) || []);
    const childLayouts = new Map();
    const nodes = new Map();
    childIds.forEach((id) => {
      const childGroup = hierarchy.groupById.get(id);
      if (childGroup) {
        const nested = layoutContainer(id); childLayouts.set(id, nested);
        nodes.set(id, { id, w: nested.width, h: nested.height });
      } else {
        const node = g.nodes.get(id); if (node) nodes.set(id, node);
      }
    });
    const edgesByPair = new Map();
    g.edges.forEach((edge) => {
      if (!isDescendant(edge.from, containerId) || !isDescendant(edge.to, containerId)) return;
      const from = childAt(edge.from, containerId); const to = childAt(edge.to, containerId);
      if (!nodes.has(from) || !nodes.has(to) || from === to) return;
      const key = JSON.stringify([from, to]);
      const current = edgesByPair.get(key);
      if (current) current.weight += 1;
      else edgesByPair.set(key, { from, to, weight: 1 });
    });
    const edges = [...edgesByPair.values()];
    const dir = group?.dir || (containerId === rootId && childIds.filter((id) => hierarchy.groupById.has(id)).length >= 4
      && g.order.length >= 18 && g.dir === 'TD' ? 'LR' : g.dir);
    const horizontal = dir === 'LR' || dir === 'RL';
    const rootCompound = containerId === rootId && childIds.filter((id) => hierarchy.groupById.has(id)).length >= 4;
    const placed = rootCompound
      ? layoutCompoundRoot(nodes, childIds.filter((id) => nodes.has(id)), edges, g.dir)
      : layered(nodes, childIds.filter((id) => nodes.has(id)), edges, {
        dir, gapX: horizontal ? 78 : 56, gapY: horizontal ? 56 : 78, maxCross: 100000,
      });
    const titleTop = group ? 38 : 0; const side = group ? 18 : 0; const bottom = group ? 18 : 0;
    const result = { containerId, childIds, childLayouts, placed,
      width: placed.width + side * 2, height: placed.height + titleTop + bottom,
      titleTop, side };
    memo.set(containerId, result); return result;
  };
  const root = layoutContainer(rootId);
  const pos = new Map(); const frames = [];
  const emit = (layout, ox, oy, parentId) => {
    layout.childIds.forEach((id) => {
      const p = layout.placed.pos.get(id); if (!p) return;
      const x = ox + layout.side + p.x; const y = oy + layout.titleTop + p.y;
      const nested = layout.childLayouts.get(id);
      if (nested) {
        frames.push({ id, parentId, x0: x, y0: y, x1: x + nested.width, y1: y + nested.height });
        emit(nested, x, y, id);
      } else pos.set(id, { x, y, w: p.w, h: p.h });
    });
  };
  emit(root, 0, 0, rootId);
  const result = { pos, frames, width: root.width, height: root.height, engine: 'grouped-fallback' };
  result.routes = routeCompoundEdges(g, result);
  result.quality = routeQuality(result.routes);
  return result;
}

function fallbackLayout(g) {
  if (g.groups.length) return groupedFallbackLayout(g);
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
  const horizontal = g.dir === 'LR' || g.dir === 'RL';
  const labelled = mappedEdges.filter((edge) => edge.label).map((edge) => chipSize(edge.label));
  /* Mermaid/Dagre 会把边标签参与 rank 间距计算，标签因此位于两个节点之间。
     本地树布局以前只按固定 58px 留层间距，标签稍宽就无处可放，碰撞处理只能
     把它推到整张图外侧。按标签的真实尺寸扩层，标签仍贴着所属连线且不挡节点。 */
  const labelGap = labelled.length
    ? Math.max(...labelled.map((size) => (horizontal ? size.w : size.h))) + 24
    : 58;
  const L = useTree ? tree(g.nodes, g.order, mappedEdges, { dir: g.dir, gapLevel: Math.max(58, labelGap) })
    : layered(g.nodes, g.order, mappedEdges, { dir: g.dir,
      gapX: horizontal ? Math.max(46, labelGap) : 46,
      gapY: horizontal ? 62 : Math.max(62, labelGap) });
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

function validateLayout(g, layout) {
  const finiteBox = (box) => box && [box.x, box.y, box.w, box.h].every(Number.isFinite)
    && box.w > 0 && box.h > 0;
  for (const id of g.order) if (!finiteBox(layout.pos.get(id))) return `missing-node:${id}`;
  const frames = layout.frames || [];
  const ownerFrames = new Map(frames.map((frame) => [frame.id, frame]));
  for (const [id, ownerId] of g.nodeOwners || []) {
    if (!ownerId) continue;
    const node = layout.pos.get(id); const frame = ownerFrames.get(ownerId);
    if (!node || !frame || node.x < frame.x0 - 1 || node.y < frame.y0 - 1
      || node.x + node.w > frame.x1 + 1 || node.y + node.h > frame.y1 + 1) return `node-outside-group:${id}`;
  }
  const siblings = new Map();
  frames.forEach((frame) => {
    const key = frame.parentId || 'root';
    if (!siblings.has(key)) siblings.set(key, []);
    siblings.get(key).push(frame);
  });
  for (const list of siblings.values()) {
    for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i]; const b = list[j];
      if (a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0) return `overlapping-groups:${a.id},${b.id}`;
    }
  }
  return '';
}

function overviewModel(g) {
  const hierarchy = graphHierarchy(g);
  const rootGroups = g.groups.filter((group) => !group.parentId);
  const rootOf = (id) => {
    let owner = hierarchy.groupById.has(id) ? id : hierarchy.owner.get(id);
    if (!owner) return null;
    while (hierarchy.groupById.get(owner)?.parentId) owner = hierarchy.groupById.get(owner).parentId;
    return owner;
  };
  const bundlesByPair = new Map();
  const localEdges = [];
  g.edges.forEach((edge) => {
    const fromGroup = rootOf(edge.from); const toGroup = rootOf(edge.to);
    if (!fromGroup || !toGroup || fromGroup === toGroup) { localEdges.push(edge); return; }
    const key = `${fromGroup}\u0000${toGroup}`;
    if (!bundlesByPair.has(key)) bundlesByPair.set(key, {
      id: `bundle-${bundlesByPair.size}`, from: fromGroup, to: toGroup, members: [],
    });
    bundlesByPair.get(key).members.push(edge);
  });
  return { hierarchy, rootGroups, rootOf, localEdges, bundles: [...bundlesByPair.values()] };
}

function shouldRenderOverview(g, kind) {
  if (kind !== 'flow') return false;
  const roots = g.groups.filter((group) => !group.parentId);
  return roots.length >= 4 && g.order.length >= 18 && overviewModel(g).bundles.length >= 5;
}

function orderOverviewCore(groups, bundles, sourceIndex) {
  const ids = groups.map((group) => group.id);
  const outgoing = new Map(ids.map((id) => [id, []]));
  bundles.forEach((bundle) => outgoing.get(bundle.from)?.push(bundle.to));
  let seq = 0; const index = new Map(); const low = new Map(); const stack = []; const active = new Set(); const components = [];
  const visit = (id) => {
    index.set(id, seq); low.set(id, seq); seq += 1; stack.push(id); active.add(id);
    (outgoing.get(id) || []).forEach((to) => {
      if (!index.has(to)) { visit(to); low.set(id, Math.min(low.get(id), low.get(to))); }
      else if (active.has(to)) low.set(id, Math.min(low.get(id), index.get(to)));
    });
    if (low.get(id) !== index.get(id)) return;
    const component = []; let item;
    do { item = stack.pop(); active.delete(item); component.push(item); } while (item !== id);
    component.sort((a, b) => sourceIndex.get(a) - sourceIndex.get(b)); components.push(component);
  };
  ids.forEach((id) => { if (!index.has(id)) visit(id); });
  const weight = new Map(bundles.map((bundle) => [`${bundle.from}\u0000${bundle.to}`, bundle.members.length]));
  const scoreOrder = (candidate) => {
    const at = new Map(candidate.map((id, i) => [id, i])); let score = 0;
    bundles.forEach((bundle) => {
      if (!at.has(bundle.from) || !at.has(bundle.to)) return;
      const distance = at.get(bundle.to) - at.get(bundle.from); const w = bundle.members.length;
      score += Math.abs(distance) * w + (distance <= 0 ? 10000 * w : 0);
    });
    return score;
  };
  components.forEach((component, i) => {
    if (component.length < 2 || component.length > 7) return;
    components[i] = permutations(component).reduce((best, candidate) =>
      scoreOrder(candidate) < scoreOrder(best) ? candidate : best, component);
  });
  const componentWeight = (component) => bundles.reduce((sum, bundle) =>
    sum + (component.includes(bundle.from) && component.includes(bundle.to) ? bundle.members.length : 0), 0);
  const core = components.slice().sort((a, b) => b.length - a.length
    || componentWeight(b) - componentWeight(a)
    || Math.min(...a.map((id) => sourceIndex.get(id))) - Math.min(...b.map((id) => sourceIndex.get(id))))[0] || ids.slice(0, 1);
  return { core, components, weight };
}

function overviewGroupPlan(g, model, group) {
  const ids = (group.nodes || []).filter((id) => g.nodes.has(id));
  const idSet = new Set(ids);
  const edges = model.localEdges.filter((edge) => idSet.has(edge.from) && idSet.has(edge.to));
  if (!edges.length) {
    const gap = 28; const innerWidth = ids.reduce((sum, id) => sum + g.nodes.get(id).w, 0)
      + gap * Math.max(0, ids.length - 1);
    return { ids, edges, noFlow: true, width: Math.max(230, innerWidth + 44), height: 126 };
  }
  const placed = layered(new Map(ids.map((id) => [id, g.nodes.get(id)])), ids, edges, {
    dir: group.dir || 'TD', gapX: 34, gapY: 42, maxCross: 620,
  });
  return { ids, edges, noFlow: false, placed,
    width: Math.max(280, placed.width + 44), height: Math.max(176, placed.height + 58) };
}

function overviewBundlePath(bundle, frames, roles, indexes, laneIndex) {
  const a = frames.get(bundle.from); const b = frames.get(bundle.to);
  const center = (frame) => ({ x: (frame.x0 + frame.x1) / 2, y: (frame.y0 + frame.y1) / 2 });
  const ac = center(a); const bc = center(b);
  const sourceRole = roles.get(bundle.from); const targetRole = roles.get(bundle.to);
  if (sourceRole === 'core' && targetRole === 'core') {
    if (indexes.get(bundle.to) > indexes.get(bundle.from)) {
      const start = { x: a.x1, y: ac.y }; const end = { x: b.x0, y: bc.y };
      const mid = (start.x + end.x) / 2;
      return simplifyOrthogonal([start, { x: mid, y: start.y }, { x: mid, y: end.y }, end]);
    }
    const start = { x: a.x0, y: a.y1 - 54 }; const end = { x: b.x1, y: b.y1 - 54 };
    const lane = Math.max(a.y1, b.y1) + 44 + laneIndex * 18;
    return simplifyOrthogonal([start, { x: start.x - 22, y: start.y }, { x: start.x - 22, y: lane },
      { x: end.x + 22, y: lane }, { x: end.x + 22, y: end.y }, end]);
  }
  if (sourceRole === 'top') {
    const sx = Math.max(a.x0 + 42, Math.min(a.x1 - 42, bc.x));
    const tx = Math.max(b.x0 + 42, Math.min(b.x1 - 42, sx));
    const start = { x: sx, y: a.y1 }; const end = { x: tx, y: b.y0 }; const mid = (start.y + end.y) / 2;
    return simplifyOrthogonal([start, { x: start.x, y: mid }, { x: end.x, y: mid }, end]);
  }
  if (targetRole === 'bottom') {
    const sx = Math.max(a.x0 + 48, Math.min(a.x1 - 48, bc.x));
    const tx = Math.max(b.x0 + 48, Math.min(b.x1 - 48, sx));
    const start = { x: sx, y: a.y1 }; const end = { x: tx, y: b.y0 };
    const mid = start.y + (end.y - start.y) * (0.46 + laneIndex * 0.04);
    return simplifyOrthogonal([start, { x: start.x, y: mid }, { x: end.x, y: mid }, end]);
  }
  const horizontal = Math.abs(bc.x - ac.x) >= Math.abs(bc.y - ac.y);
  if (horizontal) {
    const start = { x: bc.x >= ac.x ? a.x1 : a.x0, y: ac.y };
    const end = { x: bc.x >= ac.x ? b.x0 : b.x1, y: bc.y }; const mid = (start.x + end.x) / 2;
    return simplifyOrthogonal([start, { x: mid, y: start.y }, { x: mid, y: end.y }, end]);
  }
  const start = { x: ac.x, y: bc.y >= ac.y ? a.y1 : a.y0 };
  const end = { x: bc.x, y: bc.y >= ac.y ? b.y0 : b.y1 }; const mid = (start.y + end.y) / 2;
  return simplifyOrthogonal([start, { x: start.x, y: mid }, { x: end.x, y: mid }, end]);
}

function longestSegmentMidpoint(points) {
  let best = { length: -1, x: 0, y: 0, horizontal: true };
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]; const b = points[i]; const length = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    if (length > best.length) best = { length, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2,
      horizontal: Math.abs(a.x - b.x) >= Math.abs(a.y - b.y) };
  }
  return best;
}

function renderOverview(g, kind) {
  const model = overviewModel(g); const groupById = new Map(model.rootGroups.map((group) => [group.id, group]));
  const sourceIndex = new Map(model.rootGroups.map((group, i) => [group.id, i]));
  const { core } = orderOverviewCore(model.rootGroups, model.bundles, sourceIndex);
  const coreSet = new Set(core); const incoming = new Map(model.rootGroups.map((group) => [group.id, 0]));
  const outgoing = new Map(model.rootGroups.map((group) => [group.id, 0]));
  model.bundles.forEach((bundle) => { outgoing.set(bundle.from, outgoing.get(bundle.from) + bundle.members.length); incoming.set(bundle.to, incoming.get(bundle.to) + bundle.members.length); });
  const top = model.rootGroups.map((group) => group.id).filter((id) => !coreSet.has(id)
    && model.bundles.some((bundle) => bundle.from === id && coreSet.has(bundle.to))
    && !model.bundles.some((bundle) => bundle.to === id && coreSet.has(bundle.from)));
  const bottom = model.rootGroups.map((group) => group.id).filter((id) => !coreSet.has(id) && !top.includes(id));
  const coreAt = new Map(core.map((id, i) => [id, i]));
  const barycenter = (id, source) => {
    const links = model.bundles.filter((bundle) => source ? bundle.from === id && coreSet.has(bundle.to)
      : bundle.to === id && coreSet.has(bundle.from));
    const total = links.reduce((sum, bundle) => sum + bundle.members.length, 0) || 1;
    return links.reduce((sum, bundle) => sum + coreAt.get(source ? bundle.to : bundle.from) * bundle.members.length, 0) / total;
  };
  top.sort((a, b) => barycenter(a, true) - barycenter(b, true) || sourceIndex.get(a) - sourceIndex.get(b));
  bottom.sort((a, b) => barycenter(a, false) - barycenter(b, false) || sourceIndex.get(a) - sourceIndex.get(b));
  const plans = new Map(model.rootGroups.map((group) => [group.id, overviewGroupPlan(g, model, group)]));
  const GAP = 92; const PAD = 34;
  const rowWidth = (ids) => ids.reduce((sum, id) => sum + plans.get(id).width, 0) + GAP * Math.max(0, ids.length - 1);
  const coreWidth = rowWidth(core); const bottomWidth = rowWidth(bottom); const topWidth = rowWidth(top);
  const width = Math.max(1180, coreWidth, bottomWidth, topWidth) + PAD * 2;
  const frames = new Map(); const roles = new Map();
  const placeRow = (ids, y, role, stretch = false) => {
    const natural = rowWidth(ids); let x = PAD + (width - PAD * 2 - natural) / 2;
    ids.forEach((id) => {
      const plan = plans.get(id); let w = plan.width;
      if (stretch && ids.length === 1) { w = Math.max(w, coreWidth); x = PAD + (width - PAD * 2 - w) / 2; }
      frames.set(id, { id, parentId: 'root', x0: x, y0: y, x1: x + w, y1: y + plan.height }); roles.set(id, role);
      x += w + GAP;
    });
  };
  const topHeight = Math.max(0, ...top.map((id) => plans.get(id).height));
  placeRow(top, PAD, 'top', true);
  const coreY = PAD + topHeight + (top.length ? 118 : 0); placeRow(core, coreY, 'core');
  const coreHeight = Math.max(0, ...core.map((id) => plans.get(id).height));
  const bottomY = coreY + coreHeight + (bottom.length ? 178 : 0); placeRow(bottom, bottomY, 'bottom');
  const bottomHeight = Math.max(0, ...bottom.map((id) => plans.get(id).height));
  const height = bottomY + bottomHeight + PAD;
  const pos = new Map();
  model.rootGroups.forEach((group) => {
    const frame = frames.get(group.id); const plan = plans.get(group.id); if (!frame || !plan) return;
    if (plan.noFlow) {
      const inner = frame.x1 - frame.x0 - 40;
      const used = plan.ids.reduce((sum, id) => sum + g.nodes.get(id).w, 0);
      const gap = plan.ids.length > 1 ? Math.max(18, (inner - used) / (plan.ids.length - 1)) : 0;
      let x = frame.x0 + 20 + Math.max(0, (inner - used - gap * Math.max(0, plan.ids.length - 1)) / 2);
      plan.ids.forEach((id) => { const node = g.nodes.get(id); pos.set(id, { x, y: frame.y0 + 62, w: node.w, h: node.h }); x += node.w + gap; });
    } else {
      const offsetX = frame.x0 + (frame.x1 - frame.x0 - plan.placed.width) / 2;
      const offsetY = frame.y0 + 42;
      plan.ids.forEach((id) => { const p = plan.placed.pos.get(id); if (p) pos.set(id, { x: offsetX + p.x, y: offsetY + p.y, w: p.w, h: p.h }); });
    }
  });
  const localGraph = { ...g, edges: model.localEdges };
  const localLayout = { pos, frames: [...frames.values()], width, height };
  const localRoutes = routeCompoundEdges(localGraph, localLayout);
  const id = uid('fco'); const root = svgOpen(width, height, 'dg-flow dg-flow-overview').replace(' role="img"',
    ` data-flow-view="overview" data-layout-engine="overview-bundled" data-bundle-count="${model.bundles.length}" data-detail-edge-count="${g.edges.length}" data-cross-group-edge-count="${model.bundles.reduce((sum, bundle) => sum + bundle.members.length, 0)}" role="img" aria-label="系统架构概览"`);
  const out = [root, inlineStyle(), arrowDefs(id)];
  model.rootGroups.forEach((group) => {
    const frame = frames.get(group.id); const authored = g.styles?.get(group.id); const authoredClass = authoredClasses(g, group.id);
    out.push(rect(frame.x0, frame.y0, frame.x1 - frame.x0, frame.y1 - frame.y0, 14,
      `dg-group dg-overview-group${authoredClass ? ` ${authoredClass}` : ''}`, `data-group-id="${esc(group.id)}" data-group-title="${esc(group.title)}" ${styleExtra(authored)}`));
    out.push(`<text x="${round(frame.x0 + 18)}" y="${round(frame.y0 + 25)}" class="dg-group-title dg-overview-title" text-anchor="start">${esc(group.title)}</text>`);
    out.push(`<text x="${round(frame.x1 - 18)}" y="${round(frame.y0 + 25)}" class="dg-group-count" text-anchor="end">${plans.get(group.id).ids.length} 个模块</text>`);
  });
  model.localEdges.forEach((edge) => {
    const sections = routeSections(localRoutes.get(edge.id));
    sections.forEach((points, index) => out.push(path(orthogonalPath(points), 'dg-edge dg-local-edge',
      `${index === sections.length - 1 && edge.arrow ? ` marker-end="url(#${id}-arrow)"` : ''} data-edge-id="${esc(edge.id)}" data-edge-from="${esc(edge.from)}" data-edge-to="${esc(edge.to)}"`)));
  });
  const coreIndexes = new Map(core.map((groupId, i) => [groupId, i])); let returnLane = 0; let lowerLane = 0;
  model.bundles.forEach((bundle) => {
    const reverse = roles.get(bundle.from) === 'core' && roles.get(bundle.to) === 'core'
      && coreIndexes.get(bundle.to) < coreIndexes.get(bundle.from);
    const lane = reverse ? returnLane++ : (roles.get(bundle.to) === 'bottom' ? lowerLane++ : 0);
    const points = overviewBundlePath(bundle, frames, roles, coreIndexes, lane);
    const groupFrom = groupById.get(bundle.from); const groupTo = groupById.get(bundle.to);
    const relations = bundle.members.map((edge) => `${g.nodes.get(edge.from)?.label || edge.from} → ${g.nodes.get(edge.to)?.label || edge.to}`);
    const memberIds = bundle.members.map((edge) => edge.id).join(',');
    const nodeIds = [...new Set(bundle.members.flatMap((edge) => [edge.from, edge.to]))].join(',');
    const label = `${reverse ? '回传 · ' : ''}${bundle.members.length} 项`;
    const data = `data-bundle-id="${esc(bundle.id)}" data-bundle-from="${esc(bundle.from)}" data-bundle-to="${esc(bundle.to)}" data-bundle-members="${esc(memberIds)}" data-bundle-nodes="${esc(nodeIds)}" data-bundle-relations="${esc(relations.join('||'))}" tabindex="0" role="button" aria-label="${esc(`${groupFrom?.title || bundle.from}到${groupTo?.title || bundle.to}，${bundle.members.length}项关系`)}"`;
    out.push(path(orthogonalPath(points, 10), 'dg-bundle-hit', data));
    out.push(path(orthogonalPath(points, 10), `dg-bundle${reverse ? ' is-return' : ''}`, `marker-end="url(#${id}-arrow)" ${data}`));
    const mid = longestSegmentMidpoint(points); const labelW = Math.max(54, textWidth(label) + 24); const lx = mid.x - labelW / 2; const ly = mid.y - 12;
    out.push(`<g class="dg-bundle-label${reverse ? ' is-return' : ''}" ${data}><rect x="${round(lx)}" y="${round(ly)}" width="${round(labelW)}" height="24" rx="12"/><text x="${round(mid.x)}" y="${round(mid.y + 4)}" text-anchor="middle">${esc(label)}</text></g>`);
  });
  g.order.forEach((nodeId) => {
    const p = pos.get(nodeId); const node = g.nodes.get(nodeId); if (!p || !node) return;
    const authored = g.styles?.get(nodeId); const authoredClass = authoredClasses(g, nodeId);
    out.push(drawShape(node.shape, p, `dg-shape dg-overview-node${authoredClass ? ` ${authoredClass}` : ''}`, authored,
      `data-node-id="${esc(nodeId)}" tabindex="0"`));
    if (node.lines?.length && node.shape !== 'terminal') out.push(textBlock(p.x + p.w / 2, p.y + p.h / 2, node.lines, 'dg-text', 18, styleExtra(authored, 'text')));
  });
  out.push('</svg>'); return out.join('');
}

function renderWithElk(g, kind) {
  const fallback = (reason) => {
    if (reason && typeof console !== 'undefined' && console.warn) {
      console.warn('[docsmith-diagrams] ELK layout rejected', { reason, nodes: g.order.length,
        groups: g.groups.length, edges: g.edges.length });
    }
    const svg = renderLaidOut(g, fallbackLayout(g), kind);
    return reason ? svg.replace(' role="img"', ` data-layout-warning="${esc(reason)}" role="img"`) : svg;
  };
  if (typeof window === 'undefined' || typeof window.ELK !== 'function') return Promise.resolve(fallback('elk-unavailable'));
  const elk = new window.ELK();
  return elk.layout(buildElkGraph(g, kind)).then((result) => {
    const pos = new Map(); const frames = []; const routes = new Map(); const labels = new Map();
    collectElk(result, 0, 0, pos, frames, routes, labels);
    const layout = { pos, frames, routes, labels, width: result.width || 1,
      height: result.height || 1, engine: 'elk' };
    const invalid = validateLayout(g, layout);
    return invalid ? fallback(invalid) : renderLaidOut(g, layout, kind);
  }).catch((error) => fallback(error?.message || 'elk-error'));
}

export function render(src, kind = 'flow', options = {}) {
  const g = parse(src, kind);
  if (shouldRenderOverview(g, kind) && options.view !== 'detail') return renderOverview(g, kind);
  if (kind === 'flow' && !g.groups.length && isTree(g.order, g.edges)) {
    return renderLaidOut(g, fallbackLayout(g), kind);
  }
  const rendered = renderWithElk(g, kind);
  if (!shouldRenderOverview(g, kind) || options.view !== 'detail') return rendered;
  return Promise.resolve(rendered).then((svg) => svg.replace(' role="img"',
    ` data-flow-view="detail" data-detail-edge-count="${g.edges.length}" role="img"`));
}
