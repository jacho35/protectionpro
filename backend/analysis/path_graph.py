"""Shortest paths over a drawn network of polylines (metres).

Shared by the Building circuiting engine (cable routes along walls or drawn
containment) and the reticulation MV design (cable routes along streets).

A network is a list of polylines. Their vertices become nodes (snapped to
``SNAP`` m), every consecutive pair an edge, and every place two segments
cross a node of its own, so a route can turn from one line to another.
"""

import heapq
import math

SNAP = 0.01  # m


def _key(p):
    return (round(p[0] / SNAP), round(p[1] / SNAP))


def dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _seg_cross(p, q, r, s):
    """Intersection point of segments pq and rs, or None (parallel / apart)."""
    d1x, d1y = q[0] - p[0], q[1] - p[1]
    d2x, d2y = s[0] - r[0], s[1] - r[1]
    den = d1x * d2y - d1y * d2x
    if abs(den) < 1e-12:
        return None
    t = ((r[0] - p[0]) * d2y - (r[1] - p[1]) * d2x) / den
    u = ((r[0] - p[0]) * d1y - (r[1] - p[1]) * d1x) / den
    if -1e-9 <= t <= 1 + 1e-9 and -1e-9 <= u <= 1 + 1e-9:
        return (p[0] + t * d1x, p[1] + t * d1y)
    return None


def nearest_on_segment(p, a, b):
    """Closest point to p on segment ab, and its distance."""
    abx, aby = b[0] - a[0], b[1] - a[1]
    ll = abx * abx + aby * aby
    t = 0.0 if ll == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / ll))
    c = (a[0] + t * abx, a[1] + t * aby)
    return c, dist(p, c)


class PathGraph:
    def __init__(self, polylines, extra_edges=None):
        """``polylines``: lists of (x, y). ``extra_edges``: ((x, y), (x, y)) pairs
        joined as if drawn (a door between two rooms, say)."""
        segs = []
        for pl in polylines or []:
            pts = [(float(p[0]), float(p[1])) for p in pl]
            for a, b in zip(pts, pts[1:]):
                if dist(a, b) > 1e-9:
                    segs.append((a, b))
        for a, b in extra_edges or []:
            a = (float(a[0]), float(a[1]))
            b = (float(b[0]), float(b[1]))
            if dist(a, b) > 1e-9:
                segs.append((a, b))
        # split every segment at the points where others cross it
        cuts = [[] for _ in segs]
        for i in range(len(segs)):
            for j in range(i + 1, len(segs)):
                x = _seg_cross(segs[i][0], segs[i][1], segs[j][0], segs[j][1])
                if x is not None:
                    cuts[i].append(x)
                    cuts[j].append(x)
        self.segs = []
        self.pos = {}
        self.adj = {}
        for (a, b), cs in zip(segs, cuts):
            pts = sorted([a, b] + cs, key=lambda p: dist(a, p))
            for p, q in zip(pts, pts[1:]):
                if _key(p) == _key(q):
                    continue
                self._edge(p, q)
                self.segs.append((p, q))

    def _node(self, p):
        k = _key(p)
        if k not in self.pos:
            self.pos[k] = (float(p[0]), float(p[1]))
            self.adj[k] = {}
        return k

    def _edge(self, p, q):
        a, b = self._node(p), self._node(q)
        d = dist(self.pos[a], self.pos[b])
        if b not in self.adj[a] or d < self.adj[a][b]:
            self.adj[a][b] = d
            self.adj[b][a] = d

    def snap(self, p, max_drop=None):
        """Attach point p to the network at its nearest point. Returns
        (node key, drop length) or None if farther than ``max_drop``."""
        best = None
        for a, b in self.segs:
            c, d = nearest_on_segment(p, a, b)
            if best is None or d < best[1]:
                best = (c, d, a, b)
        if best is None or (max_drop is not None and best[1] > max_drop + 1e-9):
            return None
        c, d, a, b = best
        k = _key(c)
        if k not in self.pos:  # a point part-way along an edge: split it
            ka, kb = _key(a), _key(b)
            self.adj[ka].pop(kb, None)
            self.adj[kb].pop(ka, None)
            self.pos[k] = c
            self.adj[k] = {}
            for e in (ka, kb):
                w = dist(c, self.pos[e])
                self.adj[k][e] = w
                self.adj[e][k] = w
            self.segs = [s for s in self.segs if s != (a, b)] + [(a, c), (c, b)]
        return k, d

    def route(self, src, dst):
        """Shortest path between two node keys: (length, [points]) or None."""
        if src == dst:
            return 0.0, [self.pos[src]]
        best = {src: 0.0}
        prev = {}
        heap = [(0.0, src)]
        while heap:
            d, u = heapq.heappop(heap)
            if u == dst:
                break
            if d > best.get(u, math.inf):
                continue
            for v, w in self.adj[u].items():
                nd = d + w
                if nd < best.get(v, math.inf) - 1e-12:
                    best[v] = nd
                    prev[v] = u
                    heapq.heappush(heap, (nd, v))
        if dst not in best:
            return None
        path = [dst]
        while path[-1] != src:
            path.append(prev[path[-1]])
        return best[dst], [self.pos[k] for k in reversed(path)]


def connect(graph, a, b, max_drop=None):
    """Route between two free points over the network, each joined to it by a
    straight drop. Returns {length, points, drops} or None."""
    sa = graph.snap(a, max_drop)
    sb = graph.snap(b, max_drop)
    if sa is None or sb is None:
        return None
    r = graph.route(sa[0], sb[0])
    if r is None:
        return None
    length, pts = r
    return {"length": length + sa[1] + sb[1],
            "points": [tuple(a)] + pts + [tuple(b)],
            "drops": sa[1] + sb[1]}
