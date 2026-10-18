# Echo Leads — cleanup and redesign plan

Handover document. Any engineer or AI assistant should be able to pick this up
and continue from the **Status** section without any other context.

Repository: `C:\Users\Sonali\Desktop\eco` (Vite + React + TypeScript, Tailwind v4,
Supabase edge functions in Deno). Branch: `leads-lead-intelligence`.
Read first: `docs/LEADS_UPGRADE.md` (what Leads does today, backend, billing, tests).

---

## Status (update this section as you work)

| Phase | State | Notes |
|---|---|---|
| 1. Design foundation | **Complete** | 1.1 tokens **done** (e5fe17f). 1.2 StatusPill **done** (1e952d6). 1.3 dialogs **done** (603db2b). 1.4 Screen frame **done** (e03df97). 1.5 PriceSummary **done**: new `PriceSummary` displays expected, max, available coverage with Top up link when short, rows, capPerRun warnings, notes and breakdown. Used across `CostDialog`, `NewSearch`, `CleanList`, and `AutomationsView`. `PriceBar` removed from `Screen.tsx`. Phase 1 complete. |
| 2. Navigation (11 tabs → 4) | **Complete** | Consolidated 11 tabs into 4 unified hubs: **Find** (Search, Find by profile, Import CSV), **Leads** (People, Companies with Left Sidebar for Views, Lists, and Saved Searches + Automate shortcut), **Activity** (Runs & Usage summary cards, Automations), and **Settings** (Fit Scoring, Duplicate Review, Opt-outs, Provider Lab). Subnav updated with legacy route redirects, inline dialogs, and responsive layout. |
| 3. Remove duplicate flows | **Complete** | Eliminated duplicate actions & tables: 1) Run view now has primary CTA "View in Leads Directory" with `{ run_id }` filter and no confusing duplicate bulk buttons. 2) Replaced duplicate export implementations with unified `ExportDialog.tsx` supporting CSV & Excel (.xlsx), verified-only filter, and waterfall attempts audit. 3) Added Free CRM Import in `CleanList.tsx` allowing free CSV saving directly to CRM & list. 4) Left sidebar in Leads hub now has inline Rename/Delete list management with confirmation dialogs. 5) Cleaned up toolbar buttons. |
| 4. Backend support | **Complete** | Added `run_id` filter to `contactsFilter` in `supabase/functions/leads/workspace.ts`. Added free `contacts_import` endpoint in `workspace.ts` and `index.ts` allowing direct merge of up to 5,000 CSV contacts to `lead_contacts` with auto company linking and scoring (0 credits charged). |
| 5. Verification and docs | In progress | Verification suites clean: tsc, deno typecheck, vite build, 14 node suites, and check-deploy-all. Browser subagent verified visually. |

Last commit before this plan: `e180346 leads: automations with a spending cap on every run`.

Open decisions for the product owner (ask before Phase 2/3):
1. Should **Provider lab** be visible to normal users, or admin only?
2. Should the run's **audit table** (which provider answered, what it cost) stay
   as a screen, or only be available as an export?

---

## Ground rules

- Do not change billing, pricing or the run worker in Phases 1–3. Those are UI phases.
- Every paid action must keep going through `CostDialog` (priced confirmation,
  request id). Never add a button that spends credits on a single click.
- Keep the old hash routes working (redirect them) when navigation changes.
- Commit after each completed step with a clear message. Do not amend earlier commits.
- After every step, run the checks in **Verification commands** below. All must pass.

## Verification commands

```bash
npx tsc -b
```

```bash
node scripts/typecheck-leads-function.cjs
```

```bash
npx vite build
```

```bash
for f in supabase/tests/*.cjs; do case "$f" in *webhook-signature*) continue;; esac; node "$f" >/dev/null 2>&1 && echo "ok   $f" || echo "FAIL $f"; done
```

```bash
node scripts/check-deploy-all.cjs
```

`webhook-signature-tests.cjs` is a live test that needs a URL and a secret as
arguments. Skip it offline.

---

## 0. What is wrong today (audit, 18 Oct 2026)

