const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

test("indicator worker returns aligned SMA values", () => {
  let response;
  const context = {
    self: { postMessage(message) { response = message; } }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync("web/indicator-worker.js", "utf8"), context);
  context.self.onmessage({
    data: {
      type: "calculate",
      jobId: 7,
      times: new Float64Array([5, 10, 15, 20]),
      open: new Float64Array([1, 2, 3, 4]),
      high: new Float64Array([1, 2, 3, 4]),
      low: new Float64Array([1, 2, 3, 4]),
      close: new Float64Array([1, 2, 3, 4]),
      volume: new Float64Array([NaN, NaN, NaN, NaN]),
      indicators: [{ uid: "sma-1", id: "sma", panel: "overlay", params: { period: 2, source: "close" } }]
    }
  });
  assert.equal(response.type, "result");
  assert.equal(response.jobId, 7);
  assert.equal(response.results.length, 1);
  const values = Array.from(response.results[0].lines[0].values);
  assert.ok(Number.isNaN(values[0]));
  assert.deepEqual(values.slice(1), [1.5, 2.5, 3.5]);
});

test("worker isolates invalid indicator failures", () => {
  let response;
  const context = { self: { postMessage(message) { response = message; } } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync("web/indicator-worker.js", "utf8"), context);
  context.self.onmessage({
    data: {
      type: "calculate", jobId: 8,
      times: new Float64Array([1, 2]), open: new Float64Array([1, 1]),
      high: new Float64Array([1, 1]), low: new Float64Array([1, 1]),
      close: new Float64Array([1, 1]), volume: new Float64Array([NaN, NaN]),
      indicators: [
        { uid: "bad", id: "unknown-indicator", panel: "overlay", params: {} },
        { uid: "good", id: "sma", panel: "overlay", params: { period: 1 } }
      ]
    }
  });
  assert.equal(response.type, "result");
  assert.equal(response.results.length, 2);
  assert.ok(Array.isArray(response.errors));
});
