# openslice

`openslice` is another name for [carveout](https://www.npmjs.com/package/carveout).
Both run the same CLI, so `npx -y openslice <command>` does exactly what
`npx -y carveout <command>` does:

```sh
npx -y openslice plan  apps/api/src/billing --depth 1 --with-tests
npx -y openslice cut   apps/api/src/billing --depth 1 --with-tests --public --out ../billing-slice
npx -y openslice check ../billing-slice
npx -y openslice patch ../billing-slice --output billing.patch
npx -y openslice impact --base main --run
npx -y openslice gate --base main
```

carveout hands one part of a closed TypeScript repository to an outside
contractor. The slice installs, builds and tests on its own, with stubs and
mocks in place of the rest of the code, and the work comes back as a checked
patch. The full documentation is in the
[carveout README](https://github.com/lunox-work/carveout#readme).

Messages and `--help` still say `carveout`.
