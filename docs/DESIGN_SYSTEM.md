# Echo design system

A spec for building screens, and a list of the things currently on screen that
this document says to stop doing.

Written after auditing `src/`, not before imagining it. The numbers in §0 are what
is actually in the codebase. Where this document and the existing files disagree,
the existing files are what is shipping, and the gap between them is the work.

---

## 0. What is wrong now

**Twenty-two greys.** `#8a8a86` appears 213 times, `#9b9b96` 14, `#b5b5ad` 38,
`#d5d5cf` 9, `#b5b5b0` 8. These are five different colours for "the muted text",
invented per use. Somebody reading two screens cannot tell whether the difference
between `#8a8a86` and `#9b9b96` is meaningful or an accident, and the honest
answer is that it is an accident.

**Two ambers and three reds.** `#b45309` (18×) and `#b5801f` (12×) are both
"warning". `#b03a20` (10×), `#c0462e` (7×) and `#8a2a2a` (8×) are all "error".
`index.css` already declares `--news-amber: #b45309`, so that one wins and the
others go. A palette with two warnings is a palette where half the warnings are
not warnings.

**Everything is ten pixels.** `text-[10px]` 150 times, `text-[11px]` 71 times.
Then nothing between 12 and 19. There is no ramp — there is a floor and a jump.
Body text in a 1600px viewport should be 13px, and no screen currently has any.

**Eleven arbitrary hex values.** Not twenty-two — twenty-two in Leads and the
dashboard together, of which the ones above are the duplication. A design system
whose colours are written inline in 700 places is not a design system.

**Spacing is fine.** Tailwind's scale is used consistently; the arbitrary values
are all heights, which is a different problem and a smaller one.

---

## 1. Colour

### Ink

| token | hex | use |
|---|---|---|
| `ink` | `#141414` | headings, figures, anything load-bearing |
| `ink-2` | `#4a4a47` | body text on white |
| `ink-3` | `#8a8a86` | labels, secondary text, placeholders |
| `ink-4` | `#b5b5ad` | disabled, hints, decorative |

Four steps. `#9b9b96` and `#b5b5b0` are deleted; both were "muted" and `#8a8a86`
already is.

### Surface and rule

| token | hex | use |
|---|---|---|
| `bg` | `#f6f6f4` | the page |
| `raised` | `#ffffff` | cards, panels |
| `sunken` | `#fbfbfa` | table headers, nested panels |
| `well` | `#f0f0ec` | skeletons, inactive chips |
| `rule` | `#e3e3de` | the visible border of anything |
| `rule-soft` | `#eeeeea` | internal dividers, no border of its own |

Six. `#deded8` becomes `rule`; `#c9c9c2` becomes `rule-soft`; `#d5d5cf` becomes
`ink-4` at reduced opacity or a `border-dashed` where it meant "unreached".

### Signal

| token | hex | meaning | never used for |
|---|---|---|---|
| `good` | `#1a7f4b` | verified, delivered, worked | anything merely present |
| `warn` | `#b45309` | needs attention, catch-all, paused | errors |
| `bad` | `#b03a20` | failed, no mailbox, out of credits | warnings |

Three. The rule that matters: **`warn` is never a softer `bad`.** Catch-all is
amber because it is a usable answer with a caveat. Out of credits is red because
the run stops. `#b5801f`, `#c0462e` and `#8a2a2a` are deleted.

A red that means "one row failed" and a red that means "your account is empty"
must not be the same red. `bad` with a number next to it is fine; `bad` on a
whole panel is a claim about the account and should be `warn`.

### Provider chips

The one place colour is decorative. A pastel fill plus a darker ink of the same
hue, because the fills are far too light to read as text. Keyed on the endpoint's
prefix, not its exact id, so a new endpoint on a provider already in the list
inherits its colour without anyone editing a file. Leave this as it is.

---

## 2. Type

Two families and four roles. The rule that fixes most of §0 is that **a size is
chosen by role, never by eye.**

| role | size | family | tracking | use |
|---|---|---|---|---|
| `label` | 10px | mono | `uppercase` + `0.05em` | section labels, column headers, table meta |
| `body` | 13px | Inter | `-0.012em` | sentences, descriptions, anything being read |
| `figure` | 20px | mono | `-0.025em`, tabular | numbers the user acts on |
| `title` | 18px | Inter | `-0.025em` | page and screen titles |

**`text-[Npx]` is banned inside this ramp.** A size is one of four. `11px` exists
in 71 places and should become `label` or `body` — which one is a judgement each
time, and getting it wrong is a two-second decision that a scale cannot make for
you.

**Mono is for numbers and labels. Never for a sentence.** This is already the rule
in most of the app and it is the right one: mono's job here is to make a column of
figures align and to make a label read as a label rather than as content. The
Opus screenshots break it — their "Free count" sentence is set in mono at 14px and
is noticeably harder to read than the same sentence in Inter.

**Figures are tabular.** Always. A number that changes width as it ticks makes the
column jump and the eye reads the movement instead of the value. This is why every
figure class carries `tabular-nums`.

---

## 3. Spacing

4px base. The names exist so that `gap-6` means the same thing in two files.

| name | value | use |
|---|---|---|
| `tight` | 4 | inside a control |
| `snug` | 8 | between a label and its value |
| `base` | 12 | between rows in a list |
| `roomy` | 16 | panel padding, at the small end |
| `wide` | 24 | between panels |
| `airy` | 32 | between page sections |

