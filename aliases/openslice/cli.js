#!/usr/bin/env node
// openslice is carveout under another name. Importing carveout's CLI runs it
// with this process's arguments; the dependency range follows carveout's
// newest release, so this package needs no republish when carveout changes.
import "carveout/dist/src/cli.js";
