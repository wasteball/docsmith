/* =====================================================================
 * Docsmith · 分层布局
 * ---------------------------------------------------------------------
 * 有向图怎么摆：先按依赖关系分层，再在层内排序，最后定坐标。
 * 流程图和状态图共用这一套 —— 它们本质上是同一种图，只是画法不同。
 *
 * 层内排序用的是重心法（barycenter）：一个节点的横向位置，取它所有前驱
 * 的平均位置。迭代几轮，连线交叉会明显减少。这是 Sugiyama 那套算法里
 * 性价比最高的一步，几十行换来肉眼可见的整齐。
 * ===================================================================== */

/**
 * @param nodes Map<id, {id, label, shape, lines, w, h}>
 * @param edges [{from, to, ...}]
 * @param opts  {dir, gapX, gapY, maxCross}
 */
export function layered(nodes, order, edges, opts = {}) {
  const dir = opts.dir || 'TD';
  const horizontal = dir === 'LR' || dir === 'RL';
  const GAP_X = opts.gapX ?? 46;
  const GAP_Y = opts.gapY ?? 62;
  const MAX_CROSS = opts.maxCross ?? 980;

  /* ---------------------------------------------------- 1. 分层
     先把强连通分量收缩成 DAG。旧实现遇到回边时会修改一个已经处理完的
     节点 rank，却不会把新 rank 继续传给后继，状态机因此挤成一团。 */
  const rank = {};
  const orderIndex = new Map(order.map((id, index) => [id, index]));
  const graphEdges = edges.filter((e) => e.from !== e.to
    && orderIndex.has(e.from) && orderIndex.has(e.to));
  const out = new Map(order.map((id) => [id, []]));
  graphEdges.forEach((e) => out.get(e.from).push(e.to));

  let nextIndex = 0;
  const indices = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  const visit = (id) => {
    indices.set(id, nextIndex);
    low.set(id, nextIndex);
    nextIndex += 1;
    stack.push(id);
    onStack.add(id);
    for (const to of out.get(id) || []) {
      if (!indices.has(to)) {
        visit(to);
        low.set(id, Math.min(low.get(id), low.get(to)));
      } else if (onStack.has(to)) {
        low.set(id, Math.min(low.get(id), indices.get(to)));
      }
    }
    if (low.get(id) !== indices.get(id)) return;
    const component = [];
    let item;
    do {
      item = stack.pop();
      onStack.delete(item);
      component.push(item);
    } while (item !== id);
    component.sort((a, b) => orderIndex.get(a) - orderIndex.get(b));
    components.push(component);
  };
  order.forEach((id) => { if (!indices.has(id)) visit(id); });

  const componentOf = new Map();
  components.forEach((component, index) => component.forEach((id) => componentOf.set(id, index)));
  const componentOut = new Map(components.map((_, index) => [index, new Set()]));
  const componentIndeg = components.map(() => 0);
  graphEdges.forEach((edge) => {
    const from = componentOf.get(edge.from);
    const to = componentOf.get(edge.to);
    if (from === to || componentOut.get(from).has(to)) return;
    componentOut.get(from).add(to);
    componentIndeg[to] += 1;
  });

  const componentOrder = (index) => Math.min(...components[index].map((id) => orderIndex.get(id)));
  const queue = components.map((_, index) => index)
    .filter((index) => componentIndeg[index] === 0)
    .sort((a, b) => componentOrder(a) - componentOrder(b));
  const componentRank = components.map(() => 0);
  while (queue.length) {
    const current = queue.shift();
    for (const to of componentOut.get(current)) {
      componentRank[to] = Math.max(componentRank[to], componentRank[current] + components[current].length);
      componentIndeg[to] -= 1;
      if (componentIndeg[to] === 0) {
        queue.push(to);
        queue.sort((a, b) => componentOrder(a) - componentOrder(b));
      }
    }
  }
  components.forEach((component, componentIndex) => {
    component.forEach((id, localIndex) => { rank[id] = componentRank[componentIndex] + localIndex; });
  });

  /* ------------------------------------------- 2. 层内排序（重心法） */
  const byRank = new Map();
  order.forEach((id) => {
    if (!byRank.has(rank[id])) byRank.set(rank[id], []);
    byRank.get(rank[id]).push(id);
  });
  const rankKeys = [...byRank.keys()].sort((a, b) => a - b);

  const preds = new Map();
  edges.forEach((e) => {
    if (!preds.has(e.to)) preds.set(e.to, []);
    preds.get(e.to).push(e.from);
  });

  const idxIn = {};
  rankKeys.forEach((r) => byRank.get(r).forEach((id, i) => { idxIn[id] = i; }));

  const succs = new Map();
  edges.forEach((e) => {
    if (!succs.has(e.from)) succs.set(e.from, []);
    succs.get(e.from).push(e.to);
  });

  /* 重心法，**双向**跑。

     原来只有「按前驱算重心」这一遍（从上往下扫）。那样一个节点的位置只受
     它上游影响，下游完全不参与 —— 于是分叉出去又汇回来的图（流程图几乎都是
     这个形状）会出现大量交叉：两条分支各自被排到边上，汇合点却在中间，
     线就得斜着穿过整张图（用户原话「实体布局混乱、连线混乱」）。

     标准 Sugiyama 的做法是上下交替扫若干轮，每轮里节点向「所有邻居的平均
     位置」靠拢。这里照做：正扫看前驱、反扫看后继，跑 4 轮共 8 遍。
     几十行代码，交叉数明显下降，而且完全确定 —— 同样的输入永远同样的输出。 */
  const meanOf = (id, neighbours, wantRank) => {
    const ns = (neighbours.get(id) || []).filter((n) => rank[n] === wantRank);
    return ns.length ? ns.reduce((a, n) => a + (idxIn[n] ?? 0), 0) / ns.length : null;
  };
  for (let pass = 0; pass < 4; pass += 1) {
    // 正扫：向前驱靠拢
    for (const r of rankKeys.slice(1)) {
      const row = byRank.get(r);
      const bary = new Map();
      row.forEach((id) => {
        const m = meanOf(id, preds, r - 1);
        bary.set(id, m == null ? (idxIn[id] ?? 0) : m);
      });
      row.sort((a, b) => bary.get(a) - bary.get(b));
      row.forEach((id, i) => { idxIn[id] = i; });
    }
    // 反扫：向后继靠拢
    for (const r of rankKeys.slice(0, -1).reverse()) {
      const row = byRank.get(r);
      const bary = new Map();
      row.forEach((id) => {
        const m = meanOf(id, succs, r + 1);
        bary.set(id, m == null ? (idxIn[id] ?? 0) : m);
      });
      row.sort((a, b) => bary.get(a) - bary.get(b));
      row.forEach((id, i) => { idxIn[id] = i; });
    }
  }

  /* ---------------------------------------- 3. 宽层折行 + 定坐标 */
  const span = (id) => (horizontal ? nodes.get(id).h : nodes.get(id).w) + (horizontal ? GAP_Y : GAP_X);

  let maxCross = 0;
  const plans = rankKeys.map((r) => {
    const rows = [[]];
    let used = 0;
    for (const id of byRank.get(r)) {
      if (used + span(id) > MAX_CROSS && rows[rows.length - 1].length) { rows.push([]); used = 0; }
      rows[rows.length - 1].push(id);
      used += span(id);
    }
    rows.forEach((row) => {
      const w = row.reduce((a, id) => a + span(id), 0) - (horizontal ? GAP_Y : GAP_X);
      maxCross = Math.max(maxCross, w);
    });
    return rows;
  });

  const pos = new Map();
  let cursor = 0;
  plans.forEach((rows) => {
    rows.forEach((row) => {
      const depth = row.reduce((a, id) => Math.max(a, horizontal ? nodes.get(id).w : nodes.get(id).h), 0);
      const used = row.reduce((a, id) => a + span(id), 0) - (horizontal ? GAP_Y : GAP_X);
      let c = (maxCross - used) / 2;
      for (const id of row) {
        const n = nodes.get(id);
        if (horizontal) {
          pos.set(id, { x: cursor + (depth - n.w) / 2, y: c, w: n.w, h: n.h });
          c += n.h + GAP_Y;
        } else {
          pos.set(id, { x: c, y: cursor + (depth - n.h) / 2, w: n.w, h: n.h });
          c += n.w + GAP_X;
        }
      }
      cursor += depth + (horizontal ? GAP_X : GAP_Y);
    });
    cursor += horizontal ? 30 : 14;
  });

  let W = 0;
  let H = 0;
  pos.forEach((p) => { W = Math.max(W, p.x + p.w); H = Math.max(H, p.y + p.h); });

  if (dir === 'BT' || dir === 'RL') {
    pos.forEach((p) => {
      if (dir === 'BT') p.y = H - p.y - p.h;
      else p.x = W - p.x - p.w;
    });
  }

  const PAD = 14;
  pos.forEach((p) => { p.x += PAD; p.y += PAD; });

  return { pos, width: W + PAD * 2, height: H + PAD * 2, rank };
}