Nothing else. A padding value not on this list is a bug.

---

## 4. Density

One rule, and it is the one that makes a dense product readable.

**Rows are 44px. Nothing else is.**

44 is the number from the iOS and Material guidelines because it is the smallest
height a fingertip can hit reliably, and a row in a data table is a target. The
table offers a 34px compact mode, and it is opt-in from a control rather than a
default, because the default for a table somebody will click on is the one that is
easy to click.

Headers are 36px. Toolbars are 44px. Both are consequences of the same rule: if a
row is 44px, the header above it cannot be 28px without the eye stalling on the
boundary between them.

**Every row height is a variable, not a literal.** The table's density toggle
changes one number and the skeleton changes with it, because a skeleton at 44px
under a table that has just switched to 34px makes the table jump, and once the eye
has seen the jump it expects it on every later load.

---

## 5. The page frame

| screen | max width | why |
|---|---|---|
| form or list screen | `max-w-5xl` (1024) | a form wider than this has fields too far from their labels |
| lead table | `max-w-[1400px]` | six columns stop being readable at 1024 |
| settings | `max-w-3xl` (768) | nothing there needs width |

All three are `mx-auto px-6 py-8`. A screen that stretches to 1600px is not
filling space, it is spreading one column of content until the eye has to travel.

**Every screen has a header.** Title at `title` size, one line of `body` in
`ink-3` underneath, controls right-aligned. This is why Leads read as a prototype
beside Billing: it had no header at all, so there was nothing to be at the top of
the page and the content started wherever it started.

---

## 6. Components

What each shared piece is, so they are built once.

**Panel** — `rule` border, `raised` fill. Header row 44px carrying a `label` and
whatever control belongs there. Body `roomy` padding, or flush for a table.
Panels stack with `wide` between them.

**Button** — one primary style: `ink` fill, white text, `snug` padding, mono at
`label` size. Square. One secondary: `rule` border, `ink-2` text. No third
style; a third style is a need for a specific screen, not a system variant.

**Figure** — a `label` and a `figure`-size number, optional one-line sub-label.
The sub-label states the **denominator**, not the implication: "of 61 at most", not
"most of your run". `Found 0` is not information; `0 of 3` is a state.

**Stat tile** — a figure with a bar beneath it, drawn against a total the user can
see named. A bar scaled to an unnamed maximum communicates nothing.

**Status pill** — a word, in `warn` or `good`, never a bare colour. A coloured dot
with no word is a legend nobody has.

**Table row** — 44px. Checkbox 28px. First cell carries the identity (logo, name,
domain). The last column is always cost, because this is a product that charges
per lookup and the row that does not say what it cost is the row somebody has to
open to find out.

**Empty state** — one line saying what is here now, and the action that makes it
exist. Never a paragraph describing a feature that does not exist yet.

---

## 7. Motion

Motion is for two things only: **a thing that just changed, and a thing that is
still happening.**

| what | how long | why |
|---|---|---|
| a value that changed | 300ms ease-out | the eye was on the old number and needs to be led to the new one |
| a bar that grew | 500ms, ease-out | same |
| a row that arrived | 150ms, 4px rise | enough to notice, not enough to read as a slideshow |
| a running indicator | 1.4s loop | the only loop in the product |

Everything else is instant. A progress bar that fills over 200ms on load, or a
panel that fades in on navigation, is motion with no information in it.

**`prefers-reduced-motion` collapses all of it to 0ms**, not to a slower version.
The one exception is the running indicator, which becomes a static filled dot —
"this is happening" is still worth saying, and a still image of it says it.

---

## 8. Getting from here to there

Not a rewrite. In order, each step shippable on its own.

**1. Add the tokens to `index.css`.** The CSS custom properties already exist for
six of them. The point is a name to aim at, not the colour itself.

**2. Replace the duplicates.** `#9b9b96` → `ink-3`. `#b5b5b0` → `ink-4`.
`#deded8` → `rule`. `#b5801f` → `warn`. `#c0462e` → `bad`. `#8a2a2a` → `bad`.
About 65 occurrences. Mechanical, reviewable in one pass, and it is the step that
makes every later step easier to review because there is one colour to argue
about instead of two.

**3. Kill the 11px.** 71 occurrences. Most become `label` or `body`; the judgement
per site is quick and the result is a real ramp.

**4. Do not touch Feed or Billing yet.** They are the reference, not the target.
Normalising them is a separate piece of work and doing it at the same time as the
Leads work means a diff nobody can read.

**5. Every new screen is built to this.** The point of a spec is not to fix the
past, it is that the next screen does not add a twenty-third grey.

---

## 9. What this document says no to

**A second page width.** One frame per screen type, listed above. A screen that
needs a fourth is a screen that has been given two jobs.

**Gradients, shadows, and radii.** Square corners and a `rule` border are the
app's texture. A soft shadow says "this floats above the page", and nothing here
floats above the page — it is a desk.

**A colour for every provider in the palette.** The chips are the only decorative
colour, and they are keyed off the endpoint prefix precisely so that adding a
sixth provider does not require editing a palette file.

**Motion on navigation.** A panel that fades in when you switch tabs is a panel
that has arrived, and it already said so by being on the screen.

**Anything that needs the data provider.** None of this document is about what the
product can fetch. It is about what it does with what it already has.