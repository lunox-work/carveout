# Identicon: a default avatar derived from an account id

Every user and organization gets a default avatar computed from its id, with
nothing uploaded or stored: a 5×5 grid mirrored left to right, plus a hue.
The function goes in `packages/shared/src/identicon.ts` as a **frozen
contract**. What it returns decides how every existing account looks, and a
change to it cannot be migrated or rolled back. So this spec fixes the exact
algorithm, and golden vectors pin its output. A determinism test alone would
still pass after a refactor that silently changed every face.

`packages/shared` is bundled by the browser and the extension, so the module
imports nothing: no `zod`, no `node:*`. It uses only the `TextEncoder`
global, which Node 22+ and browsers both provide. `crypto.subtle` (used by
`specHash` in `packages/jira`) is not an option because it is async, and
`identicon` is synchronous.

## Exports

In `packages/shared/src/identicon.ts`, exactly as the ticket gives them:

```ts
export interface Identicon {
    readonly cells: readonly boolean[];
    readonly hue: number;
}

export function identicon(seed: string): Identicon;
```

The module exports nothing else. Its helpers (the hash, the bit layout) stay
private.

`packages/shared/src/index.ts` adds `export * from "./identicon.js";` so that
`@sandbox-factory/shared` exposes `identicon` and `Identicon`. The `exports`
map only offers `"."`. Every existing export of `index.ts`, `build-info.ts` and
`jira.ts` keeps its current name and behaviour.

## Algorithm (normative)

1. **Input.** Every string is accepted, including `""`. There is no runtime
   check of the argument's type; the `string` signature is the only guard.
2. **Bytes.** `bytes = new TextEncoder().encode(seed)`, which is UTF-8. The
   seed is not trimmed, case-folded or Unicode-normalized. A lone surrogate
   encodes as U+FFFD, as `TextEncoder` always does.
3. **FNV-1a, 32-bit.** `h = 0x811c9dc5`. For each byte `b` in order:
   `h = Math.imul(h ^ b, 0x01000193)`, and finally `h = h >>> 0`.
   The result is an unsigned 32-bit integer. There is no finalizer step.
4. **Cells.** `cells` has length 25 and is row-major: index `row * 5 + col`,
   with `row` and `col` in `0..4`, row 0 at the top and col 0 at the left.
   The source column is `k = col <= 2 ? col : 4 - col`, so col 3 mirrors col 1
   and col 4 mirrors col 0. Then
   `cells[row * 5 + col] = ((h >>> (row * 3 + k)) & 1) === 1`.
   The grid uses bits 0–14 of `h`.
5. **Empty grid.** If no cell is `true` (bits 0–14 of `h` are all zero), the
   centre cell, index 12, is set to `true`. Nothing else is adjusted.
6. **Hue.** `hue = (h >>> 15) % 360`, from bits 15–31, which are disjoint from
   the cell bits. It is an integer in `0..359`, in degrees, with no rounding
   step.
7. **Result.** Return a new plain object `{ cells, hue }` with a new `cells`
   array on every call. Neither is frozen. There is no cache and no module
   state.

A grid with every cell set is returned unchanged. A grid with no cells set
gets only its centre cell. Nothing re-rolls the hash.

Lightness, chroma, the SVG path, the viewBox and the React component all
belong to the web app. None of them is part of this contract.

### Reading the grids below

A grid is written as five space-separated rows, top to bottom. Each row has
five characters, left to right. `#` is `true` and `.` is `false`. To get
`cells`, concatenate the rows and map each character to a boolean. For
example, `##.## #...# ..... .###. #####` is:

```ts
[true, true, false, true, true,
 true, false, false, false, true,
 false, false, false, false, false,
 false, true, true, true, false,
 true, true, true, true, true]
```

The `h` columns give the hash value, so a developer can debug
against them. Tests check only `cells` and `hue`.