/**
 * 连线的起止点：从边框上出发，不从中心 —— 否则线会穿进方块里。
 *
 * vertical 传进来时（分层/树布局知道自己是竖着还是横着长的），改用
 * **贴着面走**的锚点，而不是「圆心连线与边框的交点」：
 *
 *   竖排时，只要 b 在 a 下方，就固定从 a 的**下边**出发、进 b 的**上边**；
 *   横排时同理走右边→左边。
 *
 * 为什么这样更好看：几何交点法会让稍微偏一点的边从**侧面**斜着钻出来，
 * 再配上贝塞尔的竖直控制点，画出来就是一条 S 形的扭线（用户原话
 * 「实体布局混乱、连线混乱」有一半是这个）。真实的流程图工具都是从
 * 底面出、顶面进 —— 线看着是「从这一层流到下一层」，而不是四处乱窜。
 *
 * 出发点在面上按 x 差异**略微**偏移（不超过节点自身宽度的 40%），
 * 这样一个节点分出好几条边时不会全叠在同一个点上。
 */
export function anchors(a, b, vertical) {
  const ax = a.x + a.w / 2;
  const ay = a.y + a.h / 2;
  const bx = b.x + b.w / 2;
  const by = b.y + b.h / 2;
  const dx = bx - ax;
  const dy = by - ay;
  if (!dx && !dy) return { x1: ax, y1: ay, x2: bx, y2: by };

  if (vertical === true) {
    // 只在真的「上下相邻」时走面锚点；同层或往回指的边仍走侧面
    if (b.y >= a.y + a.h - 1) {
      const off = (w) => Math.max(-w * 0.4, Math.min(w * 0.4, dx * 0.25));
      return { x1: ax + off(a.w), y1: a.y + a.h, x2: bx - off(b.w), y2: b.y };
    }
    if (a.y >= b.y + b.h - 1) {
      const off = (w) => Math.max(-w * 0.4, Math.min(w * 0.4, dx * 0.25));
      return { x1: ax + off(a.w), y1: a.y, x2: bx - off(b.w), y2: b.y + b.h };
    }
  } else if (vertical === false) {
    if (b.x >= a.x + a.w - 1) {
      const off = (h) => Math.max(-h * 0.4, Math.min(h * 0.4, dy * 0.25));
      return { x1: a.x + a.w, y1: ay + off(a.h), x2: b.x, y2: by - off(b.h) };
    }
    if (a.x >= b.x + b.w - 1) {
      const off = (h) => Math.max(-h * 0.4, Math.min(h * 0.4, dy * 0.25));
      return { x1: a.x, y1: ay + off(a.h), x2: b.x + b.w, y2: by - off(b.h) };
    }
  }

  const onEdge = (cx, cy, w, h, vx, vy) => {
    const sx = vx ? (w / 2) / Math.abs(vx) : Infinity;
    const sy = vy ? (h / 2) / Math.abs(vy) : Infinity;
    const s = Math.min(sx, sy);
    return { x: cx + vx * s, y: cy + vy * s };
  };
  const p1 = onEdge(ax, ay, a.w, a.h, dx, dy);
  const p2 = onEdge(bx, by, b.w, b.h, -dx, -dy);
  return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
}

