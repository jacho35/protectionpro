// A township in metres for the boundary-first routing tests: blocks of erven 15 × 30 m back to back, 13 m road reserves, 3 m splays where
// two streets meet, a T junction and a crossroads. `wob` draws the street lines rough: wavy (amplitude in m) and off centre by about as much.
// `pieces` draws every street line in that many separate pieces (end to end), the way some drawings come.
function township(o) {
  o = Object.assign({ wob: 0, pieces: 1 }, o || {});
  const erven = [];
  const mk = (x0, x1, y0, y1, n, cut) => {                                       // two rows of n erven; cut = the splayed corners
    const w = (x1 - x0) / n, S = 3;
    for (const [ya, yb, top] of [[y0, y0 + 30, true], [y0 + 30, y1, false]]) for (let i = 0; i < n; i++) {
      const a = x0 + i * w, b = a + w; let poly = [[a, ya], [b, ya], [b, yb], [a, yb]];
      const first = i === 0, last = i === n - 1;
      if (top && first && cut.tl) poly = [[a + S, ya], [b, ya], [b, yb], [a, yb], [a, ya + S]];
      if (top && last && cut.tr) poly = [[a, ya], [b - S, ya], [b, ya + S], [b, yb], [a, yb]];
      if (!top && first && cut.bl) poly = [[a, ya], [b, ya], [b, yb], [a + S, yb], [a, yb - S]];
      if (!top && last && cut.br) poly = [[a, ya], [b, ya], [b, yb - S], [b - S, yb], [a, yb]];
      erven.push({ id: 'E' + (erven.length + 1), poly });
    }
  };
  mk(0, 90, 0, 60, 6, { tr: 1, br: 1 }); mk(103, 193, 0, 60, 6, { tl: 1, tr: 1, bl: 1, br: 1 }); mk(206, 296, 0, 60, 6, { tl: 1, bl: 1 });
  mk(0, 193, 73, 133, 13, { tr: 1, br: 1 }); mk(206, 296, 73, 133, 6, { tl: 1, bl: 1 });
  const W = o.wob, wob = (k, ph) => W * Math.sin(k + ph);
  const H = (y, x0, x1, ph) => { const pts = []; for (let x = x0; x <= x1; x += 4) pts.push([x, y + 0.7 * W + wob(x / 23, ph)]); return pts; };
  const V = (x, y0, y1, ph) => { const pts = []; for (let y = y0; y <= y1; y += 4) pts.push([x - 0.8 * W + wob(y / 17, ph), y]); return pts; };
  // street ends drawn up to 1.5 m past the other street when rough (an overshoot), exactly to its line when not
  const over = W ? 1.5 : 0;
  let lines = [H(-6.5, -12, 308, 0), H(66.5, -12, 308, 1), H(139.5, -12, 308, 2), V(96.5, -6.5 - over, 66.5 + over, 0.5), V(199.5, -6.5 - over, 139.5 + over, 1.5)];
  if (o.pieces > 1) lines = lines.flatMap(pts => { const out = [], n = o.pieces, per = Math.ceil((pts.length - 1) / n); for (let i = 0; i < pts.length - 1; i += per) out.push(pts.slice(i, Math.min(pts.length, i + per + 1))); return out; });
  const streets = lines.map((pts, i) => ({ id: 'S' + i, name: 'Street ' + i, w: 13, pts }));
  return { erven, lines, streets };
}
module.exports = township;