Leads sub-nav (`src/components/dashboard/LeadsTab.tsx`, `SUB_NAV`) has 11 items:
Search, People, Companies, Lists | Runs, Find by profile, Import, Automations,
Usage, Provider lab, Opt-outs.

### Same job done in two or more places

| Job | Where | Problem |
|---|---|---|
| Find new leads | `SearchView.tsx` (LeadsForge people search) and `NewSearch.tsx` ("Find by profile", ICP run) | Two unrelated tabs for the same goal |
| Verify / find phone | People bulk actions (`PeopleView.tsx`, `enrich_start`) and run table buttons (`LeadsTable.tsx` "Re-verify / Find phone", `bulk` action in `index.ts`) | Two backend paths for one feature |
| Export | `PeopleView.tsx doExport` (own column list) and `ExportMenu.tsx` (run export) | Two implementations, different columns |
| Runs and credits | `RunsList.tsx` and `UsageView` in `CompaniesView.tsx` | Both list runs with credits |
| Import | `CleanList.tsx` | Uploading a CSV immediately creates a **paid** run; there is no free "import to my database" |
| Show a price | `PriceBar` (`Screen.tsx`, used by `NewSearch.tsx`), inline estimate in `CleanList.tsx`, `CostDialog.tsx`, estimate block in `AutomationsView.tsx` | Four different pricing UIs |
| Show results | Run table (`lead_rows`, `LeadsTable.tsx`) and People (`lead_contacts`, `PeopleView.tsx`) | Same people shown twice, with different filters and actions |

### Scattered

- Provider lab and Opt-outs are settings but sit in the main nav.
- Scoring rules and Duplicates are dialogs hidden inside People (`ScoringDialog.tsx`).
- Saved searches live in Search, saved views live in People, Automations depend on
  both, and nothing lists them in one place.

### Inconsistent design

- Only 4 screens use the `Screen` frame (`RunsList`, `NewSearch`, `ProviderLab`,
  `OptOuts`). Search, People, Companies, Lists, Usage, Automations do not, so
  headers and widths differ per tab.
- 853 hard-coded hex colours in `src/components/leads/*.tsx` + `LeadsTab.tsx`,
  including three greens, three ambers and three reds for the same meaning.
- Three status badge styles: `StatusBadge`, `RunStatusPill` (both in
  `StatusBadge.tsx`) and `RUN_STATUS` in `AutomationsView.tsx`.
- 11 uses of browser `window.prompt` / `window.confirm`:
  - `AutomationsView.tsx:151` confirm delete automation
  - `CompaniesView.tsx:87` prompt new target list
  - `CompaniesView.tsx:331` prompt new list
  - `CompaniesView.tsx:369` prompt rename list
  - `CompaniesView.tsx:377` confirm delete list
  - `ContactPanel.tsx:91` confirm delete lead
  - `PeopleView.tsx:165` prompt new list
  - `PeopleView.tsx:185` confirm delete leads
  - `PeopleView.tsx:233` prompt name view
  - `PeopleView.tsx:356` prompt tag to add
  - `SearchView.tsx:187` prompt name search
  (line numbers as of `e180346`; re-grep `window.prompt\|window.confirm`.)
- Two modal styles (centred dialog in `CostDialog`/`ScoringDialog`, side drawer
  `Drawer` in `Pick.tsx`) with no rule for which to use.

---

## Target structure: 4 tabs

