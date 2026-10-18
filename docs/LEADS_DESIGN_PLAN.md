# Echo Leads — design plan

Written against four screenshots of Opus (a YouTube walkthrough, a competitor).
Not "make it look like that" — the visual language stays Echo's, square and
monochrome and mono-labelled, because Billing and Feed are built that way and
Leads changing means the app stops being one thing. What is worth taking is their
**information architecture and their honesty about price**, which we already have
the machinery for and have been underusing.

Each item below says what it is, whether we can build it today, what it costs, and
what I think of it. The ones I think are bad are still here, with the reason.

---

## 1. The free count, as its own card, above the price

**They do this.** A card reading "Free count, before you spend anything" sits
*between* the profile and the price button. Sub-line: "From keywords through Treg.
Count calls are free, so editing the card costs nothing."

**We should.** This is the single best idea in the screenshots and it is the one
thing Echo does not have. It converts "trust us" into "check", and the second
sentence removes the reason not to fiddle with the filters — every keystroke is
free.

**Blocked.** `count` is not implemented and needs the provider token.

**What we can do now.** Build the card, its layout and its states, and have it say
the one thing that is already true: *"about N of your filters have no provider
behind them yet"*. Then when `count` lands, the only change is the number going
from a dash to a figure. CountLine already exists for the number and already
renders a dash rather than a zero, which is the right behaviour and is currently
not being used.

**Effort.** Small now, small later. **Verdict: do it.**

---

## 2. Price per unit, on the button

**They do this.** The button reads "Find 50 leads", and beside it, smaller, "about
16.6 credits each".

**We should.** Fifty credits and sixteen point six credits each are the same
money and they answer different questions. The first is "can I afford this", the
second is "is this worth doing". We currently show likely/max for the run only.

**Effort.** Trivial — the estimate already returns both, it is one division.
**Verdict: do it.**

---

## 3. Say out loud what the hold does

**They do this.** Under the button: *"Est. 830 credits (max 2,306). The max is
held when the run starts and the unused part comes back when it ends."*

**We should, urgently.** This is the sentence we most needed and least said. We
have had two-phase balance since the beginning — reserve the worst case, settle
what was earned, release the rest — and the UI has never told the user. A user
reading "max 2,306 credits" and watching 2,306 vanish from their balance has every
reason to think they were robbed unless something says otherwise.

One sentence, placed under the price, removes the single most likely support
ticket this product will generate.

**Effort.** Trivial. **Verdict: do it, first.**

---

## 4. The count in the profile's own header

**They do this.** "UK owner-operated trades and home services firms — About 156,386
companies · 44,999 decision makers", directly under the title.

**We should, partially.** Even without a provider we know the *filters*, so the
header can honestly say what has been chosen rather than what matched. The
matching numbers are item 1.

**Effort.** Trivial for the chosen-shape part. **Verdict: do the honest version.**

---

## 5. "What Opus assumed"

