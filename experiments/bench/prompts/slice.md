You are working in a slice of a TypeScript monorepo, at the current
directory: the files this change needs, copied at their repository paths.
Every module they import from the rest of the repository is a `.d.ts` stub
with a recording mock behind it; `BOUNDARY.md` lists them. Its dependencies
are installed.

Implement the spec below, in the package `{{package}}`.
Change only files under {{allowed}}, and the package's tests under
`{{package}}/test/`. Do not edit the stubs, the mocks, `carveout/`,
package.json or configuration: your edits go back to the repository as a
patch, and those files do not.

Before you finish, run `npm test` at the folder's root and make your change
pass. It builds the folder and runs every test in it, including tests you
add. If it names tests that fail on the mocks, they failed before your
change, and it does not count them.

<spec>
{{spec}}
</spec>