/** 自环：在节点右上方绕一个小圈 */
export function selfLoop(p) {
  const x = p.x + p.w;
  const y = p.y + p.h * 0.3;
  return `M${x} ${y} C${x + 34} ${y - 14}, ${x + 34} ${y + 26}, ${x} ${y + 16}`;
}

/* =====================================================================
 * 树形布局
 * ---------------------------------------------------------------------
 * 分层布局对付一般的有向图，但对**树**来说结果很差：所有叶子被平铺在同
 * 一层，横向拉得极长，而且看不出谁是谁的孩子。
 *
 * 树该这么摆：每个节点占据的横向空间 = 它所有子树占据空间之和，父节点
 * 居中在孩子上方。这就是组织架构图的画法，一眼就能看清从属关系。
 *
 * 判断条件很简单：每个节点最多一个父节点，且没有环。满足就走这里。
 * ===================================================================== */

/** 这张图是树（或森林）吗？ */
export function isTree(order, edges) {
  if (!edges.length) return false;
  const parents = new Map();
  for (const e of edges) {
    if (e.from === e.to) return false;
    if (parents.has(e.to)) return false;              // 有节点被指了两次
    parents.set(e.to, e.from);
  }
  // 查环
  for (const start of order) {
    let cur = start;
    let hop = 0;
    while (parents.has(cur) && hop++ <= order.length) cur = parents.get(cur);
    if (hop > order.length) return false;
  }
  return true;
}

