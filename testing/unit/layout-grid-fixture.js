// Four short parallel streets (40 m) off a connector road, two erven on each side of every street (16 m frontage, 18 m deep) for the kiosk tests.
// 4 short parallel streets (40 m) off a connector, 2 erven on each side (16 m frontage, 18 m deep)
const grid = (gap = 56) => {
  const streets = [{ id: 'C', name: 'Connector', w: 10, pts: [[0, 0], [gap * 3 + 60, 0]] }], erven = [];
  for (let s = 0; s < 4; s++) {
    const x = 30 + s * gap; streets.push({ id: 'S' + (s + 1), name: 'Street ' + (s + 1), w: 10, pts: [[x, 0], [x, -40]] });
    for (let i = 0; i < 2; i++) {
      const y0 = -4 - 16 * i, y1 = y0 - 16;
      erven.push({ id: `E${s + 1}e${i + 1}`, poly: [[x + 6, y0], [x + 24, y0], [x + 24, y1], [x + 6, y1]] });
      erven.push({ id: `E${s + 1}w${i + 1}`, poly: [[x - 6, y0], [x - 24, y0], [x - 24, y1], [x - 6, y1]] });
    }
  }
  return { streets, erven };
};
module.exports = grid;
