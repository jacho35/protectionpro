const assert = require('assert');
const W = require('../../frontend/js/plan-workarea.js');
const poly = [[0, 0], [10, 0], [10, 10], [0, 10]], bb = W.bbox(poly);
assert(W.inPoly(5, 5, poly)); assert(!W.inPoly(15, 5, poly));
assert(W.segHits([5, 5, 6, 6], poly, bb));          // inside
assert(W.segHits([-5, 5, 15, 5], poly, bb));        // crosses through
assert(!W.segHits([20, 20, 30, 30], poly, bb));     // outside
assert(!W.segHits([-5, -5, -1, 20], poly, bb));     // misses
assert.strictEqual(W.filterSegs([[5, 5, 6, 6], [20, 20, 30, 30]], poly).length, 1);
console.log('workarea ok');
