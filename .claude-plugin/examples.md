- "Hand `src/billing/invoice.ts` to an outside contractor: cut a slice that
  installs, builds and tests on its own, with a task to add VAT rounding."
  The carveout skill plans the slice, cuts it into a folder with a TASK.md,
  and says whether it is ready to hand off.
- "The contractor sent back their folder. Check it and give me a patch I can
  apply." The carveout skill turns the work into a patch, holding CI,
  manifest and lockfile edits and tests bent to pass.
- "My agent changed `packages/api`. What does the change reach, which tests
  should I run, and did it weaken any test?" The carveout-gate skill runs
  `impact` and `gate` and reports the files reached, the tests to run and any
  weakened test or config edit.