```gherkin
Feature: identicon derives a mirrored 5x5 grid and a hue from a seed
  identicon(seed) is a pure, synchronous function of the seed's UTF-8 bytes,
  hashed with FNV-1a 32-bit and no finalizer. Bits 0-14 give the grid and
  (h >>> 15) % 360 gives the hue.

  Rule: Golden vectors pin the output for four seeds, and any change to them is a breaking change

    @happy
    Scenario Outline: A pinned seed produces its pinned face
      When identicon is called with seed "<seed>"
      Then cells is the grid "<grid>"
      And hue is <hue>

      Examples:
        | seed                             | h          | grid                          | hue |
        | a                                | 0xe40c292c | ..#.. #.#.# ..#.. ..#.. .#.#. | 120 |
        | user-1                           | 0xf5537974 | ..#.. .###. #.#.# ..#.. ##### | 326 |
        | user-2                           | 0xf8537e2d | #.#.# #.#.# ..... ##### ##### | 62  |
        | Zb8f2Kq9Lm3Nx7Rt5Vw1Yc6Hd4Jp0Gs | 0xbe3a26be | .###. ##### .#.#. ##.## .#.#. | 196 |

    @happy
    Scenario: The pinned face for "a" as a literal cells array
      When identicon is called with seed "a"
      Then the result deep-equals:
        """
        { cells: [false, false, true, false, false,
                  true, false, true, false, true,
                  false, false, true, false, false,
                  false, false, true, false, false,
                  false, true, false, true, false],
          hue: 120 }
        """

  Rule: The result has a fixed shape - 25 booleans, mirrored, and an integer hue in 0..359

    @happy
    Scenario Outline: Every result has the contract's shape
      When identicon is called with seed "<seed>"
      Then cells has length 25
      And every element of cells is a boolean
      And for every row r in 0..4, cells[r*5+4] equals cells[r*5+0]
      And for every row r in 0..4, cells[r*5+3] equals cells[r*5+1]
      And hue is an integer with 0 <= hue <= 359
      And the result's own keys are exactly "cells" and "hue"

      Examples:
        | seed                             |
        | a                                |
        | user-1                           |
        | user-2                           |
        | Zb8f2Kq9Lm3Nx7Rt5Vw1Yc6Hd4Jp0Gs |

  Rule: The same seed always gives an equal result, in a new object, whatever was called before

    @happy
    Scenario: Repeated calls agree
      When identicon is called twice with seed "user-1"
      Then the two results are deep-equal
      And the two results are not the same object
      And their cells arrays are not the same array

    @concurrency
    Scenario: Interleaved calls do not affect each other
      Given identicon has already been called with "user-2", "a" and "" in that order
      When identicon is called with seed "user-1"
      Then cells is the grid "..#.. .###. #.#.# ..#.. #####"
      And hue is 326

    @concurrency
    Scenario: Calls made from overlapping async tasks agree with sequential calls
      When Promise.all runs 100 async tasks, each awaiting a resolved promise and then calling identicon with "user-1" or "user-2", alternating
      Then every "user-1" result deep-equals identicon("user-1")
      And every "user-2" result deep-equals identicon("user-2")

  Rule: The seed is hashed byte for byte as UTF-8, with no trimming, case folding or normalization

    @boundary
    Scenario Outline: Seeds that differ in any way give their own faces
      When identicon is called with seed <seed>
      Then cells is the grid "<grid>"
      And hue is <hue>

      Examples:
        | seed                         | note                         | h          | grid                          | hue |
        | "a"                          | baseline                     | 0xe40c292c | ..#.. #.#.# ..#.. ..#.. .#.#. | 120 |
        | "A"                          | case is significant          | 0xc40bf6cc | ..#.. #...# ##.## ##.## ##### | 295 |
        | " a"                         | whitespace is not trimmed    | 0x70c54c3a | .#.#. ##### ..... .###. ..#.. | 138 |
        | "café"                  | NFC, U+00E9                  | 0xa82b5049 | #...# #...# #...# ..... #.#.# | 62  |
        | "café"                 | NFD, e + U+0301, not equal   | 0xd6dd9437 | ##### .###. ..... .#.#. #...# | 211 |

    @boundary
    Scenario: A lone surrogate hashes as U+FFFD, the replacement TextEncoder makes
      When identicon is called with seed "\uD800"
      Then the result deep-equals identicon("�")
      And cells is the grid ".#.#. #...# #...# .###. #...#"
      And hue is 239

  Rule: Every string is a valid seed, including the empty string and very long ones

    @boundary
    Scenario: The empty seed is accepted and hashes zero bytes
      When identicon is called with seed ""
      Then it does not throw
      And cells is the grid "#.#.# ..... ##### .###. #...#"
      And hue is 225

    @boundary
    Scenario Outline: A long seed is hashed in full, not truncated
      When identicon is called with seed "x" repeated <n> times
      Then cells is the grid "<grid>"
      And hue is <hue>

      Examples:
        | n     | h          | grid                          | hue |
        | 9999  | 0x8e91ef7f | ##### ##### #.#.# ##### .###. | 275 |
        | 10000 | 0x76bb4805 | #.#.# ..... ..... ..#.. ..#.. | 310 |

  Rule: A hash that fills no cell gets the centre cell; a hash that fills every cell is kept

    @boundary
    Scenario Outline: Degenerate hashes
      When identicon is called with seed "<seed>"
      Then cells is the grid "<grid>"
      And hue is <hue>

      Examples:
        | seed       | note                        | h          | grid                          | hue |
        | user-46623 | no cell bit set, centre lit | 0x55ee0000 | ..... ..... ..#.. ..... ..... | 76  |
        | user-54233 | no cell bit set, centre lit | 0x8c0c0000 | ..... ..... ..#.. ..... ..... | 64  |
        | user-46705 | every cell bit set, kept    | 0x6b5bffff | ##### ##### ##### ##### ##### | 247 |

  Rule: Adding identicon changes no existing export of the package

    @happy
    Scenario: The package entry point re-exports identicon alongside the existing exports
      When the test imports identicon from "../src/index.js"
      Then it is the same function as identicon from "../src/identicon.js"
      And formatVersion, buildInfoSchema and handleSchema are still exported from "../src/index.js" and behave as before
```