**They do this.** A bulleted panel of the assumptions the generator made, with a
warning icon on the consequential one ("GB is the only target country, matching
the primary focus"), and notes on coverage limits ("LinkedIn coverage of very
small trades firms is thin, and many sole trader trades may only be findable on
Google").

**We should.** This is the best honesty feature in the screenshots. Our ICP
document already has an `assumptions` field and a `confidence` number and we render
neither. An AI-written profile that quietly guessed "GB only" and cost the user a
wasted run is a bad experience, and the fix is to say it on the screen.

**Effort.** Small — the data exists in `lead_icps.json.assumptions`.
**Verdict: do it.**

---

## 6. Credits and dollars on every row

**They do this.** The Cost column reads "1.1 credits" with "$0.0058 Treg"
underneath.

**We should.** This is the price being auditable, which is the entire premise of a
per-result waterfall. Ours shows credits only, so the user cannot see what the
provider charged them and cannot tell a good waterfall from an expensive one.

We have the number. `api_usage.provider_cost_usd` with `metadata->>'row_id'`, and
`lead_attempts.cost_usd` sums to the same thing per row.

**Effort.** Small — one aggregate query per page, or a new column the worker
writes. The column is cleaner and one line of worker code. **Verdict: do it, with
the column.**

---

## 7. Attempt history that shows the step, and shows the failures

**They do this.** The expanded row lists every attempt with a Step column —
Person, Email, Verify, Phone — a provider, a hit or miss, and a cost. And when a
call failed it says so in plain language: "Verify · ContactOut · HTTP 429".

**We should.** Ours shows step and provider and cost but not the failures, and it
does not join to the error. A 429 that silently becomes a miss is a provider
problem the user is paying for and cannot see.

`api_usage` already has `http_status` and `error_code`, and `lead_attempts` has
`api_usage_id` pointing at it. **No migration needed for the join.**

**Effort.** Small. **Verdict: do it.**

---

## 8. A provider distribution bar above the table

**They do this.** "QuickEnrich 8 · Kitt 4 · AI Ark 2 · LeadsForge 1" under a
multi-coloured bar, giving the number of leads each provider actually supplied.

**We should, but ours is better.** We have this already, and ours ranks by cost per
independent find rather than raw count — the reference is answering "who finds the
most" when the useful question is "who is worth their slot". What we do not have
is the *per-run* version at the top of the lead list.

**Effort.** Small. **Verdict: do it.**

---

## 9. Stat tiles with sub-labels

**They do this.** "Found — 0 — of 3 people" and "Spent — 8 credits — $0.0310
Treg". The sub-label under the big number says what the number is a fraction *of*.

**We should.** We have the numbers; we lost the denominators when we moved off the
tile layout. "0" out of nothing is not information; "0 of 3" is a state.

**Effort.** Trivial. **Verdict: do it.**

---

## 10. Run controls in the header

**They do this.** Pause, Cancel and Export sit in the top-right of the lead list,
beside a live "pouring · 0 of 50" indicator.

**We already have this** — I added it in the last pass. Worth noting so it does not
get duplicated.

---

## 11. "Credits held" in the run's subtitle

**They do this.** "50 leads · 2,305 credits held".

**We should.** Same reason as item 3. The user can see what is currently reserved
against them without going to the Billing tab.

**Effort.** Trivial — the run has `max_credits` and the wallet has `reserved`.
**Verdict: do it.**

---

## 12. An employee range slider

**They do this.** A two-handle slider with "1 to 10" beside it.

**Should we?** A slider is nicer than chips for a continuous range and it is
compact. But we have five named bands with real industry meaning — "1–10" and
"11–50" are how people describe company size, and a slider invites "17" which is
not a thing anyone means.

Keep the chips. The screenshot's better feature is that the *current value is
stated in words* next to the control, which ours does too.

**Verdict: skip. Ours is fine and their version invites values nobody means.**

---

## 13. "Regenerate with a note"

**They do this.** A textarea reading "smaller firms, US only" and a Regenerate
button, under the price.

**Should we?** Yes eventually, and the column is already there — `lead_icps.note`,
already written by `save_icp`. It needs `read_site` and a model call, so it is
token-blocked.

**Verdict: wanted, blocked.**

---

## 14. An opening angle per lead

**They do this.** The expanded row carries a generated line: *"If a customer can
reorder this afternoon, who answers the phone when they call the next firm on
Google?"*

**This is the best feature in the screenshots and the most expensive.** It is the
difference between a list and something an outreach tool can use.

But per-lead generation for 2,000 leads is 2,000 model calls. Doing it for
everyone means every user pays for it and most never read it.

**Do it as a bulk action instead.** Select the rows you are actually going to work,
press Generate, get angles for those. Priced and shown first, like everything else.
Cost per row shown next to the button so the user knows what selecting 200 rows
will do to their balance.

Needs a column on `lead_rows` and one edge action. The `ai` function already exists.

**Verdict: do it as a bulk action. Never as a default.**

---

## 15. Clearer status vocabulary

**They do this.** "Finding email", "Finding person", "Queued", "Catch-all".

**We should.** Our states are `queued`, `trying`, `miss`, `found`, `done`,
`skipped`, `failed` — database words. "Finding email" is what is happening.

The column names the **step** rather than the state, which is more useful: a user
does not care that it is `trying`, they care that it is looking for the person
rather than the address.

Keep the database enums. Change only what is drawn.

**Effort.** Small. **Verdict: do it.**

---

## Rejected

**Their visual language.** Soft shadows, 8px radii, two-column card layout, a
sans-serif body at 14px. Adopting it would make Leads look like a different
product from Billing, which sits two clicks away in the same sidebar.

**The "Regenerate" as the primary path.** It makes editing feel like a
conversation you are losing. Ours is a form you fill and a price you see, which
is the right shape for a product that charges by the lookup.

---

## Waves

**A — trust, first, before anything else.** Item 3 (say what the hold does), item 2
(price per unit), item 9 (stat tiles with denominators), item 11 (credits held),
item 6 (credits and dollars per row, with the column). All of it is showing the
user what they are paying for, and all of it is work we have already done behind a
number we were not showing.

**B — the list.** Item 7 (attempts with step and failure), item 8 (provider
distribution), item 15 (status vocabulary), the bulk bar's "Never contact" getting
the same treatment as the rest.

**C — the profile.** Item 5 (assumptions), item 4 (honest header), the count card
built and waiting for a number.

**D — token-blocked.** Item 1 (free count), item 13 (regenerate with a note).

**E — the expensive one.** Item 14 (opening angles as a bulk action), if the
margin works out.

---

## The order is not arbitrary

A comes first because of item 3 alone. We take the worst case up front and settle
down, we have since the first migration, and we have never said so. Every other
item on this page makes the product more honest; that one prevents a user
concluding we stole their credits.

Everything in A is display. None of it needs a provider, a migration or a new
edge action, and all of it can be finished before the token arrives.