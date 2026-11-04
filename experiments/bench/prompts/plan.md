You are in a checkout of a TypeScript monorepo, at the current directory.
Its dependencies are installed. Do not implement anything here. Your job is
to choose the entry points of a slice: the files or folders a change needs,
so that someone can work on the spec below in a slice of this repository
without the rest of it.

The slicer is at `.carveout/`. Preview what a cut would hold with

    node .carveout/dist/src/cli.js plan <entry>... --repo . --depth 1 --with-tests

It reads the import graph and writes nothing. It lists the files the slice
would hold, the modules it would cut (each becomes a `.d.ts` stub and a
recording mock), the files outside the slice that import it, and its
tests. Entry points are files or folders relative to the repository's
root; a file the spec says to add does not exist yet, so name the folder
or module it will live beside. Keep the slice small: the files the change
edits, the module they belong to, and the tests of that module.

The change is in the package `{{package}}`, under {{allowed}}, and its
tests go under `{{package}}/test/`.

When you have chosen, write the entry points to `.carveout/entries`, one
repository-relative path per line, and stop. Write nothing else.

<spec>
{{spec}}
</spec>
