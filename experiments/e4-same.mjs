// E4 fix check: the graph a build writes, before and after, compared as
// canonical JSON of nodes, links, files and invalid configs.
// node experiments/e4-same.mjs <repo> <dist/src before> <dist/src after>
const [, , root, before, after] = process.argv;
const canon = (g) => JSON.stringify({ nodes: g.graph.nodes, links: g.graph.links, files: g.files, invalid: g.invalidConfigs });
const a = (await import(`${before}/graph.js`)).buildGraph(root);
const b = (await import(`${after}/graph.js`)).buildGraph(root);
console.log(root.split("/").pop(), "identical:", canon(a) === canon(b), "before", a.timings, "after", b.timings);