/**
 * 树布局。
 * @param nodes Map<id, {w, h}>
 */
export function tree(nodes, order, edges, opts = {}) {
  const dir = opts.dir || 'TD';
  const horizontal = dir === 'LR' || dir === 'RL';
  const GAP_SIB = opts.gapSibling ?? 22;      // 兄弟之间
  const GAP_LEVEL = opts.gapLevel ?? 58;      // 层与层之间
  const PAD = 16;

  const kids = new Map();
  const hasParent = new Set();
  for (const e of edges) {
    if (!kids.has(e.from)) kids.set(e.from, []);
    kids.get(e.from).push(e.to);
    hasParent.add(e.to);
  }
  const roots = order.filter((id) => !hasParent.has(id));
  if (!roots.length) roots.push(order[0]);

  /* 沿"横向"看，每棵子树要多宽 */
  const extent = (id) => (horizontal ? nodes.get(id).h : nodes.get(id).w);
  const depthOf = (id) => (horizontal ? nodes.get(id).w : nodes.get(id).h);

  const spanCache = new Map();
  function span(id, seen = new Set()) {
    if (spanCache.has(id)) return spanCache.get(id);
    if (seen.has(id)) return extent(id);
    seen.add(id);
    const cs = kids.get(id) || [];
    const own = extent(id);
    const sub = cs.length
      ? cs.reduce((a, c) => a + span(c, seen), 0) + GAP_SIB * (cs.length - 1)
      : 0;
    const v = Math.max(own, sub);
    spanCache.set(id, v);
    return v;
  }

  /* 每一层的深度取该层最高（或最宽）的节点，层内对齐 */
  const levelDepth = [];
  function measureDepth(id, lv, seen = new Set()) {
    if (seen.has(id)) return;
    seen.add(id);
    levelDepth[lv] = Math.max(levelDepth[lv] || 0, depthOf(id));
    (kids.get(id) || []).forEach((c) => measureDepth(c, lv + 1, seen));
  }
  roots.forEach((r) => measureDepth(r, 0));

  const levelStart = [];
  levelDepth.reduce((acc, d, i) => {
    levelStart[i] = acc;
    return acc + d + GAP_LEVEL;
  }, 0);

  const pos = new Map();
  function place(id, start, lv, seen = new Set()) {
    if (seen.has(id)) return;
    seen.add(id);
    const n = nodes.get(id);
    const total = span(id);
    const own = extent(id);
    const cross = start + (total - own) / 2;        // 父节点居中在自己的子树上
    const along = levelStart[lv] + (levelDepth[lv] - depthOf(id)) / 2;

    pos.set(id, horizontal
      ? { x: along + PAD, y: cross + PAD, w: n.w, h: n.h }
      : { x: cross + PAD, y: along + PAD, w: n.w, h: n.h });

    let c = start;
    const cs = kids.get(id) || [];
    // 子树总宽可能小于父节点自身宽度，那就把这一排孩子也居中
    const subTotal = cs.length
      ? cs.reduce((a, k) => a + span(k), 0) + GAP_SIB * (cs.length - 1)
      : 0;
    if (subTotal < total) c += (total - subTotal) / 2;
    for (const k of cs) {
      place(k, c, lv + 1, seen);
      c += span(k) + GAP_SIB;
    }
  }

  let cursor = 0;
  const seen = new Set();
  for (const r of roots) {
    place(r, cursor, 0, seen);
    cursor += span(r) + GAP_SIB * 2;
  }
  // 没被任何根挂上的孤立节点，补在最后
  for (const id of order) {
    if (pos.has(id)) continue;
    const n = nodes.get(id);
    pos.set(id, horizontal
      ? { x: PAD, y: cursor + PAD, w: n.w, h: n.h }
      : { x: cursor + PAD, y: PAD, w: n.w, h: n.h });
    cursor += extent(id) + GAP_SIB;
  }

  let W = 0;
  let H = 0;
  pos.forEach((p) => { W = Math.max(W, p.x + p.w); H = Math.max(H, p.y + p.h); });

  if (dir === 'BT' || dir === 'RL') {
    pos.forEach((p) => {
      if (dir === 'BT') p.y = H + PAD - p.y - p.h;
      else p.x = W + PAD - p.x - p.w;
    });
  }

  return { pos, width: W + PAD, height: H + PAD };
}
