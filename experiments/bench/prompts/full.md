You are working in a checkout of a TypeScript monorepo, at the current
directory. Its dependencies are installed, and the workspace packages that
`{{package}}` depends on are built.

Implement the spec below, in the package `{{package}}`.
Change only files under {{allowed}}, and the package's tests under
`{{package}}/test/`. Do not change package.json files, lockfiles or
configuration.

Before you finish, run the package's tests and make them pass:
`npm test` in `{{package}}`.

<spec>
{{spec}}
</spec>