Decided:

- Hash algorithm: plain FNV-1a 32-bit over UTF-8 bytes, with no finalizer. It is synchronous and needs no dependency (`crypto.subtle` is async, and `node:crypto` cannot be bundled for the browser).
- Bit layout: bit `row*3 + k` sets row `row`, source column `k` in `0..2`; cols 3 and 4 mirror cols 1 and 0.
- `cells` order: row-major, 25 entries, top-left first.
- Hue: integer `(h >>> 15) % 360` in `0..359`, with no rounding and bits disjoint from the grid.
- Golden seeds: `a`, `user-1`, `user-2`, `Zb8f2Kq9Lm3Nx7Rt5Vw1Yc6Hd4Jp0Gs`.
- Text handling: the seed is not trimmed, case-folded or Unicode-normalized; lone surrogates become U+FFFD via `TextEncoder`.
- Empty seed: accepted, and gives the zero-byte hash's face.
- Length limit: none; the whole seed is hashed.
- Degenerate grids: a hash with bits 0–14 all zero gets only the centre cell (index 12) set, pinned by `user-46623`; an all-on grid is returned as computed, pinned by `user-46705`; the hash is never re-rolled.
- Non-string input: not validated at runtime and outside the contract; the `string` signature is the only guard, so tests do not pin it.
- Result objects: a new plain object and a new `cells` array per call, not frozen; no cache or module state.
- Overlapping calls: none can conflict, because the function is synchronous and stateless; results do not depend on call order.
- Package surface: `index.ts` re-exports `identicon.ts`; all existing exports are unchanged.