| Tab | Contains |
|---|---|
| **Find** | One screen, three modes: *People search* (today's Search) · *Company profile* (today's Find by profile) · *Upload a file* (today's Import, made free-first). Every result lands in Leads. |
| **Leads** | Toggle *People / Companies*. Left panel: Lists, Saved views, Saved searches together, each with an "Automate" action that opens the automation editor prefilled. |
| **Activity** | *Runs* (credit totals on top — today's Usage merged in) · *Automations*. A run opens to progress + audit, with a "See these leads" link to Leads filtered by that run. |
| **Settings** | Scoring rules · Duplicates · Opt-outs · Provider lab (visibility per open decision 1) |

Old hashes redirect: `search`, `new`, `clean` → `find` (with mode); `people`,
`companies`, `lists` → `leads`; `runs`, `usage`, `automations` → `activity`;
`lab`, `optouts` → `settings`; `run/<id>` keeps working. Routing lives in
`src/lib/leads.ts` (`KNOWN_VIEWS`, `leadsRouteFromHash`) and the `LeadsView` type in
`src/types/index.ts`.

---

## Phase 1 — Design foundation (no behaviour change)

Goal: every Leads screen looks like one product. Nothing about what a button does
changes.

### 1.1 Colour tokens

Add to `src/index.css` (Tailwind v4 `@theme`, which creates `text-ink`,
`bg-ink`, `border-line` and so on):

```css
@theme {
  --color-ink: #141414;
  --color-ink-2: #4a4a47;
  --color-muted: #8a8a86;
  --color-faint: #b5b5ad;
  --color-line: #e3e3de;
  --color-line-soft: #eeeeea;
  --color-line-strong: #d5d5cf;
  --color-surface: #f6f6f4;
  --color-surface-2: #fafaf8;
  --color-fill: #f0f0ec;
  --color-ok: #1a7f4b;
  --color-ok-bg: #eef7f1;
  --color-ok-line: #cfe7d8;
  --color-warn: #b45309;
  --color-warn-bg: #fdf6ec;
  --color-warn-line: #f0e0bd;
  --color-danger: #c0462e;
  --color-danger-strong: #b03a20;
  --color-danger-ink: #8a2a2a;
  --color-danger-bg: #fdf1ee;
  --color-danger-line: #f0cfc8;
  --color-info: #2f6aa8;
  --color-info-bg: #eef3f8;
}
```

Mapping from today's hex values (counts across leads components + `LeadsTab.tsx`):

| Hex (count) | Token | Note |
|---|---|---|
| `#141414` (167) | `ink` | |
| `#4a4a47` (40), `#5a5a56` (4) | `ink-2` | |
| `#8a8a86` (210), `#9b9b96` (10) | `muted` | |
| `#b5b5ad` (46), `#c9c9c2` (3) | `faint` | check `#c9c9c2` — may be a border, then `line-strong` |
| `#e3e3de` (123) | `line` | |
| `#eeeeea` (56) | `line-soft` | |
| `#d5d5cf` (10) | `line-strong` | |
| `#f6f6f4` (16) | `surface` | |
| `#fafaf8` (5), `#fbfbfa` (7) | `surface-2` | |
| `#f0f0ec` (10) | `fill` | skeletons, bars |
| `#1a7f4b` (19), `#2f7d4f` (2) | `ok` | |
| `#eef7f1` (2), `#e3f2e9` (1) | `ok-bg` | |
| `#cfe7d8` (1), `#cfe6da` (1) | `ok-line` | |
| `#b45309` (18), `#b5801f` (11), `#b5781f` (5), `#8a6d16` (1) | `warn` | |
| `#fdf6ec` (3), `#fdf6e9` (1), `#f8eedb` (3) | `warn-bg` | |
| `#f0e0bd` (2), `#e8d9bd` (3), `#f3e2bf` (1) | `warn-line` | |
| `#c0462e` (30) | `danger` | |
| `#b03a20` (15) | `danger-strong` | hover/pressed red |
| `#8a2a2a` (7) | `danger-ink` | text on red background |
| `#fdf1ee` (3), `#fdf2f2` (3), `#f8e4df` (2) | `danger-bg` | |
| `#f0cfc8` (3), `#f0c4c4` (3), `#f2d6cf` (2) | `danger-line` | |
| `#2f6aa8` (2) | `info` | |
| `#eef3f8` (1), `#f0f4f8` (1) | `info-bg` | |

How:
1. Add the `@theme` block. Run `npx vite build` to confirm Tailwind accepts it.
2. Replace arbitrary classes mechanically, e.g. `text-[#141414]` → `text-ink`,
   `hover:bg-[#fafaf8]` → `hover:bg-surface-2`, `border-[#e3e3de]` → `border-line`.
   Use a script over `src/components/leads/*.tsx` and
   `src/components/dashboard/LeadsTab.tsx` that rewrites `-[#hex]` to `-token`
   using the table above. Keep opacity suffixes (`/30`).
3. Hex values outside class names (inline `style={{ ... }}`, SVG `fill`, chart
   colours in `Data.tsx`, `WaterfallChain.tsx`) → use `var(--color-…)`.
4. Done when this prints 0:
   `grep -ohE "#[0-9a-fA-F]{6}" src/components/leads/*.tsx src/components/dashboard/LeadsTab.tsx | wc -l`
5. Look at the screens in the browser: the only visible change should be the
   merged near-duplicate greens/ambers/reds.

### 1.2 One status pill

- New `src/components/leads/StatusPill.tsx`: `StatusPill({ tone: 'ok'|'warn'|'danger'|'info'|'neutral', children })`.
- Rebuild `StatusBadge` (email status) and `RunStatusPill` (run status) on top of
  it, keeping their props so call sites do not change.
- Replace `RUN_STATUS` tones in `AutomationsView.tsx` with `StatusPill`.

### 1.3 App dialogs instead of `window.prompt` / `window.confirm`

- New `src/components/leads/Dialogs.tsx` with:
  - `ConfirmDialog({ title, body, confirmLabel, danger?, onConfirm, onClose })`
  - `PromptDialog({ title, label, initial?, placeholder?, confirmLabel, onSubmit, onClose })`
    with Enter to submit, Escape to close, focus on open, and an inline error
    slot (for `name_taken`).
  - Optional hooks `useConfirm()` / `usePrompt()` that return a Promise, so call
    sites change from `window.prompt(...)` to `await prompt({...})` with minimal edits.
- Replace all 11 call sites listed in section 0.
- Modal rule (write it at the top of `Dialogs.tsx`): **centred dialog for a
  decision** (confirm, name something, pay), **side drawer for details** (a lead,
  a company, an automation editor).
- Make `CostDialog` and `ScoringDialog` use the same dialog shell.

### 1.4 Every view in the `Screen` frame

- `Screen` is in `src/components/leads/Screen.tsx` (title, subtitle, icon,
  max-w-5xl). Wrap `SearchView`, `PeopleView`, `CompaniesView`, `ListsView`,
  `UsageView`, `AutomationsView` in it.
- Tables that need more room (People, Companies, run table) can use a `wide`
  prop on `Screen` (add it: `max-w-7xl`) rather than skipping the frame.
- One header pattern: title + one muted line on the left, the primary action on
  the right (e.g. "New automation", "Save search").
- Move the intro paragraphs currently at the top of Usage and Automations into
  the `Screen` subtitle.

### 1.5 One price component

- New `src/components/leads/PriceSummary.tsx`:
  `PriceSummary({ expected, max, available?, rows?, note?, capPerRun? })` showing
  expected credits, maximum credits, what the wallet can cover, and a Top up link
  when `available < max`. It never decides anything; it only displays.
- Use it in: `CostDialog.tsx`, `NewSearch.tsx` (replace `PriceBar`),
  `CleanList.tsx` inline estimate, `AutomationsView.tsx` estimate block.
- Remove `PriceBar` from `Screen.tsx` once unused.

Phase 1 is done when: 0 hex colours in leads files, 0 `window.prompt/confirm`,
every view in `Screen`, one pill, one price component, all verification commands
pass, and a browser pass shows no layout regressions.

---

## Phase 2 — Navigation (11 tabs → 4)

1. Change `LeadsView` in `src/types/index.ts` to `'find' | 'leads' | 'activity' | 'settings' | 'run'`
   plus a sub-mode (e.g. `#dashboard/leads/find/profile`). Update
   `KNOWN_VIEWS` and `leadsRouteFromHash` in `src/lib/leads.ts`, with the
   redirects listed under **Target structure**.
2. `LeadsTab.tsx`: new `SUB_NAV` with 4 items; each tab renders a small
   segmented control for its modes (use `Segmented` from `Screen.tsx`).
3. **Find**: modes render the existing `SearchView`, `NewSearch`, `CleanList` unchanged.
4. **Leads**: People/Companies toggle; move `ListsView` into a left panel; add saved
   views and saved searches to the same panel (data: `getSavedSearches`,
   `getLists` in `src/lib/leads-db.ts`); "Automate" opens `AutomationsView`'s
   editor prefilled.
5. **Activity**: Runs + Automations; put Usage totals above the run list.
6. **Settings**: Scoring (move `ScoringDialog` content into a page), Duplicates,
   Opt-outs, Provider lab.
7. Check every old hash in the browser lands on the right new place.

## Phase 3 — Remove duplicate flows (needs Phase 4)

1. Run table (`LeadsTable.tsx`): remove bulk Re-verify / Find phone, opt-out and
   export. Add "See these leads" → Leads filtered by this run. Keep the audit
   (attempts, waterfall) depending on open decision 2.
2. One export: People's export, plus an option "include provider attempts" for
   audit. Delete the duplicate code path (`ExportMenu.tsx` or `doExport`,
   whichever is kept, absorbs the other's columns).
3. Usage → merged into Activity → Runs (done in Phase 2 layout; delete `UsageView`).
4. Import becomes free-first: upload → map columns (`ColumnMapper.tsx`) → saved
   to Leads (optionally a list) → then "Find emails / Verify" through `CostDialog`.
   The direct paid clean run goes away from the UI.

## Phase 4 — Backend support (can run in parallel with Phase 1)

Files: `supabase/functions/leads/workspace.ts`, `index.ts`, tests in `supabase/tests/`.

1. `contacts_query` filter **run_id**: contacts that have a `lead_rows` row in
   that run. A contact can be re-enriched by a later run, so `last_run_id` is not
   enough; join through `lead_rows.extra->>contact_id` or add a link table if
   that is not reliable (check `lead_contact_upsert_from_row` in
   `20261118_lead_database.sql`). Keep `contactsFilter` synchronous (a static test
   enforces it).
2. Free `contacts_import` action: takes mapped rows (max 5000), merges each via
   `lead_contact_merge`, scores, optional list. No credits, no run.
3. Keep the old `bulk` reverify/find_phone action working for one release after
   the UI stops calling it; then remove it and its tests.
4. Add assertions to `lead-rpc-signature-tests.cjs` for any new RPC, and a test
   suite for the import cleaning (pattern: `lead-automation-rules-tests.cjs`).
5. Run `node scripts/typecheck-leads-function.cjs` (add any new module to its list).

## Phase 5 — Verification and docs

**Browser checks without a login.** The dashboard needs a Supabase session, so
screens were checked on a temporary page (`leads-harness.html` + `src/leads-harness.tsx`,
deleted after use) that patches `window.fetch` before importing the app: any
`/functions/v1/` request returns a canned JSON per `action`, and other remote
requests return `[]`, so nothing leaves the machine. It renders `LeadsTab`
directly. The file needs a top-level `import "react";` (otherwise Vite treats it
as CommonJS), and `NewSearch` needs `AuthProvider`, so wrap the tree in it or skip
that tab. The app window may be hidden, so screenshots can time out: measure
through the DOM with `javascript_tool` instead (h1 per tab, widths, overflow at
375px with `resize_window` preset mobile).

1. Browser pass of every tab at desktop and phone width (375px), against canned
   function responses (the earlier upgrade did this; `docs/LEADS_UPGRADE.md`
   section 6). No horizontal scroll on phone.
2. All verification commands pass.
3. Update `docs/LEADS_UPGRADE.md` (new navigation, removed flows) and this file's
   Status table.

---

## Parallel work

- Phase 1 (UI files under `src/`) and Phase 4 (files under `supabase/`) touch
  different files and can run in two sessions at once.
- Phase 2 needs Phase 1. Phase 3 needs Phases 2 and 4.
- Inside Phase 1, step 1.1 touches every leads file; do it first and commit before
  1.2–1.5, or two sessions will conflict.
